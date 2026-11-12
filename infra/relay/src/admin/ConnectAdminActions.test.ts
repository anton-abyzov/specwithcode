import { createClerkClient, verifyToken } from "@clerk/backend";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { RelayApi } from "@specweave-studio/contracts/relay";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as OpenApi from "effect/http-api/OpenApi";
import { beforeEach, vi } from "vite-plus/test";

import * as PhoneRemovals from "../agentActivity/PhoneRemovals.ts";
import * as ClerkSessions from "../auth/ClerkSessions.ts";
import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as ClientKeyRevocations from "../environments/ClientKeyRevocations.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import { clearClerkOAuthVerificationCache } from "../http/ClerkBearer.ts";
import { relayAdminActions } from "../persistence/schema.ts";
import {
  ADMIN_SECRETS,
  adminTestConfig,
  seedConnectAdmin,
} from "../testing/connectAdminFixtures.ts";
import { layerSqliteRelayDb, makeSqliteD1 } from "../testing/sqliteD1.ts";
import * as AdminIdentities from "./AdminIdentities.ts";
import * as ConnectAdmin from "./ConnectAdmin.ts";
import * as ConnectAdminActions from "./ConnectAdminActions.ts";
import * as ConnectAdminQueries from "./ConnectAdminQueries.ts";

vi.mock("@clerk/backend", () => ({
  createClerkClient: vi.fn(),
  verifyToken: vi.fn(),
}));

const AUDIENCE = "studio-code-relay";
const SESSIONS: Record<string, { sub: string; aud: string }> = {
  "owner-session": { sub: "user_owner", aud: AUDIENCE },
  "other-session": { sub: "user_free", aud: AUDIENCE },
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
});

/**
 * What user_free has with no owner setting: founder seats are still open in the
 * seed, so its next link would take one and the founder limit applies.
 */
const SEEDED_DEFAULT = { maxMachines: 10, source: "founder" };

const ACTIONS = "/v1/admin/actions";
const limitOf = (userId: string) => `/v1/admin/accounts/${userId}/machine-limit`;
const unlinkOf = (userId: string, environmentId: string) =>
  `/v1/admin/accounts/${userId}/machines/${environmentId}/unlink`;
const removeOf = (userId: string, deviceId: string) =>
  `/v1/admin/accounts/${userId}/phones/${deviceId}/remove`;

/**
 * The tunnel fields are read when a request runs, so a test can change them
 * between two requests. `owners` is read once, when the relay is built.
 */
interface World {
  owners?: ReadonlyArray<string>;
  /** Cloudflare refuses to take the tunnel down. */
  deprovisionFails?: boolean;
  /** Cloudflare never answers. */
  deprovisionHangs?: boolean;
  /** Runs while the tunnel teardown is under way. */
  onDeprovision?: Effect.Effect<void>;
}

interface Outside {
  /** Tunnel teardowns asked of Cloudflare, as `user/environment`. */
  readonly deprovisioned: Array<string>;
  /** Clerk sessions the relay ended. */
  readonly revokedSessions: Array<string>;
  /** Accounts whose machines were told to drop a phone's keys. */
  readonly notified: Array<string>;
}

