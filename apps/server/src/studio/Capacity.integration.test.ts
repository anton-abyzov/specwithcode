import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as DateTime from "effect/DateTime";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native HTTP fixture records real loopback requests independently of the capacity client.
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as Capacity from "./Capacity.ts";
import { CodexNativeRouteCheckError } from "../provider/CodexProvider.ts";
import * as NativeRoute from "./NativeRoute.ts";
import { SwitchFetch } from "./SwitchClient.ts";
import { provider, rawAccount, rawSnapshot, settings } from "./fixtures.ts";

type RequestRecord = {
  method: string;
  path: string;
  origin?: string;
  accept?: string;
  contentType?: string;
  body: string;
};
type Reply = { status?: number; json?: unknown; text?: string; contentType?: string };

/** The real SwitchClient talks to a real HTTP listener. Only its destination
 * host/port changes; paths, bodies, headers, abort and redirect policy are intact.
 * Native auth/probing are explicit doubles, so these tests cannot start a model.
 */
async function withCompanion(test: (h: Awaited<ReturnType<typeof companion>>) => Promise<void>) {
  const h = await companion();
  try {
    await test(h);
  } finally {
    await h.close();
  }
}

async function companion() {
  const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
  const h = {
    now,
    raw: rawSnapshot(now) as unknown,
    requests: [] as RequestRecord[],
    native: [provider("codex", "codex", now)] as ReadonlyArray<ServerProvider>,
    refreshed: undefined as ReadonlyArray<ServerProvider> | undefined,
    refreshIds: [] as string[],
    config: settings,
    routeVerified: true,
    routeFailure: undefined as CodexNativeRouteCheckError | undefined,
    routes: [] as Array<{
      entry: ProviderInstanceConfig;
      cwd: string | null;
      baseEnv: NodeJS.ProcessEnv;
    }>,
    respond: undefined as ((request: RequestRecord) => Reply | undefined) | undefined,
  };
  const server = NodeHttp.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const record: RequestRecord = {
      method: request.method ?? "",
      path: request.url ?? "",
      body: Buffer.concat(chunks).toString("utf8"),
      ...(request.headers.origin ? { origin: request.headers.origin } : {}),
      ...(request.headers.accept ? { accept: request.headers.accept } : {}),
      ...(request.headers["content-type"] ? { contentType: request.headers["content-type"] } : {}),
    };
    h.requests.push(record);
    const override = h.respond?.(record);
    if (override) {
      response.writeHead(override.status ?? 200, {
        "content-type": override.contentType ?? "application/json",
      });
      response.end(override.text ?? JSON.stringify(override.json ?? {}));
      return;
    }
    // Model the companion's persisted policy, not the Capacity implementation.
    // Its subsequent GET must confirm that the client sent a valid wire mutation.
    const snapshot = h.raw as ReturnType<typeof rawSnapshot>;
    if (record.path === "/api/policy" && record.method === "POST")
      snapshot.policy = { ...snapshot.policy, ...JSON.parse(record.body) };
    if (record.path === "/api/select" && record.method === "POST")
      snapshot.policy = { ...snapshot.policy, selectedAccount: JSON.parse(record.body).id };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(h.raw));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  };
  const transport = (async (input, init) => {
    const url = new URL(String(input));
    // Fail before any network access if production tries another host or route.
    expect(url.origin).toBe("http://127.0.0.1:8318");
    expect(["/api/state", "/api/refresh", "/api/policy", "/api/select"]).toContain(url.pathname);
    expect(url.search).toBe("");
    expect(init?.redirect).toBe("error");
    expect(init?.credentials).toBe("omit");
    url.port = String(port);
    return Effect.runSync(FetchHttpClient.Fetch)(url, init);
  }) as typeof fetch;
  const run = <A, E>(effect: Effect.Effect<A, E, Capacity.Capacity>) =>
    Effect.runPromise(
      Clock.clockWith((clock) =>
        effect.pipe(
          Effect.provide(Capacity.layer),
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(NativeRoute.NativeRoute, {
                verify: (entry, cwd, baseEnv) =>
                  Effect.sync(() => {
                    h.routes.push({ entry, cwd, baseEnv });
                    return h.routeVerified;
                  }).pipe(
                    Effect.flatMap((verified) =>
                      h.routeFailure ? Effect.fail(h.routeFailure) : Effect.succeed(verified),
                    ),
                  ),
              }),
              Layer.mock(Settings.ServerSettingsService)({
                getSettings: Effect.sync(() => h.config),
              }),
              Layer.mock(Providers.ProviderRegistry)({
                getProviders: Effect.sync(() => h.native),
                refreshInstance: (id) =>
                  Effect.sync(() => {
                    h.refreshIds.push(id);
                    return h.refreshed ?? h.native;
                  }),
              }),
            ),
          ),
          Effect.provideService(HostProcessEnvironment, {}),
          Effect.provideService(SwitchFetch, transport),
          Effect.provideService(
            Clock.Clock,
            Object.assign(Object.create(clock) as Clock.Clock, {
              currentTimeMillis: Effect.succeed(now),
              currentTimeMillisUnsafe: () => now,
            }),
          ),
        ),
      ),
    );
  return {
    ...h,
    get state() {
      return h;
    },
    run,
    close,
  };
}

