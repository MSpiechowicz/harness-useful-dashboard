import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { type AlertLang, type BudgetConfig, windowName } from "./budgets.ts";
import { lines as linesChanged } from "./changes.ts";
import { digestName, digestText } from "./digestText.ts";
import { friction } from "./friction.ts";
import { getMeta, setMeta } from "./db.ts";
import { appDataDir, expandHome } from "./paths.ts";
import type { PriceBook } from "./pricing.ts";
import { limitHistory } from "./plans.ts";
import type { Filters } from "./queries.ts";
import { budgetRows, dayStart, InputError, iso, openReadOnly, type ReportContext, usd } from "./reports.ts";
import { formatUsd } from "./statusline.ts";
import { generateTips } from "./tips.ts";

/**
 * The weekly digest: a short Markdown report of a week of usage against the week before, built from the same queries as
 * the dashboard and the command-line reports. Written to a folder, never sent anywhere.
 */

export interface DigestConfig {
  /** Off until the user turns it on. */
  enabled: boolean;
  /** Weekday it is written on, 0 Sunday to 6 Saturday. */
  day: number;
  /** Hour of that day, local time, 0 to 23. */
  hour: number;
  /** Folder for the files. Empty: `digests` in the app data folder. */
  dir: string;
}

export const DEFAULT_DIGEST: DigestConfig = { enabled: false, day: 1, hour: 9, dir: "" };

/** "last": the previous Monday to Sunday. "this": the last 7 days up to now, for a digest written on request. */
export type DigestWeek = "last" | "this";

export interface DigestRange {
  from: number;
  /** Exclusive. */
  to: number;
  /** The 7 days before, for the comparison. */
  prevFrom: number;
  prevTo: number;
}

/**
 * The days a digest covers, from local midnights: a day is counted as a calendar day, so a week with a clock change
 * still has 7 days. The week before has the same length, and "this" ends now.
 */
export function digestRange(now: number, week: DigestWeek): DigestRange {
  if (week === "this") return { from: dayStart(now, 6), to: now, prevFrom: dayStart(now, 13), prevTo: dayStart(now, 6) };
  const monday = dayStart(now, (new Date(now).getDay() + 6) % 7);
  return { from: dayStart(monday, 7), to: monday, prevFrom: dayStart(monday, 14), prevTo: dayStart(monday, 7) };
}

/** The ISO 8601 week a day falls in, from its local date: Monday starts a week, the one with the year's first Thursday is 1. */
export function isoWeek(t: number): { year: number; week: number } {
  const d = new Date(t);
  const day = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const jan1 = Date.UTC(day.getUTCFullYear(), 0, 1);
  return { year: day.getUTCFullYear(), week: Math.ceil(((day.getTime() - jan1) / 86_400_000 + 1) / 7) };
}

/** `2026-W41.md`: named by the week the period ends in. */
export function digestFileName(r: DigestRange): string {
  const { year, week } = isoWeek(r.to - 1);
  return `${year}-W${String(week).padStart(2, "0")}.md`;
}

const localDate = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export interface DigestContext extends ReportContext {
  prices: PriceBook;
  lang: AlertLang;
  /** Tip rules the user hid: they stay out of the digest too. */
  hiddenTips: string[];
}

export interface Digest {
  week: DigestWeek;
  file: string;
  /** The days covered, first and last, as dates. */
  from: string;
  to: string;
  generatedAt: string;
  totals: { costUsd: number | null; tokens: number; sessions: number; prompts: number };
  previous: { costUsd: number | null; tokens: number; sessions: number; prompts: number };
  /** Relative change against the week before, null when it had none. */
  change: { cost: number | null; tokens: number | null; sessions: number | null; prompts: number | null };
  lines: { changed: number; added: number; removed: number; costPer100Usd: number | null; previousCostPer100Usd: number | null };
  top: Record<"projects" | "models" | "providers", { key: string; label: string; costUsd: number | null; share: number }[]>;
  budgets: { scope: "monthly" | "project"; project?: string; spentUsd: number | null; capUsd: number | null; usedPercent: number; projectedUsd?: number | null }[];
  limits: { name: string; peakPercent: number; fullCycles: number }[];
  failures: { toolFailures: number; toolCalls: number; reasons: { reason: string; count: number }[]; apiErrors: number };
  tips: { id: string; severity: string; title: string; impactUsd: number }[];
  /** The Markdown, in the UI's language. */
  markdown: string;
}

const changeOf = (now: number, before: number) => (before ? (now - before) / before : null);

/**
 * The digest of a week: numbers from the database, as of `c.now`, and its Markdown. `ref` is the moment the week is
 * counted back from: a digest written late for its slot still covers that slot's week.
 */
