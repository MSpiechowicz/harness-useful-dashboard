#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { configPath, ensureAppDataDir } from "./core/paths.ts";
import { loadConfig, resolveDbPath, updateConfig } from "./core/config.ts";
import { openDb } from "./core/db.ts";
import { scan } from "./core/ingest/index.ts";
import { fallbackLine, gather, parseInput, render, useColor } from "./core/statusline.ts";
import { REPORT_COMMANDS, type ReportCommand, runReport } from "./core/reportCli.ts";
import { InputError } from "./core/reports.ts";
import { importCursorCsv } from "./core/ingest/cursor.ts";
import { McpServer, serveStream } from "./mcp/server.ts";
import { createTools } from "./mcp/tools.ts";
import { DbWriter } from "./core/ingest/writer.ts";
import { localIdentity } from "./core/paths.ts";
import { PriceBook } from "./core/pricing.ts";
import { App } from "./server/app.ts";
import { loadToken, signInUrl } from "./server/auth.ts";
import { createHandler, loadAssets } from "./server/http.ts";
import { openUi } from "./server/open.ts";
import { applyUpdate, checkForUpdate, cleanupOldBinary, installedPath, isCompiledBinary } from "./server/update.ts";
import { BIN_NAME, VERSION } from "./version.ts";

const HELP = `${BIN_NAME} ${VERSION} — token usage dashboard for Claude Code, Codex and Cursor

Usage:
  ${BIN_NAME} [serve] [options]      Start the dashboard and open it (default)
  ${BIN_NAME} scan [--full]          Ingest new usage from local logs and exit
  ${BIN_NAME} import-cursor <file>   Import a Cursor usage CSV export
  ${BIN_NAME} today                  Today's cost, tokens and sessions against yesterday
  ${BIN_NAME} report [options]       Cost by project, model, provider, user, day, week or month
  ${BIN_NAME} limits [--check]       Plan limits and budgets, with exit codes for scripts
  ${BIN_NAME} statusline             Print one status line for Claude Code (reads its JSON on stdin)
  ${BIN_NAME} mcp                    Serve usage data to AI agents over MCP (stdio, read-only)
  ${BIN_NAME} update [--check]       Update to the latest release
  ${BIN_NAME} config [path|get|set <key> <value>]
  ${BIN_NAME} version

Options:
  --db <path>       Use this SQLite file (e.g. on iCloud Drive / a network share)
  --port <n>        Port to listen on (default 4317)
  --no-open         Don't open a window
  --browser         Open in the default browser instead of an app window

Statusline options:
  --format <tpl>    Line template (default "{model} · {session} · {today} · {limit}")
                    Placeholders: {model} {session} {today} {limit}
  --no-color        Plain text (NO_COLOR is honored too)

Report options (today, report, limits):
  --range <r>       today, 7d, 30d, month or all (report default 30d)
  --from <date>     Start day, YYYY-MM-DD in local time (with --to, instead of --range)
  --to <date>       Last day, included
  --by <what>       project, model, provider, user, day, week or month (default project)
  --provider, --project, --model, --user <value>   Only this harness, project, model or user
  --json, --csv     Machine-readable output (CSV for report only)
  --limit <n>       Rows in the report table (default 25, 0 for all)
  --scan            Scan the local logs first (writes the database)
  --check           limits: exit 0 below --warn, 10 at or above it, 11 at 100%, 2 with no fresh reading
  --warn <pct>      limits: the warning threshold for limits and budgets (default 80)
  Numbers are as fresh as the last scan. Exit code 2 means bad options or no database.
`;

interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that take a value: `--db x` as well as `--db=x`. */
const VALUE_FLAGS = ["db", "port", "format", "range", "from", "to", "by", "provider", "project", "model", "user", "warn", "limit"];

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

