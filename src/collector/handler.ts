import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { requireEnv } from "../config.js";
import { createPriceFetcher } from "./fetch-prices.js";
import { createDynamoPriceStore, type PriceStore } from "./store.js";
import { type PriceSlot } from "../rules/types.js";

export interface CollectorDeps {
  fetchPrices: () => Promise<PriceSlot[]>;
  store: PriceStore;
  now: () => Date;
}

export function createCollector({ fetchPrices, store, now }: CollectorDeps) {
  return async function collect(): Promise<{ stored: number }> {
    const slots = await fetchPrices();
    await store.putPrices(slots, now());

    console.log(JSON.stringify({ msg: "collected prices", slots: slots.length }));
    return { stored: slots.length };
  };
}

// Composition root. Module scope, so this runs once per cold start rather than
// once per invocation, and a missing TABLE_NAME kills the container immediately.
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = createCollector({
  fetchPrices: createPriceFetcher(),
  store: createDynamoPriceStore({ client: documentClient, tableName: requireEnv("TABLE_NAME") }),
  now: () => new Date(),
});
