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

  it("throws when an entry is malformed", () => {
    expect(() => parsePrices({ prices: [{ startDate: 5, price: "free" }] })).toThrow("malformed price entry");
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
