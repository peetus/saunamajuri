import { describe, expect, it } from "vitest";
import { findCheapestWindow } from "./find-window.js";
import { type PriceSlot, type Rule } from "./types.js";

const NOW = new Date("2026-09-21T00:00:00.000Z");

/** Builds contiguous 15-minute slots starting at `start`, one per price. */
function slots(start: string, prices: number[]): PriceSlot[] {
  const t0 = new Date(start).getTime();
  return prices.map((price, i) => ({
    startDate: new Date(t0 + i * 15 * 60_000).toISOString(),
    price,
  }));
}

const rule: Rule = {
  id: "sauna",
  durationMinutes: 30,
  maxAveragePrice: 5,
  minLeadTimeMinutes: 0,
};

describe("findCheapestWindow", () => {
  it("returns null when there are not enough slots", () => {
    expect(findCheapestWindow(slots("2026-09-21T01:00:00.000Z", [1]), rule, NOW)).toBeNull();
  });

  it("finds the cheapest run of adjacent slots", () => {
    const result = findCheapestWindow(slots("2026-09-21T01:00:00.000Z", [9, 9, 1, 2, 9]), rule, NOW);

    expect(result).toEqual({
      startDate: "2026-09-21T01:30:00.000Z",
      endDate: "2026-09-21T02:00:00.000Z",
      averagePrice: 1.5,
    });
  });

  it("returns null when the cheapest window is still too expensive", () => {
    expect(findCheapestWindow(slots("2026-09-21T01:00:00.000Z", [9, 9, 9]), rule, NOW)).toBeNull();
  });

  it("ignores windows that start before the lead time", () => {
    const leadRule: Rule = { ...rule, minLeadTimeMinutes: 12 * 60 };

    const result = findCheapestWindow(
      slots("2026-09-21T01:00:00.000Z", [1, 1]).concat(slots("2026-09-21T13:00:00.000Z", [3, 3])),
      leadRule,
      NOW,
    );

    expect(result?.startDate).toBe("2026-09-21T13:00:00.000Z");
  });

  // The feed can have holes, and a naive sliding window would span them.
  it("does not span a gap in the data", () => {
    const gapped = slots("2026-09-21T01:00:00.000Z", [1]).concat(slots("2026-09-21T05:00:00.000Z", [1]));

    expect(findCheapestWindow(gapped, rule, NOW)).toBeNull();
  });

  // Real: the feed has shown -0.009 c/kWh.
  it("handles negative prices", () => {
    const result = findCheapestWindow(slots("2026-09-21T01:00:00.000Z", [3, -1, -3, 3]), rule, NOW);

    expect(result?.averagePrice).toBe(-2);
  });

  it("returns null for an empty feed", () => {
    expect(findCheapestWindow([], rule, NOW)).toBeNull();
  });

  it("finds a window that lies after a gap", () => {
    const gapped = slots("2026-09-21T01:00:00.000Z", [1]).concat(slots("2026-09-21T05:00:00.000Z", [2, 2]));

    expect(findCheapestWindow(gapped, rule, NOW)?.startDate).toBe("2026-09-21T05:00:00.000Z");
  });

  it("sorts an unordered feed before scanning", () => {
    const unordered = slots("2026-09-21T01:00:00.000Z", [9, 1, 1]).reverse();

    expect(findCheapestWindow(unordered, rule, NOW)?.startDate).toBe("2026-09-21T01:15:00.000Z");
  });

  it("rounds a duration up to whole slots", () => {
    const shortRule: Rule = { ...rule, durationMinutes: 20 };

    // 20 minutes needs two 15-minute slots, so the window is 30 minutes long.
    expect(findCheapestWindow(slots("2026-09-21T01:00:00.000Z", [1, 1]), shortRule, NOW)).toEqual({
      startDate: "2026-09-21T01:00:00.000Z",
      endDate: "2026-09-21T01:30:00.000Z",
      averagePrice: 1,
    });
  });

  it("returns null for a rule that needs no time at all", () => {
    expect(
      findCheapestWindow(slots("2026-09-21T01:00:00.000Z", [1, 1]), { ...rule, durationMinutes: 0 }, NOW),
    ).toBeNull();
  });

  it("accepts a window priced exactly at the ceiling", () => {
    expect(findCheapestWindow(slots("2026-09-21T01:00:00.000Z", [5, 5]), rule, NOW)?.averagePrice).toBe(5);
  });

  it("prefers the earlier of two equally cheap windows", () => {
    const result = findCheapestWindow(slots("2026-09-21T01:00:00.000Z", [1, 1, 1, 1]), rule, NOW);

    expect(result?.startDate).toBe("2026-09-21T01:00:00.000Z");
  });

  it("includes a window starting exactly at the lead time", () => {
    const leadRule: Rule = { ...rule, minLeadTimeMinutes: 60 };

    expect(findCheapestWindow(slots("2026-09-21T01:00:00.000Z", [1, 1]), leadRule, NOW)?.startDate).toBe(
      "2026-09-21T01:00:00.000Z",
    );
  });

  // A duplicated timestamp is zero minutes after its predecessor, not fifteen,
  // so it must not count towards a contiguous run.
  it("does not treat duplicated timestamps as contiguous", () => {
    const duplicated = [
      { startDate: "2026-09-21T01:00:00.000Z", price: 1 },
      { startDate: "2026-09-21T01:00:00.000Z", price: 1 },
    ];

    expect(findCheapestWindow(duplicated, rule, NOW)).toBeNull();
  });

  it("scans a full feed of 192 slots without missing the cheapest run", () => {
    const prices = Array.from({ length: 192 }, (_, i) => (i === 100 || i === 101 ? 0.5 : 8));
    const result = findCheapestWindow(slots("2026-09-21T01:00:00.000Z", prices), rule, NOW);

    expect(result?.startDate).toBe(slots("2026-09-21T01:00:00.000Z", prices)[100].startDate);
    expect(result?.averagePrice).toBe(0.5);
  });
});