/** Headers for asking the running dashboard: the token, and the header state-changing requests need. */
function apiHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${loadToken()}`, "X-Harness-Dashboard": "1" };
}

async function isOurServer(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: apiHeaders(), signal: AbortSignal.timeout(800) });
    if (!res.ok) return false;
    const body = (await res.json()) as { version?: string };
    return typeof body.version === "string";
  } catch {
    return false;
  }
}

async function serve(args: Args): Promise<void> {
  cleanupOldBinary();
  const cfg = loadConfig();
  const port = Number(args.flags.port ?? cfg.port) || 4317;
  const openMode = args.flags["no-open"] ? "none" : args.flags.browser ? "browser" : cfg.openMode;

  // Single instance: if the dashboard already runs on this port, just bring up a window.
  if (await isOurServer(port)) {
    console.log(`Dashboard already running at http://localhost:${port}`);
    openUi(signInUrl(`http://localhost:${port}`, loadToken()), openMode);
    return;
  }

  const token = loadToken();
  const app = new App(typeof args.flags.db === "string" ? args.flags.db : undefined);
  const assets = await loadAssets();
  let server: ReturnType<typeof Bun.serve>;
  const hooks = {
    restart() {
      // Hand the port over to the freshly installed binary; open windows reconnect on their own.
      server.stop(true);
      app.close();
      // Detached, as `update` does: the new server must outlive this process and its process group.
      Bun.spawn([installedPath(), "serve", "--no-open", "--port", String(port)], { stdio: ["ignore", "inherit", "inherit"], detached: true }).unref();
      setTimeout(() => process.exit(0), 200);
    },
    shutdown: () => shutdown(),
  };
  const handler = createHandler(app, assets, hooks, { token, port });

  const shutdown = () => {
    server.stop(true);
    app.close();
    process.exit(0);
  };
  server = Bun.serve({ port, hostname: "127.0.0.1", idleTimeout: 60, fetch: handler });
  const url = `http://localhost:${server.port}`;
  console.log(`${BIN_NAME} ${VERSION}`);
  console.log(`  database: ${app.dbPath}`);
  console.log(`  listening: ${url}`);
  // Without a window to open, this is how to get in: the API only answers a browser that came through this link.
  if (openMode === "none") console.log(`  open: ${signInUrl(url, token)}`);

  const first = app.scanNow();
  first
    .then((r) => console.log(`  scanned ${r.filesSeen} files (${r.filesParsed} changed, +${r.usageRows} usage rows) in ${r.durationMs} ms`))
    .catch((err) => console.error("[scan]", err));
  app.startBackgroundScan();
  openUi(signInUrl(url, token), openMode);

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
    console.error(`error: ${(err as Error).message}`);
    process.exitCode = err instanceof InputError ? 2 : 1;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.help || args.cmd === "help") return void console.log(HELP);
  if (args.flags.version || args.cmd === "version") return void console.log(VERSION);
  // Before anything that can fail: the status line always prints a line and exits 0.
  if (args.cmd === "statusline") return statusline(args, typeof args.flags.db === "string" ? args.flags.db : undefined);
  // Read-only as well: no app data folder is created for it.
  if (args.cmd === "mcp") return mcp(typeof args.flags.db === "string" ? args.flags.db : undefined);
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
      const status = await checkForUpdate(true);
      if (status.error) throw new Error(`Update check failed: ${status.error}`);
      if (!status.available) return void console.log(`Up to date (${VERSION}).`);
      console.log(`Update available: ${VERSION} → ${status.latest}`);
      if (args.flags.check) return;
      if (!isCompiledBinary()) throw new Error("Running from source; use `git pull && bun run build` instead.");
      const r = await applyUpdate((m) => console.log(`  ${m}`));
      // A dashboard still running the old version is stopped and started again from the new one. Its open windows
      // reconnect on their own.
      const port = Number(loadConfig().port) || 4317;
      if (await isOurServer(port)) {
        await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST", headers: apiHeaders() }).catch(() => {});
        for (let i = 0; i < 30 && (await isOurServer(port)); i++) await Bun.sleep(100);
        Bun.spawn([r.path, "serve", "--no-open", "--port", String(port)], { stdio: ["ignore", "ignore", "ignore"], detached: true }).unref();
        console.log(`Updated to ${r.version} and restarted the dashboard.`);
      } else {
        console.log(`Updated to ${r.version}.`);
      }
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
        updateConfig({ [key]: value });
        return void console.log(`${key} = ${JSON.stringify(value)}`);
      }
      throw new Error(`unknown config subcommand: ${sub}`);
    }

    default:
      console.error(`Unknown command: ${args.cmd}\n`);
      console.log(HELP);
      process.exit(2);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  });
}
