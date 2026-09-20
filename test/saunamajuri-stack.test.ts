import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { expect, it } from "vitest";
import { SaunamajuriStack } from "../lib/saunamajuri-stack.js";

function synth(): Template {
  const app = new cdk.App();
  const stack = new SaunamajuriStack(app, "TestStack", { env: { account: "123456789012", region: "eu-north-1" } });
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

// Least privilege, encoded. table.grantReadWriteData() would hand out twelve
// actions; this fails if anyone reaches for the convenient grant, or adds an
// action without deciding to.
it("grants the collector only the DynamoDB actions it uses", () => {
  const policies = synth().findResources("AWS::IAM::Policy");
  const statements = Object.values(policies).flatMap(
    (policy) => (policy.Properties?.PolicyDocument as { Statement: { Action: string | string[] }[] }).Statement,
  );

  const dynamoActions = statements
    .flatMap((statement) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]))
    .filter((action) => action.startsWith("dynamodb:"))
    .sort();

  expect(dynamoActions).toEqual(["dynamodb:BatchWriteItem"]);
});

it("matches the approved infrastructure snapshot", () => {
  expect(synth().toJSON()).toMatchSnapshot();
});
