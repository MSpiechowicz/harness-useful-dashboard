import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getMeta, setMeta } from "./db.ts";
import { appDataDir } from "./paths.ts";
import { BATCH_SIZE, buildPrompt, type LabelConfig, labelInputs, labelQueue, noteAttempts, parseLabels, saveLabels, SYSTEM_PROMPT, tagLabelerSessions } from "./labels.ts";

/**
 * Runs the user's own `claude` or `codex` to label sessions (labels.ts), with their login and only after they turned it
 * on. A batch of sessions is one call: the prompt goes in on stdin, the CLI is started without a shell and with no tools
 * where it lets that be asked for, in a folder of its own, and it has two minutes. Failures carry fixed codes only, never
 * the CLI's output, and back the next try off. A daily cap bounds what is sent.
 */

export type LabelCode = "not-installed" | "not-signed-in" | "timeout" | "bad-output" | "failed";

/** What Settings shows. Kept in the meta table per host, so a restart doesn't ask again early or forget today's count. */
export interface LabelState {
  /** The last run that went through, epoch ms. */
  ranAt: number | null;
  /** The last try, epoch ms. */
  triedAt: number | null;
  /** Labelled and left unlabelled by the last run. */
  labelled: number;
  failed: number;
  /** All sessions labelled on this machine. */
  total: number;
  code: LabelCode | null;
  /** Not run again by itself before this, epoch ms. */
  nextAt: number | null;
  failures: number;
  /** The local day the count below is for, and how many sessions were sent in it. */
  day: string;
  sent: number;
}

/** What an invocation of the CLI gave. */
export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type CliRunner = (cmd: string[], opts: { stdin: string; cwd: string; env: Record<string, string | undefined>; timeoutMs: number }) => Promise<CliResult>;

export interface LabelerDeps {
  now?: () => number;
  /** Where a program is on PATH, null when it isn't. */
  which?: (name: string) => string | null;
  run?: CliRunner;
  /** The labeler's folder. Default: <app data>/labeler. */
  dir?: string;
  env?: Record<string, string | undefined>;
}

/** What the CLIs say when there is no login. */
const SIGNED_OUT = /not (?:logged|signed) in|please (?:log|sign) ?in|\/login|unauthori[sz]ed|authentication|api key/i;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The least time between two background runs. */
export const RUN_EVERY_MS = 30 * MINUTE;
const CLI_TIMEOUT_MS = 120_000;
const MAX_BACKOFF_MS = 6 * HOUR;
/** Label now asks again only once the last try is a minute old. */
const FORCE_AFTER_MS = MINUTE;
/** The environment variable every run carries, for hooks and wrappers that want to tell it apart. */
export const LABELER_ENV = "HARNESS_DASHBOARD_LABELER";

export const labelerDir = () => join(appDataDir(), "labeler");

const metaKey = (host: string) => `labeler:${host}`;
const localDay = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function labelState(db: Database, host: string, now = Date.now()): LabelState {
  const empty: LabelState = { ranAt: null, triedAt: null, labelled: 0, failed: 0, total: 0, code: null, nextAt: null, failures: 0, day: localDay(now), sent: 0 };
  try {
    const raw = getMeta(db, metaKey(host));
    const s = raw ? { ...empty, ...(JSON.parse(raw) as Partial<LabelState>) } : empty;
    // Today's count starts at zero with the day.
    return s.day === localDay(now) ? s : { ...s, day: localDay(now), sent: 0 };
  } catch {
    return empty;
  }
}

/** How many more sessions may be sent today. */
export const remainingToday = (s: LabelState, cap: number) => Math.max(0, cap - s.sent);

/** The command that runs a CLI for one batch, without a shell. The prompt is not in it: it goes in on stdin. */
export function cliCommand(cli: LabelConfig["cli"], exe: string, model: string, lastMessage: string): string[] {
  if (cli === "claude") {
    // -p prints the answer and exits. No tools at all, no skills, no MCP servers, nothing saved to disk, and the
    // standing instructions replace the long default system prompt, which is most of what a call would cost.
    return [exe, "-p", "--output-format", "json", "--model", model || "haiku", "--tools", "", "--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config", "--system-prompt", SYSTEM_PROMPT];
  }
  // exec runs non-interactively. Codex can't be started without its shell tool, so it gets a read-only sandbox in an
  // empty folder and is never asked for approval. The user's config is left out (its MCP servers would start with every
  // call): the login still comes from CODEX_HOME. The prompt is read from stdin ("-").
  return [exe, "exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "-s", "read-only", "-c", 'approval_policy="never"', ...(model ? ["-m", model] : []), "--output-last-message", lastMessage, "-"];
}

/** The model's answer out of what the CLI printed. Null when there is none. */
function answerOf(cli: LabelConfig["cli"], stdout: string, lastMessage: string): { text: string } | { signedOut: true } | null {
  if (cli === "codex") {
    try {
      return { text: readFileSync(lastMessage, "utf8") };
    } catch {
      return null;
    }
  }
  try {
    const out = JSON.parse(stdout) as { is_error?: unknown; result?: unknown };
    if (typeof out.result !== "string") return null;
    if (out.is_error === true) return SIGNED_OUT.test(out.result) ? { signedOut: true } : null;
    return { text: out.result };
  } catch {
    return null;
  }
}

async function spawnCli(cmd: string[], opts: { stdin: string; cwd: string; env: Record<string, string | undefined>; timeoutMs: number }): Promise<CliResult> {
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  } catch {
    return { code: null, stdout: "", stderr: "", timedOut: false };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs);
  try {
    proc.stdin.write(opts.stdin);
    await proc.stdin.end();
  } catch {
    /* the CLI exited before reading: its exit code says why */
  }
  const read = async (s: ReadableStream) => (await new Response(s).text()).slice(0, 1_000_000);
  const [stdout, stderr, code] = await Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
}

