import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId, EnvironmentHttpApi, AuthOrchestrationReadScope, AuthOrchestrationOperateScope } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Schema from "effect/Schema";
import * as Auth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as Config from "../config.ts";
import * as Capacity from "./Capacity.ts";
import * as Http from "./http.ts";
import { StudioCapacityPolicyInput, StudioCapacityRefreshInput, StudioCapacitySelectInput } from "@specweave-studio/contracts/studio";
import { unavailableCapacity } from "./capacitySnapshot.ts";

class StudioTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.studio) {}
async function api(scopes: ReadonlyArray<typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope> = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope], desktop = false) {
  const calls: string[] = [];
  const snapshot = unavailableCapacity(
    DateTime.toEpochMillis(DateTime.nowUnsafe()), "switch-unavailable");
  const routes = HttpApiBuilder.layer(StudioTestApi).pipe(Layer.provide(Http.layer), Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(Layer.mock(Auth.EnvironmentAuth)({ authenticateHttpRequest: (request) => request.headers.authorization === "Bearer synthetic-session"
      ? Effect.succeed({ sessionId: AuthSessionId.make("synthetic-session"), subject: "test-native-client", method: "bearer-access-token" as const, scopes })
      : Effect.fail(new Auth.ServerAuthMissingCredentialError({})) })),
    Layer.provide(Layer.mock(Capacity.Capacity)({ current: Effect.succeed(snapshot), refresh: Effect.sync(() => { calls.push("refresh"); return snapshot; }), policy: (input) => Effect.sync(() => { calls.push(`policy:${input.mode}`);
            return snapshot;
          }),
        select: (input) =>
          Effect.sync(() => {
            calls.push(`select:${input.id}`);
            return snapshot;
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.effect(
        Config.ServerConfig,
        Effect.map(Config.ServerConfig, (config) => ({
          ...config,
          mode: desktop ? ("desktop" as const) : ("web" as const),
        })),
      ).pipe(Layer.provide(Config.layerTest(process.cwd(), { prefix: "studio-capacity-http-" }))),
    ),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  const request = (
    path: string,
    body?: object,
    headers: Record<string, string> = {
      authorization: "Bearer synthetic-session",
      origin: "https://private.example.ts.net",
      "x-forwarded-proto": "https",
    },
  ) =>
    handler(
      new Request(`http://private.example.ts.net${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", host: "private.example.ts.net", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { request, calls, dispose };
}
describe("capacity HTTP authorization and CSRF", () => {
  it("rejects unauthenticated reads and insufficient mutation scope without calling the companion", async () => {
    const app = await api([AuthOrchestrationReadScope]);
    try { expect((await app.request("/api/studio/capacity", undefined, {})).status).toBe(401);
      expect((await app.request("/api/studio/capacity")).status).toBe(200);
      expect((await app.request("/api/studio/capacity/refresh", {})).status).toBe(403); expect(app.calls).toEqual([]);
    } finally { await app.dispose(); }
  });
  it("accepts exact private HTTPS forwarded-protocol mutations and rejects forged Origin/unknown body fields", async () => {
    const app = await api();
    try {
      expect((await app.request("/api/studio/capacity/policy", { mode: "spend-first" })).status).toBe(200);
      expect((await app.request("/api/studio/capacity/select", { id: null })).status).toBe(200);
      expect((await app.request("/api/studio/capacity/refresh", {})).status).toBe(200);
      const bad = await app.request("/api/studio/capacity/refresh", {}, { authorization: "Bearer synthetic-session", origin: "https://attacker.invalid", "x-forwarded-host": "attacker.invalid", "x-forwarded-proto": "https" });
      expect(bad.status).toBe(403);
      expect((await app.request("/api/studio/capacity/refresh", { url: "http://attacker.invalid", authenticated: true })).status).toBe(400);
      expect(app.calls).toEqual(["policy:spend-first", "select:null", "refresh"]);
    } finally { await app.dispose(); }
  });
  it("permits only the trusted desktop Origin after authenticating scope", async () => {
    const app = await api(undefined, true);
    const readOnly = await api([AuthOrchestrationReadScope], true);
    const headers = { authorization: "Bearer synthetic-session", origin: "studio://app", "sec-fetch-site": "cross-site" };
    try {
      expect((await app.request("/api/studio/capacity/policy", { mode: "balanced" }, headers)).status).toBe(200);
      expect((await readOnly.request("/api/studio/capacity/policy", { mode: "balanced" }, headers)).status).toBe(403);
      expect((await app.request("/api/studio/capacity/policy", { mode: "balanced" }, { ...headers, origin: "studio://attacker" })).status).toBe(403);
      expect(app.calls).toEqual(["policy:balanced"]); expect(readOnly.calls).toEqual([]);
    } finally { await app.dispose(); await readOnly.dispose(); }
  });
  it("trusts the Mac app Origin on a web-mode service too", async () => {
    const app = await api();
    const headers = { authorization: "Bearer synthetic-session", origin: "studio://app", "sec-fetch-site": "cross-site" };
    try {
      expect((await app.request("/api/studio/capacity/policy", { mode: "balanced" }, headers)).status).toBe(200);
      expect((await app.request("/api/studio/capacity/policy", { mode: "balanced" }, { ...headers, origin: "studio://attacker" })).status).toBe(403);
      expect(app.calls).toEqual(["policy:balanced"]);
    } finally { await app.dispose(); }
  });
  it("allows only explicit private Origin allowlists, scoped CLI auth, and rejects cookie requests without Origin", () => {
    const base = { requestUrl: "/api/studio/capacity/policy", host: "private.example.ts.net:8443", forwardedProto: "https", trustedOrigins: [] as string[] };
    expect(Http.capacityMutationOriginAllowed({ ...base, origin: "https://private.example.ts.net" })).toBe(false);
    expect(Http.capacityMutationOriginAllowed({ ...base, origin: "https://private.example.ts.net", trustedOrigins: ["https://private.example.ts.net"] })).toBe(true);
    expect(Http.capacityMutationOriginAllowed({ ...base, authorization: "DPoP synthetic" })).toBe(true);
    expect(Http.capacityMutationOriginAllowed({ ...base, authorization: "Bearer synthetic", cookie: "native=session" })).toBe(false);
    expect(Http.capacityMutationOriginAllowed({ ...base, origin: "https://private.example.ts.net:8443", fetchSite: "cross-site" })).toBe(false);
    expect(Http.capacityMutationOriginAllowed({ ...base, origin: "studio://app", fetchSite: "cross-site", trustedOrigins: ["studio://app"] })).toBe(true);
    expect(Http.capacityMutationOriginAllowed({ ...base, origin: "studio://attacker", fetchSite: "cross-site", trustedOrigins: ["studio://app"] })).toBe(false);
  });
  it("rejects hidden auth flags, arbitrary URLs and unknown pins in the public request contract", () => {
    expect(Schema.decodeUnknownOption(StudioCapacityRefreshInput)({ authenticated: true })._tag).toBe("None");
    expect(Schema.decodeUnknownOption(StudioCapacityPolicyInput)({ mode: "balanced", url: "http://attacker.invalid" })._tag).toBe("None");
    expect(Schema.decodeUnknownOption(StudioCapacitySelectInput)({ id: "foreign", allowUnknown: true })._tag).toBe("None");
  });
});
