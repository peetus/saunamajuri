import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SNSClient } from "@aws-sdk/client-sns";
import { requireEnv } from "../config.js";
import { type Rule } from "../rules/types.js";
import { createCollector } from "./collect.js";
import { createPriceFetcher } from "./fetch-prices.js";
import { createSnsNotifier } from "./notify.js";
import { createDynamoNotificationLog, createDynamoPriceStore } from "./store.js";

// Hardcoded for now; evening 4 moves these into DynamoDB behind the HTTP API.
// Sauna has the strictest ceiling because a 6-8 kW stove burns the most kWh.
const RULES: Rule[] = [
  { id: "sauna", durationMinutes: 120, maxAveragePrice: 3, minLeadTimeMinutes: 12 * 60 },
  { id: "dishwasher", durationMinutes: 120, maxAveragePrice: 5, minLeadTimeMinutes: 12 * 60 },
  { id: "laundry", durationMinutes: 180, maxAveragePrice: 5, minLeadTimeMinutes: 12 * 60 },
];

// Composition root.
const tableName = requireEnv("TABLE_NAME");
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = createCollector({
  fetchPrices: createPriceFetcher(),
  store: createDynamoPriceStore({ client: documentClient, tableName }),
  notifications: createDynamoNotificationLog({ client: documentClient, tableName }),
  notifier: createSnsNotifier({ client: new SNSClient({}), topicArn: requireEnv("TOPIC_ARN") }),
  rules: RULES,
  now: () => new Date(),
});
