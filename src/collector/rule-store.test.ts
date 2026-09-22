import { describe, expect, it, vi } from "vitest";
import { type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createDynamoRuleStore } from "./rule-store.js";
import { type Rule } from "../rules/types.js";

const TABLE = "prices";

const SAUNA: Rule = { id: "sauna", durationMinutes: 120, maxAveragePrice: 3, minLeadTimeMinutes: 720 };

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

describe("getRules", () => {
  it("returns an empty list when the user has no rules", async () => {
    const { client } = fakeClient([{}]);

    await expect(createDynamoRuleStore({ client, tableName: TABLE }).getRules()).resolves.toEqual([]);
  });

  it("unwraps the stored rule from each item", async () => {
    const { client } = fakeClient([{ Items: [{ pk: "USER#me", sk: "RULE#sauna", rule: SAUNA }] }]);

    await expect(createDynamoRuleStore({ client, tableName: TABLE }).getRules()).resolves.toEqual([SAUNA]);
  });

  it("queries only the rule items for the user", async () => {
    const { client, calls } = fakeClient([{}]);
    await createDynamoRuleStore({ client, tableName: TABLE }).getRules();

    expect(calls[0]).toEqual({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": "USER#me", ":prefix": "RULE#" },
    });
  });
});

describe("putRule", () => {
  it("stores the rule under its id", async () => {
    const { client, calls } = fakeClient();
    await createDynamoRuleStore({ client, tableName: TABLE }).putRule(SAUNA);

    expect(calls[0]).toEqual({
      TableName: TABLE,
      Item: { pk: "USER#me", sk: "RULE#sauna", rule: SAUNA },
    });
  });

  it("does not put a TTL on a rule", async () => {
    const { client, calls } = fakeClient();
    await createDynamoRuleStore({ client, tableName: TABLE }).putRule(SAUNA);

    expect((calls[0] as { Item: Record<string, unknown> }).Item.ttl).toBeUndefined();
  });

  it("overwrites rather than duplicating when the same id is stored twice", async () => {
    const { client, calls } = fakeClient();
    const store = createDynamoRuleStore({ client, tableName: TABLE });

    await store.putRule(SAUNA);
    await store.putRule({ ...SAUNA, maxAveragePrice: 9 });

    const keys = calls.map((input) => (input as { Item: { sk: string } }).Item.sk);
    expect(keys).toEqual(["RULE#sauna", "RULE#sauna"]);
  });
});

describe("getPricesForDay", () => {
  it("returns an empty list for a day with no stored prices", async () => {
    const { client } = fakeClient([{}]);

    await expect(createDynamoRuleStore({ client, tableName: TABLE }).getPricesForDay("2026-09-22")).resolves.toEqual(
      [],
    );
  });

  // The DynamoDB key layout must not escape this file: callers get PriceSlot.
  it("maps items back to PriceSlot, not raw items", async () => {
    const { client } = fakeClient([
      { Items: [{ pk: "PRICE#2026-09-22", sk: "2026-09-22T00:00:00.000Z", price: 1.5, ttl: 123 }] },
    ]);

    await expect(createDynamoRuleStore({ client, tableName: TABLE }).getPricesForDay("2026-09-22")).resolves.toEqual([
      { startDate: "2026-09-22T00:00:00.000Z", price: 1.5 },
    ]);
  });

  it("queries the day's partition", async () => {
    const { client, calls } = fakeClient([{}]);
    await createDynamoRuleStore({ client, tableName: TABLE }).getPricesForDay("2026-09-22");

    expect(calls[0]).toEqual({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "PRICE#2026-09-22" },
    });
  });

  // A Finnish day is one partition, so this is a keyed Query and never a Scan.
  it("never issues a Scan", async () => {
    const { client, calls } = fakeClient([{}]);
    await createDynamoRuleStore({ client, tableName: TABLE }).getPricesForDay("2026-09-22");

    expect(calls[0]).toHaveProperty("KeyConditionExpression");
  });
});