export function buildDigest(c: DigestContext, week: DigestWeek, ref = c.now): Digest {
  const r = digestRange(ref, week);
  const f: Filters = { from: r.from, to: r.to };
  const pf: Filters = { from: r.prevFrom, to: r.prevTo };
  const sum = (x: Filters) => {
    const s = c.queries.summary(x);
    return { costUsd: usd(s.cost), tokens: s.tokens, sessions: s.sessions, prompts: s.prompts };
  };
  const totals = sum(f);
  const previous = sum(pf);
  const ln = linesChanged(c.db, f).total;
  const pln = linesChanged(c.db, pf).total;
  const top = (dim: "project" | "model" | "provider") =>
    c.queries.breakdown(f, dim, 5).rows.map((x) => ({ key: x.key, label: x.label, costUsd: usd(x.cost), share: x.share }));

  // Monthly and project caps as they stand now: the day's cap says little about a week.
  const budgets = budgetRows(c.db, c.budgets, c.user, c.now)
    .filter((b): b is typeof b & { scope: "monthly" | "project" } => b.scope !== "daily")
    .map((b) => ({ scope: b.scope, project: b.project, spentUsd: b.spentUsd, capUsd: b.capUsd, usedPercent: b.usedPercent, projectedUsd: b.projectedUsd }));

  const limits = limitHistory(c.db, f)
    .filter((h) => h.points.length)
    .map((h) => ({
      name: [h.provider.charAt(0).toUpperCase() + h.provider.slice(1), h.plan, windowName(h.windowMs, h.label ?? h.windowId), h.scope].filter(Boolean).join(" "),
      peakPercent: Math.round(Math.max(...h.points.map((p) => p[1])) * 1000) / 10,
      fullCycles: h.hits,
    }))
    .sort((a, b) => b.peakPercent - a.peakPercent);

  const fr = friction(c.db, f, "day");
  const failures = {
    toolFailures: fr.totals.errors,
    toolCalls: fr.totals.ok + fr.totals.errors,
    reasons: fr.reasons.filter((x) => x.reason !== "rejected").slice(0, 3).map((x) => ({ reason: x.reason, count: x.count })),
    apiErrors: fr.apiErrors.total,
  };

  const hidden = new Set(c.hiddenTips);
  const tips = generateTips(c.db, f, c.prices)
    .filter((t) => !hidden.has(t.id))
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 3)
    .map((t) => ({ id: t.id, severity: t.severity, title: tipTitle(c.lang, t.id, t.params), impactUsd: Math.round(t.impact * 100) / 100 }));

  const d: Digest = {
    week,
    file: digestFileName(r),
    from: localDate(r.from),
    to: localDate(r.to - 1),
    generatedAt: iso(c.now)!,
    totals,
    previous,
    change: {
      cost: changeOf(totals.costUsd ?? 0, previous.costUsd ?? 0),
      tokens: changeOf(totals.tokens, previous.tokens),
      sessions: changeOf(totals.sessions, previous.sessions),
      prompts: changeOf(totals.prompts, previous.prompts),
    },
    lines: { changed: ln.changed, added: ln.added, removed: ln.removed, costPer100Usd: usd(ln.costPer100), previousCostPer100Usd: usd(pln.costPer100) },
    top: { projects: top("project"), models: top("model"), providers: top("provider") },
    budgets,
    limits,
    failures,
    tips,
    markdown: "",
  };
  d.markdown = renderDigest(d, c.lang, c.now);
  return d;
}

// ---------------------------------------------------------------------------------------------------------------
// Markdown

/** 950, 12.4k, 3.1M, 1.2B. */
function count(n: number): string {
  for (const [size, unit] of [[1e9, "B"], [1e6, "M"], [1e3, "k"]] as const) {
    if (Math.abs(n) >= size) {
      const v = n / size;
      return `${Math.abs(v) < 100 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)}${unit}`;
    }
  }
  return String(Math.round(n));
}

const percent = (v: number | null) => (v == null ? "-" : `${Math.round(v * 100)}%`);
export const signed = (v: number | null) => (v == null ? "-" : `${v > 0 ? "+" : ""}${Math.round(v * 100)}%`);

/** A name from the user's data, on one line and in a code span, so nothing in it reads as Markdown. */
function code(s: string): string {
  const one = s.replace(/[`\r\n|]+/g, " ").trim();
  return `\`${one.length > 60 ? `${one.slice(0, 59)}…` : one}\``;
}

function tipTitle(lang: AlertLang, id: string, params: Record<string, string | number | null>): string {
  const fill: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v == null) fill[k] = "";
    else if (typeof v === "string") fill[k] = code(v);
    else if (["cost", "before", "after"].includes(k)) fill[k] = formatUsd(v);
    else fill[k] = k === "avg" ? count(v) : Number.isInteger(v) ? v : Math.round(v * 10) / 10;
  }
  const raw = digestName(lang, `tip:${id}`);
  return raw ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(fill[k] ?? "")) : id;
}