type Call = (
  path: string,
  token?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Effect.Effect<Response>;

/** Both admin groups over a seeded relay database; Clerk and Cloudflare stood in. */
const withActions = <A, E>(
  world: World,
  use: (
    call: Call,
    outside: Outside,
    database: <B, F>(run: Effect.Effect<B, F, RelayDb.RelayDb>) => Effect.Effect<B, F>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const layerDb = layerSqliteRelayDb(makeSqliteD1().d1);
    yield* seedConnectAdmin.pipe(Effect.provide(layerDb));
    const outside: Outside = { deprovisioned: [], revokedSessions: [], notified: [] };
    const layerBase = Layer.mergeAll(
      layerDb,
      NodeCryptoLayer.layer,
      RelayConfiguration.layer(adminTestConfig({ adminUserIds: world.owners ?? ["user_owner"] })),
    );
    const layerServices = Layer.mergeAll(
      ConnectAdminQueries.layer,
      ConnectAdminActions.layerLog,
      EnvironmentLinks.layer,
      PhoneRemovals.layer,
      Layer.mock(AdminIdentities.AdminIdentities, {
        lookup: () => Effect.succeed(new Map()),
        search: () => Effect.succeed({ userIds: [], truncated: false }),
      }),
      Layer.mock(ManagedEndpointProvider.ManagedEndpointTunnelClient, {
        get: (tunnelId) => Effect.succeed({ id: tunnelId, status: "healthy" }),
      }),
      Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {
        prepareDeprovision: () => Effect.succeed(null),
        deprovision: (input) =>
          Effect.gen(function* () {
            if (world.onDeprovision) yield* world.onDeprovision;
            if (world.deprovisionHangs) return yield* Effect.never;
            if (world.deprovisionFails) {
              return yield* new ManagedEndpointProvider.ManagedEndpointDeprovisioningFailed({
                userId: input.userId,
                environmentId: input.environmentId,
                cause: "cloudflare down",
              } as never);
            }
            outside.deprovisioned.push(`${input.userId}/${input.environmentId}`);
            return true;
          }),
      }),
      Layer.mock(HookInbox.HookInbox, { clear: () => Effect.void }),
      Layer.mock(ClerkSessions.ClerkSessions, {
        revoke: (sessionId) => Effect.sync(() => void outside.revokedSessions.push(sessionId)),
      }),
      Layer.mock(ClientKeyRevocations.ClientKeyRevocations, {
        notify: (input) => Effect.sync(() => void outside.notified.push(input.userId)),
      }),
    ).pipe(Layer.provideMerge(layerBase));
    const app = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(
            HttpApi.make("RelayApi").add(RelayApi.groups.admin).add(RelayApi.groups.adminActions),
          ).pipe(
            Layer.provide(ConnectAdmin.layerApi),
            // The actions reuse the account routes' own unlink and phone removal,
            // which ask for their services while a request runs.
            Layer.provide(
              ConnectAdminActions.layerApi.pipe(HttpRouter.provideRequest(layerServices)),
            ),
            Layer.provide(ConnectAdmin.layerAdminAuth),
            Layer.provide(layerServices),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      ),
      (handler) => Effect.promise(() => handler.dispose()),
    );
    const call: Call = (path, token, body, signal) =>
      Effect.promise(() =>
        app.handler(
          new Request(`https://relay.example.test${path}`, {
            method:
              path === ACTIONS || !path.match(/(machine-limit|unlink|remove)$/u) ? "GET" : "POST",
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            ...(signal === undefined ? {} : { signal }),
            headers: {
              ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
          }),
        ),
      );
    return yield* use(call, outside, (run) => run.pipe(Effect.provide(layerDb)));
  }).pipe(Effect.scoped);

const json = <A = Record<string, unknown>>(response: Response) =>
  Effect.promise(() => response.json() as Promise<A>);
const text = (response: Response) => Effect.promise(() => response.text());

interface RecordedAction {
  readonly id: string;
  readonly ownerUserId: string;
  readonly action: string;
  readonly targetUserId: string;
  readonly targetId: string | null;
  readonly targetLabel: string | null;
  readonly limitBefore: unknown;
  readonly limitSet: unknown;
  readonly outcome: string;
  readonly createdAt: string;
}

const actionsOf = (call: Call) =>
  Effect.gen(function* () {
    const response = yield* call(ACTIONS, "owner-session");
    expect(response.status).toBe(200);
    return (yield* json<{ actions: ReadonlyArray<RecordedAction> }>(response)).actions;
  });

