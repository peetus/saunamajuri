import { findCheapestWindow } from "../rules/find-window.js";
import { overlaps } from "../rules/overlap.js";
import { type PriceSlot, type Rule } from "../rules/types.js";
import { type Notifier } from "./notify.js";
import { type NotificationLog, type PriceStore } from "./store.js";

export interface CollectorDeps {
  fetchPrices: () => Promise<PriceSlot[]>;
  store: PriceStore;
  notifications: NotificationLog;
  notifier: Notifier;
  rules: Rule[];
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

    for (const rule of rules) {
      const window = findCheapestWindow(slots, rule, runAt);
      if (window === null) {
        continue;
      }
      // By overlap, not by start time: the lead-time cutoff advances every run,
      // so the same trough is reported one slot later each hour.
      const alreadySent = await notifications.notifiedWindows(rule.id);
      if (alreadySent.some((sent) => overlaps(sent, window))) {
        continue;
      }

      await notifier.sendAlert(rule, window);

      // After the send, so a failed send retries next run rather than going silent.
      await notifications.markNotified(rule.id, window, runAt);
      alerted.push(rule.id);
    }

    console.log(JSON.stringify({ msg: "collected prices", slots: slots.length, alerted }));
    return { stored: slots.length, alerted };
  };
}
