#!/usr/bin/env bun
import { Console as NodeConsole } from "node:console";
import { readFileSync, writeSync } from "node:fs";
import { configPath, ensureAppDataDir } from "./core/paths.ts";
import { type AlertLang, message } from "./core/budgets.ts";
import { configKeyPatch, loadConfig, resolveDbPath, updateConfig } from "./core/config.ts";
import { NewerSchemaError, openDb } from "./core/db.ts";
import { scan } from "./core/ingest/index.ts";
import { fallbackLine, gather, parseInput, render, useColor } from "./core/statusline.ts";
import { REPORT_COMMANDS, type ReportCommand, runReport } from "./core/reportCli.ts";
import { runDigest } from "./core/digest.ts";
import { InputError } from "./core/reports.ts";
import { importCursorCsv } from "./core/ingest/cursor.ts";
import { McpServer, serveStream } from "./mcp/server.ts";
import { createTools } from "./mcp/tools.ts";
import { DbWriter } from "./core/ingest/writer.ts";
import { localIdentity } from "./core/paths.ts";
import { PriceBook } from "./core/pricing.ts";
import { App } from "./server/app.ts";
import { loadToken, probeDashboard, signInUrl } from "./server/auth.ts";
import { createHandler, loadAssets } from "./server/http.ts";
import { IngestServer } from "./server/ingest.ts";
import { IngestAuth, IngestAuthUnreadable } from "./server/ingestAuth.ts";
import { checkForUpdate } from "./server/update.ts";
import { BIN_NAME, REPO, VERSION } from "./version.ts";

const HELP = `${BIN_NAME} ${VERSION} — token usage dashboard for Claude Code, Codex and Cursor

Usage:
  ${BIN_NAME} [serve] [options]      Start the dashboard server and print its sign-in link (default)
  ${BIN_NAME} scan [--full]          Ingest new usage from local logs and exit
  ${BIN_NAME} import-cursor <file>   Import a Cursor usage CSV export
  ${BIN_NAME} today                  Today's cost, tokens and sessions against yesterday
  ${BIN_NAME} report [options]       Cost by project, model, provider, user, tag, kind, day, week or month
  ${BIN_NAME} limits [--check]       Plan limits and budgets, with exit codes for scripts
  ${BIN_NAME} digest [options]       The last week as a Markdown report: cost, projects, budgets, limits, tips
  ${BIN_NAME} statusline             Print one status line for Claude Code (reads its JSON on stdin)
  ${BIN_NAME} mcp                    Serve usage data to AI agents over MCP (stdio, read-only)
  ${BIN_NAME} update [--check]       Show whether a newer release is out
  ${BIN_NAME} config [path|get|set <key> <value>]
  ${BIN_NAME} ingest token add <label>   A token remote agents send usage with over OTLP, printed once
  ${BIN_NAME} ingest token list|revoke <id>
  ${BIN_NAME} ingest basic <user>        Basic auth for the OTLP listener, the password read from stdin
  ${BIN_NAME} ingest basic --clear
  ${BIN_NAME} version

Options:
  --db <path>       Use this SQLite file (e.g. on iCloud Drive / a network share)
  --port <n>        Port to listen on (default 4317)

Statusline options:
  --format <tpl>    Line template (default "{model} · {session} · {today} · {limit}")
                    Placeholders: {model} {session} {today} {limit}
  --no-color        Plain text (NO_COLOR is honored too)

Digest options:
  --week <w>        last (the previous Monday to Sunday, default) or this (the last 7 days up to now)
  --out <file>      Write the Markdown to a file instead of printing it
  --json            The numbers as JSON

Report options (today, report, limits):
  --range <r>       today, 7d, 30d, month or all (report default 30d)
  --from <date>     Start day, YYYY-MM-DD in local time (with --to, instead of --range)
  --to <date>       Last day, included
  --by <what>       project, model, provider, user, tag, kind, day, week or month (default project)
  --provider, --project, --model, --user, --tag, --kind <value>   Only this harness, project, model, user, session tag or kind of work
                    With --by tag a session with several tags counts in each, so rows can exceed the total
                    Kinds of work (feature, bugfix, …) exist once AI session labels are on in Settings
  --json, --csv     Machine-readable output (CSV for report only)
  --limit <n>       Rows in the report table (default 25, 0 for all)
  --scan            Scan the local logs first (writes the database)
  --check           limits: exit 0 below --warn, 10 at or above it, 11 at 100%, 2 with no fresh reading
  --warn <pct>      limits: the warning threshold for limits and budgets (default 80)
  Numbers are as fresh as the last scan. Exit code 2 means bad options or no database.
`;