const accountOf = (call: Call, userId: string) =>
  Effect.gen(function* () {
    const response = yield* call(`/v1/admin/accounts/${userId}`, "owner-session");
    expect(response.status).toBe(200);
    return yield* json<{
      account: { limit: unknown };
      machines: ReadonlyArray<{ environmentId: string; unlinkedAt: string | null }>;
      phones: ReadonlyArray<{ deviceId: string }>;
    }>(response);
  });

/** The action record table is gone: no record can be written. */
const breakRecords = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  yield* db.run(sql`DROP TABLE relay_admin_actions`).pipe(Effect.orDie);
});

const POSTS: ReadonlyArray<readonly [string, unknown]> = [
  [limitOf("user_free"), { limit: { kind: "limited", maxMachines: 5 } }],
  [unlinkOf("user_owner", "m4"), undefined],
  [removeOf("user_owner", "iphone-16"), undefined],
];

describe("who may change a Connect account", () => {
  it.effect("nobody but an owner: every action route is an empty 404 and changes nothing", () =>
    withActions({}, (call, outside) =>
      Effect.gen(function* () {
        for (const token of ["other-session", "made-up-token", undefined]) {
          for (const [path, body] of [...POSTS, [ACTIONS, undefined] as const]) {
            const response = yield* call(path, token, body);
            expect(response.status, path).toBe(404);
            expect(yield* text(response), path).toBe("");
          }
        }
        expect(yield* actionsOf(call)).toEqual([]);
        expect(outside).toEqual({ deprovisioned: [], revokedSessions: [], notified: [] });
        expect((yield* accountOf(call, "user_free")).account.limit).toEqual(SEEDED_DEFAULT);
      }),
    ),
  );

  it.effect("nobody at all while no owner is set", () =>
    withActions({ owners: [] }, (call, outside) =>
      Effect.gen(function* () {
        for (const [path, body] of POSTS) {
          expect((yield* call(path, "owner-session", body)).status, path).toBe(404);
        }
        expect(outside.deprovisioned).toEqual([]);
      }),
    ),
  );

  it("the public API description does not list the action routes", () => {
    const described = JSON.stringify(OpenApi.fromApi(RelayApi));
    expect(described).not.toContain("/v1/admin");
    expect(described).not.toContain("Owner-only");
  });
});

