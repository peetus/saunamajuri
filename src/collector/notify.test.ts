import type { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { describe, expect, it, vi } from "vitest";
import { type Alert, createSnsNotifier } from "./notify.js";
import { type Rule, type Span } from "../rules/types.js";

const TOPIC = "arn:aws:sns:eu-north-1:123456789012:Alerts";

const RULE: Rule = { id: "sauna", durationMinutes: 120, maxAveragePrice: 3, minLeadTimeMinutes: 720 };

const SPAN: Span = {
  firstStart: "2026-09-21T20:00:00.000Z",
  lastStart: "2026-09-21T20:00:00.000Z",
  endDate: "2026-09-21T22:00:00.000Z",
  cheapestPrice: 1.234,
  dearestPrice: 1.234,
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

function alert(rule: Partial<Rule> = {}, span: Partial<Span> = {}): Alert {
  return { rule: { ...RULE, ...rule }, span: { ...SPAN, ...span } };
}

async function publish(alerts: Alert[] = [alert()]): Promise<PublishCommand["input"]> {
  const { client, inputs } = fakeSns();
  await createSnsNotifier({ client, topicArn: TOPIC }).sendAlerts(alerts);
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
    expect(message).not.toContain("20.00");
  });

  it("applies the winter offset in winter", async () => {
    // January is EET, UTC+2, so 20:00Z is 22:00 rather than 23:00.
    const message =
      (
        await publish([
          alert(
            {},
            {
              firstStart: "2026-01-15T20:00:00.000Z",
              lastStart: "2026-01-15T20:00:00.000Z",
              endDate: "2026-01-15T22:00:00.000Z",
            },
          ),
        ])
      ).Message ?? "";

    expect(message).toContain("22.00");
  });

  it("names the rule and its limit", async () => {
    const input = await publish();

    expect(input.Subject).toContain("sauna");
    expect(input.Message).toContain("sauna");
    expect(input.Message).toContain("3");
  });

  it("states the run length, so a start range implies its own end", async () => {
    expect((await publish()).Message).toContain("2h");
  });

  it("reports a negative price rather than hiding it", async () => {
    const input = await publish([alert({}, { cheapestPrice: -0.009, dearestPrice: -0.009 })]);

    expect(input.Subject).toContain("-0.01");
  });

  describe("spans", () => {
    it("gives the range of starts rather than a single time", async () => {
      const message =
        (
          await publish([
            alert(
              {},
              {
                firstStart: "2026-09-21T13:00:00.000Z",
                lastStart: "2026-09-21T20:00:00.000Z",
                endDate: "2026-09-21T22:00:00.000Z",
                cheapestPrice: 1.2,
                dearestPrice: 2.8,
              },
            ),
          ])
        ).Message ?? "";

      expect(message).toContain("16.00");
      expect(message).toContain("23.00");
    });

    it("gives the price range across the span", async () => {
      const message = (await publish([alert({}, { cheapestPrice: 1.2, dearestPrice: 2.8 })])).Message ?? "";

      expect(message).toContain("1.20");
      expect(message).toContain("2.80");
    });

    it("gives one price when every start in the span costs the same", async () => {
      const message = (await publish([alert({}, { cheapestPrice: 2, dearestPrice: 2 })])).Message ?? "";

      expect(message).toContain("2.00");
      expect(message).not.toContain("2.00-2.00");
    });

    it("lists every span of a rule under one heading", async () => {
      const morning = alert({}, { firstStart: "2026-09-21T04:00:00.000Z", lastStart: "2026-09-21T04:00:00.000Z" });
      const evening = alert({}, { firstStart: "2026-09-21T16:00:00.000Z", lastStart: "2026-09-21T16:00:00.000Z" });
      const message = (await publish([morning, evening])).Message ?? "";

      expect(message.match(/sauna/g)).toHaveLength(1);
      expect(message).toContain("07.00");
      expect(message).toContain("19.00");
    });

    it("keeps a rule's spans in the order it was given them", async () => {
      const early = alert({}, { firstStart: "2026-09-21T04:00:00.000Z", lastStart: "2026-09-21T04:00:00.000Z" });
      const late = alert({}, { firstStart: "2026-09-21T16:00:00.000Z", lastStart: "2026-09-21T16:00:00.000Z" });
      const message = (await publish([early, late])).Message ?? "";

      expect(message.indexOf("07.00")).toBeLessThan(message.indexOf("19.00"));
    });
  });

  describe("batching", () => {
    const THREE = [
      alert({ id: "sauna", maxAveragePrice: 3 }, { cheapestPrice: 2.5, dearestPrice: 2.5 }),
      alert({ id: "dishwasher", maxAveragePrice: 10 }, { cheapestPrice: 1.5, dearestPrice: 1.5 }),
      alert({ id: "laundry", maxAveragePrice: 10 }, { cheapestPrice: 2, dearestPrice: 2 }),
    ];

    it("sends one message for several rules rather than one each", async () => {
      const { client, inputs } = fakeSns();

      await createSnsNotifier({ client, topicArn: TOPIC }).sendAlerts(THREE);

      // One publish is equally true of one alert, so the fixture's size is the
      // whole case and is asserted rather than assumed.
      expect(THREE).toHaveLength(3);
      expect(inputs).toHaveLength(1);
    });

    it("describes every rule in the body, each with its own limit", async () => {
      const message = (await publish(THREE)).Message ?? "";

      expect(message).toContain("sauna");
      expect(message).toContain("dishwasher");
      expect(message).toContain("laundry");
      expect(message).toContain("3");
      expect(message).toContain("10");
    });

    it("keeps the rules in the order it was given them", async () => {
      const message = (await publish(THREE)).Message ?? "";

      expect(message.indexOf("sauna")).toBeLessThan(message.indexOf("dishwasher"));
      expect(message.indexOf("dishwasher")).toBeLessThan(message.indexOf("laundry"));
    });

    it("names every rule in the subject when they fit", async () => {
      const subject = (await publish(THREE)).Subject ?? "";

      expect(subject).toContain("sauna");
      expect(subject).toContain("dishwasher");
      expect(subject).toContain("laundry");
    });

    it("names a rule once in the subject even with several spans", async () => {
      const subject = (await publish([alert({ id: "sauna" }), alert({ id: "sauna" })])).Subject ?? "";

      expect(subject.match(/sauna/g)).toHaveLength(1);
    });

    it("leads the subject with the cheapest price of the batch", async () => {
      expect((await publish(THREE)).Subject).toContain("1.50");
    });

    it("publishes nothing when there is nothing to report", async () => {
      const { client, inputs } = fakeSns();

      await createSnsNotifier({ client, topicArn: TOPIC }).sendAlerts([]);

      expect(inputs).toEqual([]);
    });
  });

  // Length and newlines are both rejected by SNS, so either one fails the
  // publish at runtime rather than here.
  describe("the subject SNS will accept", () => {
    const longId = (n: number): Alert => alert({ id: String(n) + "a".repeat(31) });

    it("stays within the limit for one rule at the id length limit", async () => {
      const subject = (await publish([longId(1)])).Subject ?? "";

      expect(subject.length).toBeLessThan(100);
      expect(subject).not.toContain("\n");
    });

    it("stays within the limit for many rules at the id length limit", async () => {
      const subject = (await publish([longId(1), longId(2), longId(3), longId(4)])).Subject ?? "";

      expect(subject.length).toBeLessThan(100);
      expect(subject).not.toContain("\n");
    });

    it("falls back to counting the rules it could not name", async () => {
      const subject = (await publish([longId(1), longId(2), longId(3), longId(4)])).Subject ?? "";

      expect(subject).toContain("4");
      expect(subject).not.toContain("aaaa");
    });

    // Exactly at the documented cap, which SNS reads as exclusive. Without a
    // fixture that lands on the boundary, an off-by-one in the limit passes.
    it("falls back at exactly the documented cap", async () => {
      const first = "a".repeat(23);
      const second = "b".repeat(22);
      const third = "c".repeat(22);
      expect(`Saunamajuri: ${first}, ${second}, ${third} from 1.23 c/kWh`).toHaveLength(100);

      const subject =
        (await publish([alert({ id: first }), alert({ id: second }), alert({ id: third })])).Subject ?? "";

      expect(subject).not.toContain(first);
      expect(subject.length).toBeLessThan(100);
    });

    it("still names the rules when a batch of short ids fits", async () => {
      const subject = (await publish([alert({ id: "a" }), alert({ id: "b" })])).Subject ?? "";

      expect(subject).toContain("a, b");
    });
  });
});
