import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as DateTime from "effect/DateTime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixture writes independently exercise the fleet HTTP reader.
import { writeFile } from "node:fs/promises";
import { join } from "./nodePath.ts";
import { decodeFleetJoinCode, encodeFleetJoinCode } from "./studioFleetJoin.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  EnvironmentHttpApi,
  EnvironmentId,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
} from "@specweave-studio/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Etag from "effect/http/Etag";
import { ChildProcessSpawner } from "effect/process";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
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
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as FleetWorkerGrants from "./fleet/FleetWorkerGrants.ts";
import * as FleetHttp from "./studioFleetHttp.ts";
import { persistServerRuntimeState } from "./serverRuntimeState.ts";
import { fleetTailscaleState } from "./studioFleetInvite.ts";
const descriptor = (environmentId: string) => ({
  environmentId,
  label: "Fixture Mac",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.1.0-test",
  orchestrationProtocolVersion: 2,
  capabilities: { repositoryIdentity: true },
});
class TestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.studioFleet) {}
/**
 * This machine's `tailscale` CLI: `null` status means it is not installed.
 * Every spawn is recorded so a test can prove no Serve mapping was written.
 */
const tailscale = {
  status: null as string | null,
  /** What `tailscale up` prints before it waits for the person to sign in. */
  up: null as string | null,
  spawns: [] as Array<ReadonlyArray<string>>,
};
const issuedSessions: Array<{ scopes?: unknown; label?: string; ttl?: Duration.Duration }> = [];
/** The caller's own client, and what the phone endpoints asked of this machine's auth. */
const phoneAuth = {
  deviceType: "desktop" as "desktop" | "mobile",
  otherSessions: [] as Array<{ sessionId: string; subject: string }>,
  pairingLinks: [] as Array<{
    ttl?: Duration.Duration;
    label?: string;
    scopes?: unknown;
    subject?: string;
  }>,
  revoked: [] as string[],
};
const clientSession = (sessionId: string, subject: string, deviceType: string) => ({
  sessionId: AuthSessionId.make(sessionId),
  subject,
  scopes: [],
  method: "bearer-access-token" as const,
  client: { deviceType, label: "Anton's iPhone" },
  issuedAt: DateTime.makeUnsafe(Date.parse("2026-10-20T00:00:00.000Z")),
  expiresAt: DateTime.makeUnsafe(Date.parse("2026-11-19T00:00:00.000Z")),
  lastConnectedAt: null,
  connected: true,
  current: false,
});
const encoder = new TextEncoder();
const fakeTailscale = Layer.merge(
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
      tailscale.spawns.push(args);
      if (tailscale.status === null)
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            cause: new Error("not installed"),
          }),
        );
      const waiting = args[0] === "up" && tailscale.up !== null;
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: waiting ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(args[0] === "status" ? tailscale.status : "")),
          stderr: Stream.make(encoder.encode(waiting ? tailscale.up! : "")),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  ),
  Layer.succeed(HostProcessPlatform, "linux"),
);
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
      yield* persistServerRuntimeState({
        path: config.serverRuntimeStatePath,
        state: {
          version: 1,
          pid: process.pid,
          port: 8319,
          origin: "http://127.0.0.1:8319",
          startedAt: "2026-10-18T00:00:00.000Z",
        },
      }).pipe(Effect.orDie);
      return config;
    }),
  ).pipe(Layer.provide(Config.layerTest(process.cwd(), { prefix: "studio-fleet-http-" })));
  const routes = HttpApiBuilder.layer(TestApi).pipe(
    Layer.provide(
      FleetHttp.layer.pipe(
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("env-m4")),
            getDescriptor: Effect.succeed(descriptor("env-m4") as never),
          }),
        ),
        Layer.provide(fakeTailscale),
        Layer.provide(
          FetchHttpClient.layer.pipe(
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, globalThis.fetch)),
          ),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ThreadManagement.ThreadManagementService)({}),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(ProviderRegistry.ProviderRegistry)({}),
            FleetTargets.layer.pipe(
              Layer.provide(Layer.succeed(FetchHttpClient.Fetch, globalThis.fetch)),
            ),
          ),
        ),
      ),
    ),
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
        listSessions: () =>
          Effect.succeed([
            clientSession("synthetic-session", "fixture", phoneAuth.deviceType),
            ...phoneAuth.otherSessions.map((entry) =>
              clientSession(entry.sessionId, entry.subject, "mobile"),
            ),
          ] as never),
        createPairingLink: (input) => {
          phoneAuth.pairingLinks.push(input ?? {});
          return Effect.succeed({
            id: "pairing-phone",
            credential: "PHONECODE",
            expiresAt: DateTime.makeUnsafe(Date.parse("2026-10-20T18:10:00.000Z")),
          } as never);
        },
        revokeSession: (sessionId) =>
          Effect.sync(() => {
            phoneAuth.revoked.push(sessionId);
            return true;
          }),
        issueSession: (input) => {
          issuedSessions.push(input ?? {});
          return Effect.succeed({
            sessionId: AuthSessionId.make("synthetic-invite-session"),
            token: "synthetic-invite-token",
            method: "bearer-access-token" as const,
            scopes: input?.scopes ?? [],
            subject: "fixture",
            client: { deviceType: "bot" as const },
            expiresAt: DateTime.makeUnsafe(Date.parse("2027-10-18T00:00:00.000Z")),
          } as never);
        },
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
  const invite = (
    body: object,
    headers: Record<string, string> = {
      authorization: "Bearer synthetic-session",
      origin: "http://localhost:8319",
    },
  ) =>
    handler(
      new Request("http://localhost:8319/api/studio/fleet/invite", {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost:8319", ...headers },
        body: JSON.stringify(body),
      }),
    );
  const tailscaleStatus = (
    headers: Record<string, string> = { authorization: "Bearer synthetic-session" },
  ) =>
    handler(
      new Request("http://localhost:8319/api/studio/fleet/tailscale", {
        method: "GET",
        headers: { host: "localhost:8319", ...headers },
      }),
    );
  const signIn = (
    body: object = {},
    headers: Record<string, string> = {
      authorization: "Bearer synthetic-session",
      origin: "http://localhost:8319",
    },
  ) =>
    handler(
      new Request("http://localhost:8319/api/studio/fleet/tailscale/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost:8319", ...headers },
        body: JSON.stringify(body),
      }),
    );
  const phone = (
    path: "" | "/mint" | "/links",
    body: object,
    headers: Record<string, string> = { authorization: "Bearer synthetic-session" },
  ) =>
    handler(
      new Request(`http://localhost:8319/api/studio/fleet/phone${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost:8319", ...headers },
        body: JSON.stringify(body),
      }),
    );
  return { request, workers, add, invite, tailscaleStatus, signIn, phone, dispose };
}
afterEach(() => {
  vi.unstubAllGlobals();
  tailscale.status = null;
  tailscale.up = null;
  tailscale.spawns.length = 0;
  issuedSessions.length = 0;
  phoneAuth.deviceType = "desktop";
  phoneAuth.otherSessions = [];
  phoneAuth.pairingLinks.length = 0;
  phoneAuth.revoked.length = 0;
});
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
      new URL(String(url)).origin !== "https://m1.tailnet.ts.net"
        ? Promise.reject(new TypeError("unreachable"))
        : new URL(String(url)).pathname === "/api/auth/session"
          ? Response.json({
              authenticated: true,
              permissions: [...AuthStandardClientScopes, AuthAccessWriteScope],
            })
          : Response.json(descriptor("env-m1")),
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
describe("inviting this machine over HTTP", () => {
  // Making a line needs every scope the line hands out.
  const INVITE_OWNER_SCOPES = [...AuthStandardClientScopes, AuthAccessWriteScope];
  const status = (dnsName?: string) =>
    JSON.stringify({ Self: { ...(dnsName ? { DNSName: dnsName } : {}), TailscaleIPs: [] } });
  const serveCalls = () => tailscale.spawns.filter((args) => args[0] === "serve");
  it("refuses a caller who holds less than the line hands out", async () => {
    tailscale.status = status("m4.tailnet.ts.net.");
    const outbound = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", outbound);
    // Access management alone, like a token from an older invitation.
    const manager = await api([AuthAccessWriteScope]);
    try {
      const response = await manager.invite({});
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("full access");
      expect(serveCalls()).toEqual([]);
      expect(issuedSessions).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });
  it("needs access management and this app's own origin before Tailscale or a credential", async () => {
    tailscale.status = status("m4.tailnet.ts.net.");
    const outbound = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", outbound);
    const operator = await api([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
    const owner = await api(INVITE_OWNER_SCOPES);
    try {
      expect((await operator.invite({})).status).toBe(403);
      expect(
        (
          await owner.invite(
            {},
            { authorization: "Bearer synthetic-session", origin: "https://evil.invalid" },
          )
        ).status,
      ).toBe(403);
      expect((await owner.invite({}, { origin: "http://localhost:8319" })).status).toBe(401);
      expect((await owner.invite({ url: "https://evil.ts.net" })).status).toBe(400);
      expect((await owner.invite({ days: 0 })).status).toBe(400);
      expect(outbound).not.toHaveBeenCalled();
      expect(tailscale.spawns).toEqual([]);
      expect(issuedSessions).toEqual([]);
    } finally {
      await operator.dispose();
      await owner.dispose();
    }
  });
  it("publishes this server on its Tailscale name and returns a line naming it", async () => {
    tailscale.status = status("m4.tailnet.ts.net.");
    // Nothing answers on the tailnet name until Serve maps it to this server.
    const outbound = vi.fn<typeof fetch>(async () =>
      serveCalls().length > 0
        ? Response.json(descriptor("env-m4"))
        : Promise.reject(new TypeError("unreachable")),
    );
    vi.stubGlobal("fetch", outbound);
    const owner = await api(INVITE_OWNER_SCOPES);
    try {
      const response = await owner.invite({ label: "  Studio Mac  ", days: 30 });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await response.json()) as Record<string, string>;
      expect(body).toEqual({
        code: expect.stringMatching(/^swc-machine-/),
        url: "https://m4.tailnet.ts.net",
        label: "Studio Mac",
        expiresAt: "2027-10-18T00:00:00.000Z",
        sessionId: "synthetic-invite-session",
      });
      expect(decodeFleetJoinCode(body.code!)).toEqual({
        url: "https://m4.tailnet.ts.net",
        environmentId: "env-m4",
        label: "Studio Mac",
        managementToken: "synthetic-invite-token",
      });
      expect(serveCalls()).toEqual([["serve", "--bg", "--https=443", "http://127.0.0.1:8319"]]);
      expect(issuedSessions).toHaveLength(1);
      expect(issuedSessions[0]).toMatchObject({
        scopes: [...AuthStandardClientScopes, AuthAccessWriteScope],
        label: "Fleet management (fleet invite)",
      });
      expect(Duration.toDays(issuedSessions[0]!.ttl!)).toBe(30);

      // Again: the mapping already fronts this server, so it is reused as it is,
      // and the name defaults to this machine's own.
      const again = (await (await owner.invite({})).json()) as Record<string, string>;
      expect(decodeFleetJoinCode(again.code!)).toMatchObject({
        environmentId: "env-m4",
        label: "Fixture Mac",
      });
      expect(serveCalls()).toHaveLength(1);
      expect(Duration.toDays(issuedSessions[1]!.ttl!)).toBe(365);
    } finally {
      await owner.dispose();
    }
  });
  it("never replaces a Serve mapping that fronts another server or another app", async () => {
    tailscale.status = status("m4.tailnet.ts.net.");
    let answer: () => Response = () => Response.json(descriptor("env-other"));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => answer()),
    );
    const owner = await api(INVITE_OWNER_SCOPES);
    try {
      const other = await owner.invite({});
      expect(other.status).toBe(409);
      expect(await other.json()).toMatchObject({
        _tag: "StudioFleetInviteError",
        reason: "serves_other_server",
        message: expect.stringContaining("will not replace it"),
      });
      answer = () => new Response("<html>someone else</html>", { status: 200 });
      const occupied = await owner.invite({});
      expect(occupied.status).toBe(409);
      expect(await occupied.json()).toMatchObject({ reason: "port_occupied" });
      expect(serveCalls()).toEqual([]);
      expect(issuedSessions).toEqual([]);
    } finally {
      await owner.dispose();
    }
  });
  it("says in plain words when Tailscale is missing or has no MagicDNS name", async () => {
    const outbound = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", outbound);
    const owner = await api(INVITE_OWNER_SCOPES);
    try {
      const missing = await owner.invite({});
      expect(missing.status).toBe(409);
      expect(await missing.json()).toMatchObject({
        reason: "tailscale_missing",
        message: expect.stringContaining("tailscale.com/download"),
      });
      tailscale.status = status();
      expect(await (await owner.invite({})).json()).toMatchObject({
        reason: "magic_dns_missing",
        message: expect.stringContaining("MagicDNS"),
      });
      expect(outbound).not.toHaveBeenCalled();
      expect(serveCalls()).toEqual([]);
      expect(issuedSessions).toEqual([]);
    } finally {
      await owner.dispose();
    }
  });
});
describe("Tailscale on the machine to invite", () => {
  it("maps what Tailscale reports to install, sign in or invite", () => {
    expect(fleetTailscaleState({ _tag: "missing" })).toEqual({
      state: "not_installed",
      backendState: null,
      magicDns: false,
    });
    expect(fleetTailscaleState({ _tag: "unavailable" }).state).toBe("signed_out");
    for (const backendState of ["NeedsLogin", "NeedsMachineAuth", "Stopped", "Starting", null])
      expect(fleetTailscaleState({ _tag: "status", backendState, magicDnsName: null }).state).toBe(
        "signed_out",
      );
    expect(
      fleetTailscaleState({
        _tag: "status",
        backendState: "Running",
        magicDnsName: "m4.tailnet.ts.net",
      }),
    ).toEqual({ state: "running", backendState: "Running", magicDns: true });
  });
  it("reports the state to an access manager only", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    const operator = await api([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
    const owner = await api();
    try {
      expect((await operator.tailscaleStatus()).status).toBe(403);
      expect(tailscale.spawns).toEqual([]);
      const missing = await owner.tailscaleStatus();
      expect(missing.status).toBe(200);
      expect(missing.headers.get("cache-control")).toBe("no-store");
      expect(await missing.json()).toEqual({
        state: "not_installed",
        backendState: null,
        magicDns: false,
        platform: "linux",
        homebrew: false,
      });
      tailscale.status = JSON.stringify({ BackendState: "NeedsLogin" });
      expect(await (await owner.tailscaleStatus()).json()).toMatchObject({
        state: "signed_out",
        backendState: "NeedsLogin",
      });
      tailscale.status = JSON.stringify({
        BackendState: "Running",
        Self: { DNSName: "m4.tailnet.ts.net." },
      });
      expect(await (await owner.tailscaleStatus()).json()).toMatchObject({
        state: "running",
        magicDns: true,
      });
    } finally {
      await operator.dispose();
      await owner.dispose();
    }
  });
  it("starts a sign-in only for an access manager from this app, with no flags or keys", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    tailscale.status = JSON.stringify({ BackendState: "NeedsLogin" });
    tailscale.up = "To authenticate, visit:\n\n\thttps://login.tailscale.com/a/synthetic42\n";
    const operator = await api([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
    const owner = await api();
    try {
      expect((await operator.signIn()).status).toBe(403);
      expect(
        (
          await owner.signIn(
            {},
            { authorization: "Bearer synthetic-session", origin: "https://evil.invalid" },
          )
        ).status,
      ).toBe(403);
      expect((await owner.signIn({ authKey: "tskey-synthetic" })).status).toBe(400);
      expect(tailscale.spawns).toEqual([]);

      const started = await owner.signIn();
      expect(started.status).toBe(200);
      expect(started.headers.get("cache-control")).toBe("no-store");
      expect(await started.json()).toEqual({
        loginUrl: "https://login.tailscale.com/a/synthetic42",
      });
      expect(tailscale.spawns).toEqual([["up"]]);
    } finally {
      await operator.dispose();
      await owner.dispose();
    }
  });
});
describe("linking a phone to the other machines over HTTP", () => {
  const PHONE_SCOPES = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];
  /** M1 as a current machine: it answers its identity and mints a phone code. */
  const m1 = () => {
    const mints: Array<{ authorization: string | null; body: unknown }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.origin !== ORIGIN) return new Response("{}", { status: 404 });
      if (url.pathname === "/.well-known/studio/environment") return json(descriptor("env-m1"));
      if (url.pathname === "/api/studio/fleet/phone/mint") {
        mints.push({
          authorization: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)),
        });
        return json({
          code: "M1CODE",
          expiresAt: "2099-01-01T00:00:00.000Z",
          routes: [{ kind: "lan", httpBaseUrl: "http://192.168.1.11:8319" }],
        });
      }
      return new Response("{}", { status: 404 });
    });
    return { fetcher, mints };
  };

  it("gives the roster only to a phone paired here, with read access", async () => {
    const { fetcher, mints } = m1();
    vi.stubGlobal("fetch", fetcher);
    const desktop = await api(PHONE_SCOPES, false, ORIGIN);
    const unreadable = await api([AuthOrchestrationOperateScope], false, ORIGIN);
    try {
      expect((await desktop.phone("", { mint: ["env-m1"] })).status).toBe(403);
      phoneAuth.deviceType = "mobile";
      expect((await unreadable.phone("", { mint: ["env-m1"] })).status).toBe(403);
      expect(
        (
          await desktop.phone(
            "",
            {},
            { authorization: "Bearer synthetic-session", origin: "https://evil.invalid" },
          )
        ).status,
      ).toBe(403);
      expect(mints).toEqual([]);
    } finally {
      await desktop.dispose();
      await unreadable.dispose();
    }
  });

  it("lists the other machines and mints a code only on the ones the phone asks for", async () => {
    const { fetcher, mints } = m1();
    vi.stubGlobal("fetch", fetcher);
    phoneAuth.deviceType = "mobile";
    const phone = await api(PHONE_SCOPES, false, ORIGIN);
    try {
      const listed = await phone.phone("", {});
      expect(listed.status).toBe(200);
      expect(listed.headers.get("cache-control")).toBe("no-store");
      expect(await listed.json()).toEqual({
        hub: { environmentId: "env-m4", label: "Fixture Mac" },
        machines: [
          {
            environmentId: "env-m1",
            label: "Mac M1",
            routes: [{ kind: "fleet", httpBaseUrl: ORIGIN }],
          },
        ],
      });
      expect(mints).toEqual([]);

      const minted = await phone.phone("", { mint: ["env-m1"] });
      expect(minted.status).toBe(200);
      expect(await minted.json()).toEqual({
        hub: { environmentId: "env-m4", label: "Fixture Mac" },
        machines: [
          {
            environmentId: "env-m1",
            label: "Mac M1",
            routes: [
              { kind: "fleet", httpBaseUrl: ORIGIN },
              { kind: "lan", httpBaseUrl: "http://192.168.1.11:8319" },
            ],
            pairing: { code: "M1CODE", expiresAt: "2099-01-01T00:00:00.000Z" },
          },
        ],
      });
      expect(mints).toEqual([
        {
          authorization: "Bearer management-secret",
          body: {
            hubEnvironmentId: "env-m4",
            hubSessionId: "synthetic-session",
            label: "Anton's iPhone via Fixture Mac",
            scopes: PHONE_SCOPES,
          },
        },
      ]);
    } finally {
      await phone.dispose();
    }
  });

  it("mints a phone-only code for a machine with access management, tied to the hub's phone session", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    const operator = await api(PHONE_SCOPES);
    const owner = await api();
    const mint = (scopes: ReadonlyArray<string>) => ({
      hubEnvironmentId: "env-m4",
      hubSessionId: "hub-phone-1",
      label: "Anton's iPhone via M4",
      scopes,
    });
    try {
      expect((await operator.phone("/mint", mint([AuthOrchestrationReadScope]))).status).toBe(403);
      expect(
        (await owner.phone("/mint", mint([AuthOrchestrationReadScope, AuthAccessWriteScope])))
          .status,
      ).toBe(400);
      expect((await owner.phone("/mint", mint([AuthOrchestrationOperateScope]))).status).toBe(400);
      expect(phoneAuth.pairingLinks).toEqual([]);

      const issued = await owner.phone("/mint", mint([AuthOrchestrationReadScope]));
      expect(issued.status).toBe(200);
      expect(issued.headers.get("cache-control")).toBe("no-store");
      expect(await issued.json()).toEqual({
        code: "PHONECODE",
        expiresAt: "2026-10-20T18:10:00.000Z",
        routes: [],
      });
      expect(phoneAuth.pairingLinks).toEqual([
        {
          ttl: Duration.minutes(10),
          label: "Anton's iPhone via M4",
          scopes: [AuthOrchestrationReadScope],
          subject: "phone-link:env-m4:hub-phone-1",
        },
      ]);
    } finally {
      await operator.dispose();
      await owner.dispose();
    }
  });

  it("revokes the phone sessions a hub no longer has and lists the rest", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    phoneAuth.otherSessions = [
      { sessionId: "linked-a", subject: "phone-link:env-m4:hub-a" },
      { sessionId: "linked-b", subject: "phone-link:env-m4:hub-b" },
      { sessionId: "other-hub", subject: "phone-link:env-m3:hub-b" },
    ];
    const operator = await api(PHONE_SCOPES);
    const owner = await api();
    try {
      const body = { hubEnvironmentId: "env-m4", activeHubSessionIds: ["hub-a"] };
      expect((await operator.phone("/links", body)).status).toBe(403);
      expect(phoneAuth.revoked).toEqual([]);
      const answered = await owner.phone("/links", body);
      expect(answered.status).toBe(200);
      expect(await answered.json()).toEqual({
        links: [
          { sessionId: "linked-a", hubSessionId: "hub-a", expiresAt: "2026-11-19T00:00:00.000Z" },
        ],
        revoked: 1,
      });
      expect(phoneAuth.revoked).toEqual(["linked-b"]);
    } finally {
      await operator.dispose();
      await owner.dispose();
    }
  });
});
