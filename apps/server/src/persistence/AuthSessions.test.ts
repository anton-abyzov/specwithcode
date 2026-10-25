import { AuthSessionId, EnvironmentId } from "@specweave-studio/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as AuthSessions from "./AuthSessions.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const issuedAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const expiresAt = DateTime.makeUnsafe("2026-02-01T00:00:00.000Z");
const renewedUntil = DateTime.makeUnsafe("2026-11-01T00:00:00.000Z");
const original = {
  sessionId: AuthSessionId.make("original-worker"),
  principal: { kind: "coordinator", environmentId: EnvironmentId.make("coordinator") },
  subject: "mcp-client",
  method: "bearer-access-token",
  scopes: ["orchestration:read", "orchestration:operate"],
  client: {
    label: "SpecWithCode workers · coordinator",
    deviceType: "bot",
    ipAddress: null,
    userAgent: null,
    os: null,
    browser: null,
  },
  issuedAt,
  expiresAt,
} as const;
const renewal = { ...original, expiresAt: renewedUntil };
const layer = AuthSessions.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

it.layer(Layer.empty)("conditional worker session renewal", (it) => {
  it.effect("renews an expired row in place and preserves its identity and metadata", () =>
    Effect.gen(function* () {
      const repository = yield* AuthSessions.AuthSessionRepository;
      yield* repository.create(original);
      expect(yield* repository.renewWorker(renewal)).toBe(true);
      const row = Option.getOrThrow(yield* repository.getById(original));
      expect(row).toMatchObject({ ...original, expiresAt: renewedUntil, revokedAt: null });
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT session_id FROM auth_sessions`).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "missing, revoked and mismatched rows never create a replacement or clear revocation",
    () =>
      Effect.gen(function* () {
        const repository = yield* AuthSessions.AuthSessionRepository;
        expect(yield* repository.renewWorker(renewal)).toBe(false);
        expect(Option.isNone(yield* repository.getById(original))).toBe(true);
        yield* repository.create(original);
        for (const change of [
          { sessionId: AuthSessionId.make("other") },
          {
            principal: { kind: "coordinator", environmentId: EnvironmentId.make("other") } as const,
          },
          { scopes: ["orchestration:read"] as const },
          { issuedAt: DateTime.add(issuedAt, { seconds: 1 }) },
        ])
          expect(yield* repository.renewWorker({ ...renewal, ...change })).toBe(false);
        yield* repository.revoke({ sessionId: original.sessionId, revokedAt: expiresAt });
        expect(yield* repository.renewWorker(renewal)).toBe(false);
        const row = Option.getOrThrow(yield* repository.getById(original));
        expect(row.revokedAt).toEqual(expiresAt);
        expect(row.expiresAt).toEqual(expiresAt);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("revocation wins both serializations and concurrent renew/revoke", () =>
    Effect.gen(function* () {
      const repository = yield* AuthSessions.AuthSessionRepository;
      for (const order of ["revoke-first", "renew-first", "concurrent"] as const) {
        const sessionId = AuthSessionId.make(order);
        yield* repository.create({ ...original, sessionId });
        const renew = repository.renewWorker({ ...renewal, sessionId });
        const revoke = repository.revoke({ sessionId, revokedAt: renewedUntil });
        if (order === "revoke-first") {
          yield* revoke;
          expect(yield* renew).toBe(false);
        } else if (order === "renew-first") {
          expect(yield* renew).toBe(true);
          yield* revoke;
        } else yield* Effect.all([renew, revoke], { concurrency: "unbounded" });
        const row = Option.getOrThrow(yield* repository.getById({ sessionId }));
        expect(row.revokedAt).toEqual(renewedUntil);
        expect(yield* renew).toBe(false);
      }
    }).pipe(Effect.provide(layer)),
  );
});
