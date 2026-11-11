import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { RelayApi } from "@specweave-studio/contracts/relay";
import {
  buildCrashReport,
  CRASH_REPORT_MAX_BYTES,
  encodeCrashReport,
} from "@specweave-studio/shared/crashReport";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";
import * as Etag from "effect/http/Etag";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { RELAY_HTTP_ROUTER_CONFIG } from "../http/Api.ts";
import * as RelayHttpApi from "../http/Api.ts";
import * as Reports from "./Reports.ts";

const INSTALL_ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

interface Harness {
  readonly allowInstall?: (key: string) => Effect.Effect<boolean, Reports.ReportRateLimitError>;
  readonly allowGlobal?: Effect.Effect<boolean, Reports.ReportRateLimitError>;
  readonly allowSiteClient?: (key: string) => Effect.Effect<boolean, Reports.ReportRateLimitError>;
}

interface LogLine {
  readonly level: string;
  readonly message: ReadonlyArray<unknown>;
}

function makeHarness(options: Harness = {}) {
  const installKeys: Array<string> = [];
  const siteKeys: Array<string> = [];
  const logs: Array<LogLine> = [];
  const spans: Array<Tracer.NativeSpan> = [];
  const limiter = Layer.succeed(Reports.ReportRateLimiter, {
    allowInstall: (key) => {
      installKeys.push(key);
      return options.allowInstall ? options.allowInstall(key) : Effect.succeed(true);
    },
    allowGlobal: options.allowGlobal ?? Effect.succeed(true),
    allowSiteClient: (key) => {
      siteKeys.push(key);
      return options.allowSiteClient ? options.allowSiteClient(key) : Effect.succeed(true);
    },
  });
  const httpEffect = HttpRouter.toHttpEffect(
    Layer.mergeAll(
      HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.reports)).pipe(
        Layer.provide(Reports.layerApi.pipe(Layer.provide(limiter))),
        Layer.provide([NodeServices.layer, NodeHttpPlatform.layer, Etag.layerWeak]),
      ),
      RelayHttpApi.layerNotFoundRoute,
      RelayHttpApi.layerCors,
    ),
  ).pipe(Effect.provideService(HttpRouter.RouterConfig, RELAY_HTTP_ROUTER_CONFIG));
  const capture = Logger.make(({ logLevel, message }) => {
    logs.push({ level: logLevel, message: Array.isArray(message) ? message : [message] });
  });
  const tracer = Tracer.make({
    span: (spanOptions) => {
      const span = new Tracer.NativeSpan(spanOptions);
      spans.push(span);
      return span;
    },
  });
  const send = (request: Request) =>
    Effect.gen(function* () {
      const handler = yield* httpEffect;
      const sent = yield* Deferred.make<HttpServerResponse.HttpServerResponse>();
      yield* HttpEffect.toHandled(handler, (_request, response) =>
        Deferred.succeed(sent, response),
      ).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request),
        ),
      );
      return yield* Deferred.await(sent);
    }).pipe(Effect.provide(Logger.layer([capture])), Effect.provideService(Tracer.Tracer, tracer));
  const spanAttribute = (name: string) =>
    spans.map((span) => span.attributes.get(name)).find((value) => value !== undefined);
  return { installKeys, siteKeys, logs, spans, send, spanAttribute };
}

const readJson = (response: HttpServerResponse.HttpServerResponse) =>
  Effect.promise(() => HttpServerResponse.toWeb(response).json());

const report = () =>
  buildCrashReport({
    installId: INSTALL_ID,
    machine: "darwin-arm64-0123456789ab",
    surface: "server",
    kind: "turn_failed",
    category: "provider_overloaded",
    appVersion: "1.0.230",
    os: "darwin",
    osVersion: "25.1.0",
    arch: "arm64",
    provider: "codex",
    model: "gpt-5.5",
    error: Object.assign(new Error("Request to /Users/someone/project failed"), {
      stack: "Error: boom\n    at run (~/app/server.js:10:5)",
    }),
    detail: { exitCode: 1 },
  });

