import { type PriceSlot, type Rule, type Span } from "./types.js";

const SLOT_MINUTES = 15;
const SLOT_MS = SLOT_MINUTES * 60_000;

/** One qualifying start and what a run beginning there would average. */
interface Start {
  index: number;
  startDate: string;
  averagePrice: number;
}

/**
 * Finds every stretch during which `rule` is satisfiable, in time order.
 *
 * Time order rather than cheapest first: the cheapest stretch is normally
 * overnight, so ranking by price buries the span at an hour somebody would
 * actually use.
 */
export function findQualifyingSpans(slots: PriceSlot[], rule: Rule, now: Date): Span[] {
  const needed = Math.ceil(rule.durationMinutes / SLOT_MINUTES);
  if (needed <= 0) {
    return [];
  }

  const earliest = now.getTime() + rule.minLeadTimeMinutes * 60_000;
  const candidates = slots
    .filter((slot) => new Date(slot.startDate).getTime() >= earliest)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  const starts = qualifyingStarts(candidates, needed, rule.maxAveragePrice);
  return merge(starts, candidates, needed);
}

/** Every index at which a run of `needed` contiguous slots averages within `ceiling`. */
function qualifyingStarts(candidates: PriceSlot[], needed: number, ceiling: number): Start[] {
  const starts: Start[] = [];
  let sum = 0;

  // Sliding sum: each slot is added and dropped once, so the scan stays linear.
  for (let i = 0; i < candidates.length; i++) {
    sum += candidates[i].price;
    if (i >= needed) {
      sum -= candidates[i - needed].price;
    }
    if (i < needed - 1) {
      continue;
    }

    const start = i - needed + 1;
    const averagePrice = sum / needed;
    // Finite rather than merely a number: NaN compares false against every
    // ceiling, so an unvalidated NaN would pass this test rather than fail it.
    if (!Number.isFinite(averagePrice) || averagePrice > ceiling) {
      continue;
    }
    if (!isContiguous(candidates, start, i)) {
      continue;
    }

    starts.push({ index: start, startDate: candidates[start].startDate, averagePrice });
  }

  return starts;
}

/**
 * Groups adjacent starts, so each span is a range the appliance may begin in.
 *
 * Starts rather than slots, which is the subtle part. Merging the slots whose
 * combined average is within the ceiling would admit a span containing runs
 * that are over it, and the promise a span makes is about every start inside
 * it, not about the stretch as a whole.
 */
function merge(starts: Start[], candidates: PriceSlot[], needed: number): Span[] {
  const spans: Span[] = [];
  let group: Start[] = [];

  const close = (): void => {
    if (group.length === 0) {
      return;
    }
    const first = group[0];
    const last = group[group.length - 1];
    const averages = group.map((start) => start.averagePrice);
    spans.push({
      firstStart: first.startDate,
      lastStart: last.startDate,
      endDate: new Date(new Date(candidates[last.index + needed - 1].startDate).getTime() + SLOT_MS).toISOString(),
      cheapestPrice: Math.min(...averages),
      dearestPrice: Math.max(...averages),
    });
    group = [];
  };

  for (const start of starts) {
    if (group.length > 0 && start.index !== group[group.length - 1].index + 1) {
      close();
    }
    group.push(start);
  }
  close();

  return spans;
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
