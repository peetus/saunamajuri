import { describe, expect, it } from "vitest";
import { createPriceFetcher, parsePrices, type Fetcher } from "./fetch-prices.js";

describe("parsePrices", () => {
  it("maps the API shape to PriceSlot[]", () => {
    const raw = {
      prices: [{ price: 1.982, startDate: "2026-09-21T21:45:00.000Z", endDate: "2026-09-21T21:59:59.999Z" }],
    };

    expect(parsePrices(raw)).toEqual([{ startDate: "2026-09-21T21:45:00.000Z", price: 1.982 }]);
  });

  it("sorts slots chronologically", () => {
    const raw = {
      prices: [
        { price: 2, startDate: "2026-09-21T22:00:00.000Z" },
        { price: 1, startDate: "2026-09-21T21:45:00.000Z" },
      ],
    };

    expect(parsePrices(raw).map((slot) => slot.price)).toEqual([1, 2]);
  });

  it("throws when the payload has no prices array", () => {
    expect(() => parsePrices({ nope: true })).toThrow("unexpected API response");
  });

  // Split per field: one case asserting both are wrong passes even if only one
  // check exists.
  it("throws when startDate is not a string", () => {
    expect(() => parsePrices({ prices: [{ startDate: 5, price: 1 }] })).toThrow("malformed price entry");
  });

  it("throws when price is not a number", () => {
    expect(() => parsePrices({ prices: [{ startDate: "2026-09-21T00:00:00.000Z", price: "free" }] })).toThrow(
      "malformed price entry",
    );
  });

  // typeof NaN is "number", so nothing above this catches it.
  it("rejects a NaN price", () => {
    expect(() => parsePrices({ prices: [{ startDate: "2026-09-21T00:00:00.000Z", price: NaN }] })).toThrow(
      "malformed price entry",
    );
  });

  it("rejects an infinite price", () => {
    expect(() => parsePrices({ prices: [{ startDate: "2026-09-21T00:00:00.000Z", price: Infinity }] })).toThrow(
      "malformed price entry",
    );
  });

  // An unparseable date silently drops out of every window instead of failing.
  it("rejects an unparseable startDate", () => {
    expect(() => parsePrices({ prices: [{ startDate: "viime tiistaina", price: 1 }] })).toThrow(
      "malformed price entry",
    );
  });

  it("accepts a zero price", () => {
    expect(parsePrices({ prices: [{ startDate: "2026-09-21T00:00:00.000Z", price: 0 }] })[0].price).toBe(0);
  });

  // Later entries win, so a repeat reads as a correction.
  it("collapses a repeated startDate to one slot, keeping the later entry", () => {
    const raw = {
      prices: [
        { startDate: "2026-09-21T00:00:00.000Z", price: 1 },
        { startDate: "2026-09-21T00:15:00.000Z", price: 2 },
        { startDate: "2026-09-21T00:00:00.000Z", price: 9 },
      ],
    };

    expect(parsePrices(raw)).toEqual([
      { startDate: "2026-09-21T00:00:00.000Z", price: 9 },
      { startDate: "2026-09-21T00:15:00.000Z", price: 2 },
    ]);
  });

  it("accepts an empty price list", () => {
    expect(parsePrices({ prices: [] })).toEqual([]);
  });

  it("throws when prices is not an array", () => {
    expect(() => parsePrices({ prices: "soon" })).toThrow("missing prices array");
  });

  it("throws on null", () => {
    expect(() => parsePrices(null)).toThrow("missing prices array");
  });
});

describe("createPriceFetcher", () => {
  const okResponse = (body: unknown): Awaited<ReturnType<Fetcher>> => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });

  it("returns parsed slots from the injected fetcher", async () => {
    const fetchPrices = createPriceFetcher(() =>
      Promise.resolve(okResponse({ prices: [{ price: 3, startDate: "2026-09-21T00:00:00.000Z" }] })),
    );

    await expect(fetchPrices()).resolves.toEqual([{ startDate: "2026-09-21T00:00:00.000Z", price: 3 }]);
  });

  it("throws on a non-ok response", async () => {
    const fetchPrices = createPriceFetcher(() =>
      Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
    );

    await expect(fetchPrices()).rejects.toThrow("price API returned 503");
  });
});