describe("changing one account's machine limit", () => {
  it.effect("sets a number, lifts the limit and goes back to the default, recording each", () =>
    withActions({}, (call) =>
      Effect.gen(function* () {
        const set = yield* call(limitOf("user_free"), "owner-session", {
          limit: { kind: "limited", maxMachines: 5 },
        });
        expect(set.status).toBe(200);
        expect(set.headers.get("cache-control")).toBe("no-store");
        expect(yield* json(set)).toEqual({ limit: { maxMachines: 5, source: "override" } });
        // Changed in place: a second setting replaces the first.
        const zero = yield* call(limitOf("user_free"), "owner-session", {
          limit: { kind: "limited", maxMachines: 0 },
        });
        expect(yield* json(zero)).toEqual({ limit: { maxMachines: 0, source: "override" } });
        const lifted = yield* call(limitOf("user_free"), "owner-session", {
          limit: { kind: "unlimited" },
        });
        expect(yield* json(lifted)).toEqual({ limit: { maxMachines: null, source: "override" } });
        const reset = yield* call(limitOf("user_free"), "owner-session", {
          limit: { kind: "default" },
        });
        expect(yield* json(reset)).toEqual({ limit: SEEDED_DEFAULT });
        expect((yield* accountOf(call, "user_free")).account.limit).toEqual(SEEDED_DEFAULT);

        const actions = yield* actionsOf(call);
        expect(actions).toHaveLength(4);
        expect(new Set(actions.map((action) => action.id)).size).toBe(4);
        for (const action of actions) {
          expect(action).toMatchObject({
            ownerUserId: "user_owner",
            action: "set_machine_limit",
            targetUserId: "user_free",
            targetId: null,
            targetLabel: null,
            outcome: "done",
          });
          expect(Number.isNaN(Date.parse(action.createdAt))).toBe(false);
        }
        expect(
          actions
            .map((action) => [action.limitBefore, action.limitSet])
            .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        ).toEqual(
          [
            [SEEDED_DEFAULT, { kind: "limited", maxMachines: 5 }],
            [
              { maxMachines: 5, source: "override" },
              { kind: "limited", maxMachines: 0 },
            ],
            [{ maxMachines: 0, source: "override" }, { kind: "unlimited" }],
            [{ maxMachines: null, source: "override" }, { kind: "default" }],
          ].toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        );
      }),
    ),
  );

  it.effect("leaves the machines an account already linked", () =>
    withActions({}, (call, outside) =>
      Effect.gen(function* () {
        // user_owner has two linked machines and no account limit.
        const set = yield* call(limitOf("user_owner"), "owner-session", {
          limit: { kind: "limited", maxMachines: 0 },
        });
        expect(set.status).toBe(200);
        const linked = (yield* accountOf(call, "user_owner")).machines.filter(
          (machine) => machine.unlinkedAt === null,
        );
        expect(linked.map((machine) => machine.environmentId).toSorted()).toEqual(["m1", "m4"]);
        expect(outside.deprovisioned).toEqual([]);
      }),
    ),
  );

  it.effect("refuses a limit outside 0 to 1000 and anything that is not a setting", () =>
    withActions({}, (call) =>
      Effect.gen(function* () {
        const refused: ReadonlyArray<unknown> = [
          { limit: { kind: "limited", maxMachines: 1001 } },
          { limit: { kind: "limited", maxMachines: -1 } },
          { limit: { kind: "limited", maxMachines: 1.5 } },
          { limit: { kind: "limited", maxMachines: "5" } },
          { limit: { kind: "limited" } },
          { limit: { kind: "forever" } },
          { limit: 5 },
          {},
        ];
        for (const body of refused) {
          const response = yield* call(limitOf("user_free"), "owner-session", body);
          expect(response.status, JSON.stringify(body)).toBe(400);
        }
        const most = yield* call(limitOf("user_free"), "owner-session", {
          limit: { kind: "limited", maxMachines: 1000 },
        });
        expect(most.status).toBe(200);
        expect(yield* actionsOf(call)).toHaveLength(1);
      }),
    ),
  );

  it.effect("has nothing to set for an id the relay never saw", () =>
    withActions({}, (call) =>
      Effect.gen(function* () {
        const response = yield* call(limitOf("user_nobody"), "owner-session", {
          limit: { kind: "unlimited" },
        });
        expect(response.status).toBe(404);
        expect(yield* json(response)).toEqual({
          _tag: "RelayAdminAccountNotFoundError",
          code: "account_not_found",
        });
        expect(yield* actionsOf(call)).toEqual([]);
      }),
    ),
  );

  it.effect("does not change the limit when the record cannot be written", () =>
    withActions({}, (call, _outside, database) =>
      Effect.gen(function* () {
        yield* database(breakRecords);
        const response = yield* call(limitOf("user_free"), "owner-session", {
          limit: { kind: "limited", maxMachines: 50 },
        });
        expect(response.status).toBe(503);
        expect(yield* json(response)).toMatchObject({
          _tag: "RelayAdminUnavailableError",
          reason: "record_failed",
        });
        expect((yield* accountOf(call, "user_free")).account.limit).toEqual(SEEDED_DEFAULT);
      }),
    ),
  );

  it.effect("writes neither the record nor the limit when the limit cannot be written", () =>
    withActions({}, (call, _outside, database) =>
      Effect.gen(function* () {
        // The record is the first statement of the batch and succeeds; the limit then fails.
        yield* database(
          Effect.gen(function* () {
            const db = yield* RelayDb.RelayDb;
            yield* db
              .run(
                sql`CREATE TRIGGER refuse_limits BEFORE INSERT ON relay_managed_tunnel_limits BEGIN SELECT RAISE(ABORT, 'refused'); END`,
              )
              .pipe(Effect.orDie);
          }),
        );
        const response = yield* call(limitOf("user_free"), "owner-session", {
          limit: { kind: "limited", maxMachines: 50 },
        });
        expect(response.status).toBe(503);
        expect(yield* actionsOf(call)).toEqual([]);
        expect((yield* accountOf(call, "user_free")).account.limit).toEqual(SEEDED_DEFAULT);
      }),
    ),
  );

  it.effect("hides the route from a non-owner whatever the body says", () =>
    withActions({}, (call) =>
      Effect.gen(function* () {
        const response = yield* call(limitOf("user_free"), "other-session", { limit: "junk" });
        expect(response.status).toBe(404);
        expect(yield* text(response)).toBe("");
      }),
    ),
  );
});