/** The digest as Markdown that also reads as plain text: a table of the headline numbers, then short lists. */
export function renderDigest(d: Digest, lang: AlertLang, now: number): string {
  const m = (key: string, p: Record<string, string | number> = {}) => digestText(lang, key, p);
  const rolling = d.week === "this";
  const out = [`# ${m(rolling ? "titleRolling" : "title")}: ${m("period", { from: d.from, to: d.to })}`, "", `_${m("generated", { when: localDate(now) + " " + new Date(now).toTimeString().slice(0, 5) })}_`, ""];
  if (!d.totals.tokens && !d.previous.tokens) return [...out, m("noUsage"), ""].join("\n");

  const per100 = (v: number | null) => (v == null ? "-" : formatUsd(v));
  const row = (label: string, now: string, before: string, ch: number | null) => `| ${label} | ${now} | ${before} | ${signed(ch)} |`;
  const per100Change = d.lines.costPer100Usd != null && d.lines.previousCostPer100Usd ? (d.lines.costPer100Usd - d.lines.previousCostPer100Usd) / d.lines.previousCostPer100Usd : null;
  out.push(
    `| | ${m(rolling ? "colNowRolling" : "colNow")} | ${m(rolling ? "colPrevRolling" : "colPrev")} | ${m("colChange")} |`,
    "|---|---:|---:|---:|",
    row(m("cost"), formatUsd(d.totals.costUsd ?? 0), formatUsd(d.previous.costUsd ?? 0), d.change.cost),
    row(m("tokens"), count(d.totals.tokens), count(d.previous.tokens), d.change.tokens),
    row(m("sessions"), String(d.totals.sessions), String(d.previous.sessions), d.change.sessions),
    row(m("prompts"), String(d.totals.prompts), String(d.previous.prompts), d.change.prompts),
    `| ${m("lines")} | ${count(d.lines.changed)} | | |`,
    row(m("per100"), per100(d.lines.costPer100Usd), per100(d.lines.previousCostPer100Usd), per100Change),
    "",
  );

  const list = (title: string, items: Digest["top"]["projects"]) => {
    if (!items.length) return;
    out.push(`## ${title}`, "", ...items.map((i) => `- ${code(i.label)}: ${formatUsd(i.costUsd ?? 0)} (${percent(i.share)})`), "");
  };
  list(m("projects"), d.top.projects);
  list(m("models"), d.top.models);
  list(m("providers"), d.top.providers);

  if (d.budgets.length) {
    out.push(`## ${m("budgets")}`, "");
    for (const b of d.budgets) {
      const name = b.scope === "project" ? code(b.project ?? "") : m("monthly");
      const text = m("budgetLine", { name, spent: formatUsd(b.spentUsd ?? 0), cap: formatUsd(b.capUsd ?? 0), pct: `${Math.round(b.usedPercent)}%`, pace: formatUsd(b.projectedUsd ?? 0) });
      out.push(`- ${text}`);
    }
    out.push("");
  }

  out.push(`## ${m("limits")}`, "");
  if (d.limits.length) {
    for (const l of d.limits) out.push(`- ${m(l.fullCycles ? "limitHits" : "limitPeak", { name: l.name, pct: `${Math.round(l.peakPercent)}%`, n: l.fullCycles })}`);
  } else out.push(m("limitsNone"));
  out.push("", `## ${m("friction")}`, "");
  const f = d.failures;
  if (!f.toolFailures && !f.apiErrors) out.push(m("noFailures"));
  else {
    out.push(`- ${m("toolFailures", { count: f.toolFailures, calls: f.toolCalls, rate: f.toolCalls ? percent(f.toolFailures / f.toolCalls) : "-" })}`);
    if (f.reasons.length) out.push(`- ${m("topCauses", { list: f.reasons.map((x) => `${digestName(lang, `reason:${x.reason}`) ?? x.reason} (${x.count})`).join(", ") })}`);
    out.push(`- ${m("apiErrors", { count: f.apiErrors })}`);
  }
  out.push("", `## ${m("tips")}`, "");
  if (d.tips.length) d.tips.forEach((t, i) => out.push(`${i + 1}. ${t.title}${t.impactUsd >= 0.5 ? ` (${m("tipImpact", { cost: formatUsd(t.impactUsd) })})` : ""}`));
  else out.push(m("noTips"));
  return out.join("\n") + "\n";
}

