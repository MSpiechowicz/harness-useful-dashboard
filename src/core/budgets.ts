import type { Database } from "bun:sqlite";
import { getMeta, setMeta } from "./db.ts";
import type { LimitReport } from "./limits.ts";

/** Spending caps in USD at API-equivalent prices, for this machine's user. Null or 0: no cap. */
export interface BudgetConfig {
  daily: number | null;
  monthly: number | null;
  /** Monthly caps per project (the project path, as the Projects view lists it). */
  projects: Record<string, number>;
  /** Desktop notifications when a budget reaches 80% and 100%. */
  notify: boolean;
  /** Desktop notifications when a plan limit is 80% used. */
  limitAlerts: boolean;
}

export const DEFAULT_BUDGETS: BudgetConfig = { daily: null, monthly: null, projects: {}, notify: true, limitAlerts: true };

/** Where an alert goes off: the share of a budget or a limit used. */
export const THRESHOLDS = [0.8, 1] as const;
const LIMIT_THRESHOLD = 0.8;

export interface BudgetItem {
  scope: "daily" | "monthly" | "project";
  project: string | null;
  cap: number;
  spent: number;
  fraction: number;
  /** The period's own key: "2026-10-07" for a day, "2026-10" for a month. */
  period: string;
  /** Where a monthly budget lands at the month's end at this month's daily rate so far. Null for a day. */
  projected: number | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** How the caps stand now, in local time: today, and this month so far. */
export function budgetStatus(db: Database, cfg: BudgetConfig, user: string, now = new Date()): BudgetItem[] {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const month = day.slice(0, 7);
  const spent = (from: number) =>
    db.query<{ c: number }, [number, number, string]>("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage WHERE ts >= ? AND ts < ? AND user = ?").get(from, monthEnd, user)!.c;
  // The month's pace: what it spent per elapsed day so far, carried to the month's last day.
  const elapsed = Math.max(1, (now.getTime() - monthStart) / 86_400_000);
  const pace = (s: number) => (s / elapsed) * ((monthEnd - monthStart) / 86_400_000);

  const items: BudgetItem[] = [];
  if (cfg.daily && cfg.daily > 0) {
    const s = spent(dayStart);
    items.push({ scope: "daily", project: null, cap: cfg.daily, spent: s, fraction: s / cfg.daily, period: day, projected: null });
  }
  if (cfg.monthly && cfg.monthly > 0) {
    const s = spent(monthStart);
    items.push({ scope: "monthly", project: null, cap: cfg.monthly, spent: s, fraction: s / cfg.monthly, period: month, projected: pace(s) });
  }
  const projects = Object.entries(cfg.projects ?? {}).filter(([, cap]) => cap > 0);
  if (projects.length) {
    const rows = db
      .query<{ project: string; c: number }, [number, number, string]>(
        "SELECT project, COALESCE(SUM(cost_usd), 0) AS c FROM usage WHERE ts >= ? AND ts < ? AND user = ? AND project IS NOT NULL GROUP BY project",
      )
      .all(monthStart, monthEnd, user);
    const by = new Map(rows.map((r) => [r.project, r.c]));
    for (const [project, cap] of projects) {
      const s = by.get(project) ?? 0;
      items.push({ scope: "project", project, cap, spent: s, fraction: s / cap, period: month, projected: pace(s) });
    }
  }
  return items;
}

export interface Alert {
  /** Kept in the database once sent, so each goes off once. */
  key: string;
  title: string;
  body: string;
}

export type AlertLang = "en" | "de" | "es" | "fr" | "pl";

const MESSAGES: Record<AlertLang, Record<string, string>> = {
  en: {
    title: "Harness Dashboard",
    daily: "{pct} of today's budget used: {spent} of {cap}.",
    dailyOver: "Today's budget is used up: {spent} of {cap}.",
    monthly: "{pct} of this month's budget used: {spent} of {cap}.",
    monthlyOver: "This month's budget is used up: {spent} of {cap}.",
    project: "{project} used {pct} of its monthly budget: {spent} of {cap}.",
    projectOver: "{project} used up its monthly budget: {spent} of {cap}.",
    limit: "{plan}: {pct} of the {window} limit used.",
    limitReset: "{plan}: {pct} of the {window} limit used. Resets in {left}.",
    test: "Notifications work. You'll hear from the dashboard here.",
  },
  de: {
    title: "Harness Dashboard",
    daily: "{pct} des heutigen Budgets verbraucht: {spent} von {cap}.",
    dailyOver: "Das heutige Budget ist aufgebraucht: {spent} von {cap}.",
    monthly: "{pct} des Monatsbudgets verbraucht: {spent} von {cap}.",
    monthlyOver: "Das Monatsbudget ist aufgebraucht: {spent} von {cap}.",
    project: "{project} hat {pct} seines Monatsbudgets verbraucht: {spent} von {cap}.",
    projectOver: "{project} hat sein Monatsbudget aufgebraucht: {spent} von {cap}.",
    limit: "{plan}: {pct} des {window}-Limits verbraucht.",
    limitReset: "{plan}: {pct} des {window}-Limits verbraucht. Zurückgesetzt in {left}.",
    test: "Benachrichtigungen funktionieren. Das Dashboard meldet sich hier.",
  },
  es: {
    title: "Harness Dashboard",
    daily: "{pct} del presupuesto de hoy usado: {spent} de {cap}.",
    dailyOver: "El presupuesto de hoy se ha agotado: {spent} de {cap}.",
    monthly: "{pct} del presupuesto del mes usado: {spent} de {cap}.",
    monthlyOver: "El presupuesto del mes se ha agotado: {spent} de {cap}.",
    project: "{project} ha usado el {pct} de su presupuesto mensual: {spent} de {cap}.",
    projectOver: "{project} ha agotado su presupuesto mensual: {spent} de {cap}.",
    limit: "{plan}: {pct} del límite de {window} usado.",
    limitReset: "{plan}: {pct} del límite de {window} usado. Se renueva en {left}.",
    test: "Las notificaciones funcionan. El panel te avisará aquí.",
  },
  fr: {
    title: "Harness Dashboard",
    daily: "{pct} du budget du jour utilisé : {spent} sur {cap}.",
    dailyOver: "Le budget du jour est épuisé : {spent} sur {cap}.",
    monthly: "{pct} du budget du mois utilisé : {spent} sur {cap}.",
    monthlyOver: "Le budget du mois est épuisé : {spent} sur {cap}.",
    project: "{project} a utilisé {pct} de son budget mensuel : {spent} sur {cap}.",
    projectOver: "{project} a épuisé son budget mensuel : {spent} sur {cap}.",
    limit: "{plan} : {pct} de la limite de {window} utilisée.",
    limitReset: "{plan} : {pct} de la limite de {window} utilisée. Renouvelée dans {left}.",
    test: "Les notifications fonctionnent. Le tableau de bord vous préviendra ici.",
  },
  pl: {
    title: "Harness Dashboard",
    daily: "Wykorzystano {pct} dzisiejszego budżetu: {spent} z {cap}.",
    dailyOver: "Dzisiejszy budżet się wyczerpał: {spent} z {cap}.",
    monthly: "Wykorzystano {pct} budżetu na ten miesiąc: {spent} z {cap}.",
    monthlyOver: "Budżet na ten miesiąc się wyczerpał: {spent} z {cap}.",
    project: "{project} wykorzystał {pct} miesięcznego budżetu: {spent} z {cap}.",
    projectOver: "{project} wyczerpał miesięczny budżet: {spent} z {cap}.",
    limit: "{plan}: wykorzystano {pct} limitu {window}.",
    limitReset: "{plan}: wykorzystano {pct} limitu {window}. Odnowienie za {left}.",
    test: "Powiadomienia działają. Dashboard da znać tutaj.",
  },
};

export function message(lang: AlertLang, key: string, params: Record<string, string> = {}): string {
  const text = MESSAGES[lang]?.[key] ?? MESSAGES.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, k: string) => params[k] ?? "");
}

