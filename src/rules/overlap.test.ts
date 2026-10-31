import { describe, expect, it } from "vitest";
import { overlaps } from "./overlap.js";
import { type Span } from "./types.js";

function span(startHour: number, endHour: number): Span {
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
  it("is true for identical spans", () => {
    expect(overlaps(span(0, 2), span(0, 2))).toBe(true);
  });

  // The case the dedupe exists for: as the lead-time cutoff advances, the same
  // trough is reported one slot later each hour.
  it("is true when one span has slid forward inside the other's trough", () => {
    expect(overlaps(span(0, 2), span(1, 3))).toBe(true);
  });

  it("is true when one span contains the other", () => {
    expect(overlaps(span(0, 6), span(2, 3))).toBe(true);
  });

  it("is false for spans that merely touch", () => {
    expect(overlaps(span(0, 2), span(2, 4))).toBe(false);
  });

  it("is false for separated spans", () => {
    expect(overlaps(span(0, 2), span(5, 7))).toBe(false);
  });

  it("does not depend on argument order", () => {
    expect(overlaps(span(1, 3), span(0, 2))).toBe(true);
    expect(overlaps(span(5, 7), span(0, 2))).toBe(false);
  });
});
