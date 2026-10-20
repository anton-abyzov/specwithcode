import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { sql } from "drizzle-orm";

import * as AccountDeletion from "../account/AccountDeletion.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayDb from "../db.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "../environments/ManagedEndpointAllocations.ts";
import { relayDpopProofs, relayEnvironmentCredentials, relayEnvironmentLinks } from "./schema.ts";
import { layerSqliteRelayDb, makeSqliteD1 } from "../testing/sqliteD1.ts";

const now = "2026-10-20T00:00:00.000Z";
const origin = { localHttpHost: "127.0.0.1", localHttpPort: 3773 };

const layer = () => {
  const dbLayer = layerSqliteRelayDb();
  return Layer.mergeAll(
    ManagedEndpointAllocations.layer,
    EnvironmentLinks.layer,
    DpopProofs.layer,
    AccountDeletion.layerAccountRecords,
  ).pipe(Layer.provideMerge(dbLayer));
};

const insertLink = (input: {
  readonly userId: string;
  readonly environmentId?: string;
  readonly publicKey?: string;
  readonly providerKind?: string;
}) =>
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    yield* db.insert(relayEnvironmentLinks).values({
      userId: input.userId,
      environmentId: input.environmentId ?? "env-1",
      environmentPublicKey: input.publicKey ?? "key-1",
      endpointHttpBaseUrl: "https://env.example.test",
      endpointWsBaseUrl: "wss://env.example.test",
      endpointProviderKind: input.providerKind ?? "cloudflare_tunnel",
      createdAt: now,
      updatedAt: now,
    });
  });

const insertCredential = (credentialId: string, publicKey = "key-1") =>
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    yield* db.insert(relayEnvironmentCredentials).values({
      credentialId,
      environmentId: "env-1",
      environmentPublicKey: publicKey,
      credentialHash: `hash-${credentialId}`,
      createdAt: now,
      updatedAt: now,
    });
  });

const activeCredentialIds = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const rows = yield* db
    .select({ id: relayEnvironmentCredentials.credentialId })
    .from(relayEnvironmentCredentials)
    .where(sql`${relayEnvironmentCredentials.revokedAt} is null`);
  return rows.map((row) => row.id).sort();
});

/** Reserves an allocation and records a tunnel; returns the generation after recording. */
const provision = (userId = "user-1") =>
  Effect.gen(function* () {
    const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
    const reserved = yield* allocations.reserve({
      userId,
      environmentId: "env-1",
      hostname: `${userId}.relay.example.test`,
      tunnelName: `tunnel-${userId}`,
    });
    const generation = yield* allocations.recordTunnel({
      userId,
      environmentId: "env-1",
      tunnelId: "tunnel-id-1",
      generation: reserved.generation,
    });
    expect(generation).not.toBeNull();
    return generation!;
  });

