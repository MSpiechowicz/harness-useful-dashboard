import { type ExportRow, normalizeRow, toCsv } from "../../web/src/lib/export.ts";
import type { BudgetConfig } from "./budgets.ts";
import {
  type BudgetRow, InputError, type LimitsReport, limitsReport, openReadOnly, RANGES, type ReportContext, type TodayReport, todayReport,
  type UsageReport, usageReport,
} from "./reports.ts";
import { formatDuration, formatUsd } from "./statusline.ts";

/**
 * The `today`, `report` and `limits` commands: the reports of reports.ts as aligned tables for a terminal, or as JSON
 * and CSV for scripts. They read the database only, so the numbers are as fresh as the dashboard's last scan.
 */

export const REPORT_COMMANDS = ["today", "report", "limits"] as const;
export type ReportCommand = (typeof REPORT_COMMANDS)[number];

export interface ReportEnv {
  dbPath: string;
  budgets: BudgetConfig;
  user: string;
  host: string;
  now: number;
  env: Record<string, string | undefined>;
  /** Whether stdout is a terminal: colors only go there. */
  isTTY: boolean;
}

type Flags = Record<string, string | boolean>;

/** Runs a command: what to print on stdout and the exit code. Bad input and a missing database throw InputError. */
export function runReport(cmd: ReportCommand, flags: Flags, e: ReportEnv): { out: string; code: number } {
  const format = outputFormat(flags, cmd !== "limits");
  const args = filterArgs(flags);
  const warn = flags.warn === undefined ? 80 : Number(text(flags, "warn"));
  if (!(warn > 0 && warn <= 1000)) throw new InputError(`--warn must be a percentage above 0, got "${String(flags.warn)}"`);
  const limit = flags.limit === undefined ? 25 : Number(text(flags, "limit"));
  if (!Number.isInteger(limit) || limit < 0) throw new InputError(`--limit must be a whole number, 0 for every row, got "${String(flags.limit)}"`);

  const { db, queries } = openReadOnly(e.dbPath);
  try {
    const c: ReportContext = { db, queries, budgets: e.budgets, user: e.user, host: e.host, now: e.now };
    const p = painter(flags["no-color"] !== true && !e.env.NO_COLOR && e.isTTY);
    if (cmd === "today") {
      const r = todayReport(c, args);
      return { out: format === "json" ? json(r) : renderToday(r, p, e.now), code: 0 };
    }
    if (cmd === "report") {
      const r = usageReport(c, { ...args, by: flags.by === undefined ? undefined : text(flags, "by") });
      if (format === "json") return { out: json({ ...r, rows: reportRows(r) }), code: 0 };
      if (format === "csv") return { out: toCsv(reportRows(r), columnsFor(r)), code: 0 };
      return { out: renderReport(r, p, limit), code: 0 };
    }
    const r = limitsReport(c, warn);
    const code = flags.check === true ? r.check.exitCode : 0;
    return { out: format === "json" ? json(r) : renderLimits(r, p, e.now, flags.check === true), code };
  } finally {
    db.close();
  }
}

function text(flags: Flags, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || !v) throw new InputError(`--${name} needs a value`);
  return v;
}

function outputFormat(flags: Flags, csv: boolean): "text" | "json" | "csv" {
  if (flags.json && flags.csv) throw new InputError("Pass --json or --csv, not both");
  if (flags.csv && !csv) throw new InputError("--csv works with report only");
  return flags.json ? "json" : flags.csv ? "csv" : "text";
}

/** --range, --from, --to and the filters, as reports.ts takes them. --from or --to alone make the range custom. */
function filterArgs(flags: Flags): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const k of ["range", "from", "to", "provider", "project", "model", "user", "tag", "kind"]) if (flags[k] !== undefined) args[k] = text(flags, k);
  if (args.range !== undefined && !(RANGES as readonly string[]).includes(args.range as string)) {
    throw new InputError(`--range must be one of today, 7d, 30d, month, all, got "${String(args.range)}"`);
  }
  if (args.from !== undefined || args.to !== undefined) {
    if (args.range !== undefined && args.range !== "custom") throw new InputError("Pass --range or --from and --to, not both");
    args.range = "custom";
  }
  return args;
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

// ---------------------------------------------------------------------------------------------------------------
// Rows for JSON and CSV: the dashboard's own field names in a fixed order, times in ISO 8601, as its export writes them.

const BREAKDOWN_COLUMNS = [
  "key", "label", "cost", "share", "tokens", "tokenShare", "input", "output", "cacheRead", "cacheWrite", "reasoning",
  "messages", "sessions", "prompts", "cacheHitRate", "estimated", "firstTs", "lastTs",
];
const PERIOD_COLUMNS = [
  "period", "cost", "share", "tokens", "input", "output", "cacheRead", "cacheWrite", "reasoning", "messages", "sessions", "prompts", "firstTs", "lastTs",
];

