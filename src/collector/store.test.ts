import { describe, expect, it, vi } from "vitest";
import { type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createDynamoPriceStore } from "./store.js";
import { type PriceSlot } from "../rules/types.js";

const NOW = new Date("2026-09-21T00:00:00.000Z");
const TABLE = "prices";

// Injection is what makes this testable: no AWS, no network, no mocking library
// reaching into module internals.
function fakeClient(sends: unknown[] = []): { client: DynamoDBDocumentClient; calls: unknown[] } {
  const calls: unknown[] = [];
  const client = {
    send: vi.fn((command: { input: unknown }) => {
      calls.push(command.input);
      return Promise.resolve(sends[calls.length - 1] ?? {});
    }),
  };
  return { client: client as unknown as DynamoDBDocumentClient, calls };
}

function slots(count: number): PriceSlot[] {
  const start = new Date("2026-09-21T00:00:00.000Z").getTime();
  return Array.from({ length: count }, (_, i) => ({
    startDate: new Date(start + i * 15 * 60_000).toISOString(),
    price: i,
  }));
}

describe("createDynamoPriceStore", () => {
  it("writes nothing when there are no slots", async () => {
    const { client, calls } = fakeClient();
    await createDynamoPriceStore({ client, tableName: TABLE }).putPrices([], NOW);
    expect(calls).toHaveLength(0);
  });

  it("keys each slot by day and start time, with a 30-day TTL", async () => {
    const { client, calls } = fakeClient();
    await createDynamoPriceStore({ client, tableName: TABLE }).putPrices(slots(1), NOW);

    const input = calls[0] as { RequestItems: Record<string, { PutRequest: { Item: Record<string, unknown> } }[]> };
    expect(input.RequestItems[TABLE][0].PutRequest.Item).toEqual({
      pk: "PRICE#2026-09-21",
      sk: "2026-09-21T00:00:00.000Z",
      price: 0,
      ttl: Math.floor(NOW.getTime() / 1000) + 30 * 24 * 60 * 60,
    });
  });

  it("splits into batches of 25, because DynamoDB rejects more", async () => {
    const { client, calls } = fakeClient();
    await createDynamoPriceStore({ client, tableName: TABLE }).putPrices(slots(60), NOW);

    const sizes = calls.map(
      (input) => (input as { RequestItems: Record<string, unknown[]> }).RequestItems[TABLE].length,
    );
    expect(sizes).toEqual([25, 25, 10]);
  });

  it("retries items DynamoDB leaves unprocessed", async () => {
    const leftover = [{ PutRequest: { Item: { pk: "PRICE#2026-09-21", sk: "x" } } }];
    const { client, calls } = fakeClient([{ UnprocessedItems: { [TABLE]: leftover } }, {}]);

    await createDynamoPriceStore({ client, tableName: TABLE }).putPrices(slots(1), NOW);

    expect(calls).toHaveLength(2);
    expect((calls[1] as { RequestItems: Record<string, unknown[]> }).RequestItems[TABLE]).toEqual(leftover);
  });

  it("gives up after repeated unprocessed responses", async () => {
    const leftover = [{ PutRequest: { Item: { pk: "PRICE#2026-09-21", sk: "x" } } }];
    const { client } = fakeClient(Array.from({ length: 5 }, () => ({ UnprocessedItems: { [TABLE]: leftover } })));

    await expect(createDynamoPriceStore({ client, tableName: TABLE }).putPrices(slots(1), NOW)).rejects.toThrow(
      "left 1 items unprocessed",
    );
  });
});
