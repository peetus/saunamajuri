import { describe, expect, it } from "vitest";
import { overlaps } from "./overlap.js";
import { type Span } from "./types.js";

function window(startHour: number, endHour: number): Span {
  const at = (hour: number): string => `2026-09-22T${String(hour).padStart(2, "0")}:00:00.000Z`;
  return {
    firstStart: at(startHour),
    lastStart: at(startHour),
    endDate: at(endHour),
    cheapestPrice: 1,
    dearestPrice: 1,
  };
}

describe("overlaps", () => {
  it("is true for identical windows", () => {
    expect(overlaps(window(0, 2), window(0, 2))).toBe(true);
  });

  // The case the dedupe exists for: as the lead-time cutoff advances, the same
  // trough is reported one slot later each hour.
  it("is true when one window has slid forward inside the other's trough", () => {
    expect(overlaps(window(0, 2), window(1, 3))).toBe(true);
  });

  it("is true when one window contains the other", () => {
    expect(overlaps(window(0, 6), window(2, 3))).toBe(true);
  });

  it("is false for windows that merely touch", () => {
    expect(overlaps(window(0, 2), window(2, 4))).toBe(false);
  });

  it("is false for separated windows", () => {
    expect(overlaps(window(0, 2), window(5, 7))).toBe(false);
  });

  it("does not depend on argument order", () => {
    expect(overlaps(window(1, 3), window(0, 2))).toBe(true);
    expect(overlaps(window(5, 7), window(0, 2))).toBe(false);
  });
});
