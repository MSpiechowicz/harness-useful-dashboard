import { i18n, t } from "./i18n.svelte.ts";

const cache = new Map<string, Intl.NumberFormat>();
function nf(opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = i18n.locale + JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(i18n.locale, opts);
    cache.set(key, f);
  }
  return f;
}

/** 1,284 / 12.9K / 4.2M / 3.1B */
export function compact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  if (Math.abs(n) < 10_000) return nf({ maximumFractionDigits: 0 }).format(n);
  return nf({ notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** A plain number with a fixed count of decimals, in the UI locale (19.9 / 19,9). */
export function decimal(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return nf({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

/** Up to `digits` decimals, without trailing zeros (0 / 1.3 / 10). */
export function trimmed(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return nf({ maximumFractionDigits: digits }).format(n);
}

export function integer(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return nf({ maximumFractionDigits: 0 }).format(n);
}

export function usd(n: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (n == null || !Number.isFinite(n)) return "–";
  const abs = Math.abs(n);
  // The short "$" in every language: "1198 $" rather than "1198 USD" (Polish) or "1 198 $US" (French).
  if (opts.compact && abs >= 10_000) return nf({ style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", notation: "compact", maximumFractionDigits: 1 }).format(n);
  const digits = abs > 0 && abs < 0.01 ? 4 : abs < 100 ? 2 : 0;
  return nf({ style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

export function percent(x: number | null | undefined, digits = 0, opts: { trim?: boolean } = {}): string {
  if (x == null || !Number.isFinite(x)) return "–";
  return nf({ style: "percent", maximumFractionDigits: digits, minimumFractionDigits: opts.trim ? 0 : digits }).format(x);
}

export function metricValue(n: number, metric: "tokens" | "cost", short = true): string {
  return metric === "cost" ? usd(n, { compact: short }) : compact(n);
}

export function dateTime(ts: number | null | undefined): string {
  if (!ts) return "–";
  return new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium", timeStyle: "short" }).format(ts);
}

export function shortDate(ts: number | string | null | undefined): string {
  if (!ts) return "–";
  const d = typeof ts === "string" ? parseBucket(ts) : new Date(ts);
  return new Intl.DateTimeFormat(i18n.locale, { month: "short", day: "numeric" }).format(d);
}

/** A day with its year: Jul 27, 2026 / 27.07.2026. */
export function dayWithYear(ts: number): string {
  return new Intl.DateTimeFormat(i18n.locale, { year: "numeric", month: "short", day: "numeric" }).format(new Date(ts));
}

export function time(ts: number): string {
  return new Intl.DateTimeFormat(i18n.locale, { hour: "2-digit", minute: "2-digit" }).format(ts);
}

/** Bucket labels from the API: "2026-09-14", "2026-09-14 13:00", "2026-09". */
export function parseBucket(b: string): Date {
  if (/^\d{4}-\d{2}$/.test(b)) return new Date(`${b}-01T00:00:00`);
  return new Date(b.replace(" ", "T") + (b.length === 10 ? "T00:00:00" : ":00"));
}

export function bucketLabel(b: string, bucket: string): string {
  const d = parseBucket(b);
  if (bucket === "hour") return new Intl.DateTimeFormat(i18n.locale, { weekday: "short", hour: "2-digit" }).format(d);
  if (bucket === "month") return new Intl.DateTimeFormat(i18n.locale, { month: "short", year: "numeric" }).format(d);
  return new Intl.DateTimeFormat(i18n.locale, { month: "short", day: "numeric" }).format(d);
}

export function relative(ts: number | null | undefined): string {
  if (!ts) return "–";
  const diff = (ts - Date.now()) / 1000;
  // The short style keeps it to a table cell in every language: "20 sec. ago", "il y a 20 s", "20 sek. temu".
  const rtf = new Intl.RelativeTimeFormat(i18n.locale, { numeric: "auto", style: "short" });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return shortDate(ts);
}

/** A count of days by the language's plural rules: "1 day", "12 days". */
export function days(n: number): string {
  return t(new Intl.PluralRules(i18n.locale).select(n) === "one" ? "common.day" : "common.days", { n: nf({ maximumFractionDigits: 0 }).format(n) });
}

/** How long until a moment, in its two largest units: "4h 30m", "1d 10h", "12m". */
export function until(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "–";
  const minutes = Math.max(0, Math.round((ts - now) / 60_000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  // Units in the UI's language, as short as it writes them: "3h 22m", "3 h 22 min", "3 Std. 22 Min.".
  const unit = (n: number, u: "day" | "hour" | "minute") => nf({ style: "unit", unit: u, unitDisplay: "narrow" }).format(n);
  return d ? `${unit(d, "day")} ${unit(h, "hour")}` : h ? `${unit(h, "hour")} ${unit(m, "minute")}` : unit(m, "minute");
}

export function shortPath(p: string | null | undefined, keep = 2): string {
  if (!p) return "–";
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length <= keep ? p : "…/" + parts.slice(-keep).join("/");
}

/** Display name for a dimension value: localizes the "other" bucket, token types and missing values. */
export function entityLabel(dim: string, key: string | null, label: string): string {
  if (key === "__other__") return t("chart.other");
  if (dim === "type") return t(`tok.${key}` as "tok.input");
  if (key == null || key === "(none)") return dim === "project" ? t("common.noProject") : t("common.none");
  return label;
}