const isPeriod = (r: UsageReport) => r.by === "day" || r.by === "week" || r.by === "month";
const columnsFor = (r: UsageReport) => (isPeriod(r) ? PERIOD_COLUMNS : BREAKDOWN_COLUMNS);

export function reportRows(r: UsageReport): ExportRow[] {
  const cols = columnsFor(r);
  return r.rows.map((row) => {
    const picked: Record<string, unknown> = {};
    for (const c of cols) picked[c] = c === "estimated" ? row[c] === 1 : (row[c] ?? null);
    return normalizeRow(picked);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Text

const ANSI = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m" };
type Tone = Exclude<keyof typeof ANSI, "reset">;
type Paint = (tone: Tone, s: string) => string;

function painter(color: boolean): Paint {
  return color ? (tone, s) => `${ANSI[tone]}${s}${ANSI.reset}` : (_tone, s) => s;
}

/** 950, 12.4k, 3.1M, 1.2B. */
export function formatCount(n: number): string {
  const units: [number, string][] = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
  for (const [size, unit] of units) {
    if (Math.abs(n) >= size) {
      const v = n / size;
      return `${Math.abs(v) < 100 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)}${unit}`;
    }
  }
  return String(Math.round(n));
}

const percent = (v: number | null) => (v == null ? "-" : `${Math.round(v)}%`);
const toneOf = (pct: number, warn = 80): Tone => (pct >= 100 ? "red" : pct >= warn ? "yellow" : "green");

function formatChange(v: number | null, now: number): string {
  if (v == null) return now ? "new" : "";
  const p = Math.round(v * 100);
  return p > 0 ? `+${p}%` : `${p}%`;
}

const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

/** Aligned columns two spaces apart. "r" columns are right-aligned. Cells may carry colors. */
export function table(rows: string[][], align: ("l" | "r")[], indent = ""): string[] {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, visible(c))));
  return rows.map((r) => {
    const cells = r.map((c, i) => {
      const pad = " ".repeat((widths[i] ?? 0) - visible(c));
      return align[i] === "r" ? pad + c : i === r.length - 1 ? c : c + pad;
    });
    return (indent + cells.join("  ")).trimEnd();
  });
}

const localDate = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const filterLine = (f: Record<string, string> | undefined, p: Paint) =>
  f ? [p("dim", Object.entries(f).map(([k, v]) => `${k} ${v}`).join(", "))] : [];

function budgetLines(budgets: BudgetRow[], p: Paint, warn = 80): string[] {
  const name = (b: BudgetRow) => (b.scope === "daily" ? "Daily" : b.scope === "monthly" ? "Monthly" : `Project ${b.project}`);
  return table(
    budgets.map((b) => [
      name(b),
      `${formatUsd(b.spentUsd ?? 0)} of ${formatUsd(b.capUsd ?? 0)}`,
      p(toneOf(b.usedPercent, warn), percent(b.usedPercent)),
      b.projectedUsd != null ? p("dim", `on pace for ${formatUsd(b.projectedUsd)}`) : "",
    ]),
    ["l", "r", "r", "l"],
    "  ",
  );
}

export function renderToday(r: TodayReport, p: Paint, now: number): string {
  const day = new Date(now).toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const lines = [`${p("bold", "Today")}  ${p("dim", day)}`, ...filterLine(r.filters, p), ""];
  const row = (label: string, k: "costUsd" | "tokens" | "sessions" | "prompts", fmt: (n: number) => string, ch: number | null) => [
    label,
    fmt(r.today[k] ?? 0),
    fmt(r.yesterday[k] ?? 0),
    p("dim", formatChange(ch, r.today[k] ?? 0)),
  ];
  lines.push(
    ...table(
      [
        ["", p("dim", "Today"), p("dim", "Yesterday"), p("dim", "Change")],
        row("Cost", "costUsd", formatUsd, r.change.cost),
        row("Tokens", "tokens", formatCount, r.change.tokens),
        row("Sessions", "sessions", String, r.change.sessions),
        row("Prompts", "prompts", String, r.change.prompts),
      ],
      ["l", "r", "r", "r"],
    ),
  );
  const top = (title: string, items: TodayReport["topProjects"]) => {
    if (!items.length) return;
    lines.push("", p("bold", title));
    lines.push(...table(items.map((i) => [i.label, formatUsd(i.costUsd ?? 0), p("dim", percent((i.share ?? 0) * 100))]), ["l", "r", "r"], "  "));
  };
  top("Top projects", r.topProjects);
  top("Top models", r.topModels);
  if (r.budgets.length) lines.push("", p("bold", "Budgets"), ...budgetLines(r.budgets, p));
  if (r.claudeFiveHour) {
    const { usedPercent, resetsAt } = r.claudeFiveHour;
    const resets = resetsAt ? p("dim", `resets in ${formatDuration(Date.parse(resetsAt) - now)}`) : "";
    lines.push("", `${p("bold", "Claude 5h limit")}  ${p(toneOf(usedPercent ?? 0), percent(usedPercent))}  ${resets}`.trimEnd());
  }
  if (!r.today.modelCalls && !r.yesterday.modelCalls) lines.push("", p("dim", "No usage today or yesterday yet."));
  return lines.join("\n") + "\n";
}

