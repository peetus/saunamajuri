import { type PriceSlot } from "../rules/types.js";

const PRICES_URL = "https://api.porssisahko.net/v2/latest-prices.json";

/** The subset of `fetch` this module needs. Injected so tests never touch the network. */
export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Translates the porssisahko.net response into our own shape.
 *
 * Pure, so it is tested directly against a recorded payload. This is the
 * anti-corruption layer: if the upstream shape changes, only this function does.
 *
 * The API returns slots unordered, so they are sorted here once and every
 * consumer downstream may assume chronological order.
 */
export function parsePrices(raw: unknown): PriceSlot[] {
  if (typeof raw !== "object" || raw === null || !("prices" in raw)) {
    throw new Error("unexpected API response: missing prices array");
  }

  const { prices } = raw;
  if (!Array.isArray(prices)) {
    throw new Error("unexpected API response: missing prices array");
  }

  return prices
    .map((entry): PriceSlot => {
      const { startDate, price } = entry as { startDate?: unknown; price?: unknown };
      if (typeof startDate !== "string" || typeof price !== "number") {
        throw new Error("unexpected API response: malformed price entry");
      }
      return { startDate, price };
    })
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

/** Builds a price fetcher. Pass a fake `fetcher` in tests; the default hits the live API. */
export function createPriceFetcher(fetcher: Fetcher = globalThis.fetch): () => Promise<PriceSlot[]> {
  return async (): Promise<PriceSlot[]> => {
    const response = await fetcher(PRICES_URL);
    if (!response.ok) {
      throw new Error(`price API returned ${String(response.status)}`);
    }
    return parsePrices(await response.json());
  };
}
