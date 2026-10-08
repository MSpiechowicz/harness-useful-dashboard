import { describe, expect, test } from "bun:test";
import type { GitEventRecord, IngestSink, VcsIntent } from "../src/core/ingest/types.ts";
import { commitsIn, emitGitEvents, loggedCommits, nothingToCommit, prsIn, vcsCall, vcsIntent } from "../src/core/ingest/vcs.ts";

describe("vcsIntent", () => {
  test("a commit at the start of any shell segment", () => {
    expect(vcsIntent('git commit -m "Fix the login"')).toBe("commit");
    expect(vcsIntent("git -C x commit -am wip")).toBe("commit");
    expect(vcsIntent("git -c user.name=bot -c commit.gpgsign=false commit -m x")).toBe("commit");
    expect(vcsIntent("GIT_AUTHOR_NAME=bot HUSKY=0 git commit -m x")).toBe("commit");
    expect(vcsIntent("git add -A && git commit -m x")).toBe("commit");
    expect(vcsIntent("cd app; git commit -m x | tail -3")).toBe("commit");
    expect(vcsIntent("git status\ngit commit -m x")).toBe("commit");
    expect(vcsIntent("if git diff --quiet; then echo clean; else git commit -am x; fi")).toBe("commit");
    expect(vcsIntent("for f in a b; do git commit -m $f; done")).toBe("commit");
    expect(vcsIntent("/usr/bin/git commit -m x")).toBe("commit");
    expect(vcsIntent(["bash", "-lc", "git add . && git commit -m x"])).toBe("commit");
    expect(vcsIntent("bash -lc 'git commit -m x'")).toBe("commit");
  });

  test("a commit whose message comes from a heredoc", () => {
    const command = [
      "git add src && git commit -m \"$(cat <<'EOF'",
      "fix: The login keeps the session",
      "",
      "It said git commit --help in the body.",
      "EOF",
      ')"',
    ].join("\n");
    expect(vcsIntent(command)).toBe("commit");
  });

  test("words that only mention a commit, help and dry runs commit nothing", () => {
    expect(vcsIntent("echo git commit")).toBeNull();
    expect(vcsIntent('echo "a; git commit -m x"')).toBeNull();
    expect(vcsIntent("git commit --dry-run -m x")).toBeNull();
    expect(vcsIntent("git commit -h")).toBeNull();
    expect(vcsIntent("git commit --help")).toBeNull();
    expect(vcsIntent("git log --grep commit")).toBeNull();
    expect(vcsIntent("# git commit -m x\nls")).toBeNull();
    expect(vcsIntent("cat > notes.md <<'EOF'\ngit commit -m x\nEOF\nls")).toBeNull();
    expect(vcsIntent(null)).toBeNull();
    expect(vcsIntent({ command: "git commit" })).toBeNull();
  });

  test("gh pr create opens a pull request", () => {
    expect(vcsIntent('git push -u origin feat && gh pr create --title "Feat" --body x')).toBe("pr");
    expect(vcsIntent("git add -A && git commit -m x && git push -u origin feat && gh pr create --fill")).toBe("both");
    expect(vcsIntent(["bash", "-lc", "gh pr create --fill\ngit commit --amend --no-edit"])).toBe("both");
    expect(vcsIntent("gh pr create --help")).toBeNull();
    expect(vcsIntent("gh pr list")).toBeNull();
  });

  test("a commit in a throwaway repository is none", () => {
    // Made by the command: mktemp -d, also inside quotes, and git init.
    expect(vcsIntent('tmp=$(mktemp -d)\ngit init -q "$tmp"\ncd "$tmp"\ngit commit -q --allow-empty -m baseline')).toBeNull();
    expect(vcsIntent('cd "$(mktemp -d)" && git commit -m x')).toBeNull();
    expect(vcsIntent("probe=`mktemp -dt probe`; git -C $probe commit -m x")).toBeNull();
    expect(vcsIntent("git init && git add . && git commit -m first")).toBeNull();
    expect(vcsIntent(["/usr/bin/bash", "-lc", "git init --initial-branch=main\ngit commit --allow-empty -m first"])).toBeNull();
    // Committed in a temp directory the command changed to, or pointed git at.
    expect(vcsIntent("cd /tmp/probe && git commit -m x")).toBeNull();
    expect(vcsIntent("cd /tmp/probe && cd repo && git commit -m x")).toBeNull();
    expect(vcsIntent("git -C /tmp/probe commit -m x")).toBeNull();
    expect(vcsIntent('git -C "$TMPDIR/probe" commit -m x')).toBeNull();
    expect(vcsIntent("git --git-dir=/var/tmp/probe/.git commit -m x")).toBeNull();
    expect(vcsIntent("cd /var/folders/xy/T/probe; git commit -m x")).toBeNull();
    expect(vcsIntent('cd "%TEMP%\\probe" && git commit -m x')).toBeNull();
    expect(vcsIntent("cd 'C:\\Users\\u\\AppData\\Local\\Temp\\probe' && git commit -m x")).toBeNull();
  });

  test("temp paths that are no repository, and a PR from anywhere, still count", () => {
    expect(vcsIntent("git commit -F /tmp/message.txt")).toBe("commit");
    expect(vcsIntent('msg=$(mktemp); printf "Fix" > "$msg"; git commit -F "$msg"')).toBe("commit");
    expect(vcsIntent("git commit -m 'Run $(mktemp -d) in tests'")).toBe("commit");
    expect(vcsIntent("cd /tmp/scratchpad && bun shot.ts; cd /home/u/app && git commit -qm x")).toBe("commit");
    expect(vcsIntent("cd /tmp/probe && git -C /home/u/app commit -m x")).toBe("commit");
    expect(vcsIntent("cd src && git commit -m x")).toBe("commit");
    expect(vcsIntent("gh pr create --body-file /tmp/pr.md")).toBe("pr");
    expect(vcsIntent("cd /tmp/worktree && git commit -m x && gh pr create --fill")).toBe("pr");
  });

  test("a cd in a subshell or substitution stays there", () => {
    expect(vcsIntent("(cd /tmp/x && make); git commit -m real")).toBe("commit");
    expect(vcsIntent("dir=$(cd /tmp/x && pwd); git commit -m real")).toBe("commit");
    expect(vcsIntent('echo "$(cd /tmp/x && pwd)"; git commit -m real')).toBe("commit");
    expect(vcsIntent("dir=`cd /tmp/x && pwd`; git commit -m real")).toBe("commit");
    expect(vcsIntent("bash -c 'cd /tmp/x && make'; git commit -m real")).toBe("commit");
    expect(vcsIntent("((cd /tmp/x); cd /tmp/y); git commit -m real")).toBe("commit");
    // What runs inside still runs where it changed to, and a subshell starts where its shell is.
    expect(vcsIntent("(cd /tmp/x && git commit -m x)")).toBeNull();
    expect(vcsIntent("cd /tmp/x && (git commit -m x)")).toBeNull();
    expect(vcsIntent("(cd src); cd /tmp/x; git commit -m x")).toBeNull();
  });

  test("PowerShell and cmd scripts are read, with their flags in any case", () => {
    expect(vcsIntent('powershell -NoProfile -Command "git add -A; git commit -m x"')).toBe("commit");
    expect(vcsIntent("PowerShell.exe -ExecutionPolicy Bypass -command git commit -m x")).toBe("commit");
    expect(vcsIntent("pwsh -c 'gh pr create --fill'")).toBe("pr");
    expect(vcsIntent(["pwsh", "-NoLogo", "-Command", "git commit -m x"])).toBe("commit");
    expect(vcsIntent("cmd /c git commit -m x")).toBe("commit");
    expect(vcsIntent('cmd.exe /C "git add . && git commit -m x"')).toBe("commit");
    expect(vcsIntent("'C:\\Windows\\System32\\cmd.exe' /c git commit -m x")).toBe("commit");
    expect(vcsIntent(["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-Command", "git commit -m x"])).toBe("commit");
    expect(vcsIntent("pwsh -File release.ps1")).toBeNull();
    expect(vcsIntent("powershell -Command \"Write-Output 'git commit'\"")).toBeNull();
  });

  test("PowerShell and cmd keep a backslash in an unquoted path", () => {
    // A PowerShell or cmd tool's own command line.
    expect(vcsIntent("Set-Location C:\\Users\\me\\AppData\\Local\\Temp\\x; git commit -m a", "windows")).toBeNull();
    expect(vcsIntent("cd C:\\Temp\\x && git commit -m a", "windows")).toBeNull();
    expect(vcsIntent("cd C:\\Windows\\Temp\\probe; git commit -m a", "windows")).toBeNull();
    expect(vcsIntent("cd C:\\Users\\me\\app; git commit -m a", "windows")).toBe("commit");
    expect(vcsIntent("git -C C:\\work\\app commit -m a", "windows")).toBe("commit");
    expect(vcsIntent('git commit -m "Fix `"login`""; gh pr create --fill', "windows")).toBe("both");
    // A script handed to powershell, pwsh or cmd from a POSIX shell.
    expect(vcsIntent("pwsh -Command 'Set-Location C:\\Users\\me\\AppData\\Local\\Temp\\x; git commit -m a'")).toBeNull();
    expect(vcsIntent("cmd /c 'cd C:\\Temp\\x && git commit -m a'")).toBeNull();
    expect(vcsIntent("powershell -Command 'cd C:\\Users\\me\\app; git commit -m a'")).toBe("commit");
    // A POSIX shell still reads an unquoted backslash as an escape: bash would cd to "C:Tempx".
    expect(vcsIntent("cd C:\\Temp\\x && git commit -m a")).toBe("commit");
    expect(vcsIntent("cd 'C:\\Temp\\x' && git commit -m a")).toBeNull();
    expect(vcsIntent("bash -c 'cd /tmp/x && git commit -m a'")).toBeNull();
  });

  test("wrappers before the command are seen through", () => {
    expect(vcsIntent("sudo git commit -m x")).toBe("commit");
    expect(vcsIntent("sudo -u bot -E git commit -m x")).toBe("commit");
    expect(vcsIntent("sudo --user=bot git commit -m x")).toBe("commit");
    expect(vcsIntent("env -i PATH=/usr/bin HOME=/home/u git commit -m x")).toBe("commit");
    expect(vcsIntent("env -u GIT_DIR GIT_AUTHOR_NAME=bot git commit -m x")).toBe("commit");
    expect(vcsIntent("time git commit -m x")).toBe("commit");
    expect(vcsIntent("time -p git commit -m x")).toBe("commit");
    expect(vcsIntent("nice -n 10 git commit -m x")).toBe("commit");
    expect(vcsIntent("nice -5 git commit -m x")).toBe("commit");
    expect(vcsIntent("command git commit -m x")).toBe("commit");
    expect(vcsIntent("sudo env HUSKY=0 nice -n 5 git commit -m x")).toBe("commit");
    expect(vcsIntent("sudo -u bot bash -lc 'git commit -m x'")).toBe("commit");
    expect(vcsIntent("command -v git commit")).toBeNull();
    // A wrapper that changes directory does so for its command only.
    expect(vcsIntent("env -C /tmp/probe git commit -m x")).toBeNull();
    expect(vcsIntent("sudo --chdir=/tmp/probe git commit -m x")).toBeNull();
    expect(vcsIntent("env -C /tmp/probe ls; git commit -m x")).toBe("commit");
  });

  test("gh's global options before pr create", () => {
    expect(vcsIntent("gh -R acme/app pr create --fill")).toBe("pr");
    expect(vcsIntent("gh --repo acme/app pr create --fill")).toBe("pr");
    expect(vcsIntent("gh --repo=acme/app pr create --fill")).toBe("pr");
    expect(vcsIntent("sudo gh -R acme/app pr create --fill")).toBe("pr");
    expect(vcsIntent("gh -R acme/app pr list")).toBeNull();
    expect(vcsIntent("gh -R acme/app pr create --help")).toBeNull();
  });

  test("only the first 64 KB are read", () => {
    expect(vcsIntent(`${"ls; ".repeat(16384)}git commit -m x`)).toBeNull();
    expect(vcsIntent(`${"ls; ".repeat(16000)}git commit -m x`)).toBe("commit");
    expect(vcsIntent([...Array(16384).fill("abc"), "git", "commit"])).toBeNull();
  });

  test("a 64 KB command of any shape is read fast", () => {
    const size = 64 * 1024;
    const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    const shapes = [
      fill("("),
      fill(")"),
      fill("`"),
      fill('"$('),
      fill('x="$(echo "$(cd /tmp/a && git commit -m x)")" '),
      fill("<<EOF\n"),
      fill("cat <<'E'\ngit commit\n"),
      fill("sudo -u "),
      fill("env -C /tmp/x "),
      fill("bash -lc 'cd /tmp; (git commit -m x)'; "),
      fill("pwsh -Command "),
      fill("gh -R "),
      fill("git -C "),
      fill("a\\"),
      fill("# comment\n"),
    ];
    const started = performance.now();
    for (const shape of shapes) vcsIntent(shape);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("vcsCall", () => {
  test("a quiet commit's message, in each form git takes it, first line only", () => {
    expect(vcsCall('git commit -q -m "fix: Keep the session\n\nCo-Authored-By: x"', 2000)).toEqual({ does: "commit", subject: "fix: Keep the session" });
    expect(vcsCall("git commit -qam wip", 2000)).toEqual({ does: "commit", subject: "wip" });
    expect(vcsCall("git commit -mwip", 2000)).toEqual({ does: "commit", subject: "wip" });
    expect(vcsCall("git commit -m=wip", 2000)).toEqual({ does: "commit", subject: "wip" });
    expect(vcsCall("git commit --message='fix: a b'", 2000)).toEqual({ does: "commit", subject: "fix: a b" });
    expect(vcsCall("git commit --message 'fix: a b' && gh pr create --fill", 2000)).toEqual({ does: "both", subject: "fix: a b" });
    expect(vcsCall(["git", "commit", "-m", "feat: from words"], 2000)).toEqual({ does: "commit", subject: "feat: from words" });
  });

  test("a message from a heredoc, through -F - or a substitution", () => {
    const stdin = "git add . && git commit -q -F - <<'EOF'\n\nfeat: Start screen\n\n- Main menu\nEOF\ngit push";
    expect(vcsCall(stdin, 2000)).toEqual({ does: "commit", subject: "feat: Start screen" });
    expect(vcsCall("git commit -F- <<EOF && git push\nfix: one\nEOF", 2000)).toEqual({ does: "commit", subject: "fix: one" });
    const substituted = ["git commit -m \"$(cat <<'EOF'", "fix: The login keeps the session", "", "Body.", "EOF", ')"'].join("\n");
    expect(vcsCall(substituted, 2000)).toEqual({ does: "commit", subject: "fix: The login keeps the session" });
    // A message from a file, or one taken from another commit, is not in the command.
    expect(vcsCall("git commit -F /tmp/msg.txt", 2000)).toBe("commit");
    expect(vcsCall("git commit -C HEAD~1", 2000)).toBe("commit");
    // `-F -` from a pipe: a heredoc further on is no message.
    expect(vcsCall("printf 'x' | git commit -F -\ncat > notes <<EOF\nnot it\nEOF", 2000)).toBe("commit");
  });

  test("the message only when prompt text is kept, cut and redacted", () => {
    expect(vcsCall("git commit -m wip", 0)).toBe("commit");
    expect(vcsCall(`git commit -m "${"a".repeat(50)}"`, 10)).toEqual({ does: "commit", subject: `${"a".repeat(10)}…` });
    const key = `sk-ant-${"x".repeat(30)}`;
    const subject = (vcsCall(`git commit -m "use ${key}"`, 2000) as { subject: string }).subject;
    expect(subject.startsWith("use ")).toBe(true);
    expect(subject).not.toContain(key);
  });

  test("a one-line git log after the commits, and how many commits came before it", () => {
    expect(vcsCall("git commit -qm x && git log --oneline -1", 0)).toEqual({ does: "commit", log: 1 });
    expect(vcsCall("git commit -qm a && git commit -qm b && git push && git log --oneline -5", 0)).toEqual({ does: "commit", log: 2 });
    expect(vcsCall("git commit -qm a && git log --oneline -1 && git commit -qm b", 0)).toEqual({ does: "commit", log: 1 });
    expect(vcsCall("git commit -q -F x; git log -1 --format='%h %s'", 0)).toEqual({ does: "commit", log: 1 });
    expect(vcsCall("git commit -q -F x; git log -1 --pretty=format:'%H %s'", 0)).toEqual({ does: "commit", log: 1 });
    expect(vcsCall("git commit -q -F x; git log -1 --pretty=oneline", 0)).toEqual({ does: "commit", log: 1 });
    expect(vcsCall("git commit -q -F x; git log -1 --format '%h %s'", 0)).toEqual({ does: "commit", log: 1 });
    expect(vcsCall("git commit -q -F x; git show -s --oneline", 0)).toEqual({ does: "commit", log: 1 });
    // A log before the commit, a full log and a show with its diff tell nothing.
    expect(vcsCall("git log --oneline -3 && git commit -q -F x", 0)).toBe("commit");
    expect(vcsCall("git commit -q -F x && git log -1", 0)).toBe("commit");
    expect(vcsCall("git commit -q -F x && git show --oneline", 0)).toBe("commit");
    expect(vcsCall("git commit -q -F x && git log --pretty oneline", 0)).toBe("commit");
    expect(vcsCall("gh pr create --fill", 2000)).toBe("pr");
    expect(vcsCall("echo hi", 2000)).toBeNull();
  });
});

describe("loggedCommits", () => {
  test("the first one-line log entries, each once, without their refs", () => {
    const out = [
      "1791267267095 START /home/u/app",
      "hint: 'git pull' before pushing again.",
      "ce489b1 (HEAD -> main, origin/main) ci: Update the actions",
      "5118d9a feat: Add the dashboard",
      "ce489b1 (HEAD -> main, origin/main) ci: Update the actions",
      `${"f".repeat(40)} chore: full sha`,
    ].join("\r\n");
    expect(loggedCommits(out, 1)).toEqual([{ sha: "ce489b1", subject: "ci: Update the actions" }]);
    expect(loggedCommits(out, 5)).toEqual([
      { sha: "ce489b1", subject: "ci: Update the actions" },
      { sha: "5118d9a", subject: "feat: Add the dashboard" },
      { sha: "f".repeat(40), subject: "chore: full sha" },
    ]);
    expect(loggedCommits("1234567890123 not a sha\n", 1)).toEqual([]);
  });
});

describe("commitsIn", () => {
  test("each commit an output reports, with its branch, sha and subject", () => {
    const out = [
      "[feat/login 1a2b3c4] Keep the session",
      " 2 files changed, 10 insertions(+)",
      "[feat/login 5d6e7f8a9b] Add the test",
      " 1 file changed",
      "[feat/login 1a2b3c4] Keep the session",
    ].join("\r\n");
    expect(commitsIn(out)).toEqual([
      { branch: "feat/login", sha: "1a2b3c4", subject: "Keep the session" },
      { branch: "feat/login", sha: "5d6e7f8a9b", subject: "Add the test" },
    ]);
  });

  test("a root commit and a commit on a detached HEAD", () => {
    expect(commitsIn("[main (root-commit) abcdef0] Initial commit\n")).toEqual([{ branch: "main", sha: "abcdef0", subject: "Initial commit" }]);
    expect(commitsIn("[detached HEAD 0123abc] Rebased fix")).toEqual([{ branch: null, sha: "0123abc", subject: "Rebased fix" }]);
  });

  test("a long branch name is cut to 200 characters", () => {
    const [commit] = commitsIn(`[${"feature/".repeat(100)} 1a2b3c4] Fix it`);
    expect(commit?.branch).toHaveLength(200);
    expect(commit?.branch?.startsWith("feature/feature/")).toBe(true);
  });

  test("output without a commit line gives nothing", () => {
    expect(commitsIn("nothing to commit, working tree clean")).toEqual([]);
    expect(commitsIn("[INFO 1234567 is not hex enough]")).toEqual([]);
    expect(commitsIn(undefined)).toEqual([]);
  });

  test("a 1 MB output is read at its start and end only, and fast", () => {
    const filler = `${"[x".repeat(40)} ${"a".repeat(60)}\n`;
    const middle = filler.repeat(Math.ceil(1_000_000 / filler.length));
    const out = `[main 1111111] First\n${middle}[main 2222222] Hidden\n${middle}[main 3333333] Last\nhttps://github.com/o/r/pull/9\n`;
    expect(out.length).toBeGreaterThan(1_000_000);
    const started = performance.now();
    expect(commitsIn(out).map((c) => c.sha)).toEqual(["1111111", "3333333"]);
    expect(prsIn(out).map((p) => p.number)).toEqual([9]);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("prsIn", () => {
  test("GitHub and GitHub Enterprise pull request links, https only, each once", () => {
    const out = [
      "Creating pull request for feat into main in acme/app",
      "",
      "https://GHE.acme.corp/Platform/app/pull/42",
      "https://GHE.acme.corp/Platform/app/pull/42",
      "see https://github.com/acme/app/pull/7/files",
      "http://github.com/acme/app/pull/8",
      "https://evil@github.com/acme/app/pull/9",
      "https://github.com/../app/pull/10",
      "https://github.com/acme/../pull/11",
      "https://github.com/./app/pull/12",
      "https://github.com/acme/./pull/14",
      "https://github.com/acme/.github/pull/13",
    ].join("\n");
    expect(prsIn(out)).toEqual([
      { repo: "ghe.acme.corp/Platform/app", number: 42, url: "https://ghe.acme.corp/Platform/app/pull/42" },
      { repo: "github.com/acme/app", number: 7, url: "https://github.com/acme/app/pull/7" },
      { repo: "github.com/acme/.github", number: 13, url: "https://github.com/acme/.github/pull/13" },
    ]);
  });
});

describe("nothingToCommit", () => {
  test("a line that starts with git's word for an empty commit, in each UI language", () => {
    expect(nothingToCommit("On branch main\nnothing to commit, working tree clean\n")).toBe(true);
    expect(nothingToCommit("nothing added to commit but untracked files present")).toBe(true);
    expect(nothingToCommit("no changes added to commit (use \"git add\" and/or \"git commit -a\")")).toBe(true);
    expect(nothingToCommit("Auf Branch main\nnichts zu committen, Arbeitsverzeichnis unverändert")).toBe(true);
    expect(nothingToCommit("rien à valider, la copie de travail est propre")).toBe(true);
    expect(nothingToCommit("nada para hacer commit, el árbol de trabajo está limpio")).toBe(true);
    expect(nothingToCommit("Na gałęzi main\nnic do złożenia, drzewo robocze czyste")).toBe(true);
  });

  // Each message as git's own catalogs (de, es, fr, pl) translate "nothing to commit", "nothing added to commit but
  // untracked files present" and "no changes added to commit", hints included.
  test.each([
    ["de", [
      "nichts zu committen",
      "nichts zu committen (benutzen Sie die Option -u, um unversionierte Dateien anzuzeigen)",
      "nichts zum Commit vorgemerkt, aber es gibt unversionierte Dateien",
      "keine Änderungen zum Commit vorgemerkt (benutzen Sie \"git add\" und/oder \"git commit -a\")",
    ]],
    ["es", [
      "nada para hacer commit, el árbol de trabajo está limpio",
      "no hay nada para confirmar (crea/copia archivos y usa \"git add\" para hacerles seguimiento)",
      "no hay nada agregado para confirmar, pero hay archivos sin seguimiento presentes",
      "no hay nada agregado al commit pero hay archivos sin seguimiento presentes (usa \"git add\" para hacerles seguimiento)",
      "no se agregaron cambios al commit",
      "sin cambios agregados al commit (usa \"git add\" y/o \"git commit -a\")",
    ]],
    ["fr", [
      "rien à valider, l'arbre de travail est propre",
      "aucune modification ajoutée à la validation mais des fichiers non suivis sont présents",
      "aucune modification ajoutée à la validation",
      "aucune modification n'a été ajoutée à la validation (utilisez \"git add\" ou \"git commit -a\")",
    ]],
    ["pl", [
      "nic do złożenia (użyj -u, aby pokazać nieśledzone pliki)",
      "nie dodano nic do złożenia, ale są nieśledzone pliki (użyj „git add”, aby śledzić)",
      "brak zmian dodanych do zapisu (użyj „git add” i/lub „git commit -a”)",
    ]],
  ])("git's %s messages", (_language, messages) => {
    for (const message of messages) expect(nothingToCommit(`On branch main\n${message}\n`)).toBe(true);
  });

  test("the words inside other output say nothing", () => {
    expect(nothingToCommit("(pass) a commit with nothing to commit is none")).toBe(false);
    expect(nothingToCommit("")).toBe(false);
    expect(nothingToCommit(undefined)).toBe(false);
  });
});

describe("emitGitEvents", () => {
  const call = { provider: "codex" as const, sessionId: "codex:t", ts: 1, project: "/work/app", agent: "main", branch: "dev", callId: "codex:t:c1" };
  const emitted = (intent: VcsIntent, output: unknown, textLimit = 2000) => {
    const events: GitEventRecord[] = [];
    const sink: IngestSink = { session() {}, prompt() {}, usage() {}, tool() {}, gitEvent: (e) => events.push(e) };
    emitGitEvents(sink, intent, output, call, textLimit);
    return events;
  };

  test("each commit an output names, on its own branch, the subject only with prompt text", () => {
    expect(emitted("commit", "[feat/x 1a2b3c4] Fix it\n[detached HEAD 5d6e7f8] Rebased\n")).toEqual([
      { ...call, kind: "commit", branch: "feat/x", sha: "1a2b3c4", subject: "Fix it" },
      { ...call, kind: "commit", branch: "dev", sha: "5d6e7f8", subject: "Rebased" },
    ]);
    expect(emitted("commit", "[feat/x 1a2b3c4] Fix it", 0)[0]?.subject).toBeNull();
  });

  test("a quiet commit is one, keyed by its call, unless there was nothing to commit", () => {
    expect(emitted("commit", "")).toEqual([{ ...call, kind: "commit" }]);
    expect(emitted("commit", "1a2b3c4 Fix it\n")).toEqual([{ ...call, kind: "commit" }]);
    expect(emitted("commit", "On branch dev\nnothing to commit, working tree clean\n")).toEqual([]);
    expect(emitted("commit", "nic do złożenia, drzewo robocze czyste")).toEqual([]);
  });

  test("a quiet commit takes its sha and subject from the git log after it, else the command's message", () => {
    const out = "hint: see git push --help\nce489b1 ci: Update the actions\nce489b1 ci: Update the actions\n";
    expect(emitted({ does: "commit", log: 1, subject: "ci: Update" }, out)).toEqual([
      { ...call, kind: "commit", sha: "ce489b1", subject: "ci: Update the actions" },
    ]);
    expect(emitted({ does: "commit", log: 1 }, out, 0)).toEqual([{ ...call, kind: "commit", sha: "ce489b1", subject: null }]);
    expect(emitted({ does: "commit", log: 2 }, "f018386 ci: second\n5118d9a feat: first\n0ee7a6d chore: older\n").map((e) => e.sha)).toEqual(["f018386", "5118d9a"]);
    // No log line in the output: one commit keyed by its call, with the message the command gave it.
    expect(emitted({ does: "commit", log: 1, subject: "fix: Keep it" }, "")).toEqual([{ ...call, kind: "commit", subject: "fix: Keep it" }]);
    expect(emitted({ does: "commit", subject: "fix: Keep it" }, "", 0)).toEqual([{ ...call, kind: "commit" }]);
    // Nothing to commit: the log shows an older commit, which is none of this call's.
    expect(emitted({ does: "commit", log: 1 }, "nothing to commit, working tree clean\nce489b1 ci: older\n")).toEqual([]);
    // A `[branch sha]` line still wins.
    expect(emitted({ does: "commit", log: 1 }, "[main 1a2b3c4] Fix it\n1a2b3c4 Fix it\n").map((e) => [e.sha, e.branch])).toEqual([["1a2b3c4", "main"]]);
  });

  test("a command that commits and opens a PR gives both, a quiet commit without a URL only the commit", () => {
    const output = "[feat/x 1a2b3c4] Fix it\nTo github.com:acme/app.git\nhttps://github.com/acme/app/pull/42\n";
    expect(emitted("both", output).map((e) => [e.kind, e.sha ?? null, e.url ?? null])).toEqual([
      ["commit", "1a2b3c4", null],
      ["pr", null, "https://github.com/acme/app/pull/42"],
    ]);
    expect(emitted("both", "").map((e) => [e.kind, e.callId])).toEqual([["commit", "codex:t:c1"]]);
    // Each intent reads only its own part of the output.
    expect(emitted("commit", output).map((e) => e.kind)).toEqual(["commit"]);
    expect(emitted("pr", output).map((e) => e.kind)).toEqual(["pr"]);
  });

  test("a PR is known only by its URL", () => {
    expect(emitted("pr", "https://github.com/acme/app/pull/42\n")).toEqual([
      { ...call, kind: "pr", repo: "github.com/acme/app", number: 42, url: "https://github.com/acme/app/pull/42" },
    ]);
    expect(emitted("pr", "Opening https://github.com/acme/app/compare/main...feat in your browser.\n")).toEqual([]);
    expect(emitted("pr", "")).toEqual([]);
  });
});
