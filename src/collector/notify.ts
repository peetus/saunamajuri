import { PublishCommand, type SNSClient } from "@aws-sdk/client-sns";
import { type Rule, type Span } from "../rules/types.js";
import { helsinkiDateTime } from "../time.js";

// SNS documents the subject cap as 100 characters and rejects newlines. A
// rejected publish loses the whole batch for that run, so this is the last
// length that is unambiguously accepted rather than the documented figure.
const SUBJECT_LIMIT = 99;

/** One rule and one stretch during which it is satisfiable. */
export interface Alert {
  rule: Rule;
  span: Span;
}

export interface Notifier {
  /** Sends one message covering every span found this run. */
  sendAlerts(alerts: Alert[]): Promise<void>;
}

export interface SnsNotifierDeps {
  client: SNSClient;
  topicArn: string;
}

function at(instant: string): string {
  return helsinkiDateTime(new Date(instant));
}

function money(value: number): string {
  return value.toFixed(2);
}

/** A single figure when every start in the span costs the same, a range otherwise. */
function priceRange(span: Span): string {
  return span.cheapestPrice === span.dearestPrice
    ? money(span.cheapestPrice)
    : `${money(span.cheapestPrice)}-${money(span.dearestPrice)}`;
}

function runLength(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) {
    return `${String(rest)}min`;
  }
  return rest === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(rest)}min`;
}

/** Rule ids in the order they first appear, each listed once. */
function ruleOrder(alerts: Alert[]): string[] {
  return [...new Set(alerts.map((alert) => alert.rule.id))];
}

/**
 * Names every rule while they fit, and counts them once they do not.
 *
 * Ten ids at the length the API accepts overrun the limit between them, and an
 * overlong subject is rejected rather than truncated.
 */
function subject(alerts: Alert[]): string {
  const cheapest = Math.min(...alerts.map((alert) => alert.span.cheapestPrice));
  const suffix = `from ${money(cheapest)} c/kWh`;
  const ids = ruleOrder(alerts);
  const named = `Saunamajuri: ${ids.join(", ")} ${suffix}`;
  if (named.length <= SUBJECT_LIMIT) {
    return named;
  }
  return `Saunamajuri: ${String(ids.length)} rules ${suffix}`.slice(0, SUBJECT_LIMIT);
}

/**
 * One block per rule, listing every stretch it may be run in.
 *
 * The start range is what the reader acts on, so it leads. The run length is
 * stated once per rule rather than an end time per span, because the end is
 * whatever the chosen start plus that length comes to.
 */
function body(alerts: Alert[]): string {
  return ruleOrder(alerts)
    .map((id) => {
      const mine = alerts.filter((alert) => alert.rule.id === id);
      const { rule } = mine[0];
      const heading = `${id} - ${runLength(rule.durationMinutes)} run, your limit is ${String(rule.maxAveragePrice)} c/kWh`;
      const lines = mine.map(
        ({ span }) => `  start ${at(span.firstStart)} - ${at(span.lastStart)}   ${priceRange(span)} c/kWh`,
      );
      return [heading, ...lines].join("\n");
    })
    .join("\n\n");
}

export function createSnsNotifier({ client, topicArn }: SnsNotifierDeps): Notifier {
  return {
    async sendAlerts(alerts: Alert[]): Promise<void> {
      if (alerts.length === 0) {
        return;
      }

      await client.send(new PublishCommand({ TopicArn: topicArn, Subject: subject(alerts), Message: body(alerts) }));
    },
  };
}
