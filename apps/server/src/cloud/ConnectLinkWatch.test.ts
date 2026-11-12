import { EnvironmentId } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CloudLink from "./CloudLink.ts";
import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET, RELAY_URL_SECRET } from "./config.ts";
import * as ConnectLinkWatch from "./ConnectLinkWatch.ts";

const environmentId = EnvironmentId.make("env-watch-test");
const relayUrl = "https://relay.spec-weave.com";

const refusal = (extra: Record<string, unknown> = {}) =>
  Response.json(
    {
      _tag: "RelayAuthInvalidError",
      code: "auth_invalid",
      reason: "not_authorized",
      traceId: "trace-1",
      ...extra,
    },
    { status: 401 },
  );

const makeHarness = (input: {
  readonly linked?: boolean;
  readonly respond: (request: HttpClientRequest.HttpClientRequest) => Response | "hang";
  /** What the link service answers; false is a link made since the refused request. */
  readonly forgets?: boolean;
}) => {
  const values = new Map<string, Uint8Array>(
    input.linked === false
      ? []
      : [
          [RELAY_URL_SECRET, new TextEncoder().encode(relayUrl)],
          [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, new TextEncoder().encode("environment-credential")],
        ],
  );
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const forgotten: Array<string> = [];
  const layer = Layer.mergeAll(
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(environmentId),
    }),
    Layer.mock(CloudLink.CloudLink)({
      unlinkRevokedElsewhere: (credential) =>
        Effect.sync(() => {
          forgotten.push(credential);
          if (input.forgets === false) return false;
          values.clear();
          return true;
        }),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request);
        const response = input.respond(request);
        return response === "hang"
          ? Effect.never
          : Effect.succeed(HttpClientResponse.fromWeb(request, response));
      }),
    ),
  );
  return { layer, requests, forgotten };
};

describe("ConnectLinkWatch", () => {
  it.effect("forgets the link when the relay says the owner deregistered this machine", () => {
    const harness = makeHarness({ respond: () => refusal({ environmentLink: "revoked" }) });
    return Effect.gen(function* () {
      expect(yield* ConnectLinkWatch.checkLinkOnce).toBe("revoked");
      expect(harness.forgotten).toEqual(["environment-credential"]);
      expect(harness.requests.map((request) => [request.method, request.url])).toEqual([
        ["GET", `${relayUrl}/v1/environments/${environmentId}/client-keys/removed`],
      ]);
      expect(harness.requests[0]?.headers.authorization).toBe("Bearer environment-credential");
      // Unlinked now: nothing more is asked.
      expect(yield* ConnectLinkWatch.checkLinkOnce).toBe("not_linked");
      expect(harness.requests).toHaveLength(1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect.each([
    ["a plain refusal, as an older relay sends", () => refusal()],
    ["a failure on the relay's side", () => new Response("down", { status: 503 })],
    ["an answer that is not the relay's", () => new Response("<html>", { status: 401 })],
  ] as const)("keeps the link on %s", ([, respond]) => {
    const harness = makeHarness({ respond });
    return Effect.gen(function* () {
      expect(yield* ConnectLinkWatch.checkLinkOnce).toBe("unknown");
      expect(harness.forgotten).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps the link when the relay does not answer in time", () => {
    const harness = makeHarness({ respond: () => "hang" });
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(ConnectLinkWatch.checkLinkOnce);
      yield* TestClock.adjust("11 seconds");
      expect(yield* Fiber.join(fiber)).toBe("unknown");
      expect(harness.forgotten).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "reports linked while the relay accepts the credential, and asks nothing unlinked",
    () => {
      const linked = makeHarness({ respond: () => Response.json({ proofKeyThumbprints: [] }) });
      const unlinked = makeHarness({ linked: false, respond: () => refusal() });
      return Effect.gen(function* () {
        expect(yield* ConnectLinkWatch.checkLinkOnce.pipe(Effect.provide(linked.layer))).toBe(
          "linked",
        );
        expect(yield* ConnectLinkWatch.checkLinkOnce.pipe(Effect.provide(unlinked.layer))).toBe(
          "not_linked",
        );
        expect(unlinked.requests).toEqual([]);
      });
    },
  );

  it.effect("leaves a link made since the refused request alone", () => {
    const harness = makeHarness({
      respond: () => refusal({ environmentLink: "revoked" }),
      forgets: false,
    });
    return Effect.gen(function* () {
      expect(yield* ConnectLinkWatch.checkLinkOnce).toBe("unknown");
      expect(harness.forgotten).toEqual(["environment-credential"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("looks at start and again every interval, and stops asking once unlinked", () => {
    let revoked = false;
    const harness = makeHarness({
      respond: () =>
        revoked
          ? refusal({ environmentLink: "revoked" })
          : Response.json({ proofKeyThumbprints: [] }),
    });
    return Effect.gen(function* () {
      yield* Layer.build(ConnectLinkWatch.layerWatch);
      yield* TestClock.adjust("1 second");
      expect(harness.requests).toHaveLength(1);
      yield* TestClock.adjust(ConnectLinkWatch.LINK_WATCH_INTERVAL);
      expect(harness.requests).toHaveLength(2);
      revoked = true;
      yield* TestClock.adjust(ConnectLinkWatch.LINK_WATCH_INTERVAL);
      expect(harness.requests).toHaveLength(3);
      expect(harness.forgotten).toEqual(["environment-credential"]);
      yield* TestClock.adjust(ConnectLinkWatch.LINK_WATCH_INTERVAL);
      expect(harness.requests).toHaveLength(3);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });
});