describe("unlinking one machine of one account", () => {
  it.effect("does the account's own unlink and records it", () =>
    withActions({}, (call, outside) =>
      Effect.gen(function* () {
        const response = yield* call(unlinkOf("user_owner", "m4"), "owner-session");
        expect(response.status).toBe(200);
        expect(yield* json(response)).toEqual({ unlinked: true });
        const machines = (yield* accountOf(call, "user_owner")).machines;
        expect(
          machines.find((machine) => machine.environmentId === "m4")?.unlinkedAt,
        ).not.toBeNull();
        // The other machine of the account stays linked.
        expect(machines.find((machine) => machine.environmentId === "m1")?.unlinkedAt).toBeNull();
        // The tunnel was released for the account acted on, not for the owner who acted.
        expect(outside.deprovisioned).toEqual(["user_owner/m4"]);
        expect(yield* actionsOf(call)).toMatchObject([
          {
            ownerUserId: "user_owner",
            action: "unlink_machine",
            targetUserId: "user_owner",
            targetId: "m4",
            targetLabel: "M4 Max",
            limitBefore: null,
            limitSet: null,
            outcome: "done",
          },
        ]);
      }),
    ),
  );

  it.effect("acts on the account named in the path, also when it is not the owner's", () =>
    withActions({}, (call, outside) =>
      Effect.gen(function* () {
        expect((yield* call(unlinkOf("user_founder", "studio"), "owner-session")).status).toBe(200);
        expect(outside.deprovisioned).toEqual(["user_founder/studio"]);
        expect(
          (yield* accountOf(call, "user_founder")).machines.map((machine) => machine.unlinkedAt),
        ).not.toContain(null);
        // The owner's own machines are untouched.
        const own = (yield* accountOf(call, "user_owner")).machines;
        expect(own.filter((machine) => machine.unlinkedAt === null)).toHaveLength(2);
      }),
    ),
  );

  it.effect("has nothing to unlink for a machine that is not linked to that account", () =>
    withActions({}, (call, outside) =>
      Effect.gen(function* () {
        const paths = [
          // Already unlinked, another account's machine, and a made-up id.
          unlinkOf("user_owner", "old"),
          unlinkOf("user_free", "m4"),
          unlinkOf("user_owner", "nope"),
        ];
        for (const path of paths) {
          const response = yield* call(path, "owner-session");
          expect(response.status, path).toBe(404);
          expect(yield* json(response)).toEqual({
            _tag: "RelayAdminTargetNotFoundError",
            code: "target_not_found",
            target: "machine",
          });
        }
        const missing = yield* call(unlinkOf("user_nobody", "m4"), "owner-session");
        expect(yield* json(missing)).toMatchObject({ code: "account_not_found" });
        expect(outside.deprovisioned).toEqual([]);
        expect(yield* actionsOf(call)).toEqual([]);
      }),
    ),
  );

  it.effect("does not unlink when the record cannot be written", () =>
    withActions({}, (call, outside, database) =>
      Effect.gen(function* () {
        yield* database(breakRecords);
        const response = yield* call(unlinkOf("user_owner", "m4"), "owner-session");
        expect(response.status).toBe(503);
        expect(yield* json(response)).toMatchObject({ reason: "record_failed" });
        expect(outside.deprovisioned).toEqual([]);
        const machines = (yield* accountOf(call, "user_owner")).machines;
        expect(machines.find((machine) => machine.environmentId === "m4")?.unlinkedAt).toBeNull();
      }),
    ),
  );

  it.effect("records an unlink that failed part way and says it failed", () =>
    withActions({ deprovisionFails: true }, (call) =>
      Effect.gen(function* () {
        const response = yield* call(unlinkOf("user_owner", "m4"), "owner-session");
        expect(response.status).toBe(503);
        expect(yield* json(response)).toMatchObject({
          _tag: "RelayAdminUnavailableError",
          reason: "action_failed",
        });
        expect(yield* actionsOf(call)).toMatchObject([
          { action: "unlink_machine", targetId: "m4", outcome: "failed" },
        ]);
      }),
    ),
  );

  it.effect("finishes an unlink whose tunnel teardown failed when it is sent again", () => {
    const world: World = { deprovisionFails: true };
    return withActions(world, (call, outside) =>
      Effect.gen(function* () {
        expect((yield* call(unlinkOf("user_owner", "m4"), "owner-session")).status).toBe(503);
        const afterFailure = yield* accountOf(call, "user_owner");
        expect(
          afterFailure.machines.find((machine) => machine.environmentId === "m4")?.unlinkedAt,
        ).not.toBeNull();
        expect(outside.deprovisioned).toEqual([]);

        world.deprovisionFails = false;
        const again = yield* call(unlinkOf("user_owner", "m4"), "owner-session");
        expect(again.status).toBe(200);
        // The link was already revoked; this time the tunnel came down.
        expect(yield* json(again)).toEqual({ unlinked: false });
        expect(outside.deprovisioned).toContain("user_owner/m4");
        expect((yield* actionsOf(call)).map((action) => action.outcome)).toEqual([
          "done",
          "failed",
        ]);
      }),
    );
  });

  it.effect("has the record in place, as started, before the machine is touched", () => {
    const world: World = {};
    const seen: Array<ReadonlyArray<string>> = [];
    return withActions(world, (call, _outside, database) =>
      Effect.gen(function* () {
        world.onDeprovision = database(
          Effect.gen(function* () {
            const db = yield* RelayDb.RelayDb;
            const rows = yield* db
              .select({ outcome: relayAdminActions.outcome })
              .from(relayAdminActions)
              .pipe(Effect.orDie);
            seen.push(rows.map((row) => row.outcome));
          }),
        );
        expect((yield* call(unlinkOf("user_owner", "m4"), "owner-session")).status).toBe(200);
        expect(seen[0]).toEqual(["started"]);
        expect((yield* actionsOf(call)).map((action) => action.outcome)).toEqual(["done"]);
      }),
    );
  });

  it.effect("records an unlink that was cut off part way as failed, not left as started", () => {
    const cutOff = new AbortController();
    const world: World = {
      deprovisionHangs: true,
      onDeprovision: Effect.sync(() => cutOff.abort()),
    };
    return withActions(world, (call) =>
      Effect.gen(function* () {
        yield* call(unlinkOf("user_owner", "m4"), "owner-session", undefined, cutOff.signal);
        expect((yield* actionsOf(call)).map((action) => action.outcome)).toEqual(["failed"]);
      }),
    );
  });
});

