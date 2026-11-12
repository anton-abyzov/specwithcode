import { createClerkClient, verifyToken } from "@clerk/backend";
import { describe, expect, it } from "@effect/vitest";
import { RelayApi } from "@specweave-studio/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as OpenApi from "effect/http-api/OpenApi";
import { beforeEach, vi } from "vite-plus/test";

import * as PhoneRemovals from "../agentActivity/PhoneRemovals.ts";
import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import { traceRelayHttpRequestWith } from "../http/Api.ts";
import { clearClerkOAuthVerificationCache } from "../http/ClerkBearer.ts";
import { relayEnvironmentLinks, relayManagedEndpointAllocations } from "../persistence/schema.ts";
import {
  ADMIN_SECRETS,
  adminAllocation,
  adminLink,
  adminTestConfig,
  seedConnectAdmin,
} from "../testing/connectAdminFixtures.ts";
import { layerSqliteRelayDb, makeSqliteD1 } from "../testing/sqliteD1.ts";
import * as AdminIdentities from "./AdminIdentities.ts";
import * as ConnectAdmin from "./ConnectAdmin.ts";
import * as ConnectAdminQueries from "./ConnectAdminQueries.ts";

vi.mock("@clerk/backend", () => ({
  createClerkClient: vi.fn(),
  verifyToken: vi.fn(),
}));

const AUDIENCE = "studio-code-relay";
const ROUTES = [
  "/v1/admin/me",
  "/v1/admin/overview",
  "/v1/admin/accounts",
  "/v1/admin/accounts/user_owner",
] as const;

/** Clerk as the relay sees it: each token is one signed-in person, or nobody. */
const SESSIONS: Record<string, { sub: string; aud: string; sid?: string }> = {
  "owner-session": { sub: "user_owner", aud: AUDIENCE },
  "owner-phone-session": { sub: "user_owner", aud: AUDIENCE, sid: "sess_phone" },
  "other-session": { sub: "user_free", aud: AUDIENCE },
  "wrong-audience": { sub: "user_owner", aud: "some-other-app" },
};

beforeEach(() => {
  clearClerkOAuthVerificationCache();
  vi.mocked(verifyToken).mockReset();
  vi.mocked(createClerkClient).mockReset();
  vi.mocked(verifyToken).mockImplementation(async (token: string) => {
    const session = SESSIONS[token];
    if (!session) throw new Error("invalid token");
    return session as never;
  });
  // The headless CLI's OAuth token, signed in as the owner.
  vi.mocked(createClerkClient).mockReturnValue({
    authenticateRequest: vi.fn(async (request: Request) => {
      const signedIn = request.headers.get("authorization") === "Bearer oat_owner_cli";
      return { isAuthenticated: signedIn, toAuth: () => ({ userId: "user_owner" }) };
    }),
  } as never);
});

interface World {
  readonly owners?: ReadonlyArray<string> | undefined;
  readonly identities?: Partial<AdminIdentities.AdminIdentities["Service"]>;
  readonly tunnels?: Partial<ManagedEndpointProvider.ManagedEndpointTunnelClient["Service"]>;
  /** Clerk session ids the relay removed with a phone. */
  readonly removedSessions?: ReadonlyArray<string>;
  /** The removal check itself fails, or throws something nobody expected. */
  readonly removalCheck?: "fails" | "crashes";
  /** More rows on top of the five seeded accounts. */
  readonly seed?: Effect.Effect<void, never, RelayDb.RelayDb>;
}

const KNOWN: ReadonlyMap<string, AdminIdentities.AdminIdentity> = new Map([
  ["user_owner", { email: "owner@example.test", name: "Owner Person" }],
  ["user_free", { email: "free@example.test", name: null }],
]);

