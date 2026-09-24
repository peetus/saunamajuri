The rule engine is pure TypeScript with no AWS imports, no I/O and no clock of its own. `now` is a
parameter, so a test fixes the time rather than working around it. This is not a stylistic
preference. The interesting logic in this service is a search over price slots, and keeping it
free of AWS means it runs in milliseconds without mocks, which is what makes an adversarial test
pass affordable enough to actually do. That pass is what found a NaN price passing the upstream
check and then slipping under a rule's price ceiling, because NaN compares false against
everything.

The boundary is enforced by `eslint.config.mjs` rather than left as a convention. A convention
survives exactly as long as nobody is in a hurry, and the cost of the rule is one config block. It
fails the build on an `@aws-sdk` import under `src/rules/`, and on `new Date()` or `Date.now()`
there.

## What an alert names, revised

The engine originally reported one window per rule: the cheapest run of slots that satisfied it.
That is the wrong unit, and the reason is behavioural rather than technical. A rule is usually
satisfiable for hours either side of its cheapest moment, and an email naming a single two-hour
slot reads as the only time the appliance may be run. Since the cheapest stretch is normally
overnight, the effect was to keep proposing hours nobody would choose while saying nothing about
the usable evening around them.

It now reports every **span**: a contiguous range of start times, each of which satisfies the rule.
The message is "start any time between 16:00 and 23:00" rather than "run it at 22:45", and the
guarantee is that a run beginning anywhere in that range averages within the ceiling.

The definition matters, because the obvious one is wrong. Taking the longest contiguous stretch
whose overall average is under the ceiling would admit spans containing runs that are over it, so a
reader starting at the wrong moment inside the span would pay more than they agreed to. The engine
therefore merges qualifying **starts**, not slots: a start qualifies when the run beginning there
is within the ceiling, and adjacent qualifying starts become one span. The promise then holds at
every point in the range by construction.

Spans are ordered by time rather than by price, for the same reason the change was made: ranking by
price puts the overnight span first and buries the one at a usable hour beneath it.

Windows that have already been emailed about are recorded as markers in the same table, and a
candidate is compared against them by overlap rather than by start time. Equality is the obvious
implementation and it is wrong: the engine ignores slots inside a rule's lead time, so as the
cutoff advances each hour the same cheap stretch is reported one slot later, with a different start
each time. Comparing starts sent a fresh email every hour until the stretch arrived. Overlap asks
the question that was meant all along, which is whether this is the same stretch of cheap power,
not whether it begins at the same instant.

The marker is written after the notification is sent, not before. Writing first would lose an alert
whenever the send failed, because the marker would suppress the retry. Writing after can duplicate
an email if the write fails, and a duplicate is an annoyance where a missing alert defeats the
service. The read of the markers is consistent for the same reason, since an eventually consistent
read can miss one written moments earlier.

Notifications go through SNS rather than SES. A topic with an email subscription needs no domain
verification and no sandbox exit, and it costs nothing at this volume. The more important property
is that the delivery mechanism is a subscription rather than code, so the Android app in Track B
attaches a mobile push endpoint to the same topic without the collector changing at all. The cost
is that SNS email is plain text with a fixed sender, which is acceptable for a personal alert and
would not be for anything user-facing.

`handler.ts` contains nothing but the composition root. The logic lives in `collect.ts` because
importing the handler in a test executes `requireEnv` at module scope and throws, so the split is
what makes the collector testable at all rather than a matter of taste. The clients are built once
per cold start rather than per invocation, and a missing environment variable kills the container
immediately instead of failing an arbitrary run later.
