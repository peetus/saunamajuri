import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { requireEnv } from "../config.js";
import { createDynamoRuleStore } from "../collector/rule-store.js";
import { createRouter } from "./routes.js";

// Composition root.
const tableName = requireEnv("TABLE_NAME");
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = createRouter({
  rules: createDynamoRuleStore({ client: documentClient, tableName }),
  now: () => new Date(),
});
