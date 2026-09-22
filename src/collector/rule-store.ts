import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { type PriceSlot, type Rule } from "../rules/types.js";
import { type DynamoStoreDeps } from "./store.js";

// The API is unauthenticated and single-user, so there is nobody to derive an
// identity from. A placeholder for a real one, not a design.
const USER = "USER#me";

export interface RuleStore {
  getRules(): Promise<Rule[]>;
  /** Upserts a rule. Safe to re-run: the same id overwrites. */
  putRule(rule: Rule): Promise<void>;
  /** `day` is a Finnish calendar day, `YYYY-MM-DD`, as `helsinkiDate` renders it. */
  getPricesForDay(day: string): Promise<PriceSlot[]>;
}

export function createDynamoRuleStore({ client, tableName }: DynamoStoreDeps): RuleStore {
  return {
    async getRules(): Promise<Rule[]> {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          // Narrowed by sort-key prefix because the partition also holds
          // anything else stored under this user.
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": USER, ":prefix": "RULE#" },
        }),
      );

      return (result.Items ?? []).map((item) => item.rule as Rule);
    },

    async putRule(rule: Rule): Promise<void> {
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
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": `PRICE#${day}` },
        }),
      );

      // Mapped back to the domain shape so the key layout stays in this file.
      return (result.Items ?? []).map((item) => ({
        startDate: item.sk as string,
        price: item.price as number,
      }));
    },
  };
}
