/**
 * An ISO-8601 timestamp in UTC, e.g. `2026-09-21T18:45:00.000Z`.
 *
 * A documentation alias, not a constraint — the compiler still accepts any string.
 */
export type IsoDateString = string;

/** One 15-minute spot price slot. */
export interface PriceSlot {
  /** When the slot starts. */
  startDate: IsoDateString;
  /** Price in c/kWh, VAT included. */
  price: number;
}

/** A user's notification rule for one appliance. */
export interface Rule {
  /** Stable identifier, e.g. `sauna`. */
  id: string;
  /** Consecutive minutes of cheap power the appliance needs. */
  durationMinutes: number;
  /** Maximum acceptable average price across a run, c/kWh. */
  maxAveragePrice: number;
  /** Only report starts at least this far ahead. */
  minLeadTimeMinutes: number;
}

/**
 * A contiguous range of start times, every one of which satisfies the rule.
 *
 * The guarantee: a run beginning anywhere from `firstStart` to `lastStart`
 * averages at or under the rule's ceiling. See `docs/adr/0003` for why this is
 * reported rather than a single window.
 */
export interface Span {
  /** Earliest slot the appliance may start at. */
  firstStart: IsoDateString;
  /** Latest slot it may start at and still be covered. */
  lastStart: IsoDateString;
  /** When a run beginning at `lastStart` finishes. */
  endDate: IsoDateString;
  /** Average across the cheapest qualifying start. */
  cheapestPrice: number;
  /** Average across the dearest qualifying start. */
  dearestPrice: number;
}
