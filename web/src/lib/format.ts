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

export function integer(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return nf({ maximumFractionDigits: 0 }).format(n);
}

export function usd(n: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (n == null || !Number.isFinite(n)) return "–";
  const abs = Math.abs(n);
  if (opts.compact && abs >= 10_000) return nf({ style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(n);
  const digits = abs > 0 && abs < 0.01 ? 4 : abs < 100 ? 2 : 0;
  return nf({ style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

export function percent(x: number | null | undefined, digits = 0): string {
  if (x == null || !Number.isFinite(x)) return "–";
  return nf({ style: "percent", maximumFractionDigits: digits, minimumFractionDigits: digits }).format(x);
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
  const rtf = new Intl.RelativeTimeFormat(i18n.locale, { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return shortDate(ts);
}

/** How long until a moment, in its two largest units: "4h 30m", "1d 10h", "12m". */
export function until(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "–";
  const minutes = Math.max(0, Math.round((ts - now) / 60_000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
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
