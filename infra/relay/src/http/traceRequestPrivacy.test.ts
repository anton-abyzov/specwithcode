import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { traceRelayHttpRequestWith } from "./Api.ts";

const CALLER_ADDRESS = "203.0.113.9";
const CALLER_AGENT = "SpecWithCode/1.0 (iPhone; iOS 18.1)";

const recordedSpans = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, layer: Layer.succeed(Tracer.Tracer, tracer) };
};

/** Every attribute and event value a span would export, as text. */
const exported = (span: Tracer.NativeSpan) =>
  JSON.stringify([...span.attributes.entries(), ...span.events.map((event) => event[2] ?? null)]);

describe("relay request spans", () => {
  it.effect.each(["/v1/mobile/devices", "/v1/hooks/hook-token-secret"])(
    "never record the caller's address or user agent (%s)",
    (path) => {
      const { spans, layer } = recordedSpans();
      const seen: Array<{ readonly address: string | undefined; readonly agent: unknown }> = [];
      const request = HttpServerRequest.fromWeb(
        new Request(`https://relay.test${path}`, {
          method: "POST",
          headers: { "user-agent": CALLER_AGENT },
        }),
      ).modify({ remoteAddress: Option.some(CALLER_ADDRESS) });
      const route = Effect.gen(function* () {
        const current = yield* HttpServerRequest.HttpServerRequest;
        seen.push({
          address: Option.getOrUndefined(current.remoteAddress),
          agent: current.headers["user-agent"],
        });
        return HttpServerResponse.empty({ status: 204 });
      });

      return Effect.gen(function* () {
        yield* traceRelayHttpRequestWith(route, layer).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        );
        yield* Effect.yieldNow;

        const server = spans.find((span) => span.kind === "server");
        expect(server).toBeDefined();
        expect(server!.attributes.has("client.address")).toBe(false);
        expect(server!.attributes.has("user_agent.original")).toBe(false);
        for (const span of spans) {
          expect(exported(span)).not.toContain(CALLER_ADDRESS);
          expect(exported(span)).not.toContain("iPhone");
        }
        // The route itself still gets the caller's real request.
        expect(seen).toEqual([{ address: CALLER_ADDRESS, agent: CALLER_AGENT }]);
      });
    },
  );
});