/** The headline numbers for the notification. */
export function notificationText(d: Digest, lang: AlertLang): { title: string; body: string } {
  return {
    title: digestText(lang, "notifyTitle"),
    body: digestText(lang, "notifyBody", { cost: formatUsd(d.totals.costUsd ?? 0), change: signed(d.change.cost), tokens: count(d.totals.tokens), sessions: d.totals.sessions }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Files

/** Where the files go: the configured folder, or `digests` in the app data folder. */
export function digestDir(cfg: DigestConfig): string {
  return cfg.dir ? expandHome(cfg.dir) : join(appDataDir(), "digests");
}

/** Writes the file (creating the folder), readable by this account only like the app data folder. Returns its path. */
export function writeDigestFile(dir: string, d: Pick<Digest, "file" | "markdown">): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, d.file);
  writeFileSync(path, d.markdown, { mode: 0o600 });
  if (process.platform !== "win32") {
    // The folder may be older, and a file that existed keeps its mode: tighten what this wrote.
    try {
      chmodSync(path, 0o600);
    } catch {
      /* owned by someone else: leave it as it is */
    }
  }
  return path;
}

/** The path of a digest file, as the file name this module writes. Anything else read from the database is refused. */
const FILE_NAME = /^\d{4}-W\d{2}\.md$/;

const lastKey = (host: string) => `digest_last:${host}`;
const slotKey = (host: string) => `digest_slot:${host}`;

/** Remembers the latest digest written on this machine, for the in-app view. */
export function rememberDigest(db: Database, host: string, path: string): void {
  setMeta(db, lastKey(host), JSON.stringify({ path, at: Date.now() }));
}

/** The latest digest this machine wrote and its Markdown, or null when there is none or the file is gone. */
export function lastDigest(db: Database, host: string): { path: string; markdown: string; writtenAt: number } | null {
  try {
    const raw = getMeta(db, lastKey(host));
    if (!raw) return null;
    const { path, at } = JSON.parse(raw) as { path: string; at: number };
    if (typeof path !== "string" || !isAbsolute(path) || !FILE_NAME.test(basename(path)) || !existsSync(path)) return null;
    return { path, markdown: readFileSync(path, "utf8"), writtenAt: Number(at) || 0 };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Schedule

/** The latest time at or before `now` that is `day` at `hour` o'clock, local. Never more than a week ago. */
export function latestSlot(now: number, day: number, hour: number): number {
  const d = new Date(now);
  let back = (d.getDay() - day + 7) % 7;
  let slot = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, hour).getTime();
  if (slot > now) {
    back += 7;
    slot = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, hour).getTime();
  }
  return slot;
}

/**
 * The slot a digest is due for, or null. A week is written once: the slot is kept per machine, so an app that was off
 * at the time writes it when it starts again, and one that was off for weeks writes the latest week only.
 */
export function dueSlot(db: Database, host: string, cfg: DigestConfig, now: number): number | null {
  if (!cfg.enabled) return null;
  const slot = latestSlot(now, cfg.day, cfg.hour);
  return Number(getMeta(db, slotKey(host)) ?? 0) >= slot ? null : slot;
}

export function markSlot(db: Database, host: string, slot: number): void {
  setMeta(db, slotKey(host), String(slot));
}

// ---------------------------------------------------------------------------------------------------------------
// The command

export interface DigestEnv {
  dbPath: string;
  budgets: BudgetConfig;
  hiddenTips: string[];
  lang: AlertLang;
  user: string;
  host: string;
  now: number;
}

/**
 * `digest [--week last|this] [--out <file>] [--json]`: the Markdown (or the numbers as JSON) for stdout, from the
 * database only. With --out the file is written instead, readable by this account only.
 */
export function runDigest(flags: Record<string, string | boolean>, e: DigestEnv): { out: string; wrote?: string } {
  const week = flags.week === undefined ? "last" : flags.week;
  if (week !== "last" && week !== "this") throw new InputError(`--week must be last or this, got "${String(week)}"`);
  if (flags.out !== undefined && (typeof flags.out !== "string" || !flags.out)) throw new InputError("--out needs a file");
  if (flags.json && flags.out) throw new InputError("Pass --json or --out, not both");
  const { db, queries, prices } = openReadOnly(e.dbPath);
  try {
    const d = buildDigest({ db, queries, prices, budgets: e.budgets, user: e.user, host: e.host, now: e.now, lang: e.lang, hiddenTips: e.hiddenTips }, week);
    if (flags.json) {
      const { markdown: _markdown, ...data } = d;
      return { out: JSON.stringify(data, null, 2) + "\n" };
    }
    if (typeof flags.out === "string") {
      const path = expandHome(flags.out);
      writeFileSync(path, d.markdown, { mode: 0o600 });
      return { out: "", wrote: path };
    }
    return { out: d.markdown };
  } finally {
    db.close();
  }
}
