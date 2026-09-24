import { findQualifyingSpans } from "../rules/find-spans.js";
import { overlaps } from "../rules/overlap.js";
import { type PriceSlot } from "../rules/types.js";
import { type Alert, type Notifier } from "./notify.js";
import { type RuleStore } from "./rule-store.js";
import { type NotificationLog, type PriceStore } from "./store.js";

export interface CollectorDeps {
  fetchPrices: () => Promise<PriceSlot[]>;
  store: PriceStore;
  notifications: NotificationLog;
  notifier: Notifier;
  rules: RuleStore;
  now: () => Date;
}

/** What one collector run did, returned so it lands in the CloudWatch log. */
export interface CollectorResult {
  stored: number;
  alerted: string[];
}

/**
 * Builds the collector: fetch prices, store them, then alert per rule whose
 * cheapest qualifying window does not overlap one already emailed about.
 */
export function createCollector({ fetchPrices, store, notifications, notifier, rules, now }: CollectorDeps) {
  return async function collect(): Promise<CollectorResult> {
    const slots = await fetchPrices();
    const runAt = now();
    await store.putPrices(slots, runAt);

    const alerted: string[] = [];
    const configured = await rules.getRules();

    // Worth its own line because the alternative is indistinguishable from a
    // quiet night: with no rules the run stores prices, alerts nothing and
    // looks healthy, which is how a deploy silently stops all alerting.
    if (configured.length === 0) {
      console.log(JSON.stringify({ msg: "no rules configured, nothing to alert on" }));
    }

    const pending: Alert[] = [];

    for (const rule of configured) {
      // By overlap, not by start time: the lead-time cutoff advances every run,
      // so the same trough is reported one slot later each hour.
      const alreadySent = await notifications.notifiedSpans(rule.id);

      for (const span of findQualifyingSpans(slots, rule, runAt)) {
        if (alreadySent.some((sent) => overlaps(sent, span))) {
          continue;
        }
        pending.push({ rule, span });
      }
    }

    if (pending.length > 0) {
      await notifier.sendAlerts(pending);

      // After the send, so a failed send retries next run rather than going silent.
      for (const { rule, span } of pending) {
        await notifications.markNotified(rule.id, span, runAt);
        if (!alerted.includes(rule.id)) {
          alerted.push(rule.id);
        }
      }
    }

    console.log(JSON.stringify({ msg: "collected prices", slots: slots.length, alerted }));
    return { stored: slots.length, alerted };
  };
}
