import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { RelayApi } from "@specweave-studio/contracts/relay";
import {
  CRASH_REPORT_MAX_BYTES,
  parseCrashReport,
  parseSiteEvent,
  SITE_EVENT_MAX_BYTES,
} from "@specweave-studio/shared/crashReport";

/** Reports one installation may send per minute. Clients fold repeats, so this is generous. */
export const RELAY_CRASH_REPORT_RATE_LIMIT = { limit: 10, periodSeconds: 60 } as const;
/**
 * Install ids are random and free to mint, so all reports also share one
 * budget. Past it the relay drops reports rather than flood Workers Logs.
 */
export const RELAY_CRASH_REPORT_GLOBAL_RATE_LIMIT = { limit: 600, periodSeconds: 60 } as const;
/** Site events one client IP may send per minute. */
export const RELAY_SITE_EVENT_RATE_LIMIT = { limit: 30, periodSeconds: 60 } as const;

/** Distinctive log messages, so `wrangler tail --search` and dashboard filters find them. */
export const CRASH_REPORT_LOG_MESSAGE = "crash_report";
export const SITE_EVENT_LOG_MESSAGE = "site_event";

export interface ReportRateLimitError {
  readonly message: string;
}

/**
 * Report budgets. Each check fails with the limiter's error; the handlers
 * fail open on it, because a lost report costs less than a limiter outage
 * turning into errors on every client.
 */
export class ReportRateLimiter extends Context.Service<
  ReportRateLimiter,
  {
    /** One installation's budget, keyed by the SHA-256 hex of its install id. */
    readonly allowInstall: (installIdHash: string) => Effect.Effect<boolean, ReportRateLimitError>;
    /** The budget every crash report shares. */
    readonly allowGlobal: Effect.Effect<boolean, ReportRateLimitError>;
    /** One client's site event budget, keyed by the SHA-256 hex of its IP. */
    readonly allowSiteClient: (ipHash: string) => Effect.Effect<boolean, ReportRateLimitError>;
  }
>()("studio-relay/reports/Reports/ReportRateLimiter") {}

class ReportBodyTooLarge extends Schema.TaggedError<ReportBodyTooLarge>()(
  "ReportBodyTooLarge",
  {},
) {}

const errorResponse = (status: number, error: string, headers?: Record<string, string>) =>
  HttpServerResponse.jsonUnsafe({ error }, { status, ...(headers ? { headers } : {}) });

const accepted = () => HttpServerResponse.jsonUnsafe({ ok: true }, { status: 202 });

const sha256Hex = (value: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

/** `application/json` from fetch clients, `text/plain` from `sendBeacon`; absent is allowed. */
const acceptedContentType = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const raw = request.headers["content-type"];
  if (raw === undefined || raw.trim().length === 0) return true;
  const mediaType = raw.split(";", 1)[0]!.trim().toLowerCase();
  return mediaType === "application/json" || mediaType === "text/plain";
};

const declaredTooLarge = (request: HttpServerRequest.HttpServerRequest, max: number): boolean => {
  const declared = Number(request.headers["content-length"] ?? "0");
  return Number.isFinite(declared) && declared > max;
};

const hasNoBody = (request: HttpServerRequest.HttpServerRequest) =>
  request.source instanceof Request && request.source.body === null;

const readCappedText = (request: HttpServerRequest.HttpServerRequest, max: number) =>
  Effect.suspend(() => {
    if (hasNoBody(request)) return Effect.succeed({ text: "", bytes: 0 });
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    return request.stream.pipe(
      Stream.runForEach((chunk) => {
        total += chunk.length;
        if (total > max) return Effect.fail(new ReportBodyTooLarge());
        chunks.push(chunk);
        return Effect.void;
      }),
      Effect.map(() => {
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.length;
        }
        return { text: new TextDecoder().decode(body), bytes: total };
      }),
    );
  });

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Cloudflare's request geolocation, two letters, when the Worker has it. */
const requestCountry = (request: HttpServerRequest.HttpServerRequest): string | undefined => {
  const source = request.source as { readonly cf?: { readonly country?: unknown } } | undefined;
  const country =
    typeof source?.cf?.country === "string" ? source.cf.country : request.headers["cf-ipcountry"];
  return typeof country === "string" && /^[A-Z0-9]{2}$/u.test(country) ? country : undefined;
};

