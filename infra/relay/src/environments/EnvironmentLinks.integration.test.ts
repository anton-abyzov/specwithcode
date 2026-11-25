import type {
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkRequest,
} from "@specweave-studio/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import { relayEnvironmentLinks } from "../persistence/schema.ts";
import { layerSqliteRelayDb } from "../testing/sqliteD1.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";

// EnvironmentLinks on a real SQLite D1: what the stored rows look like after
// a machine links under one account and then under another.

const request: RelayEnvironmentLinkRequest = {
  proof: "unused",
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
  managedTunnelsEnabled: true,
};

const proof = (environmentPublicKey: string) =>
  ({
    iss: "studio-env:env-1",
    aud: "https://relay.example.test",
    sub: "env-1",
    jti: "jti",
    iat: 0,
    exp: 60,
    challenge: "challenge",
    environmentId: "env-1" as RelayEnvironmentLinkProofPayload["environmentId"],
    descriptor: {
      environmentId: "env-1" as RelayEnvironmentLinkProofPayload["environmentId"],
      label: "Desk machine",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
    environmentPublicKey,
    endpoint: {
      httpBaseUrl: "https://env.example.test/",
      wsBaseUrl: "wss://env.example.test/",
      providerKind: "cloudflare_tunnel",
    },
    origin: { localHttpHost: "127.0.0.1", localHttpPort: 8319 },
    scopes: ["agent_activity_notifications", "managed_tunnels"],
  }) satisfies RelayEnvironmentLinkProofPayload;

const link = (userId: string, environmentPublicKey: string) =>
  Effect.gen(function* () {
    const links = yield* EnvironmentLinks.EnvironmentLinks;
    const verified = proof(environmentPublicKey);
    yield* links.upsert({ userId, request, proof: verified, endpoint: verified.endpoint });
  });

const rows = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const all = yield* db
    .select({
      userId: relayEnvironmentLinks.userId,
      environmentPublicKey: relayEnvironmentLinks.environmentPublicKey,
      revokedAt: relayEnvironmentLinks.revokedAt,
    })
    .from(relayEnvironmentLinks)
    .where(eq(relayEnvironmentLinks.environmentId, "env-1"));
  return Object.fromEntries(all.map((row) => [row.userId, row]));
});

const layer = EnvironmentLinks.layer.pipe(Layer.provideMerge(layerSqliteRelayDb()));

describe("EnvironmentLinks on SQLite D1", () => {
  it.effect("revokes the previous account's link when the machine links under another", () =>
    Effect.gen(function* () {
      yield* link("user-a", "key-1");
      yield* link("user-b", "key-1");
      const stored = yield* rows;
      expect(stored["user-a"]?.revokedAt).not.toBeNull();
      expect(stored["user-b"]?.revokedAt).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps another account's link that a different key proved", () =>
    Effect.gen(function* () {
      yield* link("user-a", "key-1");
      yield* link("user-b", "key-2");
      const stored = yield* rows;
      expect(stored["user-a"]?.revokedAt).toBeNull();
      expect(stored["user-b"]?.revokedAt).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps the link active when the same account links again", () =>
    Effect.gen(function* () {
      yield* link("user-a", "key-1");
      yield* link("user-a", "key-1");
      const stored = yield* rows;
      expect(stored["user-a"]?.revokedAt).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  // The linker reads the stored key before it writes. Two links racing past
  // that read must not let the second key overwrite an active link, so the
  // write itself checks the key.
  it.effect("refuses to move an active link to another key in the write itself", () =>
    Effect.gen(function* () {
      yield* link("user-a", "key-1");
      yield* link("user-b", "key-2");
      const exit = yield* Effect.exit(link("user-a", "key-2"));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("EnvironmentLinkKeyConflict");
      const stored = yield* rows;
      expect(stored["user-a"]).toMatchObject({ environmentPublicKey: "key-1", revokedAt: null });
      // A refused write ends nothing: the other account's key-2 link stays.
      expect(stored["user-b"]?.revokedAt).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("relinks a revoked link under a new key", () =>
    Effect.gen(function* () {
      yield* link("user-a", "key-1");
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      yield* links.revokeForUser({ userId: "user-a", environmentId: "env-1" });
      yield* link("user-a", "key-2");
      const stored = yield* rows;
      expect(stored["user-a"]).toMatchObject({ environmentPublicKey: "key-2", revokedAt: null });
    }).pipe(Effect.provide(layer)),
  );
});
