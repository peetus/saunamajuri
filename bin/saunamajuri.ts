#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { SaunamajuriStack } from "../lib/saunamajuri-stack";

const app = new cdk.App();

// No default: a fallback address would put a personal email into tracked source.
const alertEmail = process.env.ALERT_EMAIL;
if (alertEmail === undefined || alertEmail === "") {
  throw new Error(
    [
      "ALERT_EMAIL is not set.",
      "Deploy with: ALERT_EMAIL=you@example.com npx cdk deploy",
      "For destroy, diff, ls and synth any address will do - they only need the app to synthesise.",
    ].join(" "),
  );
}

// Read from GitHub rather than constructed, because the subject claim's shape
// depends on whether the repository issues immutable subjects, and a guess that
// is wrong fails closed at assume-role time with nothing pointing at the cause.
const githubSubjectPrefix = process.env.GITHUB_SUB_PREFIX;
if (githubSubjectPrefix === undefined || githubSubjectPrefix === "") {
  throw new Error(
    [
      "GITHUB_SUB_PREFIX is not set.",
      "Get it with: gh api repos/<owner>/<repo>/actions/oidc/customization/sub -q .sub_claim_prefix",
      "Then deploy with: GITHUB_SUB_PREFIX=<that value> npx cdk deploy",
      "It scopes the deploy role's trust policy, so a wrong value is a real permission.",
    ].join(" "),
  );
}

// Pinned to the account and region of the current CLI profile rather than left
// environment-agnostic. An agnostic stack cannot do context lookups, and a
// misconfigured CLI region would otherwise deploy a second copy somewhere else
// without complaining.
new SaunamajuriStack(app, "SaunamajuriStack", {
  alertEmail,
  githubSubjectPrefix,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