/** The admin routes over a seeded relay database, with Clerk and Cloudflare stood in. */
const withAdmin = <A, E>(
  world: World,
  use: (
    call: (path: string, token?: string, scheme?: string) => Effect.Effect<Response>,
  ) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const layerDb = layerSqliteRelayDb(makeSqliteD1().d1);
    yield* seedConnectAdmin.pipe(Effect.provide(layerDb));
    if (world.seed) yield* world.seed.pipe(Effect.provide(layerDb));
    const layerBase = Layer.mergeAll(
      layerDb,
      RelayConfiguration.layer(
        adminTestConfig(world.owners === undefined ? {} : { adminUserIds: world.owners }),
      ),
    );
    const layerServices = Layer.mergeAll(
      ConnectAdminQueries.layer,
      Layer.mock(AdminIdentities.AdminIdentities, {
        lookup: (userIds) =>
          Effect.succeed(new Map([...KNOWN].filter(([userId]) => userIds.includes(userId)))),
        search: () => Effect.succeed({ userIds: [], truncated: false }),
        ...world.identities,
      }),
      Layer.mock(ManagedEndpointProvider.ManagedEndpointTunnelClient, {
        get: (tunnelId) => Effect.succeed({ id: tunnelId, status: "healthy" }),
        ...world.tunnels,
      }),
      Layer.mock(PhoneRemovals.PhoneRemovals, {
        findBlocking: (input) =>
          world.removalCheck === "fails"
            ? Effect.fail(
                new PhoneRemovals.PhoneRemovalPersistenceError({
                  userId: input.userId,
                  stage: "find-blocking",
                  cause: "database down",
                }),
              )
            : world.removalCheck === "crashes"
              ? Effect.die(new Error("unexpected"))
              : Effect.succeed(
                  world.removedSessions?.includes(input.clerkSessionId ?? "")
                    ? ({ id: "removal-1" } as never)
                    : null,
                ),
      }),
    ).pipe(Layer.provideMerge(layerBase));
    const app = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.admin)).pipe(
            Layer.provide(ConnectAdmin.layerApi),
            Layer.provide(ConnectAdmin.layerAdminAuth),
            Layer.provide(layerServices),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      ),
      (handler) => Effect.promise(() => handler.dispose()),
    );
    return yield* use((path, token, scheme = "Bearer") =>
      Effect.promise(() =>
        app.handler(
          new Request(`https://relay.example.test${path}`, {
            headers: token === undefined ? {} : { authorization: `${scheme} ${token}`.trim() },
          }),
        ),
      ),
    );
  }).pipe(Effect.scoped);

const json = (response: Response) => Effect.promise(() => response.json() as Promise<unknown>);
const text = (response: Response) => Effect.promise(() => response.text());

/** 404 with nothing in it: what the relay says for a path it does not have. */
const expectHidden = (response: Response) =>
  Effect.gen(function* () {
    expect(response.status).toBe(404);
    expect(yield* text(response)).toBe("");
  });

