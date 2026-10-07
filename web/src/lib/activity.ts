/** Day-by-day activity over the selected range: the calendar and the streak stats beside it read it from here. */

export interface ActivityDay {
  day: string;
  tokens: number;
  cost: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDay = (k: string) => new Date(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** The days the range covers: from its start (or the first active day) to its end, never past today. */
export function daySpan(days: readonly ActivityDay[], range: { from?: number; to?: number }): { start: string; end: string } {
  const today = dayKey(new Date());
  const start = range.from != null ? new Date(range.from) : days[0] ? parseDay(days[0].day) : new Date();
  const end = dayKey(range.to != null ? new Date(range.to - 1) : new Date());
  return { start: dayKey(start), end: end > today ? today : end };
}

/** The first day of each month the span touches, oldest first. */
export function spanMonths(span: { start: string; end: string }): Date[] {
  const first = parseDay(span.start);
  const last = parseDay(span.end);
  const out: Date[] = [];
  for (let m = new Date(first.getFullYear(), first.getMonth(), 1); m <= last; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) out.push(m);
  return out;
}

export interface ActivityStats {
  active: number;
  total: number;
  current: number;
  longest: number;
  /** First and last day of the longest streak (the latest one, when several are as long). */
  longestFrom: string | null;
  longestTo: string | null;
  busiest: ActivityDay | null;
  /** Average over the days with any usage. */
  average: number;
  /** First day of the current streak. */
  currentSince: string | null;
  /** 0 = Monday; null when nothing was used. */
  busiestWeekday: number | null;
  /** That weekday's share of all usage in the range. */
  busiestWeekdayShare: number;
}

export function activityStats(days: readonly ActivityDay[], span: { start: string; end: string }, value: (d: ActivityDay) => number): ActivityStats {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const v = (k: string) => {
    const d = byDay.get(k);
    return d ? value(d) : 0;
  };
  let active = 0;
  let total = 0;
  let run = 0;
  let longest = 0;
  let longestFrom: string | null = null;
  let longestTo: string | null = null;
  let sum = 0;
  let busiest: ActivityDay | null = null;
  const weekdays = [0, 0, 0, 0, 0, 0, 0];
  for (let d = parseDay(span.start); dayKey(d) <= span.end; d = addDays(d, 1)) {
    const k = dayKey(d);
    total++;
    if (v(k) > 0) {
      active++;
      sum += v(k);
      weekdays[(d.getDay() + 6) % 7]! += v(k);
      if (++run >= longest) {
        longest = run;
        longestTo = k;
        longestFrom = dayKey(addDays(d, 1 - run));
      }
      if (!busiest || v(k) > value(busiest)) busiest = byDay.get(k)!;
    } else run = 0;
  }
  // The current streak runs up to today, or up to yesterday while today has no usage yet.
  const today = dayKey(new Date());
  let current = 0;
  let d = parseDay(span.end);
  if (span.end === today && !(v(today) > 0)) d = addDays(d, -1);
  let currentSince: string | null = null;
  while (dayKey(d) >= span.start && v(dayKey(d)) > 0) {
    current++;
    currentSince = dayKey(d);
    d = addDays(d, -1);
  }
  const top = Math.max(...weekdays);
  return {
    active,
    total,
    current,
    currentSince,
    longest,
    longestFrom,
    longestTo,
    busiest,
    average: active ? sum / active : 0,
    busiestWeekday: top > 0 ? weekdays.indexOf(top) : null,
    busiestWeekdayShare: sum ? top / sum : 0,
  };
}