const crashRequest = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("https://relay.test/v1/crash-reports", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

const siteRequest = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("https://relay.test/v1/site-events", {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8", ...headers },
    body,
  });

const crashLogs = (logs: ReadonlyArray<LogLine>) =>
  logs.filter((line) => line.message[0] === Reports.CRASH_REPORT_LOG_MESSAGE);

describe("crash reports", () => {
  it.effect("accepts a report and writes exactly one log line without the install id", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const body = encodeCrashReport(report());
      const response = yield* harness.send(crashRequest(body, { "cf-ipcountry": "US" }));
      expect(response.status).toBe(202);
      expect(yield* readJson(response)).toEqual({ ok: true });
      expect(harness.logs).toHaveLength(1);
      const [line] = crashLogs(harness.logs);
      expect(line?.level).toBe("Warn");
      const fields = line?.message[1] as Record<string, unknown>;
      expect(fields).toMatchObject({
        log: "crash_report",
        surface: "server",
        kind: "turn_failed",
        category: "provider_overloaded",
        appVersion: "1.0.230",
        os: "darwin",
        osVersion: "25.1.0",
        arch: "arm64",
        provider: "codex",
        model: "gpt-5.5",
        errorName: "Error",
        detail: { exitCode: 1 },
        count: 1,
        machine: "darwin-arm64-0123456789ab",
        country: "US",
        bytes: new TextEncoder().encode(body).length,
      });
      expect(fields.installIdHash).toMatch(/^[0-9a-f]{16}$/);
      // A failed turn carries its category and provider, never provider error text.
      expect(fields.message).toBeUndefined();
      expect(fields.stack).toBeUndefined();
      expect(JSON.stringify(harness.logs)).not.toContain(INSTALL_ID);
      // The limiter sees a full hash, never the install id.
      expect(harness.installKeys).toHaveLength(1);
      expect(harness.installKeys[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(harness.installKeys[0]!.startsWith(fields.installIdHash as string)).toBe(true);
      expect(harness.spanAttribute("relay.crash.outcome")).toBe("accepted");
    }),
  );

  it.effect("accepts text/plain bodies from sendBeacon", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const response = yield* harness.send(
        crashRequest(encodeCrashReport(report()), { "content-type": "text/plain;charset=UTF-8" }),
      );
      expect(response.status).toBe(202);
      expect(crashLogs(harness.logs)).toHaveLength(1);
    }),
  );

  it.effect("rejects other content types", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const response = yield* harness.send(
        crashRequest(encodeCrashReport(report()), {
          "content-type": "application/x-www-form-urlencoded",
        }),
      );
      expect(response.status).toBe(415);
      expect(harness.logs).toHaveLength(0);
    }),
  );

  it.effect("rejects a declared length over the cap", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const response = yield* harness.send(
        crashRequest("{}", { "content-length": String(CRASH_REPORT_MAX_BYTES + 1) }),
      );
      expect(response.status).toBe(413);
      expect(yield* readJson(response)).toEqual({ error: "payload_too_large" });
      expect(harness.spanAttribute("relay.crash.outcome")).toBe("payload_too_large");
      expect(harness.logs).toHaveLength(0);
    }),
  );

  it.effect("rejects a streamed body over the cap", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const oversized = new Uint8Array(CRASH_REPORT_MAX_BYTES + 1).fill(0x20);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oversized.subarray(0, 10_000));
          controller.enqueue(oversized.subarray(10_000));
          controller.close();
        },
      });
      const response = yield* harness.send(
        new Request("https://relay.test/v1/crash-reports", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: stream,
          duplex: "half",
        } as RequestInit),
      );
      expect(response.status).toBe(413);
      expect(harness.installKeys).toHaveLength(0);
      expect(harness.logs).toHaveLength(0);
    }),
  );

  it.effect("rejects bodies that are not a valid report", () =>
    Effect.gen(function* () {
      for (const body of [
        "not json",
        "",
        "[]",
        JSON.stringify({ ...report(), installId: "user_123" }),
        JSON.stringify({ ...report(), v: 2 }),
      ]) {
        const harness = makeHarness();
        const response = yield* harness.send(crashRequest(body));
        expect(response.status).toBe(400);
        expect(yield* readJson(response)).toEqual({ error: "invalid_body" });
        expect(harness.spanAttribute("relay.crash.outcome")).toBe("invalid_body");
        expect(harness.logs).toHaveLength(0);
      }
    }),
  );

  it.effect("returns 429 when the install budget is spent", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ allowInstall: () => Effect.succeed(false) });
      const response = yield* harness.send(crashRequest(encodeCrashReport(report())));
      expect(response.status).toBe(429);
      expect(response.headers["retry-after"]).toBe("60");
      expect(harness.spanAttribute("relay.crash.outcome")).toBe("rate_limited");
      expect(harness.spanAttribute("relay.crash.rate_limit")).toBe("install");
      expect(crashLogs(harness.logs)).toHaveLength(0);
    }),
  );

  it.effect("returns 429 when the shared budget is spent, after the install check", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ allowGlobal: Effect.succeed(false) });
      const response = yield* harness.send(crashRequest(encodeCrashReport(report())));
      expect(response.status).toBe(429);
      expect(harness.installKeys).toHaveLength(1);
      expect(crashLogs(harness.logs)).toHaveLength(0);
      expect(harness.spanAttribute("relay.crash.rate_limit")).toBe("global");
    }),
  );

  it.effect("fails open when the limiter errors", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        allowGlobal: Effect.fail({ message: "binding unavailable" }),
        allowInstall: () => Effect.fail({ message: "binding unavailable" }),
      });
      const response = yield* harness.send(crashRequest(encodeCrashReport(report())));
      expect(response.status).toBe(202);
      expect(crashLogs(harness.logs)).toHaveLength(1);
      expect(
        harness.logs.filter((line) => line.message[0] === "Report rate limiter unavailable"),
      ).toHaveLength(2);
      expect(harness.spanAttribute("relay.crash.rate_limiter_failed_open")).toBe(true);
    }),
  );

  it.effect("answers a CORS preflight from the marketing site", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const response = yield* harness.send(
        new Request("https://relay.test/v1/crash-reports", {
          method: "OPTIONS",
          headers: {
            origin: "https://specwithcode.com",
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type",
          },
        }),
      );
      expect(response.status).toBeLessThan(300);
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.headers["access-control-allow-methods"]).toContain("POST");
      expect(response.headers["access-control-allow-headers"]).toContain("content-type");
    }),
  );
});

