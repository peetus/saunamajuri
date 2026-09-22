import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SNSClient } from "@aws-sdk/client-sns";
import { requireEnv } from "../config.js";
import { createCollector } from "./collect.js";
import { createPriceFetcher } from "./fetch-prices.js";
import { createSnsNotifier } from "./notify.js";
import { createDynamoRuleStore } from "./rule-store.js";
import { createDynamoNotificationLog, createDynamoPriceStore } from "./store.js";

// Composition root.
const tableName = requireEnv("TABLE_NAME");
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = createCollector({
  fetchPrices: createPriceFetcher(),
  store: createDynamoPriceStore({ client: documentClient, tableName }),
  notifications: createDynamoNotificationLog({ client: documentClient, tableName }),
  notifier: createSnsNotifier({ client: new SNSClient({}), topicArn: requireEnv("TOPIC_ARN") }),
  rules: createDynamoRuleStore({ client: documentClient, tableName }),
  now: () => new Date(),
});