/** What a command that would write the database says when a newer app migrated it, and one that would read it too. */
const NEWER_DATABASE = "This database was upgraded by a newer version of Harness Dashboard. Update the app.";

/** An error as the terminal shows it: a newer database gets a plain instruction instead of schema numbers. */
function errorText(err: unknown): string {
  return err instanceof NewerSchemaError ? NEWER_DATABASE : (err as Error).message;
}

interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that take a value: `--db x` as well as `--db=x`. */
const VALUE_FLAGS = ["db", "port", "format", "range", "from", "to", "by", "provider", "project", "model", "user", "warn", "limit", "week", "out"];

export function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (v !== undefined) flags[k] = v;
      else if (VALUE_FLAGS.includes(k) && argv[i + 1] && !argv[i + 1]!.startsWith("--")) flags[k] = argv[++i]!;
      else flags[k] = true;
    } else if (a === "-h") flags.help = true;
    else if (a === "-v") flags.version = true;
    else positional.push(a);
  }
  const cmd = positional.shift() ?? "serve";
  return { cmd, positional, flags };
}

/**
 * Asks the dashboard on `port` to quit and waits up to 5 s for the port to be free. Only for one probeDashboard vouched
 * for: the request carries the token.
 */
async function stopRunning(port: number, token: string): Promise<void> {
  const headers = { Authorization: `Bearer ${token}`, "X-Harness-Dashboard": "1" };
  await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST", headers, signal: AbortSignal.timeout(2000) }).catch(() => {});

  for (let i = 0; i < 50 && !(await portFree(port)); i++) await Bun.sleep(100);
}

/** Nothing accepts a connection on the port: a server can bind it. */
async function portFree(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    socket.end();
    return false;
  } catch {
    return true;
  }
}

/**
 * A line for the app shell, which runs this as `serve --shell` and reads its stdout (the contract is in
 * src-tauri/src/sidecar.rs). Written straight to the file descriptor, so the shell has it at once. In shell mode these
 * are the only lines on stdout: everything else goes to stderr.
 *
 *   HARNESS_DASHBOARD_LANG <en|de|es|fr|pl>   first, the language for the shell's own error text
 *   HARNESS_DASHBOARD_READY <sign-in link>     this process serves the dashboard and keeps running
 *   HARNESS_DASHBOARD_ERROR <text>             the dashboard can't start, this process exits non-zero
 */
function shellLine(kind: "LANG" | "READY" | "ERROR", value: string): void {
  writeSync(1, `HARNESS_DASHBOARD_${kind} ${value.replace(/\s+/g, " ").trim()}\n`);
}

/** The port is taken. `silent` when what holds it did not answer the probe: it may be a dashboard too busy to answer. */
class PortTaken extends Error {
  constructor(
    readonly port: number,
    readonly silent: boolean,
  ) {
    super(`port ${port} is in use`);
  }
}

/** What the user reads when the dashboard can't start, in their language. */
function startErrorText(err: unknown, lang: AlertLang): string {
  if (err instanceof PortTaken) return message(lang, err.silent ? "portSilent" : "portInUse", { port: String(err.port) });

  return message(lang, "startFailed", { error: errorText(err) });
}

