# Domain vocabulary

The words this codebase uses, and what they mean here specifically. Where a term
has a looser everyday meaning, the definition below is the one the code enforces.

## Spot price

The wholesale price of electricity for a period, in cents per kilowatt-hour,
VAT included, as published for the Finnish bidding area. Set a day ahead by a
market auction, not by a supplier, which is why it is knowable in advance and
worth planning around. It can be negative when generation exceeds demand; the
code treats that as an ordinary value rather than an error.

## Slot

One 15-minute period and its spot price. The atom of everything here: prices
arrive as slots, are stored as slots, and the rule engine searches over slots.
A slot is identified by the instant it begins, in UTC.

## Finnish day

The calendar day in `Europe/Helsinki`, which is UTC+2 in winter and UTC+3 in
summer. **Not the UTC day.** Midnight in Helsinki falls at 21:00Z or 22:00Z, so
keying anything by the UTC date would split each Finnish day across two groups
and misfile the hours around midnight. It is the partition key for stored
prices.

## Window

One possible run: contiguous slots long enough to satisfy a rule, with the
average price across them. An internal unit, not what the service reports — it
is a candidate the engine considers. A window is defined by the prices, not by
the storage: it may straddle a Finnish day boundary and belong to two
partitions, so the rule engine works on a flat list of slots and knows nothing
about days.

## Span

A contiguous range of **start times**, every one of which satisfies the rule.
**What the service actually reports.** The guarantee is that a run beginning
anywhere from the first start to the last averages at or under the ceiling — so
the alert reads "start any time between 16:00 and 23:00" rather than naming one
moment.

The distinction that makes it correct: a span merges qualifying _starts_, not
slots. Merging the slots whose combined average is under the ceiling would admit
a stretch containing individual runs that are over it, and the promise is about
every start inside the span, not about the stretch as a whole.

Spans are reported in time order rather than cheapest first. The cheapest
stretch is usually overnight, so ranking by price buries the one at an hour
somebody would actually use. See `docs/adr/0003`.

## Rule

One appliance's requirements, stored per user and editable over the API:

| Field                | Meaning                                                         |
| -------------------- | --------------------------------------------------------------- |
| `id`                 | Stable name, e.g. `sauna`. Lowercase slug, up to 32 characters. |
| `durationMinutes`    | Contiguous minutes of cheap power the appliance needs.          |
| `maxAveragePrice`    | Ceiling, in c/kWh, on the average across a run.                 |
| `minLeadTimeMinutes` | How far ahead a window must start to be worth reporting.        |

## Ceiling

A rule's `maxAveragePrice`, compared against the **average** across a run rather
than against any individual slot. A run may contain a slot above the ceiling as
long as the average stays under it, which is the intent: what matters is the
cost of the whole run, not its worst quarter-hour.

## Lead time

A rule's `minLeadTimeMinutes`: the minimum distance between now and a start time
for that start to be worth reporting. It exists because an alert you cannot
act on is not useful — being told that power is cheap in ten minutes is noise.
It is per-rule because the right value differs by appliance: a sauna is planned
around, a dishwasher is switched on.

The consequence is worth knowing. The engine discards everything inside the lead
time **before** looking at price, so a cheaper stretch that is too close to now
is never reported.

## Marker

A record that a span has already been reported for a rule, so the next run does
not report it again. Compared by **overlap**, not by start time: the lead-time
cutoff advances every run, so the same stretch of cheap power is found starting
one slot later each hour. Two spans that intersect at all are the same alert.

## Collector

The scheduled Lambda that fetches prices, stores them, evaluates every rule and
sends at most one email per run. The only writer of price data.
