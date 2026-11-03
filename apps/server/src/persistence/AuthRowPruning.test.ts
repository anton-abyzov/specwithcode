import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuthRowPruning from "./AuthRowPruning.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const NOW_MS = Date.parse("2026-11-03T12:00:00.000Z");
const DAY_MS = 86_400_000;
const at = (offsetDays: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(NOW_MS + offsetDays * DAY_MS));
const cutoff = AuthRowPruning.authPruneCutoff(NOW_MS);
const coordinator = JSON.stringify({ kind: "coordinator", environmentId: "coordinator" });

const insertSession = (input: {
  readonly id: string;
  readonly expiresAt: string;
  readonly revokedAt?: string | null;
  readonly subject?: string;
  readonly principal?: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at, revoked_at, principal)
      VALUES (${input.id}, ${input.subject ?? "browser"}, '[]', 'browser-session-cookie',
        ${at(-60)}, ${input.expiresAt}, ${input.revokedAt ?? null}, ${input.principal ?? null})
    `;
  });

const insertLink = (input: {
  readonly id: string;
  readonly expiresAt: string;
  readonly revokedAt?: string | null;
  readonly consumedAt?: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO auth_pairing_links (id, credential, method, scopes, subject, created_at, expires_at, consumed_at, revoked_at)
      VALUES (${input.id}, ${`credential-${input.id}`}, 'one-time-token', '[]', 'phone',
        ${at(-60)}, ${input.expiresAt}, ${input.consumedAt ?? null}, ${input.revokedAt ?? null})
    `;
  });

const remaining = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* sql<{
    readonly id: string;
  }>`SELECT session_id AS id FROM auth_sessions ORDER BY session_id`;
  const links = yield* sql<{
    readonly id: string;
  }>`SELECT id FROM auth_pairing_links ORDER BY id`;
  return { sessions: sessions.map((row) => row.id), links: links.map((row) => row.id) };
});