export interface LabelRun extends LabelState {
  /** Why nothing was run, when nothing was: "disabled", "no-prompts", "backoff", "cap", "none" (nothing to label). */
  skipped: "disabled" | "no-prompts" | "backoff" | "cap" | "none" | null;
}

/**
 * Labels sessions: the queue (labels.ts labelQueue) up to the day's cap, or `ids` (a regenerate asked for by hand, which
 * the cap doesn't hold back but counts). Does nothing and spawns nothing while the feature is off or prompt text isn't
 * stored. `force` (Label now) ignores the wait between runs and a backoff, not the cap.
 */
export async function labelSessions(
  db: Database,
  host: string,
  cfg: { labels: LabelConfig; promptTextLimit: number },
  opts: { force?: boolean; ids?: string[] } = {},
  deps: LabelerDeps = {},
): Promise<LabelRun> {
  const now = (deps.now ?? Date.now)();
  const which = deps.which ?? ((n: string) => Bun.which(n));
  const run = deps.run ?? spawnCli;
  const dir = deps.dir ?? labelerDir();
  const state = labelState(db, host, now);
  const skip = (skipped: LabelRun["skipped"]): LabelRun => ({ ...state, skipped });
  const l = cfg.labels;
  if (!l.enabled) return skip("disabled");
  // Without stored prompts there is nothing to base a label on, and nothing is sent.
  if (cfg.promptTextLimit <= 0) return skip("no-prompts");
  if (!opts.ids) {
    const waiting = state.nextAt != null && now < state.nextAt;
    const recent = state.triedAt != null && now - state.triedAt < FORCE_AFTER_MS;
    if (opts.force ? recent : waiting) return skip("backoff");
  }

  const save = (next: LabelState) => {
    setMeta(db, metaKey(host), JSON.stringify(next));
    return next;
  };
  const fail = (code: LabelCode, labelled: number, failed: number, sent: number): LabelRun => {
    const failures = state.failures + 1;
    // Nothing was sent without a program or a login: looking again is cheap, but not every few minutes.
    const wait = code === "not-installed" || code === "not-signed-in" ? RUN_EVERY_MS : Math.min(MAX_BACKOFF_MS, RUN_EVERY_MS * 2 ** (failures - 1));
    if (code !== state.code) console.error(`[labels] failed: ${code}`);
    const next = save({ ...state, triedAt: now, code, nextAt: now + wait, failures, labelled, failed, total: state.total + labelled, sent });
    return { ...next, skipped: null };
  };

  const exe = which(l.cli);
  if (!exe) return fail("not-installed", 0, 0, state.sent);

  const ids = opts.ids ?? labelQueue(db, dir, remainingToday(state, l.dailyCap), now);
  if (!ids.length) return opts.ids ? skip("none") : skip(remainingToday(state, l.dailyCap) <= 0 ? "cap" : "none");

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const env = { ...(deps.env ?? process.env), [LABELER_ENV]: "1" };
  let labelled = 0;
  let failed = 0;
  let sent = state.sent;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const lastMessage = join(dir, `last-${process.pid}-${i}.txt`);
    const prompt = buildPrompt(labelInputs(db, batch));
    sent += batch.length;
    const res = await run(cliCommand(l.cli, exe, l.model, lastMessage), { stdin: prompt, cwd: dir, env, timeoutMs: CLI_TIMEOUT_MS });
    const answer = res.timedOut || res.code !== 0 ? null : answerOf(l.cli, res.stdout, lastMessage);
    rmSync(lastMessage, { force: true });
    if (res.timedOut) return finish(fail("timeout", labelled, failed, sent));
    if (res.code === null) return finish(fail("failed", labelled, failed, sent));
    if (res.code !== 0 || !answer) {
      // Claude Code says in its JSON when it isn't signed in, Codex only in what it prints on stderr.
      const signedOut = (answer && "signedOut" in answer) || SIGNED_OUT.test(res.stderr + (l.cli === "claude" ? res.stdout.slice(0, 2000) : ""));
      return finish(fail(res.code !== 0 && signedOut ? "not-signed-in" : res.code !== 0 ? "failed" : "bad-output", labelled, failed, sent));
    }
    if ("signedOut" in answer) return finish(fail("not-signed-in", labelled, failed, sent));
    const parsed = parseLabels(answer.text, batch.length);
    if (!parsed) return finish(fail("bad-output", labelled, failed, sent));
    saveLabels(db, parsed.map((p) => ({ id: batch[p.n - 1]!, title: p.title, kind: p.kind })), l.model || (l.cli === "claude" ? "haiku" : "default"), now);
    const got = new Set(parsed.map((p) => p.n));
    noteAttempts(db, batch.filter((_, k) => !got.has(k + 1)));
    labelled += parsed.length;
    failed += batch.length - parsed.length;
  }
  return finish({ ...save({ ...state, ranAt: now, triedAt: now, labelled, failed, total: state.total + labelled, code: null, nextAt: now + RUN_EVERY_MS, failures: 0, sent }), skipped: null });

  /** Every way out: the labeler's own sessions are tagged, in case a scan already read them. */
  function finish(r: LabelRun): LabelRun {
    tagLabelerSessions(db, dir);
    return r;
  }
}
