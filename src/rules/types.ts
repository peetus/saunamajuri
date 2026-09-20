/**
 * An ISO-8601 timestamp in UTC, e.g. `2026-09-21T18:45:00.000Z`.
 *
 * A documentation alias, not a constraint — the compiler still accepts any
 * string. Everything in this project stores and reasons in UTC; conversion to
 * Europe/Helsinki happens only at the edge, when text is written for a human.
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
  /** Maximum acceptable average price across the window, c/kWh. */
  maxAveragePrice: number;
  /** Only notify about windows starting at least this far ahead. */
  minLeadTimeMinutes: number;
}

/** A contiguous run of slots that satisfies a rule. */
export interface Window {
  startDate: IsoDateString;
  endDate: IsoDateString;
  averagePrice: number;
}
