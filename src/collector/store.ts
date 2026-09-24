import { BatchWriteCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { type PriceSlot, type Span } from "../rules/types.js";
import { helsinkiDate } from "../time.js";

// Price slots are worthless once they are in the past, and TTL keeps the table
// permanently inside the 25 GB always-free tier without a cleanup job.
const PRICE_TTL_SECONDS = 30 * 24 * 60 * 60;

// The feed never looks more than ~34 hours ahead, so a week is ample margin.
const NOTIFICATION_TTL_SECONDS = 7 * 24 * 60 * 60;

// DynamoDB rejects BatchWriteItem requests carrying more than 25 items.
const MAX_BATCH_ITEMS = 25;

// BatchWriteItem can partially succeed, returning the rest in UnprocessedItems.
// That is throttling rather than failure, so the leftovers are retried - each
// attempt waiting twice as long as the last, since an immediate retry throttles
// again. Five attempts, pausing 100, 200, 400 and 800 ms.
const MAX_BATCH_ATTEMPTS = 5;
const FIRST_BACKOFF_MS = 100;

export interface PriceStore {
  /** Upserts price slots. Safe to re-run: identical keys overwrite. */
  putPrices(slots: PriceSlot[], now: Date): Promise<void>;
}

/** Remembers which windows have already been emailed about, per rule. */
export interface NotificationLog {
  /** Spans this rule has already alerted on, within the markers' lifetime. */
  notifiedSpans(ruleId: string): Promise<Span[]>;
  /** Records that an alert went out, with the span it covered. */
  markNotified(ruleId: string, span: Span, now: Date): Promise<void>;
}

export interface DynamoStoreDeps {
  client: DynamoDBDocumentClient;
  tableName: string;
  /** Injected so tests do not spend real seconds in the retry backoff. */
  delay?: (ms: number) => Promise<void>;
}

export function createDynamoPriceStore({ client, tableName, delay = sleep }: DynamoStoreDeps): PriceStore {
  return {
    async putPrices(slots: PriceSlot[], now: Date): Promise<void> {
      const ttl = Math.floor(now.getTime() / 1000) + PRICE_TTL_SECONDS;

      for (let i = 0; i < slots.length; i += MAX_BATCH_ITEMS) {
        const requests = slots.slice(i, i + MAX_BATCH_ITEMS).map((slot) => ({
          PutRequest: {
            Item: {
              // The Finnish calendar day, not the UTC one, so "today's prices"
              // is a single query for the only users this serves.
              pk: `PRICE#${helsinkiDate(new Date(slot.startDate))}`,
              sk: slot.startDate,
              price: slot.price,
              ttl,
            },
          },
        }));

        await writeBatch(client, tableName, requests, delay);
      }
    },
  };
}

type WriteRequest = { PutRequest: { Item: Record<string, unknown> } };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeBatch(
  client: DynamoDBDocumentClient,
  tableName: string,
  requests: WriteRequest[],
  delay: (ms: number) => Promise<void>,
): Promise<void> {
  let pending = requests;

  for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt++) {
    const result = await client.send(new BatchWriteCommand({ RequestItems: { [tableName]: pending } }));

    const unprocessed = result.UnprocessedItems?.[tableName] ?? [];
    if (unprocessed.length === 0) {
      return;
    }

    pending = unprocessed as WriteRequest[];
    if (attempt < MAX_BATCH_ATTEMPTS) {
      await delay(FIRST_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }

  throw new Error(
    `BatchWriteItem left ${String(pending.length)} items unprocessed after ${String(MAX_BATCH_ATTEMPTS)} attempts`,
  );
}

export function createDynamoNotificationLog({ client, tableName }: DynamoStoreDeps): NotificationLog {
  return {
    async notifiedSpans(ruleId: string): Promise<Span[]> {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": `NOTIF#${ruleId}` },
          // An eventually consistent read can miss a marker written moments ago,
          // and the cost of missing one is a duplicate email.
          ConsistentRead: true,
        }),
      );

      return (result.Items ?? []).map((item) => ({
        firstStart: item.sk as string,
        lastStart: item.lastStart as string,
        endDate: item.endDate as string,
        cheapestPrice: item.cheapestPrice as number,
        dearestPrice: item.dearestPrice as number,
      }));
    },

    async markNotified(ruleId: string, span: Span, now: Date): Promise<void> {
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            pk: `NOTIF#${ruleId}`,
            sk: span.firstStart,
            lastStart: span.lastStart,
            endDate: span.endDate,
            cheapestPrice: span.cheapestPrice,
            dearestPrice: span.dearestPrice,
            ttl: Math.floor(now.getTime() / 1000) + NOTIFICATION_TTL_SECONDS,
          },
        }),
      );
    },
  };
}
