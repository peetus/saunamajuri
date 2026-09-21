import * as cdk from "aws-cdk-lib";
import { type Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";

export interface SaunamajuriStackProps extends cdk.StackProps {
  /** Address that receives price alerts. Supplied at deploy time via ALERT_EMAIL. */
  alertEmail: string;
}

export class SaunamajuriStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SaunamajuriStackProps) {
    super(scope, id, props);

    // pk/sk are generic because one table holds several item types: price slots
    // and sent-notification markers today, rules from evening 4.
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

    // SNS rather than SES: no domain verification, no sandbox exit.
    const alerts = new sns.Topic(this, "Alerts", { displayName: "Saunamajuri alerts" });
    alerts.addSubscription(new subscriptions.EmailSubscription(props.alertEmail));

    const collector = new NodejsFunction(this, "Collector", {
      entry: "src/collector/handler.ts",
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(30),
      logGroup: collectorLogs,
      environment: { TABLE_NAME: table.tableName, TOPIC_ARN: alerts.topicArn },
    });

    // BatchWriteItem for the price slots, Query and PutItem for the markers.
    collector.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:BatchWriteItem", "dynamodb:PutItem", "dynamodb:Query"],
        resources: [table.tableArn],
      }),
    );

    // grantPublish is already one action on one topic.
    alerts.grantPublish(collector);

    // Hourly for retries, not freshness - the upstream publishes once a day.
    // See docs/adr/0002.
    new events.Rule(this, "Hourly", {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(collector)],
    });

    new cdk.CfnOutput(this, "TableName", { value: table.tableName });
    new cdk.CfnOutput(this, "CollectorName", { value: collector.functionName });
    new cdk.CfnOutput(this, "AlertsTopicArn", { value: alerts.topicArn });
  }
}