const RANGE_NAMES: Record<string, string> = { today: "today", "7d": "last 7 days", "30d": "last 30 days", month: "this month", all: "all time" };

function rangeLabel(r: UsageReport["range"]): string {
  const from = r.from ? localDate(Date.parse(r.from)) : null;
  // `to` is exclusive: the last day shown is the one before it.
  const to = r.to ? localDate(Date.parse(r.to) - 1) : null;
  const span = from && to ? (from === to ? from : `${from} to ${to}`) : to ? `until ${to}` : "";
  if (r.name === "custom") return span;
  return span ? `${RANGE_NAMES[r.name]} (${span})` : RANGE_NAMES[r.name]!;
}

const BY_TITLES: Record<string, string> = { project: "Project", model: "Model", provider: "Provider", user: "User", tag: "Tag", kind: "Kind", day: "Day", week: "Week of", month: "Month" };

export function renderReport(r: UsageReport, p: Paint, limit: number): string {
  const lines = [p("bold", `Usage by ${r.by}, ${rangeLabel(r.range)}`), ...filterLine(r.filters, p), ""];
  const period = isPeriod(r);
  const shown = limit > 0 ? r.rows.slice(0, limit) : r.rows;
  const head = [BY_TITLES[r.by]!, "Cost", ...(period ? [] : ["Share"]), "Tokens", "Sessions", "Prompts"].map((h) => p("dim", h));
  const body = shown.map((row) => [
    String(period ? row.period : row.label),
    formatUsd(Number(row.cost)),
    ...(period ? [] : [percent(Number(row.share) * 100)]),
    formatCount(Number(row.tokens)),
    String(row.sessions),
    String(row.prompts),
  ]);
  const total = [p("bold", "Total"), p("bold", formatUsd(r.total.cost)), ...(period ? [] : [""]), formatCount(r.total.tokens), String(r.total.sessions), String(r.total.prompts)];
  lines.push(...table([head, ...body, total], ["l", "r", ...(period ? [] : ["r" as const]), "r", "r", "r"]));
  if (shown.length < r.rows.length) lines.push(p("dim", `${r.rows.length - shown.length} more rows. Pass --limit 0 to show all of them.`));
  if (!r.rows.length || (period && !r.total.messages)) lines.push(p("dim", "No usage in this range."));
  return lines.join("\n") + "\n";
}

const CHECK_TEXT: Record<string, (warn: number) => string> = {
  ok: (w) => `all below ${w}%`,
  warning: (w) => `at or above ${w}%`,
  over: () => "a limit or cap is used up",
  unknown: () => "no fresh limit reading",
};

export function renderLimits(r: LimitsReport, p: Paint, now: number, check: boolean): string {
  const warn = r.check.warnPercent;
  const lines = [p("bold", "Plan limits")];
  if (r.windows.length) {
    const rows = r.windows.map((w) => {
      const fresh = w.status === "fresh";
      const used = fresh ? p(toneOf(w.usedPercent ?? 0, warn), percent(w.usedPercent)) : p("dim", percent(w.usedPercent));
      const resets = w.resetsAt && fresh ? `resets in ${formatDuration(Date.parse(w.resetsAt) - now)}` : "";
      const age = w.status === "reset since reading" ? "reset since the reading" : `read ${formatDuration(w.ageMinutes * 60_000)} ago${fresh ? "" : ", stale"}`;
      return [[w.provider, w.plan, w.scope, w.host && `on ${w.host}`].filter(Boolean).join(" "), w.window, used, resets, p("dim", age)];
    });
    lines.push(...table(rows, ["l", "l", "r", "l", "l"], "  "));
  } else {
    lines.push(p("dim", "  No readings in the last 30 days. The running dashboard records them."));
  }
  lines.push("", p("bold", "Budgets"));
  lines.push(...(r.budgets.length ? budgetLines(r.budgets, p, warn) : [p("dim", "  None set. Set them in the dashboard under Settings, Budgets and alerts.")]));
  if (check) {
    const tone: Tone = r.check.status === "ok" ? "green" : r.check.status === "unknown" ? "dim" : r.check.status === "warning" ? "yellow" : "red";
    lines.push("", `${p("bold", "Check")}  ${p(tone, CHECK_TEXT[r.check.status]!(warn))}  ${p("dim", `exit ${r.check.exitCode}`)}`);
  }
  return lines.join("\n") + "\n";
}
