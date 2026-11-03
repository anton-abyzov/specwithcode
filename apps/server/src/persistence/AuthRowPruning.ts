/**
 * Deletes auth rows nothing can use again, in small batches.
 *
 * Until November 2026 nothing deleted `auth_sessions` or `auth_pairing_links`
 * rows. M4 held 47,401 expired sessions and 54,574 expired pairing links, and
 * every auth read the update helper and the service make scanned them.
 *
 * A row is deleted only when it can no longer authorize anything and has been
 * dead for `AUTH_ROW_RETENTION_MS`:
 * - a session or pairing link revoked before the cutoff. A revoked session is
 *   refused whether its row says revoked or is missing (`SessionStore`
 *   verify: `SessionTokenRevokedError` or `UnknownSessionTokenError`), and a
 *   worker grant renewal treats `grant_missing` like `grant_revoked`
 *   (`FleetWorkerGrants`);
 * - an unrevoked session that expired before the cutoff, except a worker
 *   grant (subject `mcp-client` bound to a principal). A coordinator renews
 *   its worker grant with the expired token (`SessionStore.renewWorkerGrant`
 *   checks no expiry), so that row is kept however old it is;
 * - an unrevoked pairing link that expired before the cutoff, consumed or
 *   not. Neither `peek` nor `consume` accepts an expired link.
 * Principal revocations (`auth_principal_revocations`) are never deleted:
 * they refuse new sessions and pairing codes for a removed device.
 *
 * Every statement deletes at most `AUTH_PRUNE_BATCH_SIZE` rows, found through
 * the existing `(revoked_at, expires_at, ...)` and
 * `(revoked_at, consumed_at, expires_at)` indexes, so no new index (which the
 * update helper's schema hash of these tables would see) is needed.
 *
 * @module AuthRowPruning
 */
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/** How long a row stays after it expired or was revoked. */
export const AUTH_ROW_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Rows one delete statement removes at most. */
export const AUTH_PRUNE_BATCH_SIZE = 500;
/** The subject of a worker grant; with a principal, its expired row stays renewable. */
export const WORKER_GRANT_SUBJECT = "mcp-client";

export interface PruneAuthRowsOptions {
  /** ISO time: rows that expired or were revoked before it are deleted. */
  readonly cutoff: string;
  readonly batchSize?: number;
  /** Checked before every delete; false stops the pass and reports `interrupted`. */
  readonly shouldContinue?: Effect.Effect<boolean>;
  /**
   * Checked synchronously inside each delete's transaction, right before the
   * statement. False stops the pass like `shouldContinue`.
   */
  readonly mayDelete?: () => boolean;
  /** Pacing between batches, outside the transaction. */
  readonly betweenBatches?: Effect.Effect<void>;
  readonly pauseBetweenBatches?: Duration.Input;
}

export interface PruneAuthRowsResult {
  readonly deletedSessionCount: number;
  readonly deletedPairingLinkCount: number;
  readonly interrupted: boolean;
}

/** The cutoff for `now`: rows dead since before it are deleted. */
export const authPruneCutoff = (nowMs: number, retentionMs = AUTH_ROW_RETENTION_MS) =>
  DateTime.formatIso(DateTime.makeUnsafe(nowMs - retentionMs));

export const pruneAuthRows = (options: PruneAuthRowsOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const batchSize = Math.max(1, Math.floor(options.batchSize ?? AUTH_PRUNE_BATCH_SIZE));
    const cutoff = options.cutoff;
    let interrupted = false;

    const statements: {
      readonly sessions: ReadonlyArray<Statement>;
      readonly pairingLinks: ReadonlyArray<Statement>;
    } = {
      sessions: [
        () => sql<{ readonly id: number }>`
          DELETE FROM auth_sessions WHERE rowid IN (
            SELECT rowid FROM auth_sessions
            WHERE revoked_at < ${cutoff}
            LIMIT ${batchSize}
          ) RETURNING rowid AS "id"
        `,
        () => sql<{ readonly id: number }>`
          DELETE FROM auth_sessions WHERE rowid IN (
            SELECT rowid FROM auth_sessions
            WHERE revoked_at IS NULL
              AND expires_at < ${cutoff}
              AND NOT (subject = ${WORKER_GRANT_SUBJECT} AND principal IS NOT NULL)
            LIMIT ${batchSize}
          ) RETURNING rowid AS "id"
        `,
      ],
      pairingLinks: [
        () => sql<{ readonly id: number }>`
          DELETE FROM auth_pairing_links WHERE rowid IN (
            SELECT rowid FROM auth_pairing_links
            WHERE revoked_at < ${cutoff}
            LIMIT ${batchSize}
          ) RETURNING rowid AS "id"
        `,
        () => sql<{ readonly id: number }>`
          DELETE FROM auth_pairing_links WHERE rowid IN (
            SELECT rowid FROM auth_pairing_links
            WHERE revoked_at IS NULL
              AND expires_at < ${cutoff}
            LIMIT ${batchSize}
          ) RETURNING rowid AS "id"
        `,
      ],
    };

    type Statement = () => Effect.Effect<ReadonlyArray<{ readonly id: number }>, SqlError>;

    /** One batch in its own transaction; null when the gate refused it. */
    const runBatch = (statement: Statement) =>
      Effect.gen(function* () {
        if (options.shouldContinue !== undefined && !(yield* options.shouldContinue)) return null;
        return yield* sql.withTransaction(
          Effect.suspend(() => {
            if (options.mayDelete?.() === false) return Effect.succeed(null);
            return Effect.map(statement(), (rows) => rows.length);
          }),
        );
      });

    const drain = (statement: Statement) =>
      Effect.gen(function* () {
        let deleted = 0;
        while (!interrupted) {
          const count = yield* runBatch(statement);
          if (count === null) {
            interrupted = true;
            break;
          }
          deleted += count;
          if (count < batchSize) break;
          if (options.betweenBatches !== undefined) yield* options.betweenBatches;
          if (options.pauseBetweenBatches !== undefined)
            yield* Effect.sleep(options.pauseBetweenBatches);
          else yield* Effect.yieldNow;
        }
        return deleted;
      });

    let deletedSessionCount = 0;
    for (const statement of statements.sessions) {
      if (interrupted) break;
      deletedSessionCount += yield* drain(statement);
    }
    let deletedPairingLinkCount = 0;
    for (const statement of statements.pairingLinks) {
      if (interrupted) break;
      deletedPairingLinkCount += yield* drain(statement);
    }
    return {
      deletedSessionCount,
      deletedPairingLinkCount,
      interrupted,
    } satisfies PruneAuthRowsResult;
  });
