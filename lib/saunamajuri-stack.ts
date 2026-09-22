import * as cdk from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
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
    // and sent-notification markers today, user rules alongside them.
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

    const apiLogs = new logs.LogGroup(this, "ApiLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const api = new NodejsFunction(this, "Api", {
      entry: "src/api/handler.ts",
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(10),
      logGroup: apiLogs,
      environment: { TABLE_NAME: table.tableName },
    });

    // Query for reading prices and rules, PutItem for writing a rule. No
    // BatchWriteItem: only the collector writes slots.
    api.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:PutItem", "dynamodb:Query"],
        resources: [table.tableArn],
      }),
    );

    // Open because a browser page will be served from another origin, and
    // there is nothing user-specific to protect. CORS is not authorisation.
    const httpApi = new apigw.HttpApi(this, "HttpApi", {
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.PUT],
        allowHeaders: ["content-type"],
      },
    });

    httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [apigw.HttpMethod.GET, apigw.HttpMethod.PUT],
      integration: new integrations.HttpLambdaIntegration("ApiIntegration", api),
    });

    new cdk.CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, "TableName", { value: table.tableName });
    new cdk.CfnOutput(this, "CollectorName", { value: collector.functionName });
    new cdk.CfnOutput(this, "AlertsTopicArn", { value: alerts.topicArn });
  }
}
