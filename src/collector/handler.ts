import { createPriceFetcher } from "./fetch-prices.js";

// Composition root: runs once per cold start, not per invocation.
const fetchPrices = createPriceFetcher();

export const handler = async (): Promise<{ stored: number }> => {
  const slots = await fetchPrices();
  console.log(JSON.stringify({ msg: "collected prices", slots: slots.length }));
  return { stored: slots.length };
};
