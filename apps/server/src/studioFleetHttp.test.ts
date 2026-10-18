import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as DateTime from "effect/DateTime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixture writes independently exercise the fleet HTTP reader.
import { writeFile } from "node:fs/promises";
import { join } from "./nodePath.ts";
import { encodeFleetJoinCode } from "./studioFleetJoin.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  EnvironmentHttpApi,
  EnvironmentId,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Auth from "./auth/EnvironmentAuth.ts";
import * as AuthHttp from "./auth/http.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as Config from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { fakeMachine, ORIGIN } from "./fleet/fleetMachine.testkit.ts";
import * as FleetTargets from "./fleet/FleetTargets.ts";
import * as FleetWorkerGrants from "./fleet/FleetWorkerGrants.ts";
import * as FleetHttp from "./studioFleetHttp.ts";
const descriptor = (environmentId: string) => ({
  environmentId,
  label: "Fixture Mac",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.1.0-test",
  orchestrationProtocolVersion: 2,
  capabilities: { repositoryIdentity: true },
});
class TestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.studioFleet) {}
async function api(
  scopes: ReadonlyArray<AuthEnvironmentScope> = [AuthOrchestrationReadScope, AuthAccessWriteScope],
  operatorDelegation = false,
  url = "https://fixture.tailnet.ts.net:8443",
) {
  const config = Layer.effect(
    Config.ServerConfig,
    Effect.gen(function* () {
      const config = yield* Config.ServerConfig;
      yield* Effect.promise(() =>
        writeFile(
          join(config.baseDir, "studio-fleet.json"),
          JSON.stringify({
            version: 1,
            ...(operatorDelegation ? { allowConnectFrom: AuthOrchestrationOperateScope } : {}),
            machines: [
              {
                id: "m1",
                label: "Mac M1",
                environmentId: "env-m1",
                url,
                managementToken: url === ORIGIN ? "management-secret" : "synthetic-private-secret",
                ...(url === ORIGIN
                  ? {
                      scopes: [
                        AuthOrchestrationReadScope,
                        AuthOrchestrationOperateScope,
                        AuthAccessWriteScope,
                      ],
                    }
                  : {}),
              },
            ],
          }),
          { mode: 0o600 },
        ),
      );
      return config;
    }),
  ).pipe(Layer.provide(Config.layerTest(process.cwd(), { prefix: "studio-fleet-http-" })));
  const routes = HttpApiBuilder.layer(TestApi).pipe(
    Layer.provide(FleetHttp.layer),
    Layer.provide(
      FleetWorkerGrants.layer.pipe(
        Layer.provide(
          FleetTargets.layer.pipe(
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, globalThis.fetch)),
          ),
        ),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("env-m4")),
          }),
        ),
      ),
    ),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(
      Layer.mock(Auth.EnvironmentAuth)({
        authenticateHttpRequest: (request) =>
          request.headers.authorization === "Bearer synthetic-session"
            ? Effect.succeed({
                sessionId: AuthSessionId.make("synthetic-session"),
                subject: "fixture",
                method: "bearer-access-token" as const,
                scopes,
              })
            : Effect.fail(new Auth.ServerAuthMissingCredentialError({})),
      }),
    ),
    Layer.provideMerge(config),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  const workers = (path: "allow" | "stop", body: object, headers?: Record<string, string>) =>
    handler(
      new Request(`http://localhost:8319/api/studio/fleet/workers/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "localhost:8319",
          ...(headers ?? {
            authorization: "Bearer synthetic-session",
            origin: "http://localhost:8319",
          }),
        },
        body: JSON.stringify(body),
      }),
    );
  const request = (
    body?: object,
    headers: Record<string, string> = {
      authorization: "Bearer synthetic-session",
      origin: "http://localhost:8319",
    },
  ) =>
    handler(
      new Request(`http://localhost:8319/api/studio/fleet${body ? "/connect" : ""}`, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json", host: "localhost:8319", ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  const add = (
    body: object,
    headers: Record<string, string> = {
      authorization: "Bearer synthetic-session",
      origin: "http://localhost:8319",
    },
  ) =>
    handler(
      new Request("http://localhost:8319/api/studio/fleet/machines", {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost:8319", ...headers },
        body: JSON.stringify(body),
      }),
    );
  return { request, workers, add, dispose };
}
afterEach(() => vi.unstubAllGlobals());
describe("adding a machine over HTTP", () => {
  const invitation = encodeFleetJoinCode({
    url: "https://m1.tailnet.ts.net",
    environmentId: "env-m1",
    label: "Mac M1",
    managementToken: "synthetic-new-secret",
  });
  it("needs access management and this app's own origin before any outbound call", async () => {
    const outbound = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", outbound);
    const operator = await api([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
    const owner = await api();
    try {
      expect((await operator.add({ invitation })).status).toBe(403);
      expect(
        (
          await owner.add(
            { invitation },
            { authorization: "Bearer synthetic-session", origin: "https://evil.invalid" },
          )
        ).status,
      ).toBe(403);
      expect((await owner.add({ invitation: "https://evil.ts.net" })).status).toBe(400);
      expect((await owner.add({ invitation, url: "https://evil.ts.net" })).status).toBe(400);
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      await operator.dispose();
      await owner.dispose();
    }
  });
  it("moves a relayed machine to the address its invitation names once it answers there", async () => {
    const outbound = vi.fn<typeof fetch>(async (url) =>
      new URL(String(url)).origin === "https://m1.tailnet.ts.net"
        ? Response.json(descriptor("env-m1"))
        : Promise.reject(new TypeError("unreachable")),
    );
    vi.stubGlobal("fetch", outbound);
    const owner = await api();
    try {
      const response = await owner.add({ invitation });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.text();
      expect(body).not.toContain("synthetic-new-secret");
      expect(JSON.parse(body)).toEqual({
        id: "m1",
        label: "Mac M1",
        url: "https://m1.tailnet.ts.net",
        environmentId: "env-m1",
        change: "updated",
        previousUrl: "https://fixture.tailnet.ts.net:8443",
      });
      const fleet = (await (await owner.request()).json()) as { machines: unknown[] };
      expect(fleet.machines).toMatchObject([
        { id: "m1", url: "https://m1.tailnet.ts.net", status: "reachable" },
      ]);
    } finally {
      await owner.dispose();
    }
  });
});
describe("fleet authenticated HTTP", () => {
  it("denies unauthenticated reads, read-only pairing, CSRF and extra destinations before outbound calls", async () => {
    const outbound = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", outbound);
    const app = await api();
    const reader = await api([AuthOrchestrationReadScope]);
    try {
      expect((await app.request(undefined, {})).status).toBe(401);
      expect((await reader.request({ id: "m1" })).status).toBe(403);
      expect(
        (
          await app.request(
            { id: "m1" },
            {
              authorization: "Bearer synthetic-session",
              origin: "https://evil.invalid",
              "x-forwarded-host": "evil.invalid",
            },
          )
        ).status,
      ).toBe(403);
      expect((await app.request({ id: "m1", url: "https://evil.ts.net" })).status).toBe(400);
      expect((await app.request({ id: "missing" })).status).toBe(400);
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      await app.dispose();
      await reader.dispose();
    }
  });
  it("honors an explicit owner delegation for existing operators without granting auth administration", async () => {
    const outbound = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/pairing-token")
        ? Response.json({
            credential: "one-time",
            expiresAt: DateTime.formatIso(
              DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) + 60000),
            ),
          })
        : Response.json(descriptor("env-m1")),
    );
    vi.stubGlobal("fetch", outbound);
    const operator = await api([AuthOrchestrationReadScope, AuthOrchestrationOperateScope], true);
    const reader = await api([AuthOrchestrationReadScope], true);
    try {
      expect((await reader.request({ id: "m1" })).status).toBe(403);
      expect(outbound).not.toHaveBeenCalled();
      const response = await operator.request({ id: "m1" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      });
      expect(await (await operator.request()).json()).toMatchObject({
        connectPermission: AuthOrchestrationOperateScope,
      });
    } finally {
      await operator.dispose();
      await reader.dispose();
    }
  });
  it("pairs for the Mac app when this server runs in web mode, as M4's service does", async () => {
    const outbound = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/pairing-token")
        ? Response.json({
            credential: "one-time",
            expiresAt: DateTime.formatIso(
              DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) + 60000),
            ),
          })
        : Response.json(descriptor("env-m1")),
    );
    vi.stubGlobal("fetch", outbound);
    const app = await api();
    const desktop = {
      authorization: "Bearer synthetic-session",
      origin: "studio://app",
      "sec-fetch-site": "cross-site",
    };
    try {
      const response = await app.request({ id: "m1" }, desktop);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ environmentId: "env-m1" });
      expect(
        (await app.request({ id: "m1" }, { ...desktop, origin: "studio://attacker" })).status,
      ).toBe(403);
    } finally {
      await app.dispose();
    }
  });
  it("returns no-store metadata and consumes the exact allowlist entry for a scoped pairing", async () => {
    const outbound = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/pairing-token")
        ? Response.json({
            credential: "one-time",
            expiresAt: DateTime.formatIso(
              DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) + 60000),
            ),
          })
        : Response.json(descriptor("env-m1")),
    );
    vi.stubGlobal("fetch", outbound);
    const app = await api();
    try {
      const discovery = await app.request();
      expect(discovery.status).toBe(200);
      expect(discovery.headers.get("cache-control")).toBe("no-store");
      expect(await discovery.text()).not.toContain("synthetic-private-secret");
      const response = await app.request({ id: "m1" });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        environmentId: "env-m1",
        pairingCode: "one-time",
        scopes: [AuthOrchestrationReadScope],
      });
      expect(outbound.mock.calls.at(-1)?.[0]).toBe(
        "https://fixture.tailnet.ts.net:8443/api/auth/pairing-token",
      );
    } finally {
      await app.dispose();
    }
  });
  it("allows and stops workers only for an access manager from this app", async () => {
    const machine = fakeMachine();
    vi.stubGlobal("fetch", machine.fetcher);
    const app = await api(undefined, false, ORIGIN);
    const reader = await api(
      [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      false,
      ORIGIN,
    );
    try {
      expect((await reader.workers("allow", { id: "m1", access: "auto" })).status).toBe(403);
      expect(
        (
          await app.workers(
            "allow",
            { id: "m1", access: "auto" },
            { authorization: "Bearer synthetic-session", origin: "https://evil.invalid" },
          )
        ).status,
      ).toBe(403);
      expect(
        (await app.workers("allow", { id: "m1", access: "auto", url: "https://x" })).status,
      ).toBe(400);
      expect(machine.calls).toEqual([]);

      const allowed = await app.workers("allow", { id: "m1", access: "auto" });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("cache-control")).toBe("no-store");
      const body = await allowed.text();
      expect(body).not.toContain("mcp-token");
      expect(JSON.parse(body)).toMatchObject({
        id: "m1",
        workers: { status: "allowed", access: "auto" },
      });
      expect(await (await app.request()).json()).toMatchObject({
        machines: [{ id: "m1", workers: { status: "allowed" } }],
      });
      expect((await app.workers("allow", { id: "m1", access: "auto" })).status).toBe(400);

      const stopped = await app.workers("stop", { id: "m1" });
      expect(stopped.status).toBe(200);
      expect(await stopped.json()).toMatchObject({
        workers: { status: "not_allowed" },
        remoteSessionKept: false,
      });
    } finally {
      await app.dispose();
      await reader.dispose();
    }
  });
});
