import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as OpenApi from "effect/http-api/OpenApi";

/**
 * Unauthenticated report intake. Both endpoints are raw on the relay: it caps
 * and parses the body itself, because browsers send these with
 * `navigator.sendBeacon` as `text/plain`. Each answers 202 `{ "ok": true }`,
 * or 400, 413, 415 or 429 with `{ "error": "<code>" }`.
 */
export const RelayReportsGroup = HttpApiGroup.make("reports")
  .add(
    HttpApiEndpoint.post("crashReport", "/v1/crash-reports").annotate(
      OpenApi.Summary,
      "Submit a sanitized crash or error report",
    ),
    HttpApiEndpoint.post("siteEvent", "/v1/site-events").annotate(
      OpenApi.Summary,
      "Record a marketing site download event",
    ),
  )
  .annotate(OpenApi.Description, "Anonymous crash reports and site download events.");
