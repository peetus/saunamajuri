import { describe, expect, it, vi } from "vitest";
import { type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createDynamoNotificationLog, createDynamoPriceStore } from "./store.js";
import { type PriceSlot, type Span } from "../rules/types.js";

const NOW = new Date("2026-09-21T00:00:00.000Z");
const TABLE = "prices";

const noDelay = (): Promise<void> => Promise.resolve();

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

  it("keys each slot by Finnish day and start time, with a 30-day TTL", async () => {
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

  // 21:00Z is midnight in Helsinki in September.
  it("puts a late-evening UTC slot in the next Finnish day's partition", async () => {
    const { client, calls } = fakeClient();
    await createDynamoPriceStore({ client, tableName: TABLE }).putPrices(
      [{ startDate: "2026-09-21T21:00:00.000Z", price: 1 }],
      NOW,
    );

    const input = calls[0] as { RequestItems: Record<string, { PutRequest: { Item: Record<string, unknown> } }[]> };
    expect(input.RequestItems[TABLE][0].PutRequest.Item.pk).toBe("PRICE#2026-09-22");
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

  it("gives up after exactly five unprocessed responses", async () => {
    const leftover = [{ PutRequest: { Item: { pk: "PRICE#2026-09-21", sk: "x" } } }];
    const { client, calls } = fakeClient(
      Array.from({ length: 9 }, () => ({ UnprocessedItems: { [TABLE]: leftover } })),
    );

    await expect(
      createDynamoPriceStore({ client, tableName: TABLE, delay: noDelay }).putPrices(slots(1), NOW),
    ).rejects.toThrow("left 1 items unprocessed");
    // Without this the test passes for an unbounded retry loop too.
    expect(calls).toHaveLength(5);
  });

  // Retrying a throttle with no pause just throttles again.
  it("backs off exponentially between retries, and not after the last", async () => {
    const leftover = [{ PutRequest: { Item: { pk: "PRICE#2026-09-21", sk: "x" } } }];
    const { client } = fakeClient(Array.from({ length: 9 }, () => ({ UnprocessedItems: { [TABLE]: leftover } })));
    const waits: number[] = [];

    await expect(
      createDynamoPriceStore({
        client,
        tableName: TABLE,
        delay: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      }).putPrices(slots(1), NOW),
    ).rejects.toThrow("unprocessed");

    expect(waits).toEqual([100, 200, 400, 800]);
  });

  it("does not wait at all when the first write succeeds", async () => {
    const { client } = fakeClient();
    const waits: number[] = [];

    await createDynamoPriceStore({
      client,
      tableName: TABLE,
      delay: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    }).putPrices(slots(1), NOW);

    expect(waits).toEqual([]);
  });

  it("propagates a client failure rather than swallowing it", async () => {
    const client = { send: vi.fn(() => Promise.reject(new Error("ProvisionedThroughputExceeded"))) };

    await expect(
      createDynamoPriceStore({ client: client as unknown as DynamoDBDocumentClient, tableName: TABLE }).putPrices(
        slots(1),
        NOW,
      ),
    ).rejects.toThrow("ProvisionedThroughputExceeded");
  });
});

describe("createDynamoNotificationLog", () => {
  const SPAN: Span = {
    firstStart: "2026-09-21T22:00:00.000Z",
    lastStart: "2026-09-21T23:00:00.000Z",
    endDate: "2026-09-22T01:00:00.000Z",
    cheapestPrice: 1.5,
    dearestPrice: 2.5,
  };

  it("reports no spans when nothing has been sent", async () => {
    const { client } = fakeClient([{}]);

    await expect(createDynamoNotificationLog({ client, tableName: TABLE }).notifiedSpans("sauna")).resolves.toEqual([]);
  });

  // The caller compares by overlap, so the stored end matters as much as the
  // start. Returning only the key would make every stored span zero-length.
  it("returns each stored span whole, not just its key", async () => {
    const { client } = fakeClient([
      {
        Items: [
          {
            pk: "NOTIF#sauna",
            sk: SPAN.firstStart,
            lastStart: SPAN.lastStart,
            endDate: SPAN.endDate,
            cheapestPrice: 1.5,
            dearestPrice: 2.5,
          },
        ],
      },
    ]);

    await expect(createDynamoNotificationLog({ client, tableName: TABLE }).notifiedSpans("sauna")).resolves.toEqual([
      SPAN,
    ]);
  });

  // A stale read here sends the duplicate the markers exist to prevent.
  it("reads the rule's markers consistently", async () => {
    const { client, calls } = fakeClient([{}]);
    await createDynamoNotificationLog({ client, tableName: TABLE }).notifiedSpans("sauna");

    expect(calls[0]).toEqual({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "NOTIF#sauna" },
      ConsistentRead: true,
    });
  });

  // Two rules can legitimately alert on the same window, so the rule id has to
  // be part of the key rather than only the timestamp.
  it("keys markers per rule, so one rule does not suppress another", async () => {
    const { client, calls } = fakeClient([{}, {}]);
    const log = createDynamoNotificationLog({ client, tableName: TABLE });

    await log.notifiedSpans("sauna");
    await log.notifiedSpans("laundry");

    expect(
      calls.map((input) => (input as { ExpressionAttributeValues: Record<string, string> }).ExpressionAttributeValues),
    ).toEqual([{ ":pk": "NOTIF#sauna" }, { ":pk": "NOTIF#laundry" }]);
  });

  it("writes a marker with its end time and a seven-day TTL from the injected clock", async () => {
    const { client, calls } = fakeClient();
    await createDynamoNotificationLog({ client, tableName: TABLE }).markNotified("sauna", SPAN, NOW);

    expect(calls[0]).toEqual({
      TableName: TABLE,
      Item: {
        pk: "NOTIF#sauna",
        sk: SPAN.firstStart,
        lastStart: SPAN.lastStart,
        endDate: SPAN.endDate,
        cheapestPrice: 1.5,
        dearestPrice: 2.5,
        ttl: Math.floor(NOW.getTime() / 1000) + 7 * 24 * 60 * 60,
      },
    });
  });
});
