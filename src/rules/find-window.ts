import { type PriceSlot, type Rule, type Window } from "./types.js";

const SLOT_MINUTES = 15;
const SLOT_MS = SLOT_MINUTES * 60_000;

/**
 * Finds the cheapest run of contiguous slots long enough to satisfy `rule`,
 * ignoring anything that starts sooner than the rule's lead time.
 *
 * Returns null when no such run exists, or when the cheapest one is still above
 * the rule's price ceiling.
 */
export function findCheapestWindow(slots: PriceSlot[], rule: Rule, now: Date): Window | null {
  const needed = Math.ceil(rule.durationMinutes / SLOT_MINUTES);
  if (needed <= 0) {
    return null;
  }

  const earliest = now.getTime() + rule.minLeadTimeMinutes * 60_000;
  const candidates = slots
    .filter((slot) => new Date(slot.startDate).getTime() >= earliest)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  if (candidates.length < needed) {
    return null;
  }

  // Sliding sum: each slot is added and dropped once, so the scan stays linear.
  let best: Window | null = null;
  let sum = 0;

  for (let i = 0; i < candidates.length; i++) {
    sum += candidates[i].price;
    if (i >= needed) {
      sum -= candidates[i - needed].price;
    }
    if (i < needed - 1) {
      continue;
    }

    const start = i - needed + 1;
    if (!isContiguous(candidates, start, i)) {
      continue;
    }

    const averagePrice = sum / needed;
    if (best === null || averagePrice < best.averagePrice) {
      best = {
        startDate: candidates[start].startDate,
        endDate: new Date(new Date(candidates[i].startDate).getTime() + SLOT_MS).toISOString(),
        averagePrice,
      };
    }
  }

  if (best === null || best.averagePrice > rule.maxAveragePrice) {
    return null;
  }
  return best;
}

/** True when every slot from `from` to `to` starts exactly one slot after the previous one. */
function isContiguous(slots: PriceSlot[], from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    const expected = new Date(slots[i].startDate).getTime() + SLOT_MS;
    if (new Date(slots[i + 1].startDate).getTime() !== expected) {
      return false;
    }
  }
  return true;
}
