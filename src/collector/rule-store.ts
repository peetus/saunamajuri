import { PutCommand, QueryCommand, type QueryCommandInput } from "@aws-sdk/lib-dynamodb";
import { type PriceSlot, type Rule } from "../rules/types.js";
import { type DynamoStoreDeps } from "./store.js";

// The API is unauthenticated and single-user, so there is nobody to derive an
// identity from. A placeholder for a real one, not a design.
const USER = "USER#me";

/** Generous for a household, and small enough to bound the table and the email. */
export const RULE_LIMIT = 10;

export class RuleLimitError extends Error {
  constructor(readonly limit: number) {
    super(`at most ${String(limit)} rules`);
    this.name = "RuleLimitError";
  }
}

export interface RuleStore {
  getRules(): Promise<Rule[]>;
  /**
   * Upserts a rule. Safe to re-run: the same id overwrites.
   *
   * Throws `RuleLimitError` when a new id would take the count past
   * `RULE_LIMIT`. Replacing an existing rule is always allowed.
   */
  putRule(rule: Rule): Promise<void>;
  /** `day` is a Finnish calendar day, `YYYY-MM-DD`, as `helsinkiDate` renders it. */
  getPricesForDay(day: string): Promise<PriceSlot[]>;
}

/**
 * Runs a Query to exhaustion.
 *
 * A Query stops at a megabyte and hands back a cursor. Reading only the first
 * page returns a prefix of the answer with no error, which for rules means the
 * collector quietly alerting on a subset of them.
 */
async function queryAll(
  client: DynamoStoreDeps["client"],
  input: QueryCommandInput,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let cursor: Record<string, unknown> | undefined;

  do {
    const result = await client.send(new QueryCommand({ ...input, ExclusiveStartKey: cursor }));
    items.push(...(result.Items ?? []));
    cursor = result.LastEvaluatedKey;
  } while (cursor !== undefined);

  return items;
}

export function createDynamoRuleStore({ client, tableName }: DynamoStoreDeps): RuleStore {
  async function getRules(): Promise<Rule[]> {
    const items = await queryAll(client, {
      TableName: tableName,
      // Narrowed by sort-key prefix because the partition also holds
      // anything else stored under this user.
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": USER, ":prefix": "RULE#" },
    });

    return items.map((item) => item.rule as Rule);
  }

  return {
    getRules,

    async putRule(rule: Rule): Promise<void> {
      const existing = await getRules();
      // Counted rather than enforced by a condition expression, which cannot
      // count. Two writes racing could both pass, so this bounds growth rather
      // than guaranteeing the limit exactly.
      if (existing.length >= RULE_LIMIT && !existing.some((held) => held.id === rule.id)) {
        throw new RuleLimitError(RULE_LIMIT);
      }

      await client.send(
        new PutCommand({
          TableName: tableName,
          // No TTL. A price slot is worthless once past, but a rule is the
          // user's own configuration, and expiring it would stop the alerts.
          Item: { pk: USER, sk: `RULE#${rule.id}`, rule },
        }),
      );
    },

    async getPricesForDay(day: string): Promise<PriceSlot[]> {
      const items = await queryAll(client, {
        TableName: tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `PRICE#${day}` },
      });

      // Mapped back to the domain shape so the key layout stays in this file.
      return items.map((item) => ({
        startDate: item.sk as string,
        price: item.price as number,
      }));
    },
  };
}
