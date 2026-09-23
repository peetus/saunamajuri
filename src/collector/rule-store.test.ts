import { describe, expect, it, vi } from "vitest";
import { type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { RULE_LIMIT, RuleLimitError, createDynamoRuleStore } from "./rule-store.js";
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

    expect(calls[1]).toEqual({
      TableName: TABLE,
      Item: { pk: "USER#me", sk: "RULE#sauna", rule: SAUNA },
    });
  });

  it("does not put a TTL on a rule", async () => {
    const { client, calls } = fakeClient();
    await createDynamoRuleStore({ client, tableName: TABLE }).putRule(SAUNA);

    expect((calls[1] as { Item: Record<string, unknown> }).Item.ttl).toBeUndefined();
  });

  it("overwrites rather than duplicating when the same id is stored twice", async () => {
    const { client, calls } = fakeClient();
    const store = createDynamoRuleStore({ client, tableName: TABLE });

    await store.putRule(SAUNA);
    await store.putRule({ ...SAUNA, maxAveragePrice: 9 });

    const keys = calls
      .filter((input) => "Item" in (input as object))
      .map((input) => (input as { Item: { sk: string } }).Item.sk);
    expect(keys).toEqual(["RULE#sauna", "RULE#sauna"]);
  });
});

describe("the rule limit", () => {
  /** A page of `count` rules, as DynamoDB would return them. */
  function page(count: number): { Items: { rule: Rule }[] } {
    return { Items: Array.from({ length: count }, (_, i) => ({ rule: { ...SAUNA, id: `rule-${String(i)}` } })) };
  }

  it("accepts a new rule while under the limit", async () => {
    const { client, calls } = fakeClient([page(RULE_LIMIT - 1)]);

    await createDynamoRuleStore({ client, tableName: TABLE }).putRule(SAUNA);

    expect(calls).toHaveLength(2);
  });

  it("refuses a new rule once the limit is reached", async () => {
    const { client, calls } = fakeClient([page(RULE_LIMIT)]);

    await expect(createDynamoRuleStore({ client, tableName: TABLE }).putRule(SAUNA)).rejects.toBeInstanceOf(
      RuleLimitError,
    );
    expect(calls).toHaveLength(1);
  });

  // Refusing every write at the limit would leave the user unable to lower a
  // ceiling on a rule they already have, with no way back but deleting one.
  it("still accepts an edit to a rule that already exists at the limit", async () => {
    const existing = page(RULE_LIMIT);
    existing.Items[0].rule = SAUNA;
    const { client, calls } = fakeClient([existing]);

    await createDynamoRuleStore({ client, tableName: TABLE }).putRule({ ...SAUNA, maxAveragePrice: 9 });

    expect(calls).toHaveLength(2);
  });
});

describe("paging", () => {
  // Sort keys order lexicographically, so rules with earlier-sorting ids are
  // what push the rest onto a second page.
  it("follows the cursor until every rule has been read", async () => {
    const laundry: Rule = { ...SAUNA, id: "laundry" };
    const { client, calls } = fakeClient([
      { Items: [{ rule: SAUNA }], LastEvaluatedKey: { pk: "USER#me", sk: "RULE#sauna" } },
      { Items: [{ rule: laundry }] },
    ]);

    await expect(createDynamoRuleStore({ client, tableName: TABLE }).getRules()).resolves.toEqual([SAUNA, laundry]);
    expect(calls).toHaveLength(2);
    expect((calls[1] as { ExclusiveStartKey?: unknown }).ExclusiveStartKey).toEqual({
      pk: "USER#me",
      sk: "RULE#sauna",
    });
  });

  it("sends no cursor on the first page", async () => {
    const { client, calls } = fakeClient([{ Items: [] }]);

    await createDynamoRuleStore({ client, tableName: TABLE }).getRules();

    expect((calls[0] as { ExclusiveStartKey?: unknown }).ExclusiveStartKey).toBeUndefined();
  });

  it("follows the cursor for a day of prices too", async () => {
    const { client, calls } = fakeClient([
      {
        Items: [{ sk: "2026-09-22T00:00:00.000Z", price: 1 }],
        LastEvaluatedKey: { pk: "PRICE#2026-09-22", sk: "2026-09-22T00:00:00.000Z" },
      },
      { Items: [{ sk: "2026-09-22T00:15:00.000Z", price: 2 }] },
    ]);

    await expect(createDynamoRuleStore({ client, tableName: TABLE }).getPricesForDay("2026-09-22")).resolves.toEqual([
      { startDate: "2026-09-22T00:00:00.000Z", price: 1 },
      { startDate: "2026-09-22T00:15:00.000Z", price: 2 },
    ]);
    expect(calls).toHaveLength(2);
  });

  // A cursor that is echoed back unchanged would spin forever against a real
  // table, and a fake that always returns one would hide it.
  it("stops when the last page carries no cursor", async () => {
    const { client, calls } = fakeClient([{ Items: [{ rule: SAUNA }] }]);

    await createDynamoRuleStore({ client, tableName: TABLE }).getRules();

    expect(calls).toHaveLength(1);
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
