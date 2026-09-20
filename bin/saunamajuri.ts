#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { SaunamajuriStack } from "../lib/saunamajuri-stack";

const app = new cdk.App();

// Pinned to the account and region of the current CLI profile rather than left
// environment-agnostic. An agnostic stack cannot do context lookups, and a
// misconfigured CLI region would otherwise deploy a second copy somewhere else
// without complaining.
new SaunamajuriStack(app, "SaunamajuriStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