describe("removing one phone of one account", () => {
  it.effect("does the account's own Remove phone and records it", () =>
    withActions({}, (call, outside) =>
      Effect.gen(function* () {
        const response = yield* call(removeOf("user_owner", "iphone-16"), "owner-session");
        expect(response.status).toBe(200);
        expect(yield* json(response)).toEqual({ removed: true });
        expect((yield* accountOf(call, "user_owner")).phones).toEqual([]);
        // The phone's Clerk session is ended and the account's machines are told.
        expect(outside.revokedSessions).toEqual([ADMIN_SECRETS.clerkSessionId]);
        expect(outside.notified).toEqual(["user_owner"]);
        expect(yield* actionsOf(call)).toMatchObject([
          {
            ownerUserId: "user_owner",
            action: "remove_phone",
            targetUserId: "user_owner",
            targetId: "iphone-16",
            targetLabel: "Anton's iPhone",
            outcome: "done",
          },
        ]);
      }),
    ),
  );

  it.effect("has nothing to remove for a phone that account does not have", () =>
    withActions({}, (call, outside) =>
      Effect.gen(function* () {
        for (const path of [removeOf("user_owner", "pixel"), removeOf("user_free", "iphone-16")]) {
          const response = yield* call(path, "owner-session");
          expect(response.status, path).toBe(404);
          expect(yield* json(response)).toEqual({
            _tag: "RelayAdminTargetNotFoundError",
            code: "target_not_found",
            target: "phone",
          });
        }
        expect(outside.revokedSessions).toEqual([]);
        expect((yield* accountOf(call, "user_owner")).phones).toHaveLength(1);
        expect(yield* actionsOf(call)).toEqual([]);
      }),
    ),
  );

  it.effect("does not remove the phone when the record cannot be written", () =>
    withActions({}, (call, outside, database) =>
      Effect.gen(function* () {
        yield* database(breakRecords);
        const response = yield* call(removeOf("user_owner", "iphone-16"), "owner-session");
        expect(response.status).toBe(503);
        expect(outside.revokedSessions).toEqual([]);
        expect((yield* accountOf(call, "user_owner")).phones).toHaveLength(1);
      }),
    ),
  );
});