const current = Effect.flatMap(Capacity.Capacity, (capacity) => capacity.current);
const start = (id = "codex", options?: Capacity.NativeCreditStartOptions) =>
  Effect.flatMap(Capacity.Capacity, (capacity) =>
    capacity.assertNativeStart(ProviderInstanceId.make(id), "/owned/workspace", options),
  );
const wire = (method: string, path: string, body = ""): RequestRecord => ({
  method,
  path,
  body,
  accept: "application/json",
  ...(method === "POST"
    ? { origin: "http://127.0.0.1:8318", contentType: "application/json" }
    : {}),
});

const funded = (now: number): ServerProvider => {
  const p = provider("codex", "codex", now);
  return {
    ...p,
    usageLimits: {
      ...p.usageLimits!,
      nativeAllowanceObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      ordinaryUsageAllowed: false,
      spendControlReached: false,
      rateLimitReachedType: "rate_limit_reached",
      credits: { hasCredits: true, unlimited: false, balance: "50" },
      windows: [
        {
          id: "primary",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 100,
          resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 3600000)),
          windowDurationMins: 10080,
        },
      ],
    },
  };
};
const credits: Capacity.NativeCreditStartOptions = {
  allowCredits: true,
  expectedQuotaPoolId: `codex:sha256:${"a".repeat(64)}`,
};

