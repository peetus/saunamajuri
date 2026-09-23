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

// Deliberately narrower than its sinks require. The id is rendered verbatim
// into an SNS subject and body, and that mail arrives from Amazon with valid
// DKIM at an address its reader has confirmed, so anything expressive enough
// for a sentence or a URL is a phishing primitive handed to an unauthenticated
// caller. Slug characters leave no room for one and cost nothing: the ids this
// serves are `sauna` and `dishwasher`.
const RULE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

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
