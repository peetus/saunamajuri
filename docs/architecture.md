# Architecture

What to read before changing something. `README.md` covers what the service does and how to run it,
and `docs/adr/` records why each decision was taken and what the alternative cost. This document
covers the parts that sit between them: how a run actually proceeds, what happens when each piece
fails, and what the thing consumes.

## Two flows

Nothing here calls anything else synchronously. The collector and the API meet only through the
table.

### Scheduled collection, hourly

```
EventBridge  ─▶  Collector Lambda
                    │
                    ├─▶ GET porssisahko.net/v2/latest-prices.json
                    │      parse, validate, sort, dedupe        (fetch-prices.ts)
                    │
                    ├─▶ BatchWriteItem, 25 at a time, backoff on UnprocessedItems
                    │                                            (store.ts)
                    ├─▶ Query USER#me / RULE#                    (rule-store.ts)
                    │
                    ├─▶ findCheapestWindow per rule              (rules/find-window.ts)
                    │      filter by lead time, slide, rank by average
                    │
                    ├─▶ Query NOTIF#<rule>, skip on overlap      (rules/overlap.ts)
                    │
                    ├─▶ Publish once, covering every rule        (notify.ts)
                    └─▶ PutItem NOTIF#<rule> per rule reported
```

The order matters in two places. Prices are stored **before** any alert is sent, so an alert can
never refer to data that was not durably written. Markers are written **after** the send, so a
failed send is retried next hour rather than suppressed.

### HTTP API, on demand

```
Client ─▶ API Gateway HTTP API ─▶ API Lambda ─▶ Query / PutItem
          {proxy+}, GET and PUT    routes.ts
```

Routing is in code rather than per-route in the gateway. The handler is therefore a pure function of
an event and a `RuleStore`, testable with no AWS in the loop, at the cost of per-route IAM and
per-route metrics.

## Failure modes

The service's worst outcome is not an error. It is continuing to look healthy while not alerting, so
each row below names the symptom an operator would actually see.

| What fails                          | Symptom                                                  | What recovers it                                                                                       |
| ----------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Upstream feed down or malformed     | Run throws, nothing stored, no email                     | The next hourly run. 24 attempts a day is why the schedule is hourly; see ADR 0002                     |
| `BatchWriteItem` partially rejected | None — a 200 with `UnprocessedItems`                     | Exponential backoff inside the run, then the next run                                                  |
| Send fails mid-run                  | Run throws, no markers written                           | The next run re-sends the whole batch; one publish covers every rule, so nothing is stranded half-sent |
| Marker write fails after a send     | None                                                     | The next run re-sends. A duplicate email is preferred to a missing one                                 |
| No rules configured                 | Would be indistinguishable from a quiet night            | An explicit log line, `no rules configured`                                                            |
| Collector exceeds its memory        | Abrupt `Runtime exited`, no application log              | Nothing automatic. 256 MB against a measured 142 MB is the margin                                      |
| A rule's ceiling set too low        | Silence that looks like expensive electricity            | Nothing. This is the cost of the unauthenticated write route; see ADR 0004                             |
| IAM action missing from a role      | 500 to the caller, `AccessDeniedException` in CloudWatch | Nothing automatic. The denial is loud in the logs and silent to the client                             |

Two of those rows have no automatic recovery, and both are about the service being switched off
rather than breaking. That asymmetry is the reason the rule count is capped, queries are paginated
and the stage is throttled: each closes a path that ends in silence.

## Idempotency

Every hourly run reprocesses the same data, so each write has to be safe to repeat.

- **Price slots** are upserts keyed by their start instant. Re-fetching a day rewrites it with the
  same values.
- **Alerts** are deduplicated by marker, compared by overlap rather than equality. The lead-time
  cutoff advances every run, so the same stretch of cheap power is found starting one slot later
  each hour; comparing start times re-sent it every hour.
- **Rules** are upserts keyed by id, which is also why an unauthenticated write can silently replace
  one rather than adding another.

## What it consumes

Measured on the deployed stack rather than estimated.

|                       |                                                            |
| --------------------- | ---------------------------------------------------------- |
| Collector invocations | 24/day, ~3.0s billed at 256 MB, ~0.74 GB-s each            |
| Compute               | ~18 GB-s/day, ~540 GB-s/month                              |
| Item writes           | 192 slots × 24 runs ≈ 4,600/day, ~140,000/month            |
| Item reads            | One Query for rules plus one per rule for markers, per run |
| Stored data           | ~500 items, ~31 KB, bounded by TTL                         |

The table does not grow: price slots expire after 30 days and sent markers after 7. Rules carry no
TTL, deliberately — expiring a user's own configuration would stop their alerts with no error
anywhere.

### Cost controls

These are structural, not incidental. Nothing here is always-on: no NAT gateway, no VPC, no
relational database, no load balancer. Adding any of those changes the cost model from "rounding
error" to "monthly bill", which is why ADR 0001 records them as excluded rather than merely absent.

AWS Budgets alarms on spend. Budgets are notifications rather than brakes — cost data refreshes a
few times a day and there is no hard cap — so the real guarantee is the account plan and the absence
of anything chargeable by the hour.

The account's Lambda concurrency ceiling is 10, shared by both functions, and AWS requires 10 to
remain unreserved so per-function reservations cannot be set at all. That quota couples two
otherwise independent components: load on the API can leave the collector without the concurrency it
needs to run. The stage throttle bounds request rate, which bounds spend and abuse volume, but it
does not bound concurrency and does not make that coupling go away.

## Security posture

The deployed write route has no authorizer; that is recorded as a weak position in ADR 0004, along
with what it costs and what closing it would involve. Deployment credentials are short-lived OIDC
tokens with no stored key, scoped to one branch of one repository; ADR 0005 covers the trust policy
and what it does not close.

A `pre-push` hook derives this deployment's real identifiers from AWS and GitHub and refuses to push
a range containing one, because a scan against a hand-kept list is only as current as the last
person who remembered to update it.

## Decisions

| ADR                                               | Covers                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| [0001](adr/0001-aws-account-and-identity.md)      | Account plan, spending controls, identity, why not Identity Center            |
| [0002](adr/0002-collector-infrastructure.md)      | CDK over YAML, the Finnish day as a partition key, hourly as a retry strategy |
| [0003](adr/0003-rule-engine-and-notifications.md) | The AWS-free rule engine, overlap deduplication, SNS over SES                 |
| [0004](adr/0004-http-api-and-observability.md)    | HTTP API over REST, rules as data, the open write route and its bounds        |
| [0005](adr/0005-ci-cd-with-oidc.md)               | Deploying from CI, the OIDC trust policy, immutable subject claims            |
