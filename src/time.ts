const HELSINKI = "Europe/Helsinki";

// sv-SE renders YYYY-MM-DD, chosen for the format rather than the locale.
const dateInHelsinki = new Intl.DateTimeFormat("sv-SE", { timeZone: HELSINKI });

const timeInHelsinki = new Intl.DateTimeFormat("fi-FI", {
  timeZone: HELSINKI,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * The calendar date in Helsinki that `instant` falls on, as `YYYY-MM-DD`.
 *
 * A Finnish day, 00:00-23:59 local, because that is the day a user means. It
 * starts at 21:00 UTC in summer and 22:00 in winter, so the last hours of a UTC
 * date already belong to the next Finnish one.
 */
export function helsinkiDate(instant: Date): string {
  return dateInHelsinki.format(instant);
}

/** `instant` as a weekday and time a Finnish reader expects, e.g. `ma 23.00`. */
export function helsinkiDateTime(instant: Date): string {
  return timeInHelsinki.format(instant);
}
