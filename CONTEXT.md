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

A run of contiguous slots long enough to satisfy a rule, together with the
average price across them. What the service actually reports. A window is
defined by the prices, not by the storage: it may straddle a Finnish day
boundary and belong to two partitions, so the rule engine works on a flat list
of slots and knows nothing about days.

## Rule

One appliance's requirements, stored per user and editable over the API:

| Field                | Meaning                                                         |
| -------------------- | --------------------------------------------------------------- |
| `id`                 | Stable name, e.g. `sauna`. Lowercase slug, up to 32 characters. |
| `durationMinutes`    | Contiguous minutes of cheap power the appliance needs.          |
| `maxAveragePrice`    | Ceiling, in c/kWh, on the window's average.                     |
| `minLeadTimeMinutes` | How far ahead a window must start to be worth reporting.        |

## Ceiling

A rule's `maxAveragePrice`, compared against the **average** across a window
rather than against any individual slot. A window may contain a slot above the
ceiling as long as the average stays under it, which is the intent: what matters
is the cost of the whole run, not its worst quarter-hour.

## Lead time

A rule's `minLeadTimeMinutes`: the minimum distance between now and the start of
a window for that window to be reported. It exists because an alert you cannot
act on is not useful — being told that power is cheap in ten minutes is noise.
It is per-rule because the right value differs by appliance: a sauna is planned
around, a dishwasher is switched on.

The consequence is worth knowing. The engine filters by lead time **before**
ranking by price, so the window it reports is the cheapest _eligible_ one, which
is not always the cheapest one that exists.

## Marker

A record that a window has already been reported for a rule, so the next run
does not report it again. Compared by **overlap**, not by start time: the
lead-time cutoff advances every run, so the same stretch of cheap power is found
starting one slot later each hour. Two windows that intersect at all are the
same alert.

## Collector

The scheduled Lambda that fetches prices, stores them, evaluates every rule and
sends at most one email per run. The only writer of price data.
