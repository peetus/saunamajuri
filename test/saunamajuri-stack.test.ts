import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, expect, it } from "vitest";
import { SaunamajuriStack } from "../lib/saunamajuri-stack.js";

// Synthesised once and shared. Each call bundles both Lambdas with esbuild,
// and the stack is deterministic, so one template serves every assertion.
let template: Template | undefined;

function synth(): Template {
  if (template === undefined) {
    const app = new cdk.App();
    // A literal address: the snapshot is committed.
    const stack = new SaunamajuriStack(app, "TestStack", {
      alertEmail: "test@example.com",
      env: { account: "123456789012", region: "eu-north-1" },
    });
    template = Template.fromStack(stack);
  }
  return template;
}

// The bundling outlasts vitest's 5s default, so it gets its own timeout here
// rather than falling on whichever test runs first.
beforeAll(() => {
  synth();
}, 30_000);

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

/** Every action of one prefix granted to the role whose logical id contains `role`. */
function actionsFor(role: string, prefix: string): string[] {
  const policies = synth().findResources("AWS::IAM::Policy");

  return Object.entries(policies)
    .filter(([logicalId]) => logicalId.includes(role))
    .flatMap(
      ([, policy]) => (policy.Properties?.PolicyDocument as { Statement: { Action: string | string[] }[] }).Statement,
    )
    .flatMap((statement) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]))
    .filter((action) => action.startsWith(prefix))
    .sort();
}

// Asserted per function rather than across the whole template. An aggregate
// assertion would pass while one role held the other's permissions, which is
// the failure least privilege exists to prevent.
it("grants the collector only the DynamoDB actions it uses", () => {
  expect(actionsFor("Collector", "dynamodb:")).toEqual([
    "dynamodb:BatchWriteItem",
    "dynamodb:PutItem",
    "dynamodb:Query",
  ]);
});

// The API never writes price slots, so BatchWriteItem must not appear here.
it("grants the API only the DynamoDB actions it uses", () => {
  expect(actionsFor("Api", "dynamodb:")).toEqual(["dynamodb:PutItem", "dynamodb:Query"]);
});

it("grants the collector only sns:Publish", () => {
  expect(actionsFor("Collector", "sns:")).toEqual(["sns:Publish"]);
});

// The API has no reason to publish alerts.
it("grants the API no SNS access at all", () => {
  expect(actionsFor("Api", "sns:")).toEqual([]);
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
