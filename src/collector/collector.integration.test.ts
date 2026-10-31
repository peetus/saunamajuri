import { BatchWriteCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { beforeEach, describe, expect, it } from "vitest";
import { createCollector, type CollectorResult } from "./collect.js";
import { createPriceFetcher } from "./fetch-prices.js";
import { createSnsNotifier } from "./notify.js";
import { createDynamoRuleStore } from "./rule-store.js";
import { createDynamoNotificationLog, createDynamoPriceStore } from "./store.js";
import { type Rule } from "../rules/types.js";

// Everything real except the two AWS clients and the network: the collector,
// the anti-corruption layer, both store adapters, the notifier and the rule
// engine all run as deployed. The fake table actually stores what is written,
// so dedupe is exercised rather than stubbed.

const TABLE = "saunamajuri";
const NOW = new Date("2026-09-21T12:00:00.000Z");

const SAUNA: Rule = { id: "sauna", durationMinutes: 120, maxAveragePrice: 3, minLeadTimeMinutes: 12 * 60 };

interface FakeTable {
  client: DynamoDBDocumentClient;
  items: Map<string, Record<string, unknown>>;
}

function fakeTable(): FakeTable {
  const items = new Map<string, Record<string, unknown>>();
  const key = (item: Record<string, unknown> | undefined): string => `${String(item?.pk)}|${String(item?.sk)}`;

  const client = {
    send: (command: unknown) => {
      if (command instanceof BatchWriteCommand) {
        for (const request of command.input.RequestItems?.[TABLE] ?? []) {
          const item = request.PutRequest?.Item;
          if (item !== undefined) {
            items.set(key(item), item);
          }
        }
        return Promise.resolve({});
      }
      if (command instanceof PutCommand) {
        const item = command.input.Item ?? {};
        items.set(key(item), item);
        return Promise.resolve({});
      }
      if (command instanceof QueryCommand) {
        const values = command.input.ExpressionAttributeValues ?? {};
        const pk = values[":pk"] as string;
        const prefix = (values[":prefix"] as string | undefined) ?? "";
        return Promise.resolve({
          Items: [...items.values()].filter((item) => item.pk === pk && String(item.sk).startsWith(prefix)),
        });
      }
      throw new Error("unexpected command");
    },
  };

  return { client: client as unknown as DynamoDBDocumentClient, items };
}

/**
 * A realistic feed: 34 hours of 15-minute slots at 9 c/kWh with a cheap trough
 * overnight, shaped like the payload porssisahko.net actually returns.
 */
function feed(): { prices: { startDate: string; price: number; endDate: string }[] } {
  const start = new Date("2026-09-21T10:00:00.000Z").getTime();
  const troughFrom = new Date("2026-09-22T00:00:00.000Z").getTime();
  const troughTo = new Date("2026-09-22T03:00:00.000Z").getTime();

  return {
    prices: Array.from({ length: 136 }, (_, i) => {
      const at = start + i * 15 * 60_000;
      return {
        startDate: new Date(at).toISOString(),
        endDate: new Date(at + 15 * 60_000 - 1).toISOString(),
        price: at >= troughFrom && at < troughTo ? 1.5 : 9,
      };
    }),
  };
}

/** Seeds rules through the real store, so the collector reads them back as deployed. */
async function seed(table: FakeTable, rules: Rule[]): Promise<void> {
  const store = createDynamoRuleStore({ client: table.client, tableName: TABLE });
  for (const rule of rules) {
    await store.putRule(rule);
  }
}

function build(
  table: FakeTable,
  published: PublishCommand["input"][],
  now: Date = NOW,
): () => Promise<CollectorResult> {
  const sns = {
    send: (command: PublishCommand) => {
      published.push(command.input);
      return Promise.resolve({});
    },
  };

  return createCollector({
    fetchPrices: createPriceFetcher(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(feed()) }),
    ),
    store: createDynamoPriceStore({ client: table.client, tableName: TABLE }),
    notifications: createDynamoNotificationLog({ client: table.client, tableName: TABLE }),
    notifier: createSnsNotifier({ client: sns as unknown as SNSClient, topicArn: "arn:aws:sns:test" }),
    rules: createDynamoRuleStore({ client: table.client, tableName: TABLE }),
    now: () => now,
  });
}

