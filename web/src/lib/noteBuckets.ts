// Where a chart note sits on a time series. Kept free of the chart and UI code so it can be tested on its own.
// Bucket keys are the ones the server makes (bucketExpr in src/core/queries.ts): a day is the local date
// "2026-09-14", an hour "2026-09-14 13:00", a week its Monday's date, a month "2026-09".

const pad = (n: number) => String(n).padStart(2, "0");

/** The local date of an instant, "YYYY-MM-DD". */
export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The Monday of the week a local date "YYYY-MM-DD" is in. */
export function mondayOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return localDay(date.getTime());
}

/** The local date a bucket starts on. */
export function bucketDay(key: string, bucket: string): string {
  return bucket === "month" ? `${key}-01` : key.slice(0, 10);
}

/**
 * The index of the bucket a note falls in, or null when the series has none for it (notes outside the range are not
 * drawn, and weeks and months exist only where there is usage). A day note stands for its whole day: on hourly
 * buckets it sits at the day's first hour that has usage.
 */
export function noteBucketIndex(buckets: readonly string[], bucket: string, note: { ts: number; day: string | null }): number | null {
  const day = note.day ?? localDay(note.ts);
  let index: number;

  if (bucket === "hour") {
    if (note.day) index = buckets.findIndex((b) => b.startsWith(day));
    else index = buckets.indexOf(`${day} ${pad(new Date(note.ts).getHours())}:00`);
  } else if (bucket === "week") {
    index = buckets.indexOf(mondayOf(day));
  } else if (bucket === "month") {
    index = buckets.indexOf(day.slice(0, 7));
  } else {
    index = buckets.indexOf(day);
  }

  return index < 0 ? null : index;
}
