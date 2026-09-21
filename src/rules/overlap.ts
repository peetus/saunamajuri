import { type Window } from "./types.js";

/**
 * True when two windows share any time at all.
 *
 * Touching windows do not overlap: one ending at 02:00 and the next starting at
 * 02:00 are separate stretches of cheap power, not the same one.
 */
export function overlaps(a: Window, b: Window): boolean {
  return a.startDate < b.endDate && b.startDate < a.endDate;
}
