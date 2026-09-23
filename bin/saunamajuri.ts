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

// Supplied rather than hardcoded so the workflow can pass github.repository and
// the trust policy always names the repository it is actually running in.
const githubRepo = process.env.GITHUB_REPO;
if (githubRepo === undefined || githubRepo === "") {
  throw new Error(
    [
      "GITHUB_REPO is not set.",
      "Deploy with: GITHUB_REPO=you/saunamajuri npx cdk deploy",
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
  githubRepo,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
