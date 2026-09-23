import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { createRouter, type Router } from "./routes.js";
import { RULE_LIMIT, RuleLimitError, type RuleStore } from "../collector/rule-store.js";
import { type PriceSlot, type Rule } from "../rules/types.js";

// 12:00Z on 22 September is 15:00 in Helsinki, so "today" is 2026-09-22 either
// way. The UTC-evening case below is the one that separates them.
const NOW = new Date("2026-09-22T12:00:00.000Z");

const SAUNA: Rule = { id: "sauna", durationMinutes: 120, maxAveragePrice: 3, minLeadTimeMinutes: 720 };

const SLOTS: PriceSlot[] = [{ startDate: "2026-09-22T00:00:00.000Z", price: 1.5 }];

interface Recorded {
  putRules: Rule[];
  daysQueried: string[];
}

function router(overrides: Partial<RuleStore> = {}, now: Date = NOW): { route: Router; recorded: Recorded } {
  const recorded: Recorded = { putRules: [], daysQueried: [] };

  const rules: RuleStore = {
    getRules: () => Promise.resolve([SAUNA]),
    putRule: (rule) => {
      recorded.putRules.push(rule);
      return Promise.resolve();
    },
    getPricesForDay: (day) => {
      recorded.daysQueried.push(day);
      return Promise.resolve(SLOTS);
    },
    ...overrides,
  };

  return { route: createRouter({ rules, now: () => now }), recorded };
}

function request(method: string, path: string, options: { body?: string; day?: string } = {}): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    requestContext: { http: { method } },
    queryStringParameters: options.day === undefined ? undefined : { day: options.day },
    body: options.body,
  } as unknown as APIGatewayProxyEventV2;
}

const bodyOf = (response: { body?: string }): unknown => JSON.parse(response.body ?? "null");

describe("GET /prices", () => {
  it("defaults to the current Finnish day", async () => {
    const { route, recorded } = router();
    const response = await route(request("GET", "/prices"));

    expect(response.statusCode).toBe(200);
    expect(recorded.daysQueried).toEqual(["2026-09-22"]);
    expect(bodyOf(response)).toEqual({ day: "2026-09-22", prices: SLOTS });
  });

  // 21:30Z is already past midnight in Helsinki, so "today" is the 23rd. Using
  // the UTC date here would return the wrong day for three hours every night.
  it("uses the Finnish day, not the UTC one, late in the UTC evening", async () => {
    const { route, recorded } = router({}, new Date("2026-09-22T21:30:00.000Z"));
    await route(request("GET", "/prices"));

    expect(recorded.daysQueried).toEqual(["2026-09-23"]);
  });

  it("treats an empty day as absent", async () => {
    const { route, recorded } = router();
    await route(request("GET", "/prices", { day: "" }));

    expect(recorded.daysQueried).toEqual(["2026-09-22"]);
  });

  it("honours an explicit day", async () => {
    const { route, recorded } = router();
    await route(request("GET", "/prices", { day: "2026-01-15" }));

    expect(recorded.daysQueried).toEqual(["2026-01-15"]);
  });

  it("returns an empty list rather than an error for a day with no data", async () => {
    const { route } = router({ getPricesForDay: () => Promise.resolve([]) });
    const response = await route(request("GET", "/prices", { day: "2020-01-01" }));

    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toEqual({ day: "2020-01-01", prices: [] });
  });
});

describe("GET /rules", () => {
  it("returns the stored rules", async () => {
    const { route } = router();
    const response = await route(request("GET", "/rules"));

    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toEqual({ rules: [SAUNA] });
  });

  it("returns an empty list when none are stored", async () => {
    const { route } = router({ getRules: () => Promise.resolve([]) });

    expect(bodyOf(await route(request("GET", "/rules")))).toEqual({ rules: [] });
  });
});

