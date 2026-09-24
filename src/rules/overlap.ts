import { type Span } from "./types.js";

/**
 * True when two spans share any time at all.
 *
 * Touching spans do not overlap: one ending at 02:00 and the next starting at
 * 02:00 are separate stretches of cheap power, not the same one.
 *
 * Measured from the first start to the end of a run beginning at the last one,
 * which is the whole stretch the span describes rather than any single run
 * inside it.
 */
export function overlaps(a: Span, b: Span): boolean {
  return a.firstStart < b.endDate && b.firstStart < a.endDate;
}
