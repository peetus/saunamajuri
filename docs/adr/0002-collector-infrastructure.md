Infrastructure is defined in AWS CDK TypeScript rather than CloudFormation YAML. The stack is
small enough that YAML's portability would cost nothing, so the deciding factor was the test:
the same `tsc`, `eslint` and `vitest` that check the handlers also check the infrastructure, and
`test/saunamajuri-stack.test.ts` asserts against a synthesised template that the IAM policy
contains exactly the actions the collector calls. Expressing that against YAML would mean a
second toolchain. The cost is a synth step between the source and the deployed artefact, so what
CloudFormation receives is never what was written, and a CDK version bump can change the output
without the source changing. The committed snapshot is what makes that visible.

Each resource was built once by hand in the console before being written as CDK. That is a
method rather than an architecture decision, and it is recorded because it is repeatable: the
console names the fields a construct hides behind defaults, which makes an unfamiliar construct
readable instead of magic. It stops being worth the time once the service is familiar.

Price slots are partitioned by the Finnish calendar day rather than the UTC one, so a slot's
partition key comes from its instant rendered in `Europe/Helsinki`. A Finnish day runs 21:00 to
21:00 UTC in summer and 22:00 to 22:00 in winter, so a UTC-keyed partition would split every
day a user asks for across two partitions and make "today's prices" two queries. The service
has Finnish users only and no internationalisation planned; if that changes, the day becomes a
property of the reader rather than of the data, and this key stops being right.

Price data is kept in one DynamoDB table with generic `pk`/`sk` attributes rather than a table
per item type. The same table holds price slots now and rules and sent-notification markers
later, and keeping them together means one set of permissions and one query path. Billing is
on-demand because the table is written to once an hour, and a TTL attribute expires old slots
without a cleanup job.

The collector's DynamoDB permissions are an explicit `iam.PolicyStatement` rather than
`table.grantReadWriteData()`. The convenience grant includes `Scan` and `DeleteItem`, which the
collector never calls. An over-broad policy is easy to miss in review because the code that
would misuse it does not exist yet, so the stack test asserts the exact action set instead.

Reserved concurrency is not set on any function. This account's total Lambda concurrency is 10
and AWS requires 10 to stay unreserved, so a reservation of any size fails the deploy. The
stack test asserts its absence rather than a value, because the limit belongs to the account
rather than to the design, and a future account with a normal limit should revisit it.

The collector runs hourly although the upstream publishes once a day, shortly before 14:00
Helsinki time, so twenty-three of the twenty-four runs re-read data the table already holds.
The schedule exists for availability rather than freshness. A daily run fails silently only
because nothing would be watching it; give it a staleness check and an alarm and it reports
its own failure perfectly well. The argument for hourly is not that the alternative cannot
detect a problem, but that detecting one is not the same as fixing it. An alarm tells you the
sauna alert did not go out; hourly means it goes out anyway, an hour late, with nobody
awake. That is worth more than a page for a service nobody is on call for, and it is code
that does not have to be written, tested or trusted. Hourly also avoids pinning a cron to a
publish time that is typical rather than contractual, and avoids the hour of drift a fixed
UTC cron acquires against Helsinki twice a year.

The redundancy is affordable rather than free. Writes are keyed by slot start, so a repeat
fetch overwrites instead of duplicating, and at 192 slots a run it costs roughly 138,000 write
request units a month against an on-demand allowance of 2.5 million. If the table ever carries
enough traffic for that to matter, narrowing the schedule to the afternoon is the first thing
to cut, at the price of a cron expression that has to be reasoned about at each DST change.