describe("the list of recorded actions", () => {
  it.effect("shows the newest 100 first and carries no key, credential or session", () =>
    withActions({}, (call, _outside, database) =>
      Effect.gen(function* () {
        yield* database(
          Effect.gen(function* () {
            const db = yield* RelayDb.RelayDb;
            yield* db
              .insert(relayAdminActions)
              .values(
                Array.from({ length: 120 }, (_, index) => ({
                  id: `seed-${String(index).padStart(3, "0")}`,
                  ownerUserId: "user_owner",
                  action: index === 119 ? "something_newer_code_wrote" : "unlink_machine",
                  targetUserId: "user_free",
                  targetId: `machine-${index}`,
                  targetLabel: `Machine ${index}`,
                  beforeJson: null,
                  afterJson: null,
                  outcome: "done",
                  createdAt: `2026-10-01T0${Math.floor(index / 60)}:${String(index % 60).padStart(2, "0")}:00.000Z`,
                })),
              )
              .pipe(Effect.orDie);
          }),
        );
        yield* call(removeOf("user_owner", "iphone-16"), "owner-session");
        const response = yield* call(ACTIONS, "owner-session");
        const raw = yield* text(response);
        const { actions } = JSON.parse(raw) as { actions: ReadonlyArray<RecordedAction> };
        // 100 rows are read; the one this code cannot name is left out, not guessed at.
        expect(actions).toHaveLength(99);
        expect(actions[0]).toMatchObject({ action: "remove_phone", targetId: "iphone-16" });
        expect(actions[1]?.targetId).toBe("machine-118");
        expect(actions.map((action) => action.createdAt)).toEqual(
          actions
            .map((action) => action.createdAt)
            .toSorted()
            .toReversed(),
        );
        expect(raw).not.toContain("SECRET-");
        expect(raw).not.toMatch(/key|credential|token|thumbprint|session|secret|hash|password/iu);
      }),
    ),
  );
});
