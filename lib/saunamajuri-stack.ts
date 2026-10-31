import * as cdk from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
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
  /**
   * The subject prefix GitHub puts in its OIDC tokens for this repository,
   * as `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` reports it.
   * Supplied via GITHUB_SUB_PREFIX.
   */
  githubSubjectPrefix: string;
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
      // Two Finnish days of slots are held at once, which has measured 119 MB.
      // Lambda bills GB-seconds and scales CPU with memory, so headroom here is
      // close to cost-neutral.
      memorySize: 256,
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

    const integration = new integrations.HttpLambdaIntegration("ApiIntegration", api);

    httpApi.addRoutes({ path: "/{proxy+}", methods: [apigw.HttpMethod.GET], integration });

    // A write decides what is emailed, or silences it by replacing a rule, so it
    // needs a caller API Gateway can name. IAM rather than a key or a Lambda
    // authorizer: the request is SigV4-signed with credentials that already
    // exist, API Gateway verifies it before the Lambda runs, and only a principal
    // in this account holding execute-api:Invoke passes. HTTP APIs take no
    // resource policy, so no other account can be granted it. Kept to the one
    // route rather than the catch-all, because GET carries public data.
    httpApi.addRoutes({
      path: "/rules",
      methods: [apigw.HttpMethod.PUT],
      integration,
      authorizer: new authorizers.HttpIamAuthorizer(),
    });

    // Caps request rate, which bounds spend and the volume of abuse. It does not
    // bound concurrency: 10 requests a second against a 10 second timeout leaves
    // far more in flight than the account's 10 executions, and reserved
    // concurrency cannot be set here at all. Starving the collector is made less
    // likely rather than prevented. Reached through the CfnStage because HttpApi
    // exposes no throttle property.
    if (httpApi.defaultStage === undefined) {
      throw new Error("the HTTP API has no default stage to throttle");
    }
    const stage = httpApi.defaultStage.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 10, throttlingBurstLimit: 20 };

    // GitHub Actions presents a short-lived OIDC token instead of an access key,
    // so no long-lived AWS credential exists to leak from the repository.
    //
    // The provider is account-level and this URL can be registered only once, so
    // this stack owns it for the whole account: a second stack here must import
    // this one rather than create its own, and cdk destroy takes it away from
    // every repository that was relying on it.
    const github = new iam.OpenIdConnectProvider(this, "GithubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    const deployRole = new iam.Role(this, "GithubDeployRole", {
      // The sub condition is the whole security boundary, and it names a branch
      // rather than the repository: scoped to the repository alone it would
      // accept a token from any ref in it, so pushing any side branch would
      // deploy. What that buys depends on who can push to main, which GitHub's
      // settings decide rather than this stack. This role also deploys the
      // stack that defines it, so whoever can merge here can widen this
      // condition on the next push.
      //
      // The prefix is taken from GitHub rather than built from the repository
      // name, because GitHub issues immutable subjects: the claim carries the
      // numeric owner and repository ids, so a renamed or deleted repository
      // does not leave a name for someone else to register and reuse. Building
      // the string here would mean guessing which form is in force.
      assumedBy: new iam.OpenIdConnectPrincipal(github, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": `${props.githubSubjectPrefix}:ref:refs/heads/main`,
        },
      }),
      description: "Assumed by GitHub Actions to run cdk deploy",
    });

    // This is the right to become the deployer, which is not a narrow grant:
    // CDK's cfn-exec bootstrap role is an administrator by default. The prefix
    // is the boundary CDK offers, so the control that matters is the trust
    // policy above, which decides who may reach this role at all.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
      }),
    );

    // Read before deploying so the workflow can mask the outputs that cdk deploy
    // is about to print. This role's own credentials, not a bootstrap role's,
    // because the mask has to be in place before the CDK runs at all.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudformation:DescribeStacks"],
        resources: [this.stackId],
      }),
    );

    new cdk.CfnOutput(this, "DeployRoleArn", { value: deployRole.roleArn });
    new cdk.CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, "TableName", { value: table.tableName });
    new cdk.CfnOutput(this, "CollectorName", { value: collector.functionName });
    new cdk.CfnOutput(this, "AlertsTopicArn", { value: alerts.topicArn });
  }
}
