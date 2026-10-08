import { type GitEventRecord, type IngestSink, truncate, type VcsCommit, type VcsIntent, type VcsKind } from "./types.ts";

/**
 * Commits and pull requests an agent made, told from the shell commands it ran and their output. Nothing is executed
 * and the command text is never kept: a command only flags its call (vcsIntent), and the call's output says what came
 * of it (commitsIn, prsIn, emitGitEvents). Input is bounded and every pattern runs in linear time, so a huge output
 * costs little.
 */

/** A command is read this far: a commit or PR is said in its first pages, not after a whole script. */
const COMMAND_LIMIT = 64 * 1024;
/** Output is read at its start and its end only: git and gh say what they did there, the middle is hook or test output. */
const OUTPUT_EDGE = 64 * 1024;
/** A commit line longer than this is no commit line ("[branch sha] subject"). */
const LINE_LIMIT = 2000;
/** A branch name is kept this long. */
const BRANCH_LIMIT = 200;
/** At most this many commits or PRs from one output. */
const MAX_FOUND = 100;
/** Command substitutions inside quoted words are read this many levels deep. */
const MAX_DEPTH = 2;

/** Words that may stand before the command in a shell segment. */
const LEADING = new Set(["then", "do", "else", "if", "elif", "while", "until", "!", "{"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Commands that run the command after them, with their options that take the next word as their value and those that
 * name the directory it runs in.
 */
const WRAPPERS = new Map<string, { values: Set<string>; chdir: Set<string> }>([
  ["sudo", {
    values: new Set(["-u", "--user", "-g", "--group", "-C", "--close-from", "-D", "--chdir", "-p", "--prompt", "-r", "--role", "-t", "--type", "-T", "--command-timeout", "-U", "--other-user", "-R", "--chroot", "--host"]),
    chdir: new Set(["-D", "--chdir"]),
  }],
  ["env", { values: new Set(["-u", "--unset", "-C", "--chdir"]), chdir: new Set(["-C", "--chdir"]) }],
  ["nice", { values: new Set(["-n", "--adjustment"]), chdir: new Set() }],
  ["time", { values: new Set(["-f", "--format", "-o", "--output"]), chdir: new Set() }],
  ["command", { values: new Set(), chdir: new Set() }],
  ["exec", { values: new Set(["-a"]), chdir: new Set() }],
  ["nohup", { values: new Set(), chdir: new Set() }],
]);
/** `command -v git` only looks the command up. */
const LOOKUP = new Set(["-v", "-V"]);

/** Shells whose `-c` script is read as a command of its own (`bash -lc "git commit …"`). */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const SCRIPT_FLAG = /^-[a-z]*c[a-z]*$/i;
/** PowerShell, whose `-Command` (or `-c`) takes the rest of the line as its script. */
const POWERSHELLS = new Set(["powershell", "pwsh"]);
const POWERSHELL_COMMAND = /^-c(?:om(?:m(?:a(?:n(?:d)?)?)?)?)?$/i;
/** cmd's `/c` (or `/k`) also takes the rest of the line. */
const CMD_SCRIPT = /^\/[ck]$/i;
/** gh's global options that take the next word as their value (`gh -R owner/repo pr create`). */
const GH_VALUE_OPTIONS = new Set(["-R", "--repo"]);
/** git's global options that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
/** git's global options whose value is where it works. */
const GIT_DIR_OPTIONS = new Set(["-C", "--git-dir", "--work-tree"]);
/** A command run with one of these commits or opens nothing. */
const NOT_RUN = new Set(["--dry-run", "-h", "--help"]);
/** The characters a backslash escapes inside double quotes. */
const DOUBLE_QUOTE_ESCAPES = new Set(["$", "`", '"', "\\", "\n"]);
/** Characters that end a shell segment (newlines too, handled apart for heredocs). */
const SEPARATORS = new Set([";", "&", "|", "(", ")", "`"]);
/** `mktemp -d`, also with other short flags (`-dt`), makes a directory. */
const MKTEMP_DIRECTORY = /^-[A-Za-z]*d[A-Za-z]*$/;

/** Temp directories, in lower case: the system's own and the shell variables that name one, on Linux and macOS. */
const TEMP_DIRS = [
  "/tmp", "/var/tmp", "/private/tmp", "/var/folders", "/private/var/folders",
  "$tmpdir", "${tmpdir}", "$tmp", "${tmp}", "$temp", "${temp}",
];
/** Windows' temp directories at a drive's root, in lower case with forward slashes (`C:\Temp`, `C:\Windows\Temp`). */
const WINDOWS_TEMP_DIR = /^[a-z]:\/(?:temp|tmp|windows\/temp)(?:\/|$)/;
/** Windows' temp directory variables, in lower case: what follows them is in it, with or without a separator. */
const WINDOWS_TEMP_VARIABLES = ["%temp%", "%tmp%", "$env:temp", "$env:tmp"];

/** Whether a path is in a temp directory. */
function isTempPath(path: string): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (p.includes("/appdata/local/temp/") || p.endsWith("/appdata/local/temp")) return true;
  if (WINDOWS_TEMP_DIR.test(p)) return true;
  if (WINDOWS_TEMP_VARIABLES.some((variable) => p.startsWith(variable))) return true;
  return TEMP_DIRS.some((dir) => p === dir || p.startsWith(`${dir}/`));
}

/** A path that starts where the command already is: not from the root, home, a variable or a drive. */
const isRelative = (path: string): boolean => !/^(?:[/\\~$%]|[A-Za-z]:)/.test(path);

/** Whether a command is in a temp directory after it changes to `path`, from one that is (`inTemp`) or not. */
function inTempAfter(inTemp: boolean, path: string | undefined): boolean {
  // `cd` alone goes home, `cd -` back to where it was before: neither is told apart here.
  if (!path || path === "-") return false;
  return isRelative(path) ? inTemp : isTempPath(path);
}

/** What a command does, as read so far. */
interface Scan {
  /** Whether it commits. */
  commit: boolean;
  /** Whether it opens a PR. */
  pr: boolean;
  /**
   * Whether it sets up or works in a throwaway repository (`git init`, `mktemp -d`, a commit in a temp directory): a
   * test script's commits are no work on the session's project.
   */
  scratch: boolean;
  /** Whether the directory it last changed to is a temp directory. */
  inTemp: boolean;
  /** How many commits it runs, as read so far. */
  commits: number;
  /** After how many commits it first runs a one-line `git log`. */
  log?: number;
  /** Its first commit's message, first line only: null when it is not in the command (`-F file`, `-C sha`). */
  message?: string | null;
  /** Whether its first commit reads its message from the heredoc that follows (`-F -`). */
  messageFromHeredoc?: boolean;
}

/** A command's name without its path or `.exe`, in lower case (`C:\\Program Files\\Git\\cmd\\Git.exe` is git). */
const programOf = (word: string | undefined): string => (word ?? "").replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();

/** A long option's name and its value after `=`, or a short option alone. */
function splitOption(option: string): [string, string | undefined] {
  if (!option.startsWith("--") || !option.includes("=")) return [option, undefined];
  const at = option.indexOf("=");
  return [option.slice(0, at), option.slice(at + 1)];
}

/** Notes a commit or PR the command makes. */
function found(scan: Scan, kind: VcsKind): void {
  if (kind === "commit") scan.commit = true;
  else scan.pr = true;
}

/**
 * A `git` command's words from its first option on, run in a temp directory or not: where it works, and whether it
 * commits or makes a repository.
 */
function readGit(words: string[], from: number, inTempBefore: boolean, scan: Scan): void {
  let inTemp = inTempBefore;
  let j = from;

  while (j < words.length && words[j]!.startsWith("-")) {
    const option = words[j]!;
    const [name, inline] = splitOption(option);

    if (GIT_DIR_OPTIONS.has(name)) inTemp = inTempAfter(inTemp, inline ?? words[j + 1]);
    j += GIT_VALUE_OPTIONS.has(option) ? 2 : 1;
  }

  if (words[j] === "init") {
    scan.scratch = true;
    return;
  }

  if (words[j] === "log" || words[j] === "show") {
    if (scan.commits > 0 && scan.log === undefined && printsOneLine(words[j]!, words.slice(j + 1))) scan.log = scan.commits;
    return;
  }

  if (words[j] !== "commit" || words.slice(j + 1).some((w) => NOT_RUN.has(w))) return;

  if (inTemp) scan.scratch = true;
  found(scan, "commit");
  scan.commits++;
  if (scan.commits === 1) readMessage(words.slice(j + 1), scan);
}

/** `--format`/`--pretty` values that print a commit as "<sha> <subject>". */
const ONE_LINE_FORMAT = /^(?:oneline|(?:t?format:)?%[hH] %s)$/;

/**
 * Whether a `git log` (or `git show -s`) prints each commit as one "<sha> <subject>" line: `--oneline`, `--pretty=oneline`
 * or `--format="%h %s"`.
 */
function printsOneLine(subcommand: string, args: string[]): boolean {
  if (subcommand === "show" && !args.some((w) => w === "-s" || w === "--no-patch")) return false;

  for (let k = 0; k < args.length; k++) {
    const [name, inline] = splitOption(args[k]!);
    if (name === "--oneline") return true;
    // `--pretty`'s value is optional, so only after `=`: `--pretty oneline` names a revision.
    const value = name === "--format" ? inline ?? args[k + 1] : name === "--pretty" ? inline : undefined;
    if (value !== undefined && ONE_LINE_FORMAT.test(value)) return true;
  }
  return false;
}

/** git commit's short options without a value, which may stand in one word before `m` (`-qm`, `-am`). */
const COMMIT_FLAGS = /^-[aqvnse]*m/;

/**
 * A commit's message from its arguments: the first `-m`/`--message` (`-m x`, `-mx`, `-m=x`, `-qm x`, `--message=x`),
 * or the heredoc that follows for `-F -`. A message that is a heredoc in a substitution (`-m "$(cat <<'EOF' …)"`) is
 * its first line.
 */
function readMessage(args: string[], scan: Scan): void {
  scan.message = null;

  for (let k = 0; k < args.length; k++) {
    const word = args[k]!;
    if (word === "--") return;

    const [name, inline] = splitOption(word);
    if (name === "--message") {
      scan.message = firstLine(inline ?? args[k + 1]);
      return;
    }
    if (name === "-F" || name === "--file") {
      scan.messageFromHeredoc = (inline ?? args[k + 1]) === "-";
      return;
    }
    if (word === "-F-") {
      scan.messageFromHeredoc = true;
      return;
    }

    const short = word.startsWith("--") ? null : COMMIT_FLAGS.exec(word);
    if (short) {
      const rest = word.slice(short[0].length);
      scan.message = firstLine(rest ? rest.replace(/^=/, "") : args[k + 1]);
      return;
    }
  }
}

/** A heredoc read in a command substitution (`$(cat <<'EOF'`), up to the end of its first line. */
const HEREDOC_SUBSTITUTION = /^\$\(\s*cat\s+<<-?\s*(['"]?)[A-Za-z0-9_.-]{1,64}\1[ \t]*\n/;

/** The first line with words of a message, or of the heredoc it reads, cut to a commit line's length. */
function firstLine(message: string | undefined): string | null {
  if (!message) return null;

  const text = message.slice(0, 4 * LINE_LIMIT);
  const heredoc = HEREDOC_SUBSTITUTION.exec(text);
  const body = heredoc ? text.slice(heredoc[0].length) : text;
  for (const line of body.split("\n")) {
    if (line.trim()) return line.trim().slice(0, LINE_LIMIT);
  }
  return null;
}

/** A `gh` command's arguments: whether it opens a PR, also with global options first (`gh -R owner/repo pr create`). */
function readGh(args: string[], scan: Scan): void {
  let j = 0;
  while (j < args.length && args[j]!.startsWith("-")) j += GH_VALUE_OPTIONS.has(args[j]!) ? 2 : 1;

  if (args[j] !== "pr" || args[j + 1] !== "create") return;
  if (!args.slice(j + 2).some((w) => NOT_RUN.has(w))) found(scan, "pr");
}

/**
 * How a command line is written. POSIX shells escape with a backslash and substitute with backticks. PowerShell and
 * cmd keep a backslash as it is (`C:\Temp\x`), and PowerShell escapes with a backtick.
 */
export type ShellSyntax = "posix" | "windows";

/**
 * The script a shell runs from its arguments (`bash -lc "…"`, `pwsh -Command …`, `cmd /c …`) and how it is written, or
 * null for none.
 */
function shellScript(program: string, args: string[]): { script: string; syntax: ShellSyntax } | null {
  if (SHELLS.has(program)) {
    const flag = args.findIndex((w) => SCRIPT_FLAG.test(w));
    const script = flag >= 0 ? args[flag + 1] : undefined;
    return script ? { script, syntax: "posix" } : null;
  }

  const rest = POWERSHELLS.has(program) ? POWERSHELL_COMMAND : program === "cmd" ? CMD_SCRIPT : null;
  if (!rest) return null;

  const flag = args.findIndex((w) => rest.test(w));
  const script = flag >= 0 ? args.slice(flag + 1).join(" ") : "";
  return script ? { script, syntax: "windows" } : null;
}

/** What one shell segment's words do. */
function readSegment(words: string[], depth: number, scan: Scan): void {
  // Keywords, variables and wrappers (`sudo -u bot`, `env -i A=1`, `nice -n 5`) stand before the command. A wrapper
  // that changes directory (`env -C dir`) does so for this command only.
  let inTemp = scan.inTemp;
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (LEADING.has(word) || ASSIGNMENT.test(word)) {
      i++;
      continue;
    }

    const name = programOf(word);
    const wrapper = WRAPPERS.get(name);
    if (!wrapper) break;

    i++;
    while (i < words.length && words[i]!.startsWith("-")) {
      const [option, inline] = splitOption(words[i]!);
      if (option === "--") {
        i++;
        break;
      }
      if (name === "command" && LOOKUP.has(option)) return;

      if (wrapper.chdir.has(option)) inTemp = inTempAfter(inTemp, inline ?? words[i + 1]);
      i += inline === undefined && wrapper.values.has(option) ? 2 : 1;
    }
  }

  const program = programOf(words[i]);
  const args = words.slice(i + 1);

  if (SHELLS.has(program) || POWERSHELLS.has(program) || program === "cmd") {
    // A shell of its own: a `cd` in its script stays there.
    const shell = depth === 0 ? shellScript(program, args) : null;
    if (shell) {
      const outer = scan.inTemp;
      scan.inTemp = inTemp;
      scanCommand(shell.script, depth + 1, scan, shell.syntax);
      scan.inTemp = outer;
    }
    return;
  }

  if (program === "cd" || program === "pushd" || program === "set-location" || program === "push-location" || program === "sl") {
    scan.inTemp = inTempAfter(scan.inTemp, args.find((w) => !w.startsWith("-") || w === "-"));
    return;
  }

  if (program === "mktemp") {
    if (args.some((w) => w === "--directory" || MKTEMP_DIRECTORY.test(w))) scan.scratch = true;
    return;
  }

  if (program === "git") {
    readGit(words, i + 1, inTemp, scan);
    return;
  }

  if (program === "gh") readGh(args, scan);
}

/** Where a heredoc's body ends: after the line that is its delimiter (or the end of the text). */
function heredocEnd(text: string, from: number, delimiter: string): number {
  let pos = from;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const end = nl < 0 ? text.length : nl;
    const line = text.slice(pos, end).trim();
    pos = end + 1;
    if (line === delimiter) return pos;
  }
  return text.length;
}

/**
 * Reads a shell command once, character by character: words split on unquoted blanks, segments on `;`, `&&`, `||`, `|`,
 * newlines and parentheses. Quoted text and heredoc bodies are words, never commands, so `echo "git commit"` and a
 * script written through a heredoc commit nothing. A command substitution inside double quotes (`"$(mktemp -d)"`) is
 * read as a command of its own. A subshell or substitution (`( … )`, `$( … )`, backticks) runs apart: a `cd` in it
 * does not change where the commands after it run. In Windows syntax a backslash is a character like any other and a
 * backtick escapes the character after it.
 */
function scanCommand(text: string, depth: number, scan: Scan, syntax: ShellSyntax = "posix"): void {
  const windows = syntax === "windows";
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | null = null;
  let heredoc: string | null = null;
  let substitution = -1;
  // Where the shell was when each open subshell started, and when the open backtick did.
  const subshells: boolean[] = [];
  let backtick: boolean | null = null;

  const endWord = (): void => {
    if (inWord) words.push(word);
    if (inWord && substitution >= 0 && depth < MAX_DEPTH) {
      const outer = scan.inTemp;
      scanCommand(word.slice(substitution), depth + 1, scan, syntax);
      scan.inTemp = outer;
    }
    word = "";
    inWord = false;
    substitution = -1;
  };
  const endSegment = (): void => {
    endWord();
    if (words.length) readSegment(words, depth, scan);
    words = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    // PowerShell's escape, in quotes and out: the next character as it is.
    if (windows && ch === "`" && quote !== "'") {
      word += text[i + 1] ?? "";
      inWord = true;
      i++;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      // In double quotes a backslash escapes only these, before anything else it stays ("C:\Temp").
      else if (ch === "\\" && quote === '"' && !windows && i + 1 < text.length && DOUBLE_QUOTE_ESCAPES.has(text[i + 1]!)) word += text[++i];
      else {
        const substitutes = quote === '"' && (ch === "`" || (ch === "$" && text[i + 1] === "("));
        if (substitutes && substitution < 0) substitution = word.length;
        word += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && !windows) {
      // A backslash before a newline continues the line, before anything else it escapes it.
      if (text[i + 1] !== "\n") {
        word += text[i + 1] ?? "";
        inWord = true;
      }
      i++;
    } else if (ch === "#" && !inWord) {
      const nl = text.indexOf("\n", i);
      i = (nl < 0 ? text.length : nl) - 1;
    } else if (ch === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
      endWord();
      const m = /^<<-?[ \t]*(['"]?)([A-Za-z0-9_.-]{1,64})\1/.exec(text.slice(i, i + 80));
      if (m) {
        heredoc = m[2]!;
        i += m[0].length - 1;
      } else i++;
    } else if (ch === "\n") {
      endSegment();
      if (heredoc) {
        const end = heredocEnd(text, i + 1, heredoc);
        // A commit that reads its message from this heredoc (`git commit -F - <<'EOF'`).
        if (scan.messageFromHeredoc) scan.message = firstLine(text.slice(i + 1, Math.min(end, i + 1 + 4 * LINE_LIMIT)));
        i = end - 1;
        heredoc = null;
      }
      // Its heredoc is on the commit's own line, or there is none (`printf … | git commit -F -`).
      scan.messageFromHeredoc = false;
    } else if (SEPARATORS.has(ch)) {
      endSegment();

      if (ch === "(") subshells.push(scan.inTemp);
      else if (ch === ")" && subshells.length) scan.inTemp = subshells.pop()!;
      else if (ch === "`" && backtick === null) backtick = scan.inTemp;
      else if (ch === "`") {
        scan.inTemp = backtick!;
        backtick = null;
      }
    } else if (ch === " " || ch === "\t" || ch === "\r") {
      endWord();
    } else {
      word += ch;
      inWord = true;
    }
  }

  endSegment();
}

/**
 * Whether a shell command commits (`git commit` at the start of a segment, also with `-C dir`, `-c k=v` or variables
 * set before it), opens a pull request (`gh pr create`), or both (`git commit … && git push && gh pr create`). Not when
 * it only asks for help or a dry run. A string is read as a shell command line, an array as its words
 * (`["bash", "-lc", "git commit …"]`). `syntax` is how a string is written: "windows" for a PowerShell or cmd tool. Shells (`bash -c`, `pwsh -Command`, `cmd /c`) and wrappers (`sudo`, `env`, `nice`,
 * `time`, `command`) are seen through. Only the first 64 KB are read.
 *
 * A commit in a throwaway repository is none: not when the same command also runs `git init` or `mktemp -d`, or commits
 * in a temp directory it changed to (`cd /tmp/…`, `git -C "$TMPDIR/…"`). A PR is a PR wherever it is opened from, its
 * URL names the repository.
 */
export function vcsIntent(command: unknown, syntax: ShellSyntax = "posix"): VcsKind | "both" | null {
  return intentOf(scanVcs(command, syntax));
}

/**
 * vcsIntent, with what the command tells of a commit whose output may show no `[branch sha]` line (`git commit -q`):
 * the one-line `git log` it runs after its commits, and its first commit's message (cut to `textLimit`, none at 0).
 * What a call is remembered by until its output arrives.
 */
export function vcsCall(command: unknown, textLimit: number, syntax: ShellSyntax = "posix"): VcsIntent | null {
  const scan = scanVcs(command, syntax);
  const intent = intentOf(scan);
  if (intent !== "commit" && intent !== "both") return intent;

  const subject = scan.message ? truncate(scan.message, textLimit) : null;
  if (scan.log === undefined && !subject) return intent;

  const detail: VcsCommit = { does: intent };
  if (scan.log !== undefined) detail.log = scan.log;
  if (subject) detail.subject = subject;
  return detail;
}

function scanVcs(command: unknown, syntax: ShellSyntax): Scan {
  const scan: Scan = { commit: false, pr: false, scratch: false, inTemp: false, commits: 0 };

  if (typeof command === "string") {
    scanCommand(command.slice(0, COMMAND_LIMIT), 0, scan, syntax);
  } else if (Array.isArray(command) && command.length && command.every((w) => typeof w === "string")) {
    let budget = COMMAND_LIMIT;
    const words: string[] = [];
    for (const w of command as string[]) {
      if (budget <= 0) break;
      words.push(w.slice(0, budget));
      budget -= w.length + 1;
    }
    readSegment(words, 0, scan);
  }

  return scan;
}

function intentOf(scan: Scan): VcsKind | "both" | null {
  const commit = scan.commit && !scan.scratch;
  if (commit && scan.pr) return "both";
  if (commit) return "commit";
  return scan.pr ? "pr" : null;
}

/** The start and end of a tool's output, whole lines only, as one text. */
function edges(output: unknown): string {
  if (typeof output !== "string") return "";
  if (output.length <= 2 * OUTPUT_EDGE) return output;
  const head = output.slice(0, OUTPUT_EDGE);
  const tail = output.slice(-OUTPUT_EDGE);
  return `${head.slice(0, head.lastIndexOf("\n") + 1)}\n${tail.slice(tail.indexOf("\n") + 1)}`;
}

const COMMIT_LINE = /^\[(.+?)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.*)$/;

/**
 * The commits a `git commit` output reports: `[main 1a2b3c4] Subject`, `[main (root-commit) 1a2b3c4] …`. A commit on
 * a detached HEAD has no branch. Each sha once.
 */
export function commitsIn(output: unknown): { branch: string | null; sha: string; subject: string }[] {
  const found = new Map<string, { branch: string | null; sha: string; subject: string }>();

  for (const raw of edges(output).split("\n")) {
    if (raw[0] !== "[" || raw.length > LINE_LIMIT) continue;
    const m = COMMIT_LINE.exec(raw.replace(/\r$/, ""));
    if (!m || found.has(m[2]!)) continue;

    const branch = m[1]!.trim().slice(0, BRANCH_LIMIT);
    found.set(m[2]!, { branch: branch === "detached HEAD" ? null : branch, sha: m[2]!, subject: m[3]!.trim() });
    if (found.size >= MAX_FOUND) break;
  }

  return [...found.values()];
}

/**
 * How git starts the line that says a commit had nothing in it, in lower case: in English and in git's German,
 * Spanish, French and Polish (the languages of the UI), as their catalogs translate "nothing to commit", "nothing
 * added to commit but untracked files present" and "no changes added to commit" (some differ with a hint after them).
 */
const NOTHING_TO_COMMIT = [
  "nothing to commit",
  "nothing added to commit",
  "no changes added to commit",
  "nichts zu committen",
  "nichts zum commit vorgemerkt",
  "keine änderungen zum commit vorgemerkt",
  "nada para hacer commit",
  "no hay nada para confirmar",
  "no hay nada agregado para confirmar",
  "no hay nada agregado al commit",
  "no se agregaron cambios al commit",
  "sin cambios agregados al commit",
  "rien à valider",
  "aucune modification ajoutée à la validation",
  "aucune modification n'a été ajoutée à la validation",
  "nic do złożenia",
  "nie dodano nic do złożenia",
  "brak zmian dodanych do zapisu",
];

/** A one-line log entry: an abbreviated (7 to 12) or full sha, and the subject, maybe after its refs. */
const LOG_LINE = /^([0-9a-f]{7,12}|[0-9a-f]{40}) (?:\((?:HEAD|tag: )[^)]{0,500}\) )?(.+)$/;

/** The newest `count` commits a one-line `git log` in the output lists, each once. */
export function loggedCommits(output: unknown, count: number): { sha: string; subject: string }[] {
  const found = new Map<string, { sha: string; subject: string }>();
  const limit = Math.min(count, MAX_FOUND);

  for (const raw of edges(output).split("\n")) {
    if (found.size >= limit) break;
    if (raw.length > LINE_LIMIT) continue;

    const m = LOG_LINE.exec(raw.replace(/\r$/, ""));
    if (m && !found.has(m[1]!)) found.set(m[1]!, { sha: m[1]!, subject: m[2]!.trim() });
  }

  return [...found.values()];
}

/** Whether an output says there was nothing to commit (a `git commit … || true` that made none). */
export function nothingToCommit(output: unknown): boolean {
  for (const raw of edges(output).split("\n")) {
    if (raw.length > LINE_LIMIT) continue;
    const line = raw.trim().toLowerCase();
    if (NOTHING_TO_COMMIT.some((start) => line.startsWith(start))) return true;
  }
  return false;
}

/** An owner or repository name is never `.` or `..` (a dot-named one such as `.github` is). */
const PR_URL = /https:\/\/([A-Za-z0-9.-]{1,253}(?::\d{1,5})?)\/(?!\.\.?\/)([A-Za-z0-9_.-]{1,100})\/(?!\.\.?\/)([A-Za-z0-9_.-]{1,100})\/pull\/(\d{1,9})(?!\d)/g;

/**
 * The pull requests an output links to: `https://<host>/<owner>/<repo>/pull/<n>`, GitHub or GitHub Enterprise, https
 * only. `repo` is "<host>/<owner>/<repo>" with the host in lower case, `url` the PR's own address. Each URL once.
 */
export function prsIn(output: unknown): { repo: string; number: number; url: string }[] {
  const found = new Map<string, { repo: string; number: number; url: string }>();

  for (const m of edges(output).matchAll(PR_URL)) {
    const number = Number(m[4]);
    if (!(number > 0)) continue;

    const repo = `${m[1]!.toLowerCase()}/${m[2]}/${m[3]}`;
    const url = `https://${repo}/pull/${number}`;
    if (!found.has(url)) found.set(url, { repo, number, url });
    if (found.size >= MAX_FOUND) break;
  }

  return [...found.values()];
}

/**
 * Sends the commits and pull requests a successful shell call made (what vcsCall flagged it for) to the sink, read
 * from its output. A commit is on the branch its output names, else on the call's, and its subject is cut to the prompt
 * text limit. A commit whose output shows no `[branch sha]` line (`git commit -q`) is still one, unless the output says
 * there was nothing to commit: with the sha and subject of the one-line `git log` the command ran after it, else keyed
 * by its call with the message the command gave it. A PR is known only by its URL: one without (`gh pr create --web`)
 * is none.
 */
export function emitGitEvents(sink: IngestSink, intent: VcsIntent, output: unknown, call: Omit<GitEventRecord, "kind">, textLimit: number): void {
  const does = typeof intent === "string" ? intent : intent.does;
  const detail = typeof intent === "string" ? null : intent;

  if (does !== "pr") {
    const commits = commitsIn(output);
    for (const c of commits) sink.gitEvent?.({ ...call, kind: "commit", branch: c.branch ?? call.branch, sha: c.sha, subject: truncate(c.subject, textLimit) });

    if (!commits.length && !nothingToCommit(output)) {
      const logged = detail?.log ? loggedCommits(output, detail.log) : [];
      for (const c of logged) sink.gitEvent?.({ ...call, kind: "commit", sha: c.sha, subject: truncate(c.subject, textLimit) });

      const subject = detail?.subject ? truncate(detail.subject, textLimit) : null;
      if (!logged.length) sink.gitEvent?.(subject ? { ...call, kind: "commit", subject } : { ...call, kind: "commit" });
    }
  }

  if (does !== "commit") {
    for (const pr of prsIn(output)) sink.gitEvent?.({ ...call, kind: "pr", ...pr });
  }
}