it.layer(SqlitePersistence.layerMemory)("auth row pruning", (it) => {
  it.effect(
    "deletes only rows dead for the whole retention and keeps renewable worker grants",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM auth_sessions`;
        yield* sql`DELETE FROM auth_pairing_links`;
        // Sessions.
        yield* insertSession({ id: "active", expiresAt: at(20) });
        yield* insertSession({ id: "expired-recently", expiresAt: at(-3) });
        yield* insertSession({ id: "expired-long-ago", expiresAt: at(-30) });
        yield* insertSession({ id: "revoked-recently", expiresAt: at(20), revokedAt: at(-1) });
        yield* insertSession({ id: "revoked-long-ago", expiresAt: at(20), revokedAt: at(-10) });
        yield* insertSession({
          id: "worker-grant-expired",
          subject: "mcp-client",
          principal: coordinator,
          expiresAt: at(-90),
        });
        yield* insertSession({
          id: "worker-grant-revoked",
          subject: "mcp-client",
          principal: coordinator,
          expiresAt: at(-90),
          revokedAt: at(-30),
        });
        yield* insertSession({
          id: "mcp-client-unbound",
          subject: "mcp-client",
          expiresAt: at(-90),
        });
        // Pairing links.
        yield* insertLink({ id: "link-active", expiresAt: at(1) });
        yield* insertLink({ id: "link-expired-recently", expiresAt: at(-2) });
        yield* insertLink({ id: "link-expired", expiresAt: at(-8) });
        yield* insertLink({ id: "link-consumed-expired", expiresAt: at(-8), consumedAt: at(-9) });
        yield* insertLink({ id: "link-consumed-live", expiresAt: at(1), consumedAt: at(-1) });
        yield* insertLink({ id: "link-revoked", expiresAt: at(1), revokedAt: at(-8) });
        yield* insertLink({ id: "link-revoked-recently", expiresAt: at(1), revokedAt: at(-1) });

        const result = yield* AuthRowPruning.pruneAuthRows({ cutoff });
        expect(result).toEqual({
          deletedSessionCount: 4,
          deletedPairingLinkCount: 3,
          interrupted: false,
        });
        expect(yield* remaining).toEqual({
          sessions: ["active", "expired-recently", "revoked-recently", "worker-grant-expired"],
          links: [
            "link-active",
            "link-consumed-live",
            "link-expired-recently",
            "link-revoked-recently",
          ],
        });
        // Nothing left to do: a second pass deletes nothing.
        expect(yield* AuthRowPruning.pruneAuthRows({ cutoff })).toEqual({
          deletedSessionCount: 0,
          deletedPairingLinkCount: 0,
          interrupted: false,
        });
      }),
  );

  it.effect("deletes in batches and paces between them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM auth_sessions`;
      yield* sql`DELETE FROM auth_pairing_links`;
      for (let index = 0; index < 7; index++)
        yield* insertSession({ id: `expired-${index}`, expiresAt: at(-30) });
      let statements = 0;
      let paces = 0;
      const result = yield* AuthRowPruning.pruneAuthRows({
        cutoff,
        batchSize: 3,
        mayDelete: () => {
          statements++;
          return true;
        },
        betweenBatches: Effect.sync(() => {
          paces++;
        }),
      });
      expect(result.deletedSessionCount).toBe(7);
      // revoked: 1 empty batch; expired: 3 + 3 + 1; links: 2 empty batches.
      expect(statements).toBe(6);
      expect(paces).toBe(2);
      expect((yield* remaining).sessions).toEqual([]);
    }),
  );

  it.effect("stops before the next batch when an update begins", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM auth_sessions`;
      yield* sql`DELETE FROM auth_pairing_links`;
      for (let index = 0; index < 5; index++)
        yield* insertSession({ id: `expired-${index}`, expiresAt: at(-30) });
      yield* insertLink({ id: "link-expired", expiresAt: at(-30) });

      const refused = yield* AuthRowPruning.pruneAuthRows({ cutoff, mayDelete: () => false });
      expect(refused).toEqual({
        deletedSessionCount: 0,
        deletedPairingLinkCount: 0,
        interrupted: true,
      });
      expect((yield* remaining).sessions).toHaveLength(5);

      let allowed = 2;
      const partial = yield* AuthRowPruning.pruneAuthRows({
        cutoff,
        batchSize: 2,
        mayDelete: () => allowed-- > 0,
      });
      // The empty revoked batch and one expired batch ran; the update stopped the rest.
      expect(partial).toEqual({
        deletedSessionCount: 2,
        deletedPairingLinkCount: 0,
        interrupted: true,
      });
      expect(yield* remaining).toEqual({
        sessions: ["expired-2", "expired-3", "expired-4"],
        links: ["link-expired"],
      });

      const stopped = yield* AuthRowPruning.pruneAuthRows({
        cutoff,
        shouldContinue: Effect.succeed(false),
      });
      expect(stopped.interrupted).toBe(true);
      expect((yield* remaining).sessions).toHaveLength(3);
    }),
  );

  it.effect("finds rows through the existing indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = (query: string) =>
        sql
          .unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
          .pipe(Effect.map((rows) => rows.map((row) => row.detail).join("\n")));
      expect(
        yield* plan(
          `SELECT rowid FROM auth_sessions WHERE revoked_at IS NULL AND expires_at < '${cutoff}' AND NOT (subject = 'mcp-client' AND principal IS NOT NULL) LIMIT 500`,
        ),
      ).toContain("idx_auth_sessions_active");
      expect(
        yield* plan(`SELECT rowid FROM auth_sessions WHERE revoked_at < '${cutoff}' LIMIT 500`),
      ).toContain("idx_auth_sessions_active");
      expect(
        yield* plan(
          `SELECT rowid FROM auth_pairing_links WHERE revoked_at < '${cutoff}' LIMIT 500`,
        ),
      ).toContain("idx_auth_pairing_links_active");
      expect(
        yield* plan(
          `SELECT rowid FROM auth_pairing_links WHERE revoked_at IS NULL AND expires_at < '${cutoff}' LIMIT 500`,
        ),
      ).toContain("idx_auth_pairing_links_active");
    }),
  );
});