describe("who may use the Connect admin routes", () => {
  it.effect("hides every route from everyone while no owner is set", () =>
    withAdmin({}, (call) =>
      Effect.gen(function* () {
        for (const route of ROUTES) {
          yield* expectHidden(yield* call(route, "owner-session"));
          yield* expectHidden(yield* call(route));
        }
        // The routes are off: no token was even looked at.
        expect(verifyToken).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect("hides every route from an empty owner list too", () =>
    withAdmin({ owners: [] }, (call) =>
      Effect.gen(function* () {
        for (const route of ROUTES) yield* expectHidden(yield* call(route, "owner-session"));
      }),
    ),
  );

  it.effect("lets a signed-in owner in on every route, and never caches the answer", () =>
    withAdmin({ owners: ["user_owner"] }, (call) =>
      Effect.gen(function* () {
        for (const route of ROUTES) {
          const response = yield* call(route, "owner-session");
          expect(response.status, route).toBe(200);
          expect(response.headers.get("cache-control")).toBe("no-store");
        }
        expect(yield* json(yield* call("/v1/admin/me", "owner-session"))).toEqual({
          userId: "user_owner",
        });
      }),
    ),
  );

  it.effect("hides every route from anyone who is not an owner", () =>
    withAdmin({ owners: ["user_owner"] }, (call) =>
      Effect.gen(function* () {
        for (const route of ROUTES) {
          // Another signed-in Connect user.
          yield* expectHidden(yield* call(route, "other-session"));
          // No token, a token Clerk does not know, a token for another app.
          yield* expectHidden(yield* call(route));
          yield* expectHidden(yield* call(route, "made-up-token"));
          yield* expectHidden(yield* call(route, "wrong-audience"));
          // An empty bearer, and the owner's token under a scheme the routes do not take.
          yield* expectHidden(yield* call(route, ""));
          yield* expectHidden(yield* call(route, "owner-session", "DPoP"));
          yield* expectHidden(yield* call(route, "owner-session", "Basic"));
        }
        // None of these guesses reached Clerk's API.
        expect(createClerkClient).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect("refuses the headless CLI's token even for the owner's account", () =>
    withAdmin({ owners: ["user_owner"] }, (call) =>
      Effect.gen(function* () {
        for (const route of ROUTES) yield* expectHidden(yield* call(route, "oat_owner_cli"));
        // Clerk would accept that token as the owner. The relay never asks: a
        // guess costs no Clerk call and takes no longer than an unknown path.
        expect(createClerkClient).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect("refuses an owner's session that was removed with a phone", () =>
    withAdmin({ owners: ["user_owner"], removedSessions: ["sess_phone"] }, (call) =>
      Effect.gen(function* () {
        yield* expectHidden(yield* call("/v1/admin/me", "owner-phone-session"));
        // The owner's other session still works.
        expect((yield* call("/v1/admin/me", "owner-session")).status).toBe(200);
      }),
    ),
  );

  it.effect("refuses a session it cannot check, and admits it once it can", () =>
    Effect.gen(function* () {
      for (const removalCheck of ["fails", "crashes"] as const) {
        yield* withAdmin({ owners: ["user_owner"], removalCheck }, (call) =>
          Effect.gen(function* () {
            for (const route of ROUTES) {
              yield* expectHidden(yield* call(route, "owner-phone-session"));
            }
          }),
        );
      }
      yield* withAdmin({ owners: ["user_owner"] }, (call) =>
        Effect.gen(function* () {
          expect((yield* call("/v1/admin/me", "owner-phone-session")).status).toBe(200);
        }),
      );
    }),
  );

  it.effect("hides the routes when Clerk itself throws, instead of answering 500", () =>
    withAdmin({ owners: ["user_owner"] }, (call) =>
      Effect.gen(function* () {
        vi.mocked(verifyToken).mockImplementation(() => {
          throw new Error("clerk sdk blew up");
        });
        vi.mocked(createClerkClient).mockImplementation(() => {
          throw new Error("clerk sdk blew up");
        });
        for (const route of ROUTES) yield* expectHidden(yield* call(route, "owner-session"));
      }),
    ),
  );

  it.effect("admits each listed owner and nobody else", () =>
    withAdmin({ owners: ["user_free", "user_someone"] }, (call) =>
      Effect.gen(function* () {
        expect((yield* call("/v1/admin/me", "other-session")).status).toBe(200);
        yield* expectHidden(yield* call("/v1/admin/me", "owner-session"));
      }),
    ),
  );
});

describe("what a Connect owner reads", () => {
  it.effect("totals across every account", () =>
    withAdmin({ owners: ["user_owner"] }, (call) =>
      Effect.gen(function* () {
        expect(yield* json(yield* call("/v1/admin/overview", "owner-session"))).toEqual({
          accounts: 5,
          linkedMachines: 4,
          tunnelsAllocated: 2,
          tunnelsReady: 1,
          phones: 2,
          founderSeatsGranted: 2,
          founderSeatCap: 300,
          freeMachineLimit: 3,
          globalTunnelCap: null,
        });
      }),
    ),
  );

  it.effect("the account list with who each account is", () =>
    withAdmin({ owners: ["user_owner"] }, (call) =>
      Effect.gen(function* () {
        const body = (yield* json(yield* call("/v1/admin/accounts", "owner-session"))) as {
          accounts: ReadonlyArray<Record<string, unknown>>;
          nextCursor: string | null;
          identities: string;
        };
        expect(body.identities).toBe("read");
        expect(body.nextCursor).toBeNull();
        expect(body.accounts.map((account) => [account.userId, account.email])).toEqual([
          ["user_key", null],
          ["user_phone", null],
          ["user_founder", null],
          ["user_free", "free@example.test"],
          ["user_owner", "owner@example.test"],
        ]);
        expect(body.accounts.at(-1)).toEqual({
          userId: "user_owner",
          email: "owner@example.test",
          name: "Owner Person",
          founderNumber: 1,
          limit: { maxMachines: null, source: "override" },
          machineCount: 2,
          phoneCount: 1,
          firstSeenAt: "2026-10-01T00:00:00.000Z",
          lastSeenAt: "2026-11-11T00:00:00.000Z",
        });
      }),
    ),
  );

  it.effect("the list with ids only when Clerk does not answer, never an error", () =>
    withAdmin(
      {
        owners: ["user_owner"],
        identities: {
          lookup: () =>
            Effect.fail(
              new AdminIdentities.AdminIdentityLookupFailed({ operation: "lookup", cause: "down" }),
            ),
        },
      },
      (call) =>
        Effect.gen(function* () {
          const response = yield* call("/v1/admin/accounts", "owner-session");
          expect(response.status).toBe(200);
          const body = (yield* json(response)) as {
            accounts: ReadonlyArray<{ userId: string; email: unknown; name: unknown }>;
            identities: string;
          };
          expect(body.identities).toBe("unavailable");
          expect(body.accounts).toHaveLength(5);
          expect(body.accounts.every((a) => a.email === null && a.name === null)).toBe(true);
        }),
    ),
  );

  it.effect("an account found by its id, or by an email Clerk resolves", () => {
    const searched: Array<string> = [];
    return withAdmin(
      {
        owners: ["user_owner"],
        identities: {
          search: (query) => {
            searched.push(query);
            return Effect.succeed({
              userIds: query === "free@example.test" ? ["user_free"] : [],
              truncated: false,
            });
          },
        },
      },
      (call) =>
        Effect.gen(function* () {
          const found = (path: string) =>
            call(path, "owner-session").pipe(
              Effect.flatMap(json),
              Effect.map((body) =>
                (body as { accounts: ReadonlyArray<{ userId: string }> }).accounts.map(
                  (account) => account.userId,
                ),
              ),
            );
          expect(yield* found("/v1/admin/accounts?query=user_founder")).toEqual(["user_founder"]);
          // An id is matched by the relay; Clerk is not asked.
          expect(searched).toEqual([]);
          expect(yield* found("/v1/admin/accounts?query=%20free%40example.test%20")).toEqual([
            "user_free",
          ]);
          expect(searched).toEqual(["free@example.test"]);
          expect(yield* found("/v1/admin/accounts?query=nobody%40example.test")).toEqual([]);
          expect(yield* found("/v1/admin/accounts?query=user_nobody")).toEqual([]);
          // An email that only starts like an id is still an email.
          searched.length = 0;
          yield* found("/v1/admin/accounts?query=user_free%40example.test");
          expect(searched).toEqual(["user_free@example.test"]);
        }),
    );
  });

  it.effect("that a search matched more people than it read", () =>
    Effect.gen(function* () {
      const truncated = (path: string, clerkHasMore: boolean) =>
        withAdmin(
          {
            owners: ["user_owner"],
            identities: {
              search: () => Effect.succeed({ userIds: ["user_free"], truncated: clerkHasMore }),
            },
          },
          (call) =>
            call(path, "owner-session").pipe(
              Effect.flatMap(json),
              Effect.map((body) => (body as { searchTruncated: boolean }).searchTruncated),
            ),
        );
      expect(yield* truncated("/v1/admin/accounts?query=example.test", true)).toBe(true);
      expect(yield* truncated("/v1/admin/accounts?query=example.test", false)).toBe(false);
      // A plain list and a search by id never read Clerk's search.
      expect(yield* truncated("/v1/admin/accounts", true)).toBe(false);
      expect(yield* truncated("/v1/admin/accounts?query=user_free", true)).toBe(false);
    }),
  );

  it.effect("a clear failure, not an empty list, when a search cannot reach Clerk", () =>
    withAdmin(
      {
        owners: ["user_owner"],
        identities: {
          search: () =>
            Effect.fail(
              new AdminIdentities.AdminIdentityLookupFailed({ operation: "search", cause: "down" }),
            ),
        },
      },
      (call) =>
        Effect.gen(function* () {
          const response = yield* call("/v1/admin/accounts?query=someone", "owner-session");
          expect(response.status).toBe(503);
          expect(yield* json(response)).toMatchObject({
            _tag: "RelayAdminUnavailableError",
            reason: "identity_lookup_failed",
          });
        }),
    ),
  );

  it.effect("one account's machines with Cloudflare's live reading, and its phones", () => {
    const asked: Array<string> = [];
    return withAdmin(
      {
        owners: ["user_owner"],
        tunnels: {
          get: (tunnelId) => {
            asked.push(tunnelId);
            return Effect.succeed({
              id: tunnelId,
              status: "down",
              connsInactiveAt: "2026-11-10T00:00:00.000Z",
            });
          },
        },
      },
      (call) =>
        Effect.gen(function* () {
          const body = (yield* json(
            yield* call("/v1/admin/accounts/user_owner", "owner-session"),
          )) as {
            account: Record<string, unknown>;
            machines: ReadonlyArray<Record<string, unknown>>;
            phones: ReadonlyArray<Record<string, unknown>>;
          };
          expect(body.account).toMatchObject({
            userId: "user_owner",
            email: "owner@example.test",
            limit: { maxMachines: null, source: "override" },
          });
          expect(body.machines).toEqual([
            {
              environmentId: "m1",
              label: "M1",
              hostname: "prod-m1.tunnels.example.test",
              linkedAt: "2026-10-02T00:00:00.000Z",
              updatedAt: "2026-10-02T00:00:00.000Z",
              unlinkedAt: null,
              tunnel: "released",
              live: "unknown",
              liveChangedAt: null,
            },
            {
              environmentId: "m4",
              label: "M4 Max",
              hostname: "prod-m4.tunnels.example.test",
              linkedAt: "2026-10-01T00:00:00.000Z",
              updatedAt: "2026-10-01T00:00:00.000Z",
              unlinkedAt: null,
              tunnel: "ready",
              live: "down",
              liveChangedAt: "2026-11-10T00:00:00.000Z",
            },
            {
              environmentId: "old",
              label: "Old laptop",
              hostname: null,
              linkedAt: "2026-10-03T00:00:00.000Z",
              updatedAt: "2026-10-20T00:00:00.000Z",
              unlinkedAt: "2026-10-20T00:00:00.000Z",
              tunnel: "none",
              live: "unknown",
              liveChangedAt: null,
            },
          ]);
          // Only a tunnel that exists at Cloudflare is read there.
          expect(asked).toEqual(["tunnel-m4"]);
          expect(body.phones).toEqual([
            {
              deviceId: "iphone-16",
              label: "Anton's iPhone",
              platform: "ios",
              model: "iPhone17,3",
              appVersion: "0.1.1",
              lastSeenAt: "2026-11-11T00:00:00.000Z",
            },
          ]);
        }),
    );
  });

  it.effect("live readings for a bounded number of machines, the rest unknown", () => {
    const asked: Array<string> = [];
    const machines = Array.from({ length: ConnectAdmin.ADMIN_TUNNEL_STATUS_MAX + 5 }, (_, n) => ({
      id: `fleet-${String(n).padStart(2, "0")}`,
      at: `2026-11-01T00:${String(n).padStart(2, "0")}:00.000Z`,
    }));
    return withAdmin(
      {
        owners: ["user_owner"],
        tunnels: {
          get: (tunnelId) => {
            asked.push(tunnelId);
            return Effect.succeed({ id: tunnelId, status: "healthy" });
          },
        },
        seed: Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          yield* db
            .insert(relayEnvironmentLinks)
            .values(machines.map(({ id, at }) => adminLink("user_fleet", id, id, at)));
          yield* db
            .insert(relayManagedEndpointAllocations)
            .values(
              machines.map(({ id, at }) => adminAllocation("user_fleet", id, at, { readyAt: at })),
            );
        }).pipe(Effect.orDie),
      },
      (call) =>
        Effect.gen(function* () {
          const response = yield* call("/v1/admin/accounts/user_fleet", "owner-session");
          expect(response.status).toBe(200);
          const body = (yield* json(response)) as {
            machines: ReadonlyArray<{ live: string }>;
          };
          expect(body.machines).toHaveLength(machines.length);
          expect(asked).toHaveLength(ConnectAdmin.ADMIN_TUNNEL_STATUS_MAX);
          expect(body.machines.filter((machine) => machine.live === "healthy")).toHaveLength(
            ConnectAdmin.ADMIN_TUNNEL_STATUS_MAX,
          );
          expect(body.machines.filter((machine) => machine.live === "unknown")).toHaveLength(5);
        }),
    );
  });

  it.effect("machines as unknown when Cloudflare fails or reports a state it does not name", () =>
    Effect.gen(function* () {
      const live = (tunnels: NonNullable<World["tunnels"]>) =>
        withAdmin({ owners: ["user_owner"], tunnels }, (call) =>
          call("/v1/admin/accounts/user_founder", "owner-session").pipe(
            Effect.flatMap((response) => {
              expect(response.status).toBe(200);
              return json(response);
            }),
            Effect.map(
              (body) => (body as { machines: ReadonlyArray<{ live: string }> }).machines[0]?.live,
            ),
          ),
        );
      expect(
        yield* live({
          get: (tunnelId) =>
            Effect.fail(
              new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
                operation: "get",
                tunnelId,
                cause: "cloudflare down",
              }),
            ),
        }),
      ).toBe("unknown");
      expect(yield* live({ get: () => Effect.succeed({ status: "brand-new-state" }) })).toBe(
        "unknown",
      );
      expect(yield* live({ get: () => Effect.succeed({ status: null }) })).toBe("unknown");
      expect(yield* live({ get: () => Effect.succeed({ status: "degraded" }) })).toBe("degraded");
    }),
  );

  it.effect("a plain 'no such account' for an id the relay never saw", () =>
    withAdmin({ owners: ["user_owner"] }, (call) =>
      Effect.gen(function* () {
        const response = yield* call("/v1/admin/accounts/user_nobody", "owner-session");
        expect(response.status).toBe(404);
        expect(yield* json(response)).toEqual({
          _tag: "RelayAdminAccountNotFoundError",
          code: "account_not_found",
        });
      }),
    ),
  );
});

describe("what nobody else learns about the Connect admin routes", () => {
  it("the public API description does not list them", () => {
    const described = JSON.stringify(OpenApi.fromApi(RelayApi));
    expect(described).toContain("/v1/client/environment-links");
    expect(described).not.toContain("/v1/admin");
    expect(described).not.toContain("Owner-only");
  });

  it.effect("a search's email or name stays out of the request trace", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      let handled = "";
      const handler = Effect.gen(function* () {
        handled = (yield* HttpServerRequest.HttpServerRequest).url;
        return HttpServerResponse.empty({ status: 204 });
      });
      yield* traceRelayHttpRequestWith(handler, Layer.succeed(Tracer.Tracer, tracer)).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("https://relay.test/v1/admin/accounts?query=alice%40example.test"),
          ),
        ),
      );
      // The route still gets the search it was sent.
      expect(handled).toContain("alice%40example.test");
      expect(spans[0]?.attributes.get("url.path")).toBe("/v1/admin/accounts");
      const recorded = JSON.stringify(spans.map((span) => [...span.attributes.entries()]));
      expect(recorded).not.toContain("alice");
    }),
  );
});

describe("what a Connect owner never reads", () => {
  /** Field names that would carry a key, a credential or a session. */
  const FORBIDDEN_FIELD = /key|credential|token|thumbprint|session|secret|hash|password/iu;

  const fieldNames = (value: unknown, found: Set<string> = new Set()): Set<string> => {
    if (Array.isArray(value)) {
      for (const entry of value) fieldNames(entry, found);
    } else if (typeof value === "object" && value !== null) {
      for (const [name, entry] of Object.entries(value)) {
        found.add(name);
        fieldNames(entry, found);
      }
    }
    return found;
  };

  it.effect("a key, credential, push token or session of any account", () =>
    withAdmin({ owners: ["user_owner"] }, (call) =>
      Effect.gen(function* () {
        const routes = [
          "/v1/admin/overview",
          "/v1/admin/accounts",
          "/v1/admin/accounts/user_owner",
          "/v1/admin/accounts/user_founder",
          "/v1/admin/accounts/user_phone",
          "/v1/admin/accounts/user_key",
        ];
        for (const route of routes) {
          const response = yield* call(route, "owner-session");
          expect(response.status, route).toBe(200);
          const raw = yield* text(response);
          // The seeded secrets sit in rows these routes read from.
          expect(raw, route).not.toContain("SECRET-");
          for (const secret of Object.values(ADMIN_SECRETS)) expect(raw).not.toContain(secret);
          // Cloudflare's tunnel id stays inside the relay.
          expect(raw, route).not.toContain("tunnel-m4");
          expect(raw, route).not.toContain("tunnel-studio");
          const forbidden = [...fieldNames(JSON.parse(raw))].filter((name) =>
            FORBIDDEN_FIELD.test(name),
          );
          expect(forbidden, route).toEqual([]);
        }
      }),
    ),
  );
});
