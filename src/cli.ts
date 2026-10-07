#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { configPath, ensureAppDataDir } from "./core/paths.ts";
import { loadConfig, resolveDbPath, updateConfig } from "./core/config.ts";
import { openDb } from "./core/db.ts";
import { scan } from "./core/ingest/index.ts";
import { importCursorCsv } from "./core/ingest/cursor.ts";
import { DbWriter } from "./core/ingest/writer.ts";
import { localIdentity } from "./core/paths.ts";
import { PriceBook } from "./core/pricing.ts";
import { App } from "./server/app.ts";
import { createHandler, loadAssets } from "./server/http.ts";
import { openUi } from "./server/open.ts";
import { applyUpdate, checkForUpdate, cleanupOldBinary, installedPath, isCompiledBinary } from "./server/update.ts";
import { BIN_NAME, VERSION } from "./version.ts";

const HELP = `${BIN_NAME} ${VERSION} — token usage dashboard for Claude Code, Codex and Cursor

Usage:
  ${BIN_NAME} [serve] [options]      Start the dashboard and open it (default)
  ${BIN_NAME} scan [--full]          Ingest new usage from local logs and exit
  ${BIN_NAME} import-cursor <file>   Import a Cursor usage CSV export
  ${BIN_NAME} update [--check]       Update to the latest release
  ${BIN_NAME} config [path|get|set <key> <value>]
  ${BIN_NAME} version

Options:
  --db <path>       Use this SQLite file (e.g. on iCloud Drive / a network share)
  --port <n>        Port to listen on (default 4317)
  --no-open         Don't open a window
  --browser         Open in the default browser instead of an app window
`;

interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (v !== undefined) flags[k] = v;
      else if (["db", "port"].includes(k) && argv[i + 1] && !argv[i + 1]!.startsWith("--")) flags[k] = argv[++i]!;
      else flags[k] = true;
    } else if (a === "-h") flags.help = true;
    else if (a === "-v") flags.version = true;
    else positional.push(a);
  }
  const cmd = positional.shift() ?? "serve";
  return { cmd, positional, flags };
}

async function isOurServer(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(800) });
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
    openUi(`http://localhost:${port}`, openMode);
    return;
  }

  const app = new App(typeof args.flags.db === "string" ? args.flags.db : undefined);
  const assets = await loadAssets();
  let server: ReturnType<typeof Bun.serve>;
  const handler = createHandler(app, assets, {
    restart() {
      // Hand the port over to the freshly installed binary; open windows reconnect on their own.
      server.stop(true);
      app.close();
      Bun.spawn([installedPath(), "serve", "--no-open", "--port", String(port)], { stdio: ["ignore", "inherit", "inherit"] }).unref();
      setTimeout(() => process.exit(0), 200);
    },
    shutdown: () => shutdown(),
  });

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

  const first = app.scanNow();
  first
    .then((r) => console.log(`  scanned ${r.filesSeen} files (${r.filesParsed} changed, +${r.usageRows} usage rows) in ${r.durationMs} ms`))
    .catch((err) => console.error("[scan]", err));
  app.startBackgroundScan();
  openUi(url, openMode);

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.help || args.cmd === "help") return void console.log(HELP);
  if (args.flags.version || args.cmd === "version") return void console.log(VERSION);
  ensureAppDataDir();

  const dbFlag = typeof args.flags.db === "string" ? args.flags.db : undefined;
  switch (args.cmd) {
    case "serve":
    case "start":
      return serve(args);

    case "scan": {
      const cfg = loadConfig();
      const { path, isDefault } = resolveDbPath(cfg, dbFlag);
      const db = openDb(path, { journalMode: cfg.journalMode, isDefaultPath: isDefault });
      const id = { user: cfg.userName || localIdentity().user, host: localIdentity().host };
      const r = await scan(db, cfg, id, { full: args.flags.full === true });
      console.log(`Scanned ${r.filesSeen} files (${r.filesParsed} parsed) in ${r.durationMs} ms → ${r.usageRows} usage rows, ${r.prompts} prompts, ${r.tools} tool calls`);
      for (const e of r.errors) console.warn(`  ! ${e.path}: ${e.error}`);
      db.close();
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
        await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST", headers: { "X-Harness-Dashboard": "1" } }).catch(() => {});
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
