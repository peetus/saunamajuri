import { describe, expect, it, vi } from "vitest";
import { createCollector, type CollectorResult } from "./collect.js";
import { type Notifier } from "./notify.js";
import { type RuleStore } from "./rule-store.js";
import { type NotificationLog, type PriceStore } from "./store.js";
import { type PriceSlot, type Rule, type Span } from "../rules/types.js";

const NOW = new Date("2026-09-21T00:00:00.000Z");

const SAUNA: Rule = { id: "sauna", durationMinutes: 30, maxAveragePrice: 5, minLeadTimeMinutes: 0 };
const LAUNDRY: Rule = { id: "laundry", durationMinutes: 30, maxAveragePrice: 2, minLeadTimeMinutes: 0 };

/** Two adjacent slots at `price`. */
function slots(price: number): PriceSlot[] {
  return [
    { startDate: "2026-09-21T01:00:00.000Z", price },
    { startDate: "2026-09-21T01:15:00.000Z", price },
  ];
}

/** The collector only reads rules, so the other two throw if they are reached. */
function ruleStore(rules: Rule[]): RuleStore {
  return {
    getRules: () => Promise.resolve(rules),
    putRule: () => Promise.reject(new Error("the collector must not write rules")),
    getPricesForDay: () => Promise.reject(new Error("the collector must not read prices back")),
  };
}

interface Options {
  prices?: PriceSlot[];
  /** Rule ids that already have a marker covering the whole test day. */
  notified?: string[];
  rules?: Rule[];
  failOn?: "fetch" | "store" | "lookup" | "send" | "mark";
}

/** One publish. The outer array is emails sent, the inner one their contents. */
type SentBatch = { ruleId: string; span: Span }[];

interface Harness {
  collect: () => Promise<CollectorResult>;
  stored: PriceSlot[][];
  sent: SentBatch[];
  marked: string[];
}

/** Recording fakes, one per injected dependency. */
function harness(options: Options = {}): Harness {
  const stored: PriceSlot[][] = [];
  const sent: SentBatch[] = [];
  const marked: string[] = [];
  const fail = (step: Options["failOn"]): Promise<never> | null =>
    options.failOn === step ? Promise.reject(new Error(`${step} failed`)) : null;

  const store: PriceStore = {
    putPrices: (slots) => {
      const failed = fail("store");
      if (failed !== null) {
        return failed;
      }
      stored.push(slots);
      return Promise.resolve();
    },
  };

  const wholeDay: Span = {
    firstStart: "2026-09-21T00:00:00.000Z",
    lastStart: "2026-09-21T00:00:00.000Z",
    endDate: "2026-09-22T00:00:00.000Z",
    cheapestPrice: 1,
    dearestPrice: 1,
  };

  const notifications: NotificationLog = {
    notifiedSpans: (ruleId) =>
      fail("lookup") ?? Promise.resolve((options.notified ?? []).includes(ruleId) ? [wholeDay] : []),
    markNotified: (ruleId, span) => {
      const failed = fail("mark");
      if (failed !== null) {
        return failed;
      }
      marked.push(`${ruleId}@${span.firstStart}`);
      return Promise.resolve();
    },
  };

  const notifier: Notifier = {
    sendAlerts: (alerts) => {
      const failed = fail("send");
      if (failed !== null) {
        return failed;
      }
      sent.push(alerts.map(({ rule, span }) => ({ ruleId: rule.id, span })));
      return Promise.resolve();
    },
  };

  const collect = createCollector({
    fetchPrices: () => fail("fetch") ?? Promise.resolve(options.prices ?? slots(1)),
    store,
    notifications,
    notifier,
    rules: ruleStore(options.rules ?? [SAUNA]),
    now: () => NOW,
  });

  return { collect, stored, sent, marked };
}