const make = Effect.gen(function* () {
  const limiter = yield* ReportRateLimiter;

  const failOpen =
    (spanAttribute: string) =>
    (effect: Effect.Effect<boolean, ReportRateLimitError>): Effect.Effect<boolean> =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("Report rate limiter unavailable", { error: error.message }).pipe(
            Effect.andThen(Effect.annotateCurrentSpan({ [spanAttribute]: true })),
            Effect.as(true),
          ),
        ),
      );
  const crashFailOpen = failOpen("relay.crash.rate_limiter_failed_open");
  const siteFailOpen = failOpen("relay.site_event.rate_limiter_failed_open");

  const crashReport = Effect.fn("relay.reports.crash")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const outcome = (value: string) => Effect.annotateCurrentSpan({ "relay.crash.outcome": value });
    if (!acceptedContentType(request)) {
      yield* outcome("unsupported_media_type");
      return errorResponse(415, "unsupported_media_type");
    }
    if (declaredTooLarge(request, CRASH_REPORT_MAX_BYTES)) {
      yield* outcome("payload_too_large");
      return errorResponse(413, "payload_too_large");
    }
    const body = yield* readCappedText(request, CRASH_REPORT_MAX_BYTES).pipe(Effect.result);
    if (Result.isFailure(body)) {
      if (body.failure._tag === "ReportBodyTooLarge") {
        yield* outcome("payload_too_large");
        return errorResponse(413, "payload_too_large");
      }
      yield* outcome("invalid_body");
      return errorResponse(400, "invalid_body");
    }
    const report = parseCrashReport(parseJson(body.success.text));
    if (!report) {
      yield* outcome("invalid_body");
      return errorResponse(400, "invalid_body");
    }
    const installIdHash = yield* sha256Hex(report.installId);
    // Per-install first: one install flooding with its own id must not spend the
    // shared budget every other install relies on. The shared budget then stops
    // a flood of fresh install ids.
    const installAllowed = yield* crashFailOpen(limiter.allowInstall(installIdHash));
    const globalAllowed = installAllowed && (yield* crashFailOpen(limiter.allowGlobal));
    if (!installAllowed || !globalAllowed) {
      yield* Effect.annotateCurrentSpan({
        "relay.crash.rate_limit": installAllowed ? "global" : "install",
      });
      yield* outcome("rate_limited");
      return errorResponse(429, "rate_limited", {
        "retry-after": String(RELAY_CRASH_REPORT_RATE_LIMIT.periodSeconds),
      });
    }
    const country = requestCountry(request);
    // The one record of the report. The raw install id never reaches the log.
    yield* Effect.logWarning(CRASH_REPORT_LOG_MESSAGE, {
      log: CRASH_REPORT_LOG_MESSAGE,
      surface: report.surface,
      kind: report.kind,
      category: report.category,
      appVersion: report.appVersion,
      os: report.os,
      ...(report.osVersion ? { osVersion: report.osVersion } : {}),
      arch: report.arch,
      ...(report.provider ? { provider: report.provider } : {}),
      ...(report.model ? { model: report.model } : {}),
      ...(report.errorName ? { errorName: report.errorName } : {}),
      ...(report.message ? { message: report.message } : {}),
      ...(report.stack ? { stack: report.stack } : {}),
      ...(report.detail ? { detail: report.detail } : {}),
      count: report.count ?? 1,
      machine: report.machine,
      installIdHash: installIdHash.slice(0, 16),
      ...(country ? { country } : {}),
      bytes: body.success.bytes,
    });
    yield* Effect.annotateCurrentSpan({
      "relay.crash.surface": report.surface,
      "relay.crash.kind": report.kind,
    });
    yield* outcome("accepted");
    return accepted();
  });

  const siteEvent = Effect.fn("relay.reports.site_event")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const outcome = (value: string) =>
      Effect.annotateCurrentSpan({ "relay.site_event.outcome": value });
    if (!acceptedContentType(request)) {
      yield* outcome("unsupported_media_type");
      return errorResponse(415, "unsupported_media_type");
    }
    if (declaredTooLarge(request, SITE_EVENT_MAX_BYTES)) {
      yield* outcome("payload_too_large");
      return errorResponse(413, "payload_too_large");
    }
    const body = yield* readCappedText(request, SITE_EVENT_MAX_BYTES).pipe(Effect.result);
    if (Result.isFailure(body)) {
      if (body.failure._tag === "ReportBodyTooLarge") {
        yield* outcome("payload_too_large");
        return errorResponse(413, "payload_too_large");
      }
      yield* outcome("invalid_body");
      return errorResponse(400, "invalid_body");
    }
    const event = parseSiteEvent(parseJson(body.success.text));
    if (!event) {
      yield* outcome("invalid_body");
      return errorResponse(400, "invalid_body");
    }
    const ip = request.headers["cf-connecting-ip"]?.trim() || "unknown";
    const allowed = yield* siteFailOpen(limiter.allowSiteClient(yield* sha256Hex(`site:${ip}`)));
    if (!allowed) {
      yield* outcome("rate_limited");
      return errorResponse(429, "rate_limited", {
        "retry-after": String(RELAY_SITE_EVENT_RATE_LIMIT.periodSeconds),
      });
    }
    const country = requestCountry(request);
    yield* Effect.logInfo(SITE_EVENT_LOG_MESSAGE, {
      log: SITE_EVENT_LOG_MESSAGE,
      event: event.event,
      platform: event.platform,
      ...(event.asset ? { asset: event.asset } : {}),
      ...(event.placement ? { placement: event.placement } : {}),
      ...(event.page ? { page: event.page } : {}),
      ...(country ? { country } : {}),
    });
    yield* outcome("accepted");
    return accepted();
  });

  return { crashReport, siteEvent };
});

/**
 * Implements the RelayApi `reports` group. Raw, because `sendBeacon` posts
 * `text/plain` and the body is capped while it streams in.
 */
export const layerApi = HttpApiBuilder.group(
  RelayApi,
  "reports",
  Effect.fnUntraced(function* (handlers) {
    const reports = yield* make;
    return handlers
      .handleRaw("crashReport", ({ request }) => reports.crashReport(request))
      .handleRaw("siteEvent", ({ request }) => reports.siteEvent(request));
  }),
);
