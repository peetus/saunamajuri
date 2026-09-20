import { BatchWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { type PriceSlot } from "../rules/types.js";

// Price slots are worthless once they are in the past, and TTL keeps the table
// permanently inside the 25 GB always-free tier without a cleanup job.
const PRICE_TTL_SECONDS = 30 * 24 * 60 * 60;

// DynamoDB rejects BatchWriteItem requests carrying more than 25 items.
const MAX_BATCH_ITEMS = 25;

// BatchWriteItem can partially succeed, returning the rest in UnprocessedItems.
// That is throttling, not failure, so the leftovers are retried rather than thrown.
const MAX_BATCH_ATTEMPTS = 5;

export interface PriceStore {
  /** Upserts price slots. Safe to re-run: identical keys overwrite. */
  putPrices(slots: PriceSlot[], now: Date): Promise<void>;
}

export interface DynamoPriceStoreDeps {
  client: DynamoDBDocumentClient;
  tableName: string;
}

export function createDynamoPriceStore({ client, tableName }: DynamoPriceStoreDeps): PriceStore {
  return {
    async putPrices(slots: PriceSlot[], now: Date): Promise<void> {
      const ttl = Math.floor(now.getTime() / 1000) + PRICE_TTL_SECONDS;

      for (let i = 0; i < slots.length; i += MAX_BATCH_ITEMS) {
        const requests = slots.slice(i, i + MAX_BATCH_ITEMS).map((slot) => ({
          PutRequest: {
            Item: {
              // Partitioning by day keeps a single day's slots in one partition,
              // so the API can read a day with one query.
              pk: `PRICE#${slot.startDate.slice(0, 10)}`,
              sk: slot.startDate,
              price: slot.price,
              ttl,
            },
          },
        }));

        await writeBatch(client, tableName, requests);
      }
    },
  };
}

type WriteRequest = { PutRequest: { Item: Record<string, unknown> } };

async function writeBatch(client: DynamoDBDocumentClient, tableName: string, requests: WriteRequest[]): Promise<void> {
  let pending = requests;

  for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt++) {
    const result = await client.send(new BatchWriteCommand({ RequestItems: { [tableName]: pending } }));

    const unprocessed = result.UnprocessedItems?.[tableName] ?? [];
    if (unprocessed.length === 0) {
      return;
    }

    pending = unprocessed as WriteRequest[];
  }

  throw new Error(
    `BatchWriteItem left ${String(pending.length)} items unprocessed after ${String(MAX_BATCH_ATTEMPTS)} attempts`,
  );
}
