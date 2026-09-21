import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { expect, it } from "vitest";
import { SaunamajuriStack } from "../lib/saunamajuri-stack.js";

function synth(): Template {
  const app = new cdk.App();
  // A literal address: the snapshot is committed.
  const stack = new SaunamajuriStack(app, "TestStack", {
    alertEmail: "test@example.com",
    env: { account: "123456789012", region: "eu-north-1" },
  });
  return Template.fromStack(stack);
}

it("keeps log retention at 7 days", () => {
  synth().hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 7 });
});

// Inverted on purpose. This account's total Lambda concurrency is 10 and AWS
// requires 10 to stay unreserved, so setting this at any value fails the
// deploy. Catching it here costs milliseconds; catching it in CloudFormation
// costs a create-and-rollback.
it("never sets reserved concurrency", () => {
  const functions = synth().findResources("AWS::Lambda::Function");
  for (const fn of Object.values(functions)) {
    expect(fn.Properties?.ReservedConcurrentExecutions).toBeUndefined();
  }
});

it("expires price slots with a TTL attribute", () => {
  synth().hasResourceProperties("AWS::DynamoDB::GlobalTable", {
    TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
  });
});

it("runs the collector every hour", () => {
  synth().hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "rate(1 hour)" });
});

// Fails if anyone reaches for a grant* helper, or adds an action without
// deciding to.
it("grants the collector only the DynamoDB actions it uses", () => {
  const policies = synth().findResources("AWS::IAM::Policy");
  const statements = Object.values(policies).flatMap(
    (policy) => (policy.Properties?.PolicyDocument as { Statement: { Action: string | string[] }[] }).Statement,
  );

  const dynamoActions = statements
    .flatMap((statement) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]))
    .filter((action) => action.startsWith("dynamodb:"))
    .sort();

  expect(dynamoActions).toEqual(["dynamodb:BatchWriteItem", "dynamodb:PutItem", "dynamodb:Query"]);
});

it("grants the collector only sns:Publish", () => {
  const policies = synth().findResources("AWS::IAM::Policy");
  const statements = Object.values(policies).flatMap(
    (policy) => (policy.Properties?.PolicyDocument as { Statement: { Action: string | string[] }[] }).Statement,
  );

  const snsActions = statements
    .flatMap((statement) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]))
    .filter((action) => action.startsWith("sns:"))
    .sort();

  expect(snsActions).toEqual(["sns:Publish"]);
});

it("subscribes the alert address to the topic", () => {
  synth().hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "test@example.com" });
});

// The Lambda bundle's content hash is in the template, so without normalising
// it every handler edit churns the snapshot. Normalised, it moves only when
// infrastructure does - and then it is worth reading.
function synthWithoutAssetHashes(): unknown {
  return JSON.parse(JSON.stringify(synth().toJSON()).replace(/[0-9a-f]{64}/g, "<asset-hash>"));
}

it("matches the approved infrastructure snapshot", () => {
  expect(synthWithoutAssetHashes()).toMatchSnapshot();
});