describe("capacity service with a real local companion transport", () => {
  it("reads, mutates and reads back policy and selection with exact wire boundaries", async () =>
    withCompanion(async (h) => {
      const initial = await h.run(current);
      expect(initial).toMatchObject({
        available: true,
        policy: { mode: "balanced", selectedAccount: null },
      });
      expect(initial.accounts[0]).toMatchObject({
        id: "codex-1",
        providerInstanceId: "codex",
        status: "ready",
      });
      const policy = await h.run(
        Effect.flatMap(Capacity.Capacity, (capacity) =>
          capacity.policy({ mode: "reset-first", preferredProvider: "codex" }),
        ),
      );
      expect(policy.policy).toMatchObject({ mode: "reset-first", preferredProvider: "codex" });
      const selected = await h.run(
        Effect.flatMap(Capacity.Capacity, (capacity) => capacity.select({ id: "codex-1" })),
      );
      expect(selected.policy?.selectedAccount).toBe("codex-1");
      await h.run(Effect.flatMap(Capacity.Capacity, (capacity) => capacity.select({ id: null })));
      await h.run(Effect.flatMap(Capacity.Capacity, (capacity) => capacity.refresh));
      expect((await h.run(current)).policy).toMatchObject({
        selectedAccount: null,
        mode: "reset-first",
      });
      expect(h.requests).toEqual([
        wire("GET", "/api/state"),
        wire("POST", "/api/policy", '{"mode":"reset-first","preferredProvider":"codex"}'),
        wire("GET", "/api/state"),
        wire("POST", "/api/select", '{"id":"codex-1"}'),
        wire("POST", "/api/select", '{"id":null}'),
        wire("POST", "/api/refresh", "{}"),
        wire("GET", "/api/state"),
      ]);
      expect(h.refreshIds).toEqual([]);
      expect(h.routes).toEqual([]);
    }));

  it("rejects an exhausted selection before sending a mutation", async () =>
    withCompanion(async (h) => {
      const exhausted = rawSnapshot(h.now);
      exhausted.accounts[0]!.status = "exhausted";
      h.state.raw = exhausted;
      const failure = await h.run(
        Effect.flatMap(Capacity.Capacity, (capacity) => capacity.select({ id: "codex-1" })).pipe(
          Effect.flip,
        ),
      );
      expect(failure.category).toBe("profile-not-eligible");
      expect(h.requests).toEqual([wire("GET", "/api/state")]);
    }));

  it("maps real busy and malformed mutation replies without publishing server error text", async () =>
    withCompanion(async (h) => {
      h.state.respond = () => ({ status: 409, json: { error: "private-companion-detail" } });
      const busy = await h.run(
        Effect.flatMap(Capacity.Capacity, (capacity) => capacity.refresh).pipe(Effect.flip),
      );
      expect(busy.category).toBe("switch-busy");
      expect(busy.message).toContain("already running");
      h.state.respond = () => ({ text: "{private-companion-detail" });
      const malformed = await h.run(
        Effect.flatMap(Capacity.Capacity, (capacity) => capacity.policy({ mode: "balanced" })).pipe(
          Effect.flip,
        ),
      );
      expect(malformed.category).toBe("switch-invalid-response");
      expect(JSON.stringify([busy, malformed])).not.toContain("private-companion-detail");
      expect(h.requests).toEqual([
        wire("POST", "/api/refresh", "{}"),
        wire("POST", "/api/policy", '{"mode":"balanced"}'),
      ]);
    }));

  it("keeps background reads passive and refreshes expired capacity once on an explicit start", async () =>
    withCompanion(async (h) => {
      const old = h.now - 16 * 60_000;
      h.state.raw = rawSnapshot(old);
      h.state.native = [provider("codex", "codex", old)];
      h.state.refreshed = [provider("codex", "codex", h.now)];
      h.state.respond = (request) =>
        request.path === "/api/refresh" ? { json: rawSnapshot(h.now) } : undefined;
      expect((await h.run(current)).accounts[0]?.status).toBe("stale");
      expect(h.requests).toEqual([wire("GET", "/api/state")]);
      expect(h.refreshIds).toEqual([]);
      await h.run(start());
      expect(h.refreshIds).toEqual(["codex"]);
      expect(h.routes).toEqual([
        {
          entry: { driver: "codex", config: settings.providers.codex },
          cwd: "/owned/workspace",
          baseEnv: {},
        },
      ]);
      expect(h.requests).toEqual([
        wire("GET", "/api/state"),
        wire("GET", "/api/state"),
        wire("POST", "/api/refresh", "{}"),
      ]);
    }));

  it.each([
    ["busy", { status: 409, json: {} }, /refresh is already running/],
    ["invalid", { json: {} }, /Fresh subscription capacity could not be verified/],
    ["exhausted", null, /no remaining permitted usage/],
  ] as const)(
    "does not admit expired capacity when its one refresh is %s",
    async (kind, reply, message) =>
      withCompanion(async (h) => {
        h.state.raw = rawSnapshot(h.now - 16 * 60_000);
        const exhausted = rawSnapshot(h.now);
        exhausted.accounts[0]!.status = "exhausted";
        h.state.respond = (request) =>
          request.path === "/api/refresh" ? (reply ?? { json: exhausted }) : undefined;
        const denied = h.run(start());
        await expect(denied).rejects.toThrow(message);
        if (kind === "exhausted") {
          // The companion denies work without identifying an exhausted window.
          // Its ordinary session reset is not an estimate of recovery.
          const error = await denied.catch((error: unknown) => error);
          expect(error).toMatchObject({ _tag: "ProviderSetupError", usageLimit: {} });
          expect(
            (error as { usageLimit: { resetAt?: string } }).usageLimit.resetAt,
          ).toBeUndefined();
          expect((error as { detail: string }).detail).not.toContain("Next observed reset");
        }
        expect(h.requests).toEqual([wire("GET", "/api/state"), wire("POST", "/api/refresh", "{}")]);
        // An exhausted verdict re-reads native status once before refusing (a new
        // sign-in or an early reset shows only there); the companion is not asked twice.
        expect(h.refreshIds).toEqual(kind === "exhausted" ? ["codex"] : []);
      }),
  );

  it("verifies the selected instance and cwd, and rejects a changed native route before HTTP", async () =>
    withCompanion(async (h) => {
      const entry = {
        driver: ProviderDriverKind.make("codex"),
        config: { ...settings.providers.codex },
      };
      h.state.config = {
        ...settings,
        providerInstances: { [ProviderInstanceId.make("project-codex")]: entry },
      };
      h.state.native = [
        provider("decoy", "codex", h.now),
        provider("project-codex", "codex", h.now - 16 * 60_000),
      ];
      h.state.refreshed = [
        provider("decoy", "codex", h.now),
        provider("project-codex", "codex", h.now),
      ];
      h.state.routeVerified = false;
      await expect(h.run(start("project-codex"))).rejects.toThrow(/effective Codex route/);
      expect(h.refreshIds).toEqual(["project-codex"]);
      expect(h.routes).toEqual([{ entry, cwd: "/owned/workspace", baseEnv: {} }]);
      expect(h.requests).toEqual([]);
    }));

  it.each(["timeout", "unavailable"] as const)(
    "keeps %s route verification closed before companion HTTP",
    async (reason) =>
      withCompanion(async (h) => {
        h.state.routeFailure = new CodexNativeRouteCheckError({ reason });
        await expect(h.run(start())).rejects.toThrow(
          reason === "timeout" ? /route check timed out/ : /route check failed/,
        );
        expect(h.routes).toHaveLength(1);
        expect(h.routes[0]?.cwd).toBe("/owned/workspace");
        expect(h.requests).toEqual([]);
      }),
  );

  it("does not replace missing authorization for the selected instance with a ready different instance", async () =>
    withCompanion(async (h) => {
      h.state.native = [provider("other-codex", "codex", h.now)];
      await expect(h.run(start())).rejects.toThrow(/authorization is unverified/);
      expect(h.refreshIds).toEqual(["codex"]);
      expect(h.routes).toEqual([]);
      expect(h.requests).toEqual([]);
    }));

  it("allows a verified native default when the optional HTTP listener is absent but marks capacity unavailable", async () =>
    withCompanion(async (h) => {
      await h.close();
      await expect(h.run(start())).resolves.toBeUndefined();
      expect(await h.run(current)).toMatchObject({
        available: false,
        error: "switch-unavailable",
        policy: null,
        accounts: [],
      });
      expect(h.routes).toHaveLength(1);
      expect(h.refreshIds).toEqual([]);
      expect(h.requests).toEqual([]);
    }));

  it("retains an explicit native spend denial even when the companion is absent", async () =>
    withCompanion(async (h) => {
      const p = provider("codex", "codex", h.now);
      h.state.native = [
        {
          ...p,
          usageLimits: {
            ...p.usageLimits!,
            nativeAllowanceObservedAt: DateTime.formatIso(DateTime.makeUnsafe(h.now)),
            spendControlReached: true,
            windows: [
              {
                id: "primary",
                kind: "session",
                label: "Session",
                usedPercent: 25,
                resetsAt: DateTime.formatIso(DateTime.makeUnsafe(h.now + 3600000)),
              },
            ],
          },
        },
      ];
      await h.close();
      const denied = h.run(start());
      await expect(denied).rejects.toThrow(/spend control/);
      const error = await denied.catch((error: unknown) => error);
      expect(error).toMatchObject({ _tag: "ProviderSetupError", usageLimit: {} });
      expect((error as { usageLimit: { resetAt?: string } }).usageLimit.resetAt).toBeUndefined();
      expect((error as { detail: string }).detail).not.toContain("Next observed reset");
      expect(h.requests).toEqual([]);
      expect(h.routes).toHaveLength(1);
    }));

  it("makes unavailable and invalid companion responses distinct for a fresh explicit credit request", async () =>
    withCompanion(async (h) => {
      h.state.native = [funded(h.now)];
      h.state.respond = () => ({ status: 503, json: { error: "private-companion-detail" } });
      await expect(h.run(start("codex", credits))).resolves.toBeUndefined();
      h.state.respond = () => ({ text: "{private-companion-detail" });
      await expect(h.run(start("codex", credits))).rejects.toThrow(/capacity response is invalid/);
      h.state.respond = () => ({ json: { accounts: [], policy: { mode: "invalid" } } });
      await expect(h.run(start("codex", credits))).rejects.toThrow(/capacity response is invalid/);
      expect(h.requests).toEqual(Array.from({ length: 3 }, () => wire("GET", "/api/state")));
      expect(h.refreshIds).toEqual(["codex", "codex", "codex"]);
    }));

  it("admits freshly observed existing credits without clearing a newer companion denial", async () =>
    withCompanion(async (h) => {
      h.state.native = [funded(h.now)];
      const exhausted = rawSnapshot(h.now - 2000);
      exhausted.accounts[0]!.status = "exhausted";
      Object.assign(exhausted.accounts[0]!, {
        lastQuotaErrorAt: DateTime.formatIso(DateTime.makeUnsafe(h.now - 1000)),
      });
      h.state.raw = exhausted;
      await expect(h.run(start("codex", credits))).resolves.toBeUndefined();
      Object.assign(exhausted.accounts[0]!, {
        lastQuotaErrorAt: DateTime.formatIso(DateTime.makeUnsafe(h.now)),
      });
      await expect(h.run(start("codex", credits))).rejects.toThrow(/no remaining permitted usage/);
      expect(h.requests).toEqual([wire("GET", "/api/state"), wire("GET", "/api/state")]);
      expect(h.refreshIds).toEqual(["codex", "codex"]);
    }));

  it("does not send a companion request when credit refresh changes the selected account", async () =>
    withCompanion(async (h) => {
      const p = funded(h.now);
      h.state.native = [p];
      h.state.refreshed = [
        { ...p, usageLimits: { ...p.usageLimits!, quotaPoolId: `codex:sha256:${"b".repeat(64)}` } },
      ];
      await expect(h.run(start("codex", credits))).rejects.toThrow(/native account changed/);
      expect(h.refreshIds).toEqual(["codex"]);
      expect(h.requests).toEqual([]);
    }));

  it("refuses cached credit allowance even when companion HTTP reports ready capacity", async () =>
    withCompanion(async (h) => {
      h.state.native = [funded(h.now - 1000)];
      await expect(h.run(start("codex", credits))).rejects.toThrow(
        /Existing credits are unavailable/,
      );
      expect(h.refreshIds).toEqual(["codex"]);
      expect(h.requests).toEqual([]);
    }));

  it("enforces a companion busy account and permits genuinely unknown consumer quota without inventing readiness", async () =>
    withCompanion(async (h) => {
      const busy = rawSnapshot(h.now);
      busy.accounts[0]!.status = "active";
      h.state.raw = busy;
      await expect(h.run(start())).rejects.toThrow(/blocked, busy/);
      h.state.native = [provider("claudeAgent", "claudeAgent", h.now)];
      h.state.raw = {
        ...rawSnapshot(h.now),
        accounts: [{ ...rawAccount("claude-1", h.now), status: "unknown", quota: null }],
      };
      await expect(h.run(start("claudeAgent"))).resolves.toBeUndefined();
      const snapshot = await h.run(current);
      expect(snapshot.accounts[0]).toMatchObject({
        status: "unknown",
        providerInstanceId: "claudeAgent",
      });
      expect(snapshot.recommendations.every((r) => r.id === null)).toBe(true);
      expect(h.routes).toHaveLength(1);
      expect(h.requests).toEqual(Array.from({ length: 3 }, () => wire("GET", "/api/state")));
    }));
});
