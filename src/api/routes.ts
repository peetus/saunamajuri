import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { RuleLimitError, type RuleStore } from "../collector/rule-store.js";
import { type Rule } from "../rules/types.js";
import { helsinkiDate } from "../time.js";

/** Handles one API Gateway request. */
export type Router = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>;

export interface RouterDeps {
  rules: RuleStore;
  now: () => Date;
}

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// The id reaches two places that reject things a string may contain: an SNS
// subject, which takes no newline and caps at 100 characters, and a DynamoDB
// sort key, which caps at 1024 bytes. Printable ASCII within 64 characters
// clears both with room for the rest of the subject.
const RULE_ID = /^[\x20-\x7E]{1,64}$/;

/** Validates an untrusted body into a Rule, or returns null. */
function parseRule(body: string): Rule | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }

  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const { id, durationMinutes, maxAveragePrice, minLeadTimeMinutes } = raw as Record<string, unknown>;

  // Finite rather than merely a number: a NaN ceiling compares false against
  // every price, so the rule would never fire and would read as a silent
  // failure rather than input that was rejected.
  if (typeof id !== "string" || !RULE_ID.test(id) || id.trim() !== id) {
    return null;
  }
  if (typeof durationMinutes !== "number" || !Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    return null;
  }
  if (typeof maxAveragePrice !== "number" || !Number.isFinite(maxAveragePrice)) {
    return null;
  }
  if (typeof minLeadTimeMinutes !== "number" || !Number.isFinite(minLeadTimeMinutes) || minLeadTimeMinutes < 0) {
    return null;
  }

  return { id, durationMinutes, maxAveragePrice, minLeadTimeMinutes };
}

/**
 * Builds the API router.
 *
 * No web framework: API Gateway already routed the request, so matching on
 * method and path is the whole job. Express would mean cold-starting a router
 * to serve three routes.
 */
export function createRouter({ rules, now }: RouterDeps): Router {
  return async function route(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
    const key = `${event.requestContext.http.method} ${event.rawPath}`;

    if (key === "GET /prices") {
      // "Today" is the Finnish day, matching the partition the collector writes.
      const requested = event.queryStringParameters?.day;
      const day = requested === undefined || requested === "" ? helsinkiDate(now()) : requested;
      return json(200, { day, prices: await rules.getPricesForDay(day) });
    }

    if (key === "GET /rules") {
      return json(200, { rules: await rules.getRules() });
    }

    if (key === "PUT /rules") {
      if (event.body === undefined) {
        return json(400, { error: "body required" });
      }

      const body = event.isBase64Encoded === true ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
      const rule = parseRule(body);
      if (rule === null) {
        return json(400, { error: "id, durationMinutes, maxAveragePrice and minLeadTimeMinutes are required" });
      }

      try {
        await rules.putRule(rule);
      } catch (error) {
        // Narrow: anything else is a fault, and answering 409 to it would tell
        // the caller to change a request that was never the problem.
        if (error instanceof RuleLimitError) {
          return json(409, { error: error.message, limit: error.limit });
        }
        throw error;
      }
      return json(200, { saved: rule.id });
    }

    return json(404, { error: `no route for ${key}` });
  };
}
