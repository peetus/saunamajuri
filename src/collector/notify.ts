import { PublishCommand, type SNSClient } from "@aws-sdk/client-sns";
import { type Rule, type Window } from "../rules/types.js";

// The only place that leaves UTC: this text is read by a human.
const helsinkiTime = new Intl.DateTimeFormat("fi-FI", {
  timeZone: "Europe/Helsinki",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

// SNS documents the subject cap as 100 characters and rejects newlines. A
// rejected publish loses the whole batch for that run, so this is the last
// length that is unambiguously accepted rather than the documented figure.
const SUBJECT_LIMIT = 99;

/** One rule and the window that satisfied it. */
export interface Alert {
  rule: Rule;
  window: Window;
}

export interface Notifier {
  /** Sends one message covering every window found this run. */
  sendAlerts(alerts: Alert[]): Promise<void>;
}

export interface SnsNotifierDeps {
  client: SNSClient;
  topicArn: string;
}

function price(alert: Alert): string {
  return alert.window.averagePrice.toFixed(2);
}

/**
 * Names every rule while they fit, and counts them once they do not.
 *
 * Rule ids run to 64 characters each, so two of them already overrun the limit,
 * and an overlong subject is rejected rather than truncated.
 */
function subject(alerts: Alert[]): string {
  const cheapest = alerts.reduce((a, b) => (a.window.averagePrice <= b.window.averagePrice ? a : b));
  const suffix = `from ${price(cheapest)} c/kWh`;
  const named = `Saunamajuri: ${alerts.map((alert) => alert.rule.id).join(", ")} ${suffix}`;
  if (named.length <= SUBJECT_LIMIT) {
    return named;
  }
  return `Saunamajuri: ${String(alerts.length)} cheap windows ${suffix}`.slice(0, SUBJECT_LIMIT);
}

function body(alerts: Alert[]): string {
  return alerts
    .map(({ rule, window }) =>
      [
        rule.id,
        `${helsinkiTime.format(new Date(window.startDate))} - ${helsinkiTime.format(new Date(window.endDate))}`,
        `Average ${price({ rule, window })} c/kWh (your limit is ${String(rule.maxAveragePrice)})`,
      ].join("\n"),
    )
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
