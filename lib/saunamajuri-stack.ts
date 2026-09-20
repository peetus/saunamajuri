import * as cdk from "aws-cdk-lib";
import { type Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";

export class SaunamajuriStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Single table. pk/sk are generic because it holds several item types:
    // price slots today, rules and sent-notification markers later.
    // On-demand billing means no idle capacity charge, and TTL expires old
    // slots without a cleanup job.
    const table = new dynamodb.TableV2(this, "Table", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Declared explicitly rather than left to Lambda so retention is set from
    // the start and cdk destroy takes the logs with it. Lambda's own log group
    // would default to never expiring and outlive the function.
    const collectorLogs = new logs.LogGroup(this, "CollectorLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const collector = new NodejsFunction(this, "Collector", {
      entry: "src/collector/handler.ts",
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(30),
      logGroup: collectorLogs,
      environment: { TABLE_NAME: table.tableName },
    });

    // Granted explicitly rather than with table.grantReadWriteData(), which
    // hands out twelve actions including Scan, DeleteItem and the stream
    // readers. The collector writes price slots and nothing else, so it gets
    // one action. Evening 3 adds GetItem, PutItem and Query for the rules and
    // the notification dedupe markers - at that point, and not before.
    collector.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:BatchWriteItem"],
        resources: [table.tableArn],
      }),
    );

    // Hourly rather than daily: the upstream publishes the next day's prices
    // mid-afternoon, and the collector is idempotent, so re-fetching an
    // overlapping window costs nothing and removes any dependence on timing.
    new events.Rule(this, "Hourly", {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(collector)],
    });

    new cdk.CfnOutput(this, "TableName", { value: table.tableName });
    new cdk.CfnOutput(this, "CollectorName", { value: collector.functionName });
  }
}
