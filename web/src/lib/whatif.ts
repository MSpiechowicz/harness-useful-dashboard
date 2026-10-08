/** A change of cost as a fraction, none when there was no cost to compare with. */
export function whatIfChange(actual: number, whatIf: number): number | null {
  return actual > 0 ? whatIf / actual - 1 : null;
}

/** More cost is worse and less is better, and a change under half a percent is neither. */
export function whatIfTone(change: number | null): "good" | "bad" | "neutral" {
  if (change == null || Math.abs(change) < 0.005) return "neutral";

  return change > 0 ? "bad" : "good";
}
