import { PublishCommand, type SNSClient } from "@aws-sdk/client-sns";
import { type Rule, type Window } from "../rules/types.js";

// The only place that leaves UTC: this text is read by a human.
const helsinkiTime = new Intl.DateTimeFormat("fi-FI", {
  timeZone: "Europe/Helsinki",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export interface Notifier {
  /** Sends one alert about a window that satisfies a rule. */
  sendAlert(rule: Rule, window: Window): Promise<void>;
}

export interface SnsNotifierDeps {
  client: SNSClient;
  topicArn: string;
}

export function createSnsNotifier({ client, topicArn }: SnsNotifierDeps): Notifier {
  return {
    async sendAlert(rule: Rule, window: Window): Promise<void> {
      const start = helsinkiTime.format(new Date(window.startDate));
      const end = helsinkiTime.format(new Date(window.endDate));
      const price = window.averagePrice.toFixed(2);

      await client.send(
        new PublishCommand({
          TopicArn: topicArn,
          // SNS caps the subject at 100 characters and rejects newlines.
          Subject: `Saunamajuri: ${rule.id} ${price} c/kWh`,
          Message: [
            `Cheap window for ${rule.id}`,
            "",
            `${start} - ${end}`,
            `Average ${price} c/kWh (your limit is ${String(rule.maxAveragePrice)})`,
          ].join("\n"),
        }),
      );
    },
  };
}