/** A console whose every method writes to stderr, Bun's console.write too. */
function stderrConsole(): Console {
  const out = new NodeConsole({ stdout: process.stderr, stderr: process.stderr });
  const write = (...data: Array<string | ArrayBufferView | ArrayBuffer>): number => {
    let bytes = 0;
    for (const chunk of data) {
      if (typeof chunk === "string") bytes += writeSync(2, chunk);
      else if (chunk instanceof ArrayBuffer) bytes += writeSync(2, new Uint8Array(chunk));
      else bytes += writeSync(2, new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
    return bytes;
  };
  return Object.assign(out, { write });
}

/** Bun.serve's error when the port is taken. */
function portInUse(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  return e?.code === "EADDRINUSE" || /EADDRINUSE|address already in use/i.test(String(e?.message ?? ""));
}

/**
 * The dashboard server. On its own it runs headless and prints the sign-in link. Run by the app shell (--shell) it
 * talks to the shell in the lines above, replaces a dashboard of this install already running on the port, and quits
 * when the shell closes its stdin.
 */
async function serve(args: Args): Promise<void> {
  const shell = args.flags.shell === true;
  // stdout carries the shell's lines only: the server's own output (the banner, scans, the app's logs) goes to stderr,
  // whichever console method writes it.
  if (shell) globalThis.console = stderrConsole();

  const cfg = loadConfig();
  if (shell) shellLine("LANG", cfg.language);

  const port = Number(args.flags.port ?? cfg.port) || 4317;

  try {
    await startServer(args, port, shell);
  } catch (err) {
    if (!shell) throw err instanceof PortTaken ? new Error(startErrorText(err, "en")) : err;

    shellLine("ERROR", startErrorText(err, cfg.language));
    process.exit(1);
  }
}

async function startServer(args: Args, port: number, shell: boolean): Promise<void> {
  // Single instance: a dashboard of this install already on the port is used instead of a second one, and the app
  // shell, which always owns its server, replaces it (any version, after an update too). The token goes only to a
  // server that proved it holds it: another account may hold the port to catch it. Anything else there makes the
  // start below fail with the port in use. Links point at 127.0.0.1, where the server listens: localhost may resolve to
  // ::1 first, where another account could listen on the same port and catch the token.
  const token = loadToken();
  const probe = await probeDashboard(port, token);
  if (probe.state === "ours" && shell) {
    console.log(`Stopping the dashboard ${probe.version} on port ${port}`);
    await stopRunning(port, token);
  } else if (probe.state === "ours") {
    console.log(`Dashboard already running at http://127.0.0.1:${port}`);
    console.log(`  open: ${signInUrl(`http://127.0.0.1:${port}`, token)}`);
    return;
  }

  const app = new App(typeof args.flags.db === "string" ? args.flags.db : undefined);
  // The OTLP listener for remote agents: a server of its own, started once the dashboard's has its port. Its status is
  // logged each time it changes: when it starts, fails, or binds on a later try.
  const ingest = new IngestServer({
    app,
    auth: new IngestAuth(),
    onStatus: (s) => {
      if (s.state === "listening") console.log(`  ingest: listening on ${s.address}`);
      else if (s.state === "error") console.log(`  ingest: not listening (${s.error}${s.message ? `: ${s.message}` : ""})`);
    },
  });
  let server: ReturnType<typeof Bun.serve>;
  const shutdown = () => {
    ingest.stop();
    server.stop(true);
    app.close();
    process.exit(0);
  };

  try {
    const assets = await loadAssets();
    const handler = createHandler(app, assets, { shutdown, ingest }, { token, port, shell });
    server = Bun.serve({ port, hostname: "127.0.0.1", idleTimeout: 60, fetch: handler });
  } catch (err) {
    app.close();
    throw portInUse(err) ? new PortTaken(port, probe.state === "silent") : err;
  }

  const url = `http://127.0.0.1:${server.port}`;
  console.log(`${BIN_NAME} ${VERSION}`);
  console.log(`  database: ${app.dbPath}`);
  if (app.readOnly) console.log(`  read-only: ${NEWER_DATABASE}`);
  console.log(`  listening: ${url}`);
  // The API only answers a browser that came through this link. The shell gets it on its own line and never logs it.
  if (shell) shellLine("READY", signInUrl(url, token));
  else console.log(`  open: ${signInUrl(url, token)}`);

  // Never fatal: a listener that can't start says why here and in Settings, and follows every settings change.
  const listen = (cfg: typeof app.cfg) => void ingest.reconcile(cfg, server.port ?? port);
  listen(app.cfg);
  app.onConfigChange(listen);

  const first = app.scanNow();
  first
    .then((r) => console.log(`  scanned ${r.filesSeen} files (${r.filesParsed} changed, +${r.usageRows} usage rows) in ${r.durationMs} ms`))
    .catch((err) => console.error("[scan]", err));
  app.startBackgroundScan();

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The shell keeps stdin open while it runs: the end of it means the shell is gone or quitting.
  if (shell) void drain(Bun.stdin.stream()).then(shutdown, shutdown);
}

/** Reads a stream to its end. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    /* nothing to read: only the end matters */
  }
}

/** Reads stdin, or nothing when it is a terminal or does not finish within `ms`. */
async function readStdin(ms: number): Promise<string> {
  if (process.stdin.isTTY) return "";
  return Promise.race([Bun.stdin.text(), Bun.sleep(ms).then(() => "")]).catch(() => "");
}

/** Claude Code's status line: one line on stdout, always exit 0. Reads the database only, never scans. */
async function statusline(args: Args, dbFlag: string | undefined): Promise<void> {
  let model: string | null = null;
  try {
    const input = parseInput(await readStdin(1000));
    model = input.model;
    const cfg = loadConfig();
    const now = Date.now();
    let db: ReturnType<typeof openDb> | null = null;
    try {
      db = openDb(resolveDbPath(cfg, dbFlag).path, { readonly: true });
      db.exec("PRAGMA busy_timeout = 300");
    } catch {
      db = null; // no database yet: show what stdin knows
    }
    const data = gather(db, input, { user: cfg.userName || localIdentity().user, host: localIdentity().host, now });
    db?.close();
    const format = typeof args.flags.format === "string" ? args.flags.format : undefined;
    console.log(render(data, { format, color: useColor(args.flags["no-color"] === true, process.env), now }));
  } catch {
    console.log(fallbackLine(model));
  }
  process.exit(0);
}

/**
 * The MCP server: an agent's client starts it and talks JSON-RPC over stdin and stdout until it closes stdin. Reads the
 * database only, never scans and never asks the network.
 */
async function mcp(dbFlag: string | undefined): Promise<void> {
  // stdout carries protocol messages only: anything else printed by mistake goes to stderr.
  console.log = console.info = console.error;
  const cfg = loadConfig();
  const { user, host } = localIdentity();
  const { tools, close } = createTools({ dbPath: resolveDbPath(cfg, dbFlag).path, budgets: cfg.budgets, user: cfg.userName || user, host, cwd: process.cwd(), env: process.env });
  const server = new McpServer(
    tools,
    { name: BIN_NAME, title: "Harness Dashboard", version: VERSION },
    "Read-only token usage and API-equivalent cost (USD) of the AI coding agents on this machine, from the Harness Dashboard database. Times are ISO 8601.",
  );
  await serveStream(server, Bun.stdin.stream(), (line) => void process.stdout.write(line));
  close();
}

/** One incremental (or full) scan into the database, as `scan` runs it. */
async function runScan(dbFlag: string | undefined, full: boolean) {
  const cfg = loadConfig();
  const { path, isDefault } = resolveDbPath(cfg, dbFlag);
  const db = openDb(path, { journalMode: cfg.journalMode, isDefaultPath: isDefault });
  try {
    return await scan(db, cfg, { user: cfg.userName || localIdentity().user, host: localIdentity().host }, { full });
  } finally {
    db.close();
  }
}

/**
 * `today`, `report` and `limits`: tables for a terminal, JSON or CSV for scripts. They read the database only, unless
 * --scan asks for a scan first. Bad options and a missing database exit with 2, and nothing is created.
 */
async function report(cmd: ReportCommand, args: Args, dbFlag: string | undefined): Promise<void> {
  try {
    if (args.flags.scan === true) {
      ensureAppDataDir();
      const r = await runScan(dbFlag, false);
      console.error(`Scanned ${r.filesSeen} files (${r.filesParsed} changed, +${r.usageRows} usage rows) in ${r.durationMs} ms`);
    }
    const cfg = loadConfig();
    const { user, host } = localIdentity();
    const { out, code } = runReport(cmd, args.flags, {
      dbPath: resolveDbPath(cfg, dbFlag).path, budgets: cfg.budgets, user: cfg.userName || user, host, now: Date.now(), env: process.env, isTTY: process.stdout.isTTY === true,
    });
    process.stdout.write(out);
    process.exitCode = code;
  } catch (err) {
    console.error(`error: ${errorText(err)}`);
    process.exitCode = err instanceof InputError ? 2 : 1;
  }
}

/** `digest`: a week's Markdown report from the database, printed or written to a file. Writes nothing else. */
function digest(args: Args, dbFlag: string | undefined): void {
  try {
    const cfg = loadConfig();
    const { user, host } = localIdentity();
    const { out, wrote } = runDigest(args.flags, {
      dbPath: resolveDbPath(cfg, dbFlag).path, budgets: cfg.budgets, hiddenTips: cfg.tips.hidden, lang: cfg.language, user: cfg.userName || user, host, now: Date.now(),
    });
    if (wrote) console.error(`Wrote ${wrote}`);
    else process.stdout.write(out);
  } catch (err) {
    console.error(`error: ${errorText(err)}`);
    process.exitCode = err instanceof InputError ? 2 : 1;
  }
}

/**
 * `ingest`: who may send usage to the OTLP listener. Edits the same file Settings does, which a running dashboard reads
 * again on the next request. A file that can't be read is never written over: the error says where it is and what to do.
 */
async function ingestCommand(args: Args): Promise<void> {
  const auth = new IngestAuth();
  try {
    const broken = auth.readError();
    if (broken) throw new IngestAuthUnreadable(auth.path, broken);
    await ingestChange(auth, args);
  } catch (err) {
    if (!(err instanceof IngestAuthUnreadable)) throw err;
    throw new Error(`can't read ${err.path} (${err.reason}). Repair it, or delete it to start over without tokens and basic auth.`);
  }
}

async function ingestChange(auth: IngestAuth, args: Args): Promise<void> {
  const [what, sub, ...rest] = args.positional;

  if (what === "token" && sub === "add") {
    const made = auth.addToken(rest.join(" "));
    if ("error" in made) throw new Error(made.error);
    console.log(made.token);
    console.error("Shown this once: copy it now. A remote agent sends it as OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>");
    return;
  }

  if (what === "token" && sub === "list") {
    const tokens = auth.tokens();
    if (!tokens.length) return void console.log("No tokens.");
    const day = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "never");
    for (const t of tokens) console.log(`${t.id}  ${t.prefix}…  created ${day(t.createdAt)}  last used ${day(t.lastUsedAt)}  ${t.label}`);
    return;
  }

  if (what === "token" && sub === "revoke") {
    if (!rest[0]) throw new Error("usage: ingest token revoke <id>");
    if (!auth.revokeToken(rest[0])) throw new Error(`no token with the id ${rest[0]}`);
    return void console.log(`Revoked ${rest[0]}.`);
  }

  if (what === "basic" && args.flags.clear === true) {
    auth.clearBasic();
    return void console.log("Basic auth cleared.");
  }

  if (what === "basic" && sub) {
    // Bun has no prompt that hides what is typed: the password comes through a pipe, never as an argument.
    if (process.stdin.isTTY) throw new Error(`the password is read from stdin: printf '%s' "$PASSWORD" | ${BIN_NAME} ingest basic ${sub}`);
    const password = (await Bun.stdin.text()).replace(/\r?\n$/, "");
    const set = await auth.setBasic(sub, password);
    if ("error" in set) throw new Error(set.error);
    return void console.log(`Basic auth set for ${set.user}.`);
  }

  throw new Error("usage: ingest token add <label> | ingest token list | ingest token revoke <id> | ingest basic <user> | ingest basic --clear");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.help || args.cmd === "help") return void console.log(HELP);
  if (args.flags.version || args.cmd === "version") return void console.log(VERSION);
  // Before anything that can fail: the status line always prints a line and exits 0.
  if (args.cmd === "statusline") return statusline(args, typeof args.flags.db === "string" ? args.flags.db : undefined);
  // Read-only as well: no app data folder is created for it.
  if (args.cmd === "mcp") return mcp(typeof args.flags.db === "string" ? args.flags.db : undefined);
  if (args.cmd === "digest") return digest(args, typeof args.flags.db === "string" ? args.flags.db : undefined);
  // Reports read the database only: no app data folder either, unless --scan writes one.
  if ((REPORT_COMMANDS as readonly string[]).includes(args.cmd)) return report(args.cmd as ReportCommand, args, typeof args.flags.db === "string" ? args.flags.db : undefined);
  ensureAppDataDir();

  const dbFlag = typeof args.flags.db === "string" ? args.flags.db : undefined;
  switch (args.cmd) {
    case "serve":
    case "start":
      return serve(args);

    case "scan": {
      const r = await runScan(dbFlag, args.flags.full === true);
      console.log(`Scanned ${r.filesSeen} files (${r.filesParsed} parsed) in ${r.durationMs} ms → ${r.usageRows} usage rows, ${r.prompts} prompts, ${r.tools} tool calls`);
      for (const e of r.errors) console.warn(`  ! ${e.path}: ${e.error}`);
      return;
    }

    case "import-cursor": {
      const file = args.positional[0];
      if (!file) throw new Error("usage: import-cursor <file.csv>");
      const cfg = loadConfig();
      const { path, isDefault } = resolveDbPath(cfg, dbFlag);
      const db = openDb(path, { journalMode: cfg.journalMode, isDefaultPath: isDefault });
      const writer = new DbWriter(db, PriceBook.fromDb(db), { user: cfg.userName || localIdentity().user, host: localIdentity().host });
      let result;
      db.transaction(() => {
        result = importCursorCsv(readFileSync(file, "utf8"), writer);
      })();
      console.log(result);
      db.close();
      return;
    }

    case "update": {
      // Reports only: the Harness Dashboard app installs updates itself, for the CLI that comes with it too.
      const status = await checkForUpdate(true);
      if (status.error) throw new Error(`Update check failed: ${status.error}`);
      if (!status.available) return void console.log(`Up to date (${VERSION}).`);
      console.log(`Update available: ${VERSION} → ${status.latest}`);
      console.log("  The Harness Dashboard app updates itself and this command with it.");
      console.log(`  Or download it: ${status.releaseUrl ?? `https://github.com/${REPO}/releases/latest`}`);
      return;
    }

    case "config": {
      const sub = args.positional[0] ?? "get";
      if (sub === "path") return void console.log(configPath());
      if (sub === "get") return void console.log(JSON.stringify(loadConfig(), null, 2));
      if (sub === "set") {
        const [key, raw] = args.positional.slice(1);
        if (!key || raw === undefined) throw new Error("usage: config set <key> <value>");
        let value: unknown = raw;
        try {
          value = JSON.parse(raw);
        } catch {
          /* keep as string */
        }
        updateConfig(configKeyPatch(loadConfig(), key, value));
        return void console.log(`${key} = ${JSON.stringify(value)}`);
      }
      throw new Error(`unknown config subcommand: ${sub}`);
    }

    case "ingest":
      return ingestCommand(args);

    default:
      console.error(`Unknown command: ${args.cmd}\n`);
      console.log(HELP);
      process.exit(2);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`error: ${errorText(err)}`);
    process.exit(1);
  });
}