describe("createCollector", () => {
  it("stores every fetched slot and reports the count", async () => {
    const { collect, stored } = harness();

    expect(await collect()).toEqual({ stored: 2, alerted: ["sauna"] });
    expect(stored).toEqual([slots(1)]);
  });

  it("alerts once and records that it did", async () => {
    const { collect, sent, marked } = harness();

    await collect();

    expect(sent).toEqual([
      [
        {
          ruleId: "sauna",
          span: {
            firstStart: "2026-09-21T01:00:00.000Z",
            lastStart: "2026-09-21T01:00:00.000Z",
            endDate: "2026-09-21T01:30:00.000Z",
            cheapestPrice: 1,
            dearestPrice: 1,
          },
        },
      ],
    ]);
    expect(marked).toEqual(["sauna@2026-09-21T01:00:00.000Z"]);
  });

  it("does not alert again about a window that overlaps one already sent", async () => {
    const { collect, sent, marked } = harness({ notified: ["sauna"] });

    expect(await collect()).toEqual({ stored: 2, alerted: [] });
    expect(sent).toEqual([]);
    expect(marked).toEqual([]);
  });

  it("does not send an empty email when no rule qualifies", async () => {
    const { collect, sent } = harness({ prices: slots(99) });

    await collect();

    expect(sent).toEqual([]);
  });

  it("stores prices but sends nothing when no window qualifies", async () => {
    const { collect, stored, sent } = harness({ prices: slots(20) });

    expect(await collect()).toEqual({ stored: 2, alerted: [] });
    expect(stored).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("evaluates every rule, not just the first", async () => {
    const { collect, sent } = harness({ rules: [SAUNA, LAUNDRY] });

    expect((await collect()).alerted).toEqual(["sauna", "laundry"]);
    expect(sent.flat().map((alert) => alert.ruleId)).toEqual(["sauna", "laundry"]);
  });

  // The behaviour that was asked for: one email listing every appliance worth
  // running, not one email per appliance.
  it("reports several qualifying rules in a single email", async () => {
    const dishwasher: Rule = { id: "dishwasher", durationMinutes: 30, maxAveragePrice: 10, minLeadTimeMinutes: 0 };
    const { collect, sent, marked } = harness({ rules: [SAUNA, LAUNDRY, dishwasher] });

    expect((await collect()).alerted).toEqual(["sauna", "laundry", "dishwasher"]);
    expect(sent).toHaveLength(1);
    expect(sent[0].map((alert) => alert.ruleId)).toEqual(["sauna", "laundry", "dishwasher"]);
    expect(marked).toHaveLength(3);
  });

  it("alerts a rule whose ceiling is met and skips one whose is not", async () => {
    // 3 c/kWh is under sauna's ceiling of 5 but over laundry's of 2.
    const { collect } = harness({ rules: [SAUNA, LAUNDRY], prices: slots(3) });

    expect((await collect()).alerted).toEqual(["sauna"]);
  });

  it("suppresses only the rule that was already notified", async () => {
    const { collect, sent } = harness({ rules: [SAUNA, LAUNDRY], notified: ["sauna"] });

    expect((await collect()).alerted).toEqual(["laundry"]);
    expect(sent.flat().map((alert) => alert.ruleId)).toEqual(["laundry"]);
  });

  it("says so when no rules are configured", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(line);
    });

    const { collect } = harness({ rules: [] });
    expect((await collect()).alerted).toEqual([]);
    spy.mockRestore();

    expect(logged.some((line) => line.includes("no rules configured"))).toBe(true);
  });

  it("handles an empty feed without alerting", async () => {
    const { collect } = harness({ prices: [] });

    expect(await collect()).toEqual({ stored: 0, alerted: [] });
  });

  it("does not mark a window as notified when the send fails", async () => {
    const { collect, marked } = harness({ failOn: "send" });

    await expect(collect()).rejects.toThrow("send failed");
    expect(marked).toEqual([]);
  });

  // One publish covers every rule, so a failure loses all of them together and
  // the next run re-sends the lot.
  it("marks nothing at all when a batched send fails", async () => {
    const { collect, marked } = harness({ rules: [SAUNA, LAUNDRY], failOn: "send" });

    await expect(collect()).rejects.toThrow("send failed");
    expect(marked).toEqual([]);
  });

  it("stores nothing and sends nothing when the fetch fails", async () => {
    const { collect, stored, sent } = harness({ failOn: "fetch" });

    await expect(collect()).rejects.toThrow("fetch failed");
    expect(stored).toEqual([]);
    expect(sent).toEqual([]);
  });

  // Alerting on prices that were not durably stored would leave the next run
  // unable to tell whether it had already sent the email.
  it("does not alert when the prices could not be stored", async () => {
    const { collect, sent } = harness({ failOn: "store" });

    await expect(collect()).rejects.toThrow("store failed");
    expect(sent).toEqual([]);
  });

  it("does not send when the dedupe lookup fails", async () => {
    const { collect, sent } = harness({ failOn: "lookup" });

    await expect(collect()).rejects.toThrow("lookup failed");
    expect(sent).toEqual([]);
  });

  // Known and accepted: a failed mark after a successful send means the next
  // run re-sends. A duplicate email beats a missing one.
  it("has already sent the email when marking fails", async () => {
    const { collect, sent } = harness({ failOn: "mark" });

    await expect(collect()).rejects.toThrow("mark failed");
    expect(sent).toHaveLength(1);
  });

  // The lead-time cutoff advances every run, so the same trough is reported one
  // slot later each hour. Comparing starts for equality would re-alert on it.
  it("suppresses a window that merely slid forward inside a known trough", async () => {
    const sentAlready: Span = {
      firstStart: "2026-09-21T00:45:00.000Z",
      lastStart: "2026-09-21T00:45:00.000Z",
      endDate: "2026-09-21T01:15:00.000Z",
      cheapestPrice: 1,
      dearestPrice: 1,
    };

    const collect = createCollector({
      fetchPrices: () => Promise.resolve(slots(1)),
      store: { putPrices: () => Promise.resolve() },
      notifications: {
        notifiedSpans: () => Promise.resolve([sentAlready]),
        markNotified: () => Promise.resolve(),
      },
      notifier: { sendAlerts: () => Promise.reject(new Error("should not send")) },
      rules: ruleStore([SAUNA]),
      now: () => NOW,
    });

    expect((await collect()).alerted).toEqual([]);
  });
});
