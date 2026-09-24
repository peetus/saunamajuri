# Saunamajuri

Emails you when Finnish electricity is cheap enough to run something that draws
real power — a sauna stove, a dishwasher, a washing machine — far enough ahead
that you can plan around it.

Nord Pool spot prices move by a factor of ten within a day. Heating a sauna at
the wrong hour costs several times what the same heat costs six hours later, and
nobody wants to read a price graph every evening. Saunamajuri watches the feed
and sends one email when a cheap enough stretch appears.

## What it does

Every hour a Lambda fetches the published 15-minute spot prices, stores them, and
runs a rule engine over them. A **rule** describes one appliance:

```json
{
  "id": "sauna",
  "durationMinutes": 120,
  "maxAveragePrice": 3,
  "minLeadTimeMinutes": 720
}
```

That reads: find two contiguous hours averaging under 3 c/kWh, starting at least
twelve hours from now. The lead time is what makes the alert useful rather than
merely true — being told that power is cheap in ten minutes is not something you
can act on.

When a rule is satisfied, the email reports **every stretch during which it is
satisfiable**, as a range of start times: _start any time between 16:00 and
23:00_. Reporting only the cheapest two hours reads as the only time the
appliance may be run, and since the cheapest stretch is usually overnight, that
tends to name an hour nobody would choose. The guarantee is that a run beginning
anywhere in the range averages at or under the ceiling.

Spans are listed in time order rather than by price, so a usable hour is not
buried under a cheaper one at 03:00. Every rule satisfied in the same run shares
one email, so three appliances do not mean three messages, and a stretch already
reported is not reported again.

## Architecture

```
  EventBridge  ──hourly──▶  Collector Lambda  ──▶  SNS topic  ──▶  your inbox
                                  │
                        ┌─────────┴─────────┐
                        ▼                   ▼
                 spot price API        DynamoDB table
                 (porssisahko.net)     prices, rules, sent markers
                                            ▲
                                            │
                   you  ──▶  HTTP API  ──▶  API Lambda
```

Two Lambdas, one table, no servers and no VPC. The collector is the only writer
of price data; the API Lambda reads prices and rules and writes rules.

### Why each piece

**Lambda** — the workload is one HTTP fetch an hour. Anything always-on would be
paid for while idle. Every scheduled run is a cold start, because an hour between
invocations outlives any warm execution environment; at roughly five seconds a
run this is irrelevant here, and it would not be for a user-facing API.

**EventBridge, hourly** — the upstream publishes once a day, after 14:00 Helsinki
time, so the hourly schedule is not about freshness. It is a retry strategy. A
daily schedule gets one attempt, and an upstream outage at that moment loses the
day silently. Twenty-four attempts make a transient failure a non-event, and the
run is idempotent, so the other twenty-three cost nothing.

**DynamoDB, single table, on-demand** — one table holds price slots, user rules
and sent-notification markers under a generic `pk`/`sk` pair. DynamoDB has no
query planner: an access pattern the keys were not designed for is a table scan,
not a slow query. The keys are therefore derived from the access patterns, and
no read in this service needs a scan. On-demand billing avoids provisioning
capacity for a workload of two dozen writes a day.

**SNS** — a topic with an email subscription. SES would require domain
verification and a sandbox exit for the same result. A new subscription stays
`PendingConfirmation` until the recipient clicks the link in the confirmation
mail, which is worth knowing because that mail is often filed as spam.

**API Gateway HTTP API** — cheaper and faster than a REST API, with fewer
features. A single `{proxy+}` route reaches one Lambda that does its own routing,
which trades per-route IAM and metrics for a handler testable without any AWS in
the loop.

**CloudWatch** — log groups are declared in the stack rather than left to Lambda
to create, so retention is seven days from the start and `cdk destroy` takes the
logs with it. A Lambda-created log group defaults to never expiring and outlives
the function that wrote to it.

Fuller reasoning, including what was rejected, is in [`docs/adr/`](docs/adr/).

## Data model

One table, three item types:

| Item        | `pk`                  | `sk`                       |
| ----------- | --------------------- | -------------------------- |
| Price slot  | `PRICE#<finnish day>` | `2026-09-24T18:45:00.000Z` |
| Rule        | `USER#me`             | `RULE#sauna`               |
| Sent marker | `NOTIF#sauna`         | `2026-09-24T20:00:00.000Z` |

The partition key for prices is the **Finnish** calendar day, not the UTC day.
Finland is UTC+2, and UTC+3 under summer time, so a day boundary falls at 21:00Z
or 22:00Z depending on the season. Keying by UTC would split each Finnish day
across two partitions and misfile the three hours around midnight.

A partition is a storage boundary, not a domain boundary: a cheap window can
straddle midnight and belong to two partitions. The rule engine therefore works
on a flat list of slots and knows nothing about days — only the storage layer
knows about partitions.

Price slots carry a 30-day TTL and sent markers a 7-day one, so both delete
themselves and the table does not grow.
Rules deliberately do not. A rule is the user's own configuration, and expiring
it would stop their alerts with no error anywhere.

## Using it