const money = (v: number) => `$${v < 100 ? v.toFixed(2) : Math.round(v).toLocaleString("en-US")}`;
const percent = (f: number) => `${Math.round(f * 100)}%`;
const projectName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export function windowName(ms: number | null, label: string | null): string {
  // A monthly quota (Copilot's premium requests) reads better by its name than as "31d".
  if (ms == null || (label && ms > 8 * 86_400_000)) return label ?? "";
  const h = ms / 3_600_000;
  return h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
}

function timeLeft(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.round(h / 24)}d`;
}

/** The budget alerts due now: the highest threshold each budget crossed in its period. */
export function budgetAlerts(items: BudgetItem[], host: string, lang: AlertLang): Alert[] {
  const out: Alert[] = [];
  for (const it of items) {
    const crossed = [...THRESHOLDS].reverse().find((th) => it.fraction >= th);
    if (crossed == null) continue;
    const over = crossed >= 1;
    const key = `alert:${host}:${it.scope}:${it.project ?? ""}:${it.period}:${crossed}`;
    const text = it.scope === "project" ? (over ? "projectOver" : "project") : over ? `${it.scope}Over` : it.scope;
    out.push({ key, title: message(lang, "title"), body: message(lang, text, { pct: percent(it.fraction), spent: money(it.spent), cap: money(it.cap), project: projectName(it.project ?? "") }) });
  }
  return out;
}

/** Plan limits 80% used or more: once per window and reset. */
export function limitAlerts(reports: LimitReport[], host: string, lang: AlertLang, now = Date.now()): Alert[] {
  const out: Alert[] = [];
  for (const r of reports) {
    for (const w of r.windows) {
      if (w.usedFraction < LIMIT_THRESHOLD) continue;
      const key = `alert:${host}:limit:${r.key}:${w.id}:${w.resetsAt ?? "open"}`;
      const plan = [r.provider.charAt(0).toUpperCase() + r.provider.slice(1), r.plan].filter(Boolean).join(" ");
      const window = [windowName(w.windowMs, w.label), w.scope].filter(Boolean).join(" ");
      const params = { plan, window, pct: percent(w.usedFraction), left: w.resetsAt ? timeLeft(w.resetsAt - now) : "" };
      out.push({ key, title: message(lang, "title"), body: message(lang, w.resetsAt ? "limitReset" : "limit", params) });
    }
  }
  return out;
}

/**
 * The alerts not sent before, marked sent. A lower threshold that comes due after a higher one in the same period
 * (a cap raised mid-month) is still sent: the keys are per threshold.
 */
export function takeNew(db: Database, alerts: Alert[]): Alert[] {
  const fresh = alerts.filter((a) => getMeta(db, a.key) == null);
  if (fresh.length) db.transaction(() => fresh.forEach((a) => setMeta(db, a.key, String(Date.now()))))();
  return fresh;
}