describe("site events", () => {
  const event = { v: 1, event: "download_click", platform: "mac", asset: "arm64.dmg", page: "/" };

  it.effect("accepts a beacon from the marketing site and logs one line", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      for (const origin of ["https://specwithcode.com", "https://spec-weave.com"]) {
        const response = yield* harness.send(
          siteRequest(JSON.stringify(event), {
            origin,
            "cf-connecting-ip": "203.0.113.7",
            "cf-ipcountry": "DE",
          }),
        );
        expect(response.status).toBe(202);
        expect(response.headers["access-control-allow-origin"]).toBe("*");
      }
      const lines = harness.logs.filter(
        (line) => line.message[0] === Reports.SITE_EVENT_LOG_MESSAGE,
      );
      expect(lines).toHaveLength(2);
      expect(lines[0]?.level).toBe("Info");
      expect(lines[0]?.message[1]).toEqual({
        log: "site_event",
        event: "download_click",
        platform: "mac",
        asset: "arm64.dmg",
        page: "/",
        country: "DE",
      });
      expect(JSON.stringify(harness.logs)).not.toContain("203.0.113.7");
      expect(harness.siteKeys[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(harness.spanAttribute("relay.site_event.outcome")).toBe("accepted");
    }),
  );

  it.effect("rejects oversized and invalid events", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const large = yield* harness.send(siteRequest(" ".repeat(2_000)));
      expect(large.status).toBe(413);
      const invalid = yield* harness.send(siteRequest(JSON.stringify({ ...event, v: 9 })));
      expect(invalid.status).toBe(400);
      expect(harness.logs).toHaveLength(0);
    }),
  );

  it.effect("returns 429 when the client budget is spent and fails open on errors", () =>
    Effect.gen(function* () {
      const limited = makeHarness({ allowSiteClient: () => Effect.succeed(false) });
      const response = yield* limited.send(siteRequest(JSON.stringify(event)));
      expect(response.status).toBe(429);
      expect(response.headers["retry-after"]).toBe("60");

      const broken = makeHarness({
        allowSiteClient: () => Effect.fail({ message: "binding unavailable" }),
      });
      const open = yield* broken.send(siteRequest(JSON.stringify(event)));
      expect(open.status).toBe(202);
      expect(broken.spanAttribute("relay.site_event.rate_limiter_failed_open")).toBe(true);
    }),
  );
});
