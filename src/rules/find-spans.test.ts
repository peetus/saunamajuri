import { describe, expect, it } from "vitest";
import { findQualifyingSpans } from "./find-spans.js";
import { type PriceSlot, type Rule } from "./types.js";

const NOW = new Date("2026-09-21T00:00:00.000Z");

/** A rule needing 30 minutes, i.e. two slots, with no lead time unless given. */
function rule(overrides: Partial<Rule> = {}): Rule {
  return { id: "sauna", durationMinutes: 30, maxAveragePrice: 5, minLeadTimeMinutes: 0, ...overrides };
}

/** Slots at 15-minute spacing from 01:00, one per price given. */
function slots(...prices: number[]): PriceSlot[] {
  return prices.map((price, i) => ({
    startDate: new Date(NOW.getTime() + 3_600_000 + i * 900_000).toISOString(),
    price,
  }));
}

/** `2026-09-21T01:00:00.000Z` for index 0, one slot per index. */
function at(index: number): string {
  return new Date(NOW.getTime() + 3_600_000 + index * 900_000).toISOString();
}

describe("findQualifyingSpans", () => {
  it("returns nothing for an empty feed", () => {
    expect(findQualifyingSpans([], rule(), NOW)).toEqual([]);
  });

  it("returns nothing when no run is long enough", () => {
    expect(findQualifyingSpans(slots(1), rule(), NOW)).toEqual([]);
  });

  it("returns nothing when every run is over the ceiling", () => {
    expect(findQualifyingSpans(slots(9, 9, 9, 9), rule(), NOW)).toEqual([]);
  });

  it("reports a single qualifying start as a span of one run", () => {
    // Only 1+1 clears 5; every pair involving the 20 does not.
    const [span] = findQualifyingSpans(slots(1, 1, 20, 20), rule(), NOW);

    expect(span).toEqual({
      firstStart: at(0),
      lastStart: at(0),
      endDate: at(2),
      cheapestPrice: 1,
      dearestPrice: 1,
    });
  });

  it("merges every contiguous qualifying start into one span", () => {
    const [span] = findQualifyingSpans(slots(1, 2, 3, 4), rule(), NOW);

    expect(span.firstStart).toBe(at(0));
    expect(span.lastStart).toBe(at(2));
    expect(span.endDate).toBe(at(4));
  });

  it("carries the cheapest and dearest averages across the span", () => {
    const [span] = findQualifyingSpans(slots(1, 2, 3, 4), rule(), NOW);

    expect(span.cheapestPrice).toBe(1.5);
    expect(span.dearestPrice).toBe(3.5);
  });

  it("separates two groups of qualifying starts into two spans", () => {
    const spans = findQualifyingSpans(slots(1, 1, 20, 20, 1, 1), rule(), NOW);

    expect(spans).toHaveLength(2);
    expect(spans[0].firstStart).toBe(at(0));
    expect(spans[1].firstStart).toBe(at(4));
  });

  it("orders spans by time, not by price", () => {
    const spans = findQualifyingSpans(slots(4, 4, 20, 20, 1, 1), rule(), NOW);

    expect(spans.map((s) => s.firstStart)).toEqual([at(0), at(4)]);
    expect(spans[0].cheapestPrice).toBeGreaterThan(spans[1].cheapestPrice);
  });

  it("includes a run exactly at the ceiling", () => {
    expect(findQualifyingSpans(slots(5, 5), rule(), NOW)).toHaveLength(1);
  });

  it("excludes a run a hair over the ceiling", () => {
    expect(findQualifyingSpans(slots(5, 5.01), rule(), NOW)).toEqual([]);
  });

  describe("lead time", () => {
    it("ignores starts sooner than the lead time allows", () => {
      // 90 minutes from NOW is 01:30, so the starts at 01:00 and 01:15 are out.
      const spans = findQualifyingSpans(slots(1, 1, 1, 1), rule({ minLeadTimeMinutes: 90 }), NOW);

      expect(spans[0].firstStart).toBe(at(2));
    });

    it("returns nothing when the lead time excludes every start", () => {
      expect(findQualifyingSpans(slots(1, 1, 1, 1), rule({ minLeadTimeMinutes: 10_000 }), NOW)).toEqual([]);
    });
  });

  describe("gaps in the feed", () => {
    it("does not span a missing slot", () => {
      const present = slots(1, 1, 1, 1);
      const withHole = [present[0], present[1], present[3]];

      const spans = findQualifyingSpans(withHole, rule(), NOW);

      expect(spans).toHaveLength(1);
      expect(spans[0].lastStart).toBe(at(0));
    });

    it("accepts slots handed over out of order", () => {
      const ordered = slots(1, 2, 3, 4);
      const shuffled = [ordered[3], ordered[0], ordered[2], ordered[1]];

      expect(findQualifyingSpans(shuffled, rule(), NOW)).toEqual(findQualifyingSpans(ordered, rule(), NOW));
    });
  });

  describe("duration", () => {
    it("rounds a duration up to whole slots", () => {
      // 20 minutes still needs two slots, so a lone cheap slot is not enough.
      expect(findQualifyingSpans(slots(1), rule({ durationMinutes: 20 }), NOW)).toEqual([]);
      expect(findQualifyingSpans(slots(1, 1), rule({ durationMinutes: 20 }), NOW)).toHaveLength(1);
    });

    it("returns nothing for a duration of zero or less", () => {
      expect(findQualifyingSpans(slots(1, 1), rule({ durationMinutes: 0 }), NOW)).toEqual([]);
      expect(findQualifyingSpans(slots(1, 1), rule({ durationMinutes: -30 }), NOW)).toEqual([]);
    });
  });

  // typeof NaN is "number", and every comparison against it is false, so an
  // unvalidated NaN silently passes a ceiling test rather than failing it.
  describe("hostile input", () => {
    it("never reports a span containing a NaN price", () => {
      expect(findQualifyingSpans(slots(NaN, NaN), rule(), NOW)).toEqual([]);
    });

    it("never reports a span containing an infinite price", () => {
      expect(findQualifyingSpans(slots(Number.POSITIVE_INFINITY, 1), rule(), NOW)).toEqual([]);
    });

    it("reports a negative price rather than discarding it", () => {
      const [span] = findQualifyingSpans(slots(-1, -1), rule(), NOW);

      expect(span.cheapestPrice).toBe(-1);
    });
  });
});