describe("PUT /rules", () => {
  it("stores a valid rule and names it back", async () => {
    const { route, recorded } = router();
    const response = await route(request("PUT", "/rules", { body: JSON.stringify(SAUNA) }));

    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toEqual({ saved: "sauna" });
    expect(recorded.putRules).toEqual([SAUNA]);
  });

  it("rejects a missing body", async () => {
    const { route, recorded } = router();
    const response = await route(request("PUT", "/rules"));

    expect(response.statusCode).toBe(400);
    expect(recorded.putRules).toEqual([]);
  });

  it("rejects a body that is not an object", async () => {
    const { route, recorded } = router();
    const response = await route(request("PUT", "/rules", { body: "42" }));

    expect(response.statusCode).toBe(400);
    expect(recorded.putRules).toEqual([]);
  });

  it("rejects unparseable JSON rather than throwing a 500", async () => {
    const { route, recorded } = router();
    const response = await route(request("PUT", "/rules", { body: "{ not json" }));

    expect(response.statusCode).toBe(400);
    expect(recorded.putRules).toEqual([]);
  });

  it.each([
    ["id", { ...SAUNA, id: undefined }],
    ["durationMinutes", { ...SAUNA, durationMinutes: undefined }],
    ["maxAveragePrice", { ...SAUNA, maxAveragePrice: undefined }],
    ["minLeadTimeMinutes", { ...SAUNA, minLeadTimeMinutes: undefined }],
  ])("rejects a rule missing %s", async (_field, rule) => {
    const { route, recorded } = router();
    const response = await route(request("PUT", "/rules", { body: JSON.stringify(rule) }));

    expect(response.statusCode).toBe(400);
    expect(recorded.putRules).toEqual([]);
  });

  it("rejects a non-finite price ceiling", async () => {
    const { route, recorded } = router();
    const response = await route(
      request("PUT", "/rules", {
        body: '{"id":"x","durationMinutes":60,' + '"maxAveragePrice":null,"minLeadTimeMinutes":0}',
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(recorded.putRules).toEqual([]);
  });

  // A send that throws mid-loop leaves every later rule unprocessed, and
  // repeats on the next run.
  it.each([
    ["a newline", "sauna\nboom"],
    ["a carriage return", "sauna\rboom"],
    ["a tab", "sauna\tboom"],
    ["32+ characters", "a".repeat(33)],
    ["an uppercase letter", "Sauna"],
    ["a space", "sauna heater"],
    ["a dot", "sauna.example.com"],
    ["a slash", "http://evil.tld"],
    ["a colon", "ACTION REQUIRED: verify"],
    ["a leading hyphen", "-sauna"],
    ["an empty string", ""],
    ["leading space", " sauna"],
    ["non-ASCII", "sauna\u00e4"],
  ])("rejects a rule id containing %s", async (_case, id) => {
    const { route, recorded } = router();
    const response = await route(request("PUT", "/rules", { body: JSON.stringify({ ...SAUNA, id }) }));

    expect(response.statusCode).toBe(400);
    expect(recorded.putRules).toEqual([]);
  });

  it("accepts an id at the length limit", async () => {
    const { route, recorded } = router();
    const id = "a".repeat(32);
    const response = await route(request("PUT", "/rules", { body: JSON.stringify({ ...SAUNA, id }) }));

    expect(response.statusCode).toBe(200);
    expect(recorded.putRules[0]?.id).toBe(id);
  });

  it("decodes a base64-encoded body", async () => {
    const { route, recorded } = router();
    const response = await route({
      ...request("PUT", "/rules", { body: Buffer.from(JSON.stringify(SAUNA)).toString("base64") }),
      isBase64Encoded: true,
    });

    expect(response.statusCode).toBe(200);
    expect(recorded.putRules).toEqual([SAUNA]);
  });

  // 409 rather than 400: the request is well formed, the account is full.
  it("answers 409 when the store refuses a rule beyond the limit", async () => {
    const { route } = router({ putRule: () => Promise.reject(new RuleLimitError(RULE_LIMIT)) });
    const response = await route(request("PUT", "/rules", { body: JSON.stringify(SAUNA) }));

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body ?? "{}")).toMatchObject({ limit: RULE_LIMIT });
  });

  it("does not turn an unrelated store failure into a 409", async () => {
    const { route } = router({ putRule: () => Promise.reject(new Error("throughput exceeded")) });

    await expect(route(request("PUT", "/rules", { body: JSON.stringify(SAUNA) }))).rejects.toThrow(
      "throughput exceeded",
    );
  });

  it("rejects a non-positive duration", async () => {
    const { route, recorded } = router();
    const response = await route(request("PUT", "/rules", { body: JSON.stringify({ ...SAUNA, durationMinutes: 0 }) }));

    expect(response.statusCode).toBe(400);
    expect(recorded.putRules).toEqual([]);
  });
});

describe("routing", () => {
  it("404s an unknown path", async () => {
    const { route } = router();
    const response = await route(request("GET", "/nope"));

    expect(response.statusCode).toBe(404);
  });

  // The route key is method plus path, so the right path with the wrong verb is
  // a miss rather than an accidental match.
  it("404s a known path with the wrong method", async () => {
    const { route, recorded } = router();
    const response = await route(request("DELETE", "/rules"));

    expect(response.statusCode).toBe(404);
    expect(recorded.putRules).toEqual([]);
  });

  it("answers with JSON", async () => {
    const { route } = router();
    const response = await route(request("GET", "/rules"));

    expect(response.headers).toEqual({ "content-type": "application/json" });
  });
});
