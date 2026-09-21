import type { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { describe, expect, it, vi } from "vitest";
import { createSnsNotifier } from "./notify.js";
import { type Rule, type Window } from "../rules/types.js";

const TOPIC = "arn:aws:sns:eu-north-1:123456789012:Alerts";

const RULE: Rule = { id: "sauna", durationMinutes: 120, maxAveragePrice: 3, minLeadTimeMinutes: 720 };

const WINDOW: Window = {
  startDate: "2026-09-21T20:00:00.000Z",
  endDate: "2026-09-21T22:00:00.000Z",
  averagePrice: 1.234,
};

function fakeSns(): { client: SNSClient; inputs: PublishCommand["input"][] } {
  const inputs: PublishCommand["input"][] = [];
  const client = {
    send: vi.fn((command: PublishCommand) => {
      inputs.push(command.input);
      return Promise.resolve({});
    }),
  };
  return { client: client as unknown as SNSClient, inputs };
}

async function publish(window: Window = WINDOW, rule: Rule = RULE): Promise<PublishCommand["input"]> {
  const { client, inputs } = fakeSns();
  await createSnsNotifier({ client, topicArn: TOPIC }).sendAlert(rule, window);
  return inputs[0];
}

describe("createSnsNotifier", () => {
  it("publishes to the injected topic", async () => {
    expect((await publish()).TopicArn).toBe(TOPIC);
  });

  // UTC 20:00 is 23:00 in Helsinki on a September evening (EEST, UTC+3). Getting
  // this wrong sends someone to the sauna three hours early. Finnish notation
  // separates hours and minutes with a dot.
  it("formats times in Helsinki local time, not UTC", async () => {
    const message = (await publish()).Message ?? "";

    expect(message).toContain("23.00");
    expect(message).toContain("01.00");
    expect(message).not.toContain("20.00");
  });

  it("applies the winter offset in winter", async () => {
    // January is EET, UTC+2, so 20:00Z is 22:00 rather than 23:00.
    const message =
      (
        await publish({
          startDate: "2026-01-15T20:00:00.000Z",
          endDate: "2026-01-15T22:00:00.000Z",
          averagePrice: 1,
        })
      ).Message ?? "";

    expect(message).toContain("22.00");
  });

  it("rounds the price to two decimals in both subject and body", async () => {
    const input = await publish();

    expect(input.Subject).toContain("1.23");
    expect(input.Message).toContain("1.23");
    expect(input.Subject).not.toContain("1.234");
  });

  it("names the rule and its limit", async () => {
    const input = await publish();

    expect(input.Subject).toContain("sauna");
    expect(input.Message).toContain("sauna");
    expect(input.Message).toContain("3");
  });

  it("reports a negative price rather than hiding it", async () => {
    const input = await publish({ ...WINDOW, averagePrice: -0.009 });

    expect(input.Subject).toContain("-0.01");
  });

  // SNS rejects both, so a long rule id or a stray newline would fail the
  // publish at runtime rather than here.
  it("keeps the subject within the limits SNS enforces", async () => {
    const input = await publish(WINDOW, { ...RULE, id: "a".repeat(60) });

    expect((input.Subject ?? "").length).toBeLessThanOrEqual(100);
    expect(input.Subject).not.toContain("\n");
  });
});
