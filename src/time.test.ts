import { describe, expect, it } from "vitest";
import { helsinkiDate, helsinkiDateTime } from "./time.js";

describe("helsinkiDate", () => {
  it("agrees with UTC in the middle of the day", () => {
    expect(helsinkiDate(new Date("2026-09-21T12:00:00.000Z"))).toBe("2026-09-21");
  });

  // The whole point of the function. In September Helsinki is UTC+3, so the
  // Finnish day starts at 21:00Z the evening before.
  it("puts a late-evening UTC instant on the next Finnish day", () => {
    expect(helsinkiDate(new Date("2026-09-21T21:00:00.000Z"))).toBe("2026-09-22");
  });

  it("keeps 20:59Z on the same Finnish day", () => {
    expect(helsinkiDate(new Date("2026-09-21T20:59:00.000Z"))).toBe("2026-09-21");
  });

  // Winter is UTC+2, so the boundary moves an hour later.
  it("uses the winter offset in winter", () => {
    expect(helsinkiDate(new Date("2026-01-15T21:00:00.000Z"))).toBe("2026-01-15");
    expect(helsinkiDate(new Date("2026-01-15T22:00:00.000Z"))).toBe("2026-01-16");
  });

  it("sorts lexicographically, so it can be part of a sort key", () => {
    const dates = [
      helsinkiDate(new Date("2026-09-22T12:00:00.000Z")),
      helsinkiDate(new Date("2026-01-02T12:00:00.000Z")),
      helsinkiDate(new Date("2026-09-21T12:00:00.000Z")),
    ];

    expect([...dates].sort()).toEqual(["2026-01-02", "2026-09-21", "2026-09-22"]);
  });
});

describe("helsinkiDateTime", () => {
  it("renders a weekday and a Finnish-notation time", () => {
    expect(helsinkiDateTime(new Date("2026-09-21T20:00:00.000Z"))).toBe("ma 23.00");
  });
});