describe("relay persistence on SQLite (D1)", () => {
  it.effect("rejects a replayed DPoP proof", () =>
    Effect.gen(function* () {
      const replay = yield* DpopProofs.DpopProofReplay;
      const proof = {
        thumbprint: "thumb",
        jti: "jti-1",
        iat: 1_000,
        expiresAt: DateTime.makeUnsafe(now),
      };
      expect(yield* replay.consume(proof)).toBe(true);
      expect(yield* replay.consume(proof)).toBe(false);
      expect(yield* replay.consume({ ...proof, jti: "jti-2" })).toBe(true);
      const db = yield* RelayDb.RelayDb;
      expect(yield* db.select().from(relayDpopProofs)).toHaveLength(2);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("guards release and deprovision claims with the allocation generation", () =>
    Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const key = { userId: "user-1", environmentId: "env-1" };
      const generation = yield* provision();

      const stale = yield* allocations.claimRelease({
        ...key,
        tunnelId: "tunnel-id-1",
        generation: generation - 1,
      });
      expect(stale).toBeNull();

      const claimed = yield* allocations.claimRelease({
        ...key,
        tunnelId: "tunnel-id-1",
        generation,
      });
      expect(claimed).not.toBeNull();
      // The first claim bumped the generation, so replaying it loses.
      expect(
        yield* allocations.claimRelease({ ...key, tunnelId: "tunnel-id-1", generation }),
      ).toBeNull();

      expect(yield* allocations.claimDeprovision({ ...key, generation })).toBeNull();
      const deprovision = yield* allocations.claimDeprovision({ ...key, generation: claimed! });
      expect(deprovision).not.toBeNull();
      expect(yield* allocations.removeClaimed({ ...key, generation: claimed! })).toBe(false);
      expect(yield* allocations.removeClaimed({ ...key, generation: deprovision! })).toBe(true);
      expect(yield* allocations.get(key)).toBeNull();
    }).pipe(Effect.provide(layer())),
  );

  it.effect("runs the claimed tunnel effect only for the current generation", () =>
    Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const key = { userId: "user-1", environmentId: "env-1", tunnelId: "tunnel-id-1" };
      const generation = yield* provision();
      let runs = 0;
      const work = Effect.sync(() => ++runs);

      expect(
        yield* allocations.withClaimedTunnel({ ...key, generation: generation + 1 }, work),
      ).toEqual(Option.none());
      expect(yield* allocations.withClaimedTunnel({ ...key, generation }, work)).toEqual(
        Option.some(1),
      );
      expect(runs).toBe(1);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("enables recovery only for an active tunnel link with the same origin", () =>
    Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const key = { userId: "user-1", environmentId: "env-1", tunnelId: "tunnel-id-1" };
      const generation = yield* provision();
      expect(yield* allocations.markReady({ ...key, generation, origin })).toBe(true);
      const recovery = { ...key, environmentPublicKey: "key-1", origin };

      // No active link yet.
      expect(yield* allocations.enableRecovery(recovery)).toBe(false);
      yield* insertLink({ userId: "user-1" });
      expect(
        yield* allocations.enableRecovery({
          ...recovery,
          origin: { ...origin, localHttpPort: origin.localHttpPort + 1 },
        }),
      ).toBe(false);
      expect(
        yield* allocations.enableRecovery({ ...recovery, environmentPublicKey: "other" }),
      ).toBe(false);
      expect(yield* allocations.enableRecovery(recovery)).toBe(true);

      expect(yield* links.revokeForUser({ userId: "user-1", environmentId: "env-1" })).toBe(true);
      expect(yield* allocations.enableRecovery(recovery)).toBe(false);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("revokes the link and its unused credentials in one batch", () =>
    Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      yield* insertLink({ userId: "user-1" });
      yield* insertLink({ userId: "user-2" });
      yield* insertCredential("cred-1");
      yield* insertCredential("cred-other-key", "key-2");

      const revoke = (userId: string) =>
        links.revokeForUser({ userId, environmentId: "env-1", environmentPublicKey: "key-1" });

      // user-2 still links the key, so its credentials stay active.
      expect(yield* revoke("user-1")).toBe(true);
      expect(yield* activeCredentialIds).toEqual(["cred-1", "cred-other-key"]);
      // A repeated unlink changes nothing.
      expect(yield* revoke("user-1")).toBe(false);
      expect(yield* activeCredentialIds).toEqual(["cred-1", "cred-other-key"]);

      expect(yield* revoke("user-2")).toBe(true);
      expect(yield* activeCredentialIds).toEqual(["cred-other-key"]);

      // A credential created after the last unlink is not revoked by a replay.
      yield* insertCredential("cred-2");
      expect(yield* revoke("user-2")).toBe(false);
      expect(yield* activeCredentialIds).toEqual(["cred-2", "cred-other-key"]);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("deletes every account row in one batch", () =>
    Effect.gen(function* () {
      const records = yield* AccountDeletion.AccountRecords;
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      yield* insertLink({ userId: "user-1" });
      yield* insertLink({ userId: "user-2" });
      yield* provision();

      yield* records.deleteUserRows({ userId: "user-1" });

      const db = yield* RelayDb.RelayDb;
      const linkUsers = yield* db
        .select({ userId: relayEnvironmentLinks.userId })
        .from(relayEnvironmentLinks);
      expect(linkUsers).toEqual([{ userId: "user-2" }]);
      // Allocations are torn down by deprovisioning, not by the row delete.
      expect(yield* allocations.get({ userId: "user-1", environmentId: "env-1" })).not.toBeNull();
    }).pipe(Effect.provide(layer())),
  );

  it.effect("rolls back a batch when one statement fails", () =>
    Effect.gen(function* () {
      const db = yield* RelayDb.RelayDb;
      const proof = { thumbprint: "t", jti: "j", iat: 1, expiresAt: now, createdAt: now };
      const result = yield* RelayDb.batch(db, [
        db.insert(relayDpopProofs).values({ ...proof, jti: "first" }),
        db.insert(relayDpopProofs).values(proof),
        db.insert(relayDpopProofs).values(proof),
      ]).pipe(Effect.flip);
      expect(result._tag).toBe("SqlError");
      expect(yield* db.select().from(relayDpopProofs)).toEqual([]);
    }).pipe(Effect.provide(layerSqliteRelayDb(makeSqliteD1().d1))),
  );
});
