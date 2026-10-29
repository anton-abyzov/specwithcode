import { describe, expect, it } from "@effect/vitest";
import { and, eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SQLiteDialect } from "drizzle-orm/sqlite-core";

import * as RelayDb from "../db.ts";
import {
  relayAccountDeletions,
  relayEnvironmentLinks,
  relayManagedEndpointAllocations,
} from "../persistence/schema.ts";
import { layerSqliteRelayDb } from "../testing/sqliteD1.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";

const layerWithDb = (db: RelayDb.RelayDb["Service"]) =>
  ManagedEndpointAllocations.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db)));

describe("ManagedEndpointAllocations", () => {
  it.effect("clears endpoint readiness and recovery only when the recorded tunnel changes", () => {
    let updated:
      | {
          readonly tunnelId: string;
          readonly readyAt: unknown;
          readonly recoveryEnabledAt: unknown;
          readonly recoveryEnvironmentPublicKey: unknown;
          readonly tunnelReleasedAt: unknown;
        }
      | undefined;
    const fakeDb = {
      update: (table: unknown) => {
        expect(table).toBe(relayManagedEndpointAllocations);
        return {
          set: (values: {
            readonly tunnelId: string;
            readonly readyAt: unknown;
            readonly recoveryEnabledAt: unknown;
            readonly recoveryEnvironmentPublicKey: unknown;
            readonly tunnelReleasedAt: unknown;
          }) => {
            updated = values;
            return {
              where: () => ({
                returning: () => Effect.succeed([{ generation: 8 }]),
              }),
            };
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      expect(
        yield* allocations.recordTunnel({
          userId: "user-1",
          environmentId: "environment-1",
          tunnelId: "replacement-tunnel",
          generation: 7,
        }),
      ).toBe(8);
      expect(updated?.tunnelId).toBe("replacement-tunnel");
      // Any recorded tunnel ends a released state, so status stops reporting it.
      expect(updated?.tunnelReleasedAt).toBeNull();
      const query = new SQLiteDialect().sqlToQuery(updated?.readyAt as never);
      expect(query.sql).toBe(
        'case when "relay_managed_endpoint_allocations"."tunnel_id" = ? then "relay_managed_endpoint_allocations"."ready_at" else null end',
      );
      expect(query.params).toEqual(["replacement-tunnel"]);
      for (const [column, value] of [
        ["recovery_enabled_at", updated?.recoveryEnabledAt],
        ["recovery_environment_public_key", updated?.recoveryEnvironmentPublicKey],
      ] as const) {
        const recoveryQuery = new SQLiteDialect().sqlToQuery(value as never);
        expect(recoveryQuery.sql).toBe(
          `case when "relay_managed_endpoint_allocations"."tunnel_id" = ? then "relay_managed_endpoint_allocations"."${column}" else null end`,
        );
        expect(recoveryQuery.params).toEqual(["replacement-tunnel"]);
      }
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("records recovery support and advances the allocation generation", () => {
    let updated:
      | {
          readonly recoveryEnabledAt: string;
          readonly recoveryEnvironmentPublicKey: string;
          readonly updatedAt: string;
        }
      | undefined;
    let condition: unknown;
    const fakeDb = {
      update: (table: unknown) => {
        expect(table).toBe(relayManagedEndpointAllocations);
        return {
          set: (values: {
            readonly recoveryEnabledAt: string;
            readonly recoveryEnvironmentPublicKey: string;
            readonly updatedAt: string;
          }) => {
            updated = values;
            return {
              where: (where: unknown) => {
                condition = where;
                return {
                  returning: () => Effect.succeed([{ environmentId: "environment-1" }]),
                };
              },
            };
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      expect(
        yield* allocations.enableRecovery({
          userId: "user-1",
          environmentId: "environment-1",
          tunnelId: "tunnel-1",
          environmentPublicKey: "public-key",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 8319 },
        }),
      ).toBe(true);

      expect(updated?.recoveryEnabledAt).toBe(updated?.updatedAt);
      expect(updated?.recoveryEnabledAt).toBeDefined();
      expect(updated?.recoveryEnvironmentPublicKey).toBe("public-key");
      const query = new SQLiteDialect().sqlToQuery(condition as never);
      expect(query.sql).toContain('"relay_managed_endpoint_allocations"."tunnel_id"');
      expect(query.sql).toContain('"relay_environment_links"."environment_public_key"');
      expect(query.sql).toContain('"relay_environment_links"."endpoint_provider_kind"');
      expect(query.sql).toContain('"relay_environment_links"."revoked_at" is null');
      expect(query.sql).toContain(
        'json_extract("relay_managed_endpoint_allocations"."origin", \'$.localHttpPort\') = ?',
      );
      expect(query.params).toContain(8319);
      expect(query.params).toContain("tunnel-1");
      expect(query.params).toContain("public-key");
      expect(query.params).toContain("cloudflare_tunnel");
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("rejects recovery when the tunnel or active link no longer matches", () => {
    const fakeDb = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => Effect.succeed([]),
          }),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      expect(
        yield* allocations.enableRecovery({
          userId: "user-1",
          environmentId: "environment-1",
          tunnelId: "missing-tunnel",
          environmentPublicKey: "public-key",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 8319 },
        }),
      ).toBe(false);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("returns recovery support with tunnel allocation lookups", () => {
    const base = {
      userId: "user-1",
      hostname: "environment.example.test",
      tunnelName: "managed-tunnel",
      dnsRecordId: "dns-1",
      readyAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
      generation: 1,
    };
    const fakeDb = {
      select: () => ({
        from: (table: unknown) => {
          expect(table).toBe(relayManagedEndpointAllocations);
          return {
            leftJoin: () => ({
              where: () =>
                Effect.succeed([
                  {
                    ...base,
                    environmentId: "environment-1",
                    tunnelId: "tunnel-1",
                    recoveryEnabledAt: "2026-08-25T12:00:00.000Z",
                    recoveryEnvironmentPublicKey: "current-key",
                    linkedEnvironmentPublicKey: "current-key",
                  },
                  {
                    ...base,
                    environmentId: "environment-2",
                    tunnelId: "tunnel-2",
                    recoveryEnabledAt: null,
                    recoveryEnvironmentPublicKey: null,
                    linkedEnvironmentPublicKey: "current-key",
                  },
                  {
                    ...base,
                    environmentId: "environment-3",
                    tunnelId: "tunnel-3",
                    recoveryEnabledAt: "2026-08-25T12:00:00.000Z",
                    recoveryEnvironmentPublicKey: "old-key",
                    linkedEnvironmentPublicKey: "new-key",
                  },
                ]),
            }),
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const result = yield* allocations.listByTunnelNames([
        "first-tunnel",
        "second-tunnel",
        "third-tunnel",
      ]);

      expect(result.map((entry) => [entry.tunnelId, entry.recoveryEnabled])).toEqual([
        ["tunnel-1", true],
        ["tunnel-2", false],
        ["tunnel-3", false],
      ]);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("skips the database for an empty tunnel lookup", () =>
    Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      expect(yield* allocations.listByTunnelNames([])).toEqual([]);
    }).pipe(Effect.provide(layerWithDb({} as RelayDb.RelayDb["Service"]))),
  );

  it.effect("splits large tunnel lookups into bounded database queries", () => {
    const batchSizes: number[] = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          leftJoin: () => ({
            where: (condition: unknown) => {
              batchSizes.push(new SQLiteDialect().sqlToQuery(condition as never).params.length);
              return Effect.succeed([]);
            },
          }),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const names = Array.from({ length: 1_001 }, (_, index) => `tunnel-${index}`);
      expect(yield* allocations.listByTunnelNames(names)).toEqual([]);
      expect(batchSizes).toEqual([...Array.from({ length: 10 }, () => 100), 1]);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect.each([
    { markReleased: true, released: true },
    { markReleased: undefined, released: false },
  ] as const)(
    "marks the tunnel released only for the claim that deletes it ($markReleased)",
    ({ markReleased, released }) => {
      let updated: Record<string, unknown> | undefined;
      const fakeDb = {
        update: () => ({
          set: (values: Record<string, unknown>) => {
            updated = values;
            return {
              where: () => ({ returning: () => Effect.succeed([{ generation: 4 }]) }),
            };
          },
        }),
      } as unknown as RelayDb.RelayDb["Service"];

      return Effect.gen(function* () {
        const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
        yield* allocations.claimRelease({
          userId: "user-1",
          environmentId: "environment-1",
          tunnelId: "tunnel-1",
          generation: 3,
          ...(markReleased === undefined ? {} : { markReleased }),
        });
        expect(typeof updated?.tunnelReleasedAt === "string").toBe(released);
      }).pipe(Effect.provide(layerWithDb(fakeDb)));
    },
  );

  it.effect("returns a claim generation only when deprovision wins the allocation CAS", () => {
    const fakeDb = {
      update: (table: unknown) => {
        expect(table).toBe(relayManagedEndpointAllocations);
        return {
          set: (_values: { readonly updatedAt: string }) => {
            return {
              where: () => ({
                returning: () => Effect.succeed([{ generation: 8 }]),
              }),
            };
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const generation = yield* allocations.claimDeprovision({
        userId: "user-1",
        environmentId: "environment-1",
        generation: 7,
      });

      expect(generation).toBe(8);
      expect(generation).not.toBeNull();
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect.each([
    { generation: 7, expected: ["select", "delete"], result: true },
    { generation: 6, expected: ["select"], result: null },
  ] as const)(
    "runs the tunnel delete only for the current generation ($generation)",
    (testCase) => {
      const operations: string[] = [];
      const fakeDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () =>
                Effect.sync(() => {
                  operations.push("select");
                  return testCase.generation === 7 ? [{ generation: 7 }] : [];
                }),
            }),
          }),
        }),
      } as unknown as RelayDb.RelayDb["Service"];

      return Effect.gen(function* () {
        const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
        const result = yield* allocations.withClaimedTunnel(
          {
            userId: "user-1",
            environmentId: "environment-1",
            tunnelId: "tunnel-1",
            generation: testCase.generation,
          },
          Effect.sync(() => {
            operations.push("delete");
            return true;
          }),
        );

        expect(Option.getOrNull(result)).toBe(testCase.result);
        expect(operations).toEqual(testCase.expected);
      }).pipe(Effect.provide(layerWithDb(fakeDb)));
    },
  );

  it.effect("does not remove an allocation superseded after a deprovision claim", () => {
    const fakeDb = {
      delete: (table: unknown) => {
        expect(table).toBe(relayManagedEndpointAllocations);
        return {
          where: () => ({
            returning: () => Effect.succeed([]),
          }),
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      expect(
        yield* allocations.removeClaimed({
          userId: "user-1",
          environmentId: "environment-1",
          generation: 7,
        }),
      ).toBe(false);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("retains database failures with allocation operation and identity", () => {
    const cause = new Error("database unavailable");
    const fakeDb = {
      select: () => ({
        from: (table: unknown) => {
          expect(table).toBe(relayManagedEndpointAllocations);
          return {
            where: () => ({
              limit: () => Effect.fail(cause),
            }),
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const error = yield* Effect.flip(
        allocations.get({ userId: "user-1", environmentId: "environment-1" }),
      );

      expect(error).toMatchObject({
        _tag: "ManagedEndpointAllocationPersistenceError",
        operation: "get",
        stage: "database-request",
        userId: "user-1",
        environmentId: "environment-1",
      });
      expect(error.cause).toBe(cause);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("reports an unresolved reservation without manufacturing a cause", () => {
    const fakeDb = {
      insert: (table: unknown) => {
        expect(table).toBe(relayManagedEndpointAllocations);
        return {
          values: () => ({
            onConflictDoNothing: () => Effect.succeed([]),
          }),
        };
      },
      select: () => ({
        from: (table: unknown) => {
          expect(table).toBe(relayManagedEndpointAllocations);
          return {
            where: () => ({
              limit: () => Effect.succeed([]),
            }),
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const error = yield* Effect.flip(
        allocations.reserve({
          userId: "user-1",
          environmentId: "environment-1",
          hostname: "environment-1.example.test",
          tunnelName: "environment-1-tunnel",
        }),
      );

      expect(error).toMatchObject({
        _tag: "ManagedEndpointAllocationPersistenceError",
        operation: "reserve",
        stage: "resolve-reservation",
        userId: "user-1",
        environmentId: "environment-1",
        hostname: "environment-1.example.test",
        tunnelName: "environment-1-tunnel",
      });
      expect(error.cause).toBeUndefined();
      expect(error.message).toContain("'resolve-reservation'");
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });
});

describe("ManagedEndpointAllocations capacity", () => {
  const now = "2026-10-28T00:00:00.000Z";
  const layer = () =>
    ManagedEndpointAllocations.layer.pipe(Layer.provideMerge(layerSqliteRelayDb()));

  const link = (
    userId: string,
    environmentId: string,
    options: { readonly revoked?: boolean; readonly managed?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      const db = yield* RelayDb.RelayDb;
      yield* db.insert(relayEnvironmentLinks).values({
        userId,
        environmentId,
        environmentPublicKey: `key-${environmentId}`,
        endpointHttpBaseUrl: "https://env.example.test",
        endpointWsBaseUrl: "wss://env.example.test",
        endpointProviderKind: "cloudflare_tunnel",
        managedTunnelsEnabled: options.managed ?? true,
        revokedAt: options.revoked === true ? now : null,
        createdAt: now,
        updatedAt: now,
      });
    });

  const reserve = (
    userId: string,
    environmentId: string,
    capacity?: ManagedEndpointAllocations.ManagedEndpointAllocationCapacity,
  ) =>
    Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      return yield* allocations.reserve({
        userId,
        environmentId,
        hostname: `${userId}-${environmentId}.example.test`,
        tunnelName: `tunnel-${userId}-${environmentId}`,
        ...(capacity === undefined ? {} : { capacity }),
      });
    });

  /** Reserves and links, the way a successful managed link ends. */
  const linked = (
    userId: string,
    environmentId: string,
    capacity: ManagedEndpointAllocations.ManagedEndpointAllocationCapacity,
  ) =>
    Effect.gen(function* () {
      yield* reserve(userId, environmentId, capacity);
      yield* link(userId, environmentId);
    });

  it.effect("refuses a new machine at the account limit and keeps existing ones", () =>
    Effect.gen(function* () {
      const capacity = { maxTunnels: 2 };
      yield* linked("user-1", "env-1", capacity);
      yield* linked("user-1", "env-2", capacity);

      const error = yield* Effect.flip(reserve("user-1", "env-3", capacity));
      expect(error).toMatchObject({
        _tag: "ManagedTunnelLimitExceeded",
        reason: "account_limit",
        userId: "user-1",
        environmentId: "env-3",
        maxTunnels: 2,
        activeTunnels: 2,
      });

      // Re-linking an allocated machine at the limit stays idempotent.
      const again = yield* reserve("user-1", "env-2", capacity);
      expect(again.environmentId).toBe("env-2");
      // Other accounts are unaffected.
      yield* reserve("user-2", "env-1", capacity);
    }).pipe(Effect.provide(layer())),
  );

  /** Moves an allocation's last activity out of the in-flight window. */
  const age = (
    userId: string,
    environmentId: string,
    values: { readonly dnsRecordId?: string } = {},
  ) =>
    Effect.gen(function* () {
      const db = yield* RelayDb.RelayDb;
      yield* db
        .update(relayManagedEndpointAllocations)
        .set({ updatedAt: "1900-01-01T00:00:00.000Z", ...values })
        .where(
          and(
            eq(relayManagedEndpointAllocations.userId, userId),
            eq(relayManagedEndpointAllocations.environmentId, environmentId),
          ),
        );
    });

  it.effect("frees a slot when a link is revoked and counts machines still provisioning", () =>
    Effect.gen(function* () {
      const capacity = { maxTunnels: 2 };
      yield* reserve("user-1", "env-pending", capacity);
      yield* reserve("user-1", "env-revoked", capacity);
      yield* link("user-1", "env-revoked", { revoked: true });
      yield* age("user-1", "env-revoked");

      // env-pending has no link yet but holds a slot; env-revoked does not.
      yield* reserve("user-1", "env-2", capacity);
      const error = yield* Effect.flip(reserve("user-1", "env-3", capacity));
      expect(error).toMatchObject({ reason: "account_limit", activeTunnels: 2 });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("stops counting an allocation a failed link left behind", () =>
    Effect.gen(function* () {
      const capacity = { maxTunnels: 2, globalCap: 2 };
      yield* linked("user-1", "env-1", capacity);
      // A first link of env-orphan failed after reserve: no link row.
      yield* reserve("user-1", "env-orphan", capacity);
      const refused = yield* Effect.flip(reserve("user-1", "env-new", capacity));
      expect(refused).toMatchObject({ reason: "account_limit", activeTunnels: 2 });

      // Once out of the in-flight window it no longer holds a slot.
      yield* age("user-1", "env-orphan");
      yield* reserve("user-1", "env-new", capacity);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("stops counting a publish-only link's allocation for the account", () =>
    Effect.gen(function* () {
      const capacity = { maxTunnels: 1 };
      yield* reserve("user-1", "env-1", capacity);
      // Downgraded to publish-only and its teardown failed.
      yield* link("user-1", "env-1", { managed: false });
      yield* age("user-1", "env-1");
      yield* reserve("user-1", "env-2", capacity);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("counts an allocation that still holds a DNS record toward the global cap only", () =>
    Effect.gen(function* () {
      yield* reserve("user-1", "env-orphan", { maxTunnels: 1, globalCap: 2 });
      yield* age("user-1", "env-orphan", { dnsRecordId: "dns-1" });
      yield* linked("user-2", "env-1", { maxTunnels: 1, globalCap: 2 });

      const error = yield* Effect.flip(reserve("user-3", "env-1", { maxTunnels: 1, globalCap: 2 }));
      expect(error).toMatchObject({ reason: "service_capacity", globalActiveTunnels: 2 });
      // The record does not hold user-1's own account slot.
      yield* reserve("user-1", "env-new", { maxTunnels: 1 });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("checks the caps again when an unlinked machine whose teardown failed re-links", () =>
    Effect.gen(function* () {
      const capacity = { maxTunnels: 1, globalCap: 2 };
      yield* linked("user-a", "env-x", capacity);
      // A unlinks X; the link is revoked and the deprovision fails.
      const db = yield* RelayDb.RelayDb;
      yield* db
        .update(relayEnvironmentLinks)
        .set({ revokedAt: now })
        .where(eq(relayEnvironmentLinks.environmentId, "env-x"));
      yield* age("user-a", "env-x");
      // B takes the freed global slot, and A links a second machine.
      yield* linked("user-b", "env-y", capacity);
      yield* linked("user-a", "env-z", capacity);

      // Re-linking X now would exceed A's limit.
      const accountError = yield* Effect.flip(reserve("user-a", "env-x", capacity));
      expect(accountError).toMatchObject({ reason: "account_limit", activeTunnels: 1 });

      // With room on the account, the global cap still refuses it.
      const globalError = yield* Effect.flip(
        reserve("user-a", "env-x", { maxTunnels: 5, globalCap: 2 }),
      );
      expect(globalError).toMatchObject({ reason: "service_capacity", globalActiveTunnels: 2 });

      // With room on both, it re-claims its slot and counts as in flight.
      const resumed = yield* reserve("user-a", "env-x", { maxTunnels: 5, globalCap: 3 });
      expect(resumed.environmentId).toBe("env-x");
      const refused = yield* Effect.flip(
        reserve("user-c", "env-1", { maxTunnels: 5, globalCap: 3 }),
      );
      expect(refused).toMatchObject({ reason: "service_capacity", globalActiveTunnels: 3 });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("creates no allocation once the account's deletion has started", () =>
    Effect.gen(function* () {
      const db = yield* RelayDb.RelayDb;
      yield* db.insert(relayAccountDeletions).values({ userId: "user-1", startedAt: now });
      const error = yield* Effect.flip(reserve("user-1", "env-1", { maxTunnels: 3 }));
      expect(error._tag).toBe("ManagedEndpointAllocationPersistenceError");
      expect(yield* db.select().from(relayManagedEndpointAllocations)).toEqual([]);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("stops new machines at the global cap with service_capacity", () =>
    Effect.gen(function* () {
      const capacity = { maxTunnels: 10, globalCap: 2 };
      yield* linked("user-1", "env-1", capacity);
      yield* linked("user-2", "env-1", capacity);

      const error = yield* Effect.flip(reserve("user-3", "env-1", capacity));
      expect(error).toMatchObject({
        _tag: "ManagedTunnelLimitExceeded",
        reason: "service_capacity",
        userId: "user-3",
        maxTunnels: 10,
        activeTunnels: 0,
        globalCap: 2,
        globalActiveTunnels: 2,
      });
      // Already allocated machines keep working.
      expect((yield* reserve("user-1", "env-1", capacity)).userId).toBe("user-1");
      // Without a global cap there is no global limit.
      yield* reserve("user-3", "env-1", { maxTunnels: 10 });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("lets an unlimited account past its count but not past the global cap", () =>
    Effect.gen(function* () {
      const capacity = { maxTunnels: null, globalCap: 3 };
      yield* linked("owner", "env-1", capacity);
      yield* linked("owner", "env-2", capacity);
      yield* linked("owner", "env-3", capacity);

      const error = yield* Effect.flip(reserve("owner", "env-4", capacity));
      expect(error).toMatchObject({
        _tag: "ManagedTunnelLimitExceeded",
        reason: "service_capacity",
        maxTunnels: 3,
        activeTunnels: 3,
        globalCap: 3,
        globalActiveTunnels: 3,
      });
      // Without a global cap an unlimited account has no count limit at all.
      yield* reserve("owner", "env-4", { maxTunnels: null });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("reports account_limit when both caps are reached", () =>
    Effect.gen(function* () {
      yield* linked("user-1", "env-1", { maxTunnels: 1, globalCap: 1 });
      const error = yield* Effect.flip(reserve("user-1", "env-2", { maxTunnels: 1, globalCap: 1 }));
      expect(error).toMatchObject({ reason: "account_limit" });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("never exceeds the account limit under concurrent links", () =>
    Effect.gen(function* () {
      const capacity = { maxTunnels: 3 };
      const results = yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => `env-${index}`),
        (environmentId) => Effect.result(reserve("user-1", environmentId, capacity)),
        { concurrency: "unbounded" },
      );
      const succeeded = results.filter((result) => result._tag === "Success");
      const refused = results.filter(
        (result) =>
          result._tag === "Failure" && result.failure._tag === "ManagedTunnelLimitExceeded",
      );
      expect(succeeded).toHaveLength(3);
      expect(refused).toHaveLength(17);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("never exceeds the global cap under concurrent links", () =>
    Effect.gen(function* () {
      const capacity = { maxTunnels: 3, globalCap: 5 };
      const results = yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => `user-${index}`),
        (userId) => Effect.result(reserve(userId, "env-1", capacity)),
        { concurrency: "unbounded" },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(5);
      const db = yield* RelayDb.RelayDb;
      const rows = yield* db.select().from(relayManagedEndpointAllocations);
      expect(rows).toHaveLength(5);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("reserves without capacity checks when none is given", () =>
    Effect.gen(function* () {
      const first = yield* reserve("user-1", "env-1");
      const second = yield* reserve("user-1", "env-1");
      expect(second).toEqual(first);
      expect(first).toMatchObject({ tunnelId: null, generation: 0, readyAt: null });
    }).pipe(Effect.provide(layer())),
  );
});