describe("the collector, wired to its real collaborators", () => {
  let table: FakeTable;
  let published: PublishCommand["input"][];

  beforeEach(async () => {
    table = fakeTable();
    published = [];
    await seed(table, [SAUNA]);
  });

  it("stores the whole feed, one item per slot", async () => {
    const result = await build(table, published)();

    expect(result.stored).toBe(136);
    const priceItems = [...table.items.values()].filter((item) => String(item.pk).startsWith("PRICE#"));
    expect(priceItems).toHaveLength(136);
  });

  it("partitions slots by Finnish day, so one day is one query", async () => {
    await build(table, published)();

    const partitions = new Set(
      [...table.items.values()].map((item) => item.pk).filter((pk) => String(pk).startsWith("PRICE#")),
    );
    expect([...partitions].sort()).toEqual(["PRICE#2026-09-21", "PRICE#2026-09-22"]);
  });

  // 21:00Z is midnight in Helsinki, so this slot belongs to the next Finnish
  // day - the three hours a night a UTC-keyed partition would misplace.
  it("puts the 21:00Z slot on the next Finnish day", async () => {
    await build(table, published)();

    expect(table.items.get("PRICE#2026-09-22|2026-09-21T21:00:00.000Z")).toBeDefined();
    expect(table.items.get("PRICE#2026-09-21|2026-09-21T21:00:00.000Z")).toBeUndefined();
  });

  // The user story: it is midday, tomorrow's prices are out, and the sauna
  // should heat in the cheapest two-hour stretch at least twelve hours away.
  it("emails one alert naming the overnight trough", async () => {
    const result = await build(table, published)();

    expect(result.alerted).toEqual(["sauna"]);
    expect(published).toHaveLength(1);
    expect(published[0].Subject).toBe("Saunamajuri: sauna from 1.50 c/kWh");
    // 00:00Z is 03:00 in Helsinki, and this trough is wide enough that the
    // start range is a range rather than collapsing to a single instant.
    expect(published[0].Message).toContain("start ti 03.00 - ti 04.15");
    expect(published[0].Message).toContain("1.50-2.44");
  });

  // The user story behind batching: at 1 c/kWh everything qualifies at once,
  // and three appliances should not mean three emails.
  it("covers every qualifying appliance in one email", async () => {
    await seed(table, [
      { id: "dishwasher", durationMinutes: 120, maxAveragePrice: 10, minLeadTimeMinutes: 720 },
      { id: "laundry", durationMinutes: 120, maxAveragePrice: 10, minLeadTimeMinutes: 720 },
    ]);

    const result = await build(table, published)();

    expect(result.alerted.sort()).toEqual(["dishwasher", "laundry", "sauna"]);
    expect(published).toHaveLength(1);
    expect(published[0].Message).toContain("dishwasher");
    expect(published[0].Message).toContain("laundry");
    expect(published[0].Message).toContain("sauna");
    expect(published[0].Message).toContain("your limit is 10");
    expect(published[0].Message).toContain("your limit is 3");
  });

  // Each appliance keeps its own marker, so one already reported drops out of
  // the batch while the rest still go.
  it("leaves an already-reported appliance out of the next email", async () => {
    await seed(table, [{ id: "dishwasher", durationMinutes: 120, maxAveragePrice: 10, minLeadTimeMinutes: 720 }]);
    await build(table, published)();

    await seed(table, [{ id: "laundry", durationMinutes: 120, maxAveragePrice: 10, minLeadTimeMinutes: 720 }]);
    const second = await build(table, published, new Date("2026-09-21T13:00:00.000Z"))();

    expect(second.alerted).toEqual(["laundry"]);
    expect(published).toHaveLength(2);
    expect(published[1].Message).toContain("laundry");
    expect(published[1].Message).not.toContain("dishwasher");
  });

  // The clock must advance, or the span cannot slide and the case is empty.
  it("sends nothing an hour later, when the span has slid inside the same trough", async () => {
    await build(table, published)();
    const second = await build(table, published, new Date("2026-09-21T13:00:00.000Z"))();

    expect(second.alerted).toEqual([]);
    expect(published).toHaveLength(1);
  });

  it("stays quiet across every run of an afternoon", async () => {
    for (const hour of ["12:00", "13:00", "14:00", "15:00", "16:00", "17:00"]) {
      await build(table, published, new Date(`2026-09-21T${hour}:00.000Z`))();
    }

    expect(published).toHaveLength(1);
  });

  it("re-stores the same slots without duplicating them", async () => {
    await build(table, published)();
    const sizeAfterFirst = table.items.size;
    await build(table, published)();

    expect(table.items.size).toBe(sizeAfterFirst);
  });

  it("leaves a marker that expires, so the table cannot grow without bound", async () => {
    await build(table, published)();

    const marker = [...table.items.values()].find((item) => String(item.pk).startsWith("NOTIF#"));
    expect(marker?.ttl).toBe(Math.floor(NOW.getTime() / 1000) + 7 * 24 * 60 * 60);
  });

  it("tells a rule with no affordable window apart from one that has it", async () => {
    const strict: Rule = { id: "dishwasher", durationMinutes: 120, maxAveragePrice: 1, minLeadTimeMinutes: 12 * 60 };
    await seed(table, [strict]);
    const result = await build(table, published)();

    expect(result.alerted).toEqual(["sauna"]);
  });

  it("refuses a feed carrying a NaN price rather than emailing one", async () => {
    const collect = createCollector({
      fetchPrices: createPriceFetcher(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ prices: [{ startDate: "2026-09-22T00:00:00.000Z", price: NaN }] }),
        }),
      ),
      store: createDynamoPriceStore({ client: table.client, tableName: TABLE }),
      notifications: createDynamoNotificationLog({ client: table.client, tableName: TABLE }),
      notifier: createSnsNotifier({
        client: { send: () => Promise.resolve({}) } as unknown as SNSClient,
        topicArn: "t",
      }),
      rules: createDynamoRuleStore({ client: table.client, tableName: TABLE }),
      now: () => NOW,
    });

    await expect(collect()).rejects.toThrow("malformed price entry");
    expect(published).toEqual([]);
  });
});