The API is unauthenticated. See [Security](#security) before exposing a
deployment.

```bash
API=https://<your-api-id>.execute-api.eu-north-1.amazonaws.com
```

**List the configured rules.**

```bash
curl -s "$API/rules"
```

**Add or edit a rule.** `PUT` is an upsert keyed on `id`, so re-sending the same
id replaces that rule and leaves the others alone.

```bash
curl -s -X PUT "$API/rules" -H 'content-type: application/json' \
  -d '{"id":"dishwasher","durationMinutes":120,"maxAveragePrice":10,"minLeadTimeMinutes":720}'
```

A dishwasher draws far less than a sauna, so it tolerates a looser ceiling; set
the ceiling per appliance rather than globally. Ids are lowercase letters,
digits, `-` and `_`, up to 32 characters.

**Read prices.** Defaults to the current Finnish day.

```bash
curl -s "$API/prices"
curl -s "$API/prices?day=2026-09-24"
```

Prices are c/kWh including VAT, in 15-minute slots, as published by
[porssisahko.net](https://porssisahko.net/).

## Deploying

Requires Node.js 24, an AWS account and credentials with permission to create
the stack.

```bash
npm ci
npx cdk bootstrap                     # once per account and region
ALERT_EMAIL=you@example.com   GITHUB_SUB_PREFIX=$(gh api repos/you/saunamajuri/actions/oidc/customization/sub -q .sub_claim_prefix)   npx cdk deploy
```

Both variables are required and neither has a default, so the deploy fails
rather than falling back. `ALERT_EMAIL` would otherwise bake an address into the
source. `GITHUB_SUB_PREFIX` scopes the trust policy of the role GitHub Actions
assumes, and a wrong value there is a real permission granted to a real
repository, so it is read from GitHub rather than guessed. **Confirm the
subscription**: AWS sends a confirmation link to that address and delivers
nothing until it is clicked. Check the spam folder.

The stack outputs the API URL, table name, collector name and topic ARN. To
re-read them later:

```bash
aws cloudformation describe-stacks --stack-name SaunamajuriStack \
  --query "Stacks[0].Outputs"
```

`npx cdk destroy` removes everything, including the table and the logs.

## Continuous deployment

`.github/workflows/deploy.yml` runs `npm run check` and then `cdk deploy` on
every push to `main`. It holds no AWS credentials. GitHub mints a short-lived
OIDC token, AWS validates it against the deploy role's trust policy, and returns
credentials that expire within the hour. A leaked access key stored as a repo
secret would stay valid until somebody noticed.

The trust policy is scoped through a condition on the token's `sub` claim, and it
names a branch rather than a repository. Without the condition the role would
accept a token from any repository on GitHub. With only the repository named it
would accept one from any ref in it, which would make branch protection on `main`
beside the point.

The subject is taken from GitHub rather than assembled from the repository name.
GitHub issues immutable subjects, so the claim carries the numeric owner and
repository ids - `repo:<owner>@<owner_id>/<repo>@<repo_id>:ref:refs/heads/main` -
which means a repository that is renamed or deleted leaves no name behind for
someone else to register and reuse. A mismatch here fails closed, as an
`AssumeRoleWithWebIdentity` denial with no other symptom, so check the claim
rather than the spelling:

```bash
gh api repos/<owner>/<repo>/actions/oidc/customization/sub -q .sub_claim_prefix
aws iam get-role --role-name <role> --query 'Role.AssumeRolePolicyDocument'
```

Two repository secrets are needed: `AWS_DEPLOY_ROLE_ARN`, from the stack's
`DeployRoleArn` output, and `ALERT_EMAIL`. The role must exist before the
workflow can assume it, so the first deploy is from a laptop.

## Development

```bash
npm run check     # build, lint, format check and the full test suite
npm test
```

`npm run check` also runs automatically before every commit, via a hook installed
by `npm ci`.

The same wiring installs a `pre-push` hook that refuses to push a commit whose
content or message contains a real identifier of a live deployment - the account
id, the API URL, a resource name, the address alerts are sent to, or the numeric
GitHub ids in an OIDC subject. It derives those values from the environment on
each run rather than reading a list, because a list in the repository would
publish what it exists to withhold, and a list kept by hand is only current up
to the last person who remembered it. It scans the whole range being pushed, not
the working tree, since deleting a value from a file leaves it in the history.

Values nothing in the environment still holds - an address the history was
rewritten away from, say - go one per line in `.git/identifiers.local`, which the
hook writes as a commented template on its first run and which is not tracked.
The derived values are cached beside it. Both hold the identifiers verbatim,
because a substring search needs them, and neither can reach the repository,
because nothing under `.git` is trackable.

The rule engine under `src/rules/` is pure TypeScript with no AWS imports, no
I/O and no clock of its own, so it is tested as an ordinary library and could run
unchanged in a browser. Everything that touches AWS sits behind an interface and
is injected, which is what lets the collector be tested wired to its real
collaborators with only the AWS edge faked.

Conventions and the testing approach are in
[`CODING_STANDARDS.md`](CODING_STANDARDS.md).

## Cost

Designed to run at zero on the AWS Free Plan. Nothing here is always-on: no NAT
gateway, no VPC, no relational database, no load balancer. The hourly collector,
a table holding a few hundred small items and around 30 emails a month sit
inside the perpetual free tiers.

## Security

**The write route has no authorizer.** Anyone who knows the URL can add, replace
or overwrite rules, which in practice means redirecting or silencing the alerts
of whoever deployed it. The prices it exposes are public data, and the email
address is not readable through the API, but the deployment is single-user and
assumes the URL stays private.

This is a known, recorded limitation rather than an oversight — see
[ADR 0004](docs/adr/0004-http-api-and-observability.md) for what it costs and
what closing it would involve. Do not publish the URL, and add an authorizer
before running this for anyone but yourself.

## License

None yet.
