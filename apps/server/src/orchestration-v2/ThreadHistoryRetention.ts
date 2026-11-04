/**
 * Opt-in retention of old thread history. Off unless a policy names a day
 * count: nothing here runs on a machine whose owner did not turn it on
 * (Settings > Storage, or `specweave-studio db compact`).
 *
 * Two passes, each over the threads the projection lists:
 *
 * - **Deleted threads**, deleted at least `deletedAfterDays` ago, are purged:
 *   their events and their projection rows (runs, nodes, turn items, messages,
 *   requests, plans, checkpoints, handoffs, subagents, positions) go, and
 *   their attachments are removed again (thread deletion already removes
 *   them; this repeats it for any it missed).
 * - **Archived threads**, archived and untouched for `archivedAfterDays`,
 *   keep every projection row the UI reads and lose only their raw events.
 *
 * What stays of every thread, so nothing comes back and nothing that counts
 * threads changes: its projection thread row (for a deleted thread, the
 * tombstone with `deleted_at` that sync, handoff and the update helper's
 * thread-id proof read), its `thread.created` event (projection verify
 * derives the expected thread set from it), its newest `thread.deleted` or
 * `thread.archived` event, and the newest event of its stream (the stream's
 * high water, so `latestAgentSequence`, the log's last sequence and every
 * update-proof boundary stay where they were). Rows other threads point at
 * (provider sessions and threads, session bindings, context transfers) stay.
 *
 * Before any event goes, `orchestration_v2_thread_history_compactions`
 * records the thread and the sequence its history ends at. From then on its
 * projection rows are the base: `ProjectionMaintenance.rebuild` keeps them
 * and replays only later events, and a client resuming from before that
 * sequence takes a snapshot instead of a replay (`ws.ts`). The marker is
 * written first, so a pass stopped half-way leaves a consistent thread, and
 * its `completed_at` is set only once every delete finished: until then each
 * pass resumes the thread instead of taking it as done.
 *
 * Skipped, whatever their age: threads another machine owns or runs
 * (`execution`) or that moved by handoff (`movedTo`/`movedFrom` kind
 * "handoff"), whose copies elsewhere still exchange with this one; threads
 * with a run or an effect still in flight; and imported legacy threads whose
 * transcript was not hydrated yet (it is read from their events).
 *
 * Every delete is one small statement behind the same checks the background
 * compaction uses (`shouldContinue`, `mayDelete`), so nothing is deleted
 * while an update helper holds a snapshot or the install gate.
 *
 * @module ThreadHistoryRetention
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { HTML_RENDER_TOOL_NAME, HTML_VISUAL_TOOL_NAME } from "@specweave-studio/shared/htmlRender";

import { threadHtmlRenderAttachmentIds } from "../attachmentStore.ts";

export interface ThreadHistoryRetentionPolicy {
  /** Purge a deleted thread this many days after its deletion; null never. */
  readonly deletedAfterDays: number | null;
  /** Drop an archived thread's events this many days after it was archived; null never. */
  readonly archivedAfterDays: number | null;
}

export const RETENTION_OFF: ThreadHistoryRetentionPolicy = {
  deletedAfterDays: null,
  archivedAfterDays: null,
};

export const retentionEnabled = (policy: ThreadHistoryRetentionPolicy) =>
  policy.deletedAfterDays !== null || policy.archivedAfterDays !== null;

export interface ThreadHistoryRetentionOptions {
  readonly policy: ThreadHistoryRetentionPolicy;
  readonly nowMs: number;
  /** Count what would go, with cheap index reads, and change nothing. */
  readonly dryRun?: boolean;
  /** Checked before every delete; false stops the pass (`interrupted`). */
  readonly shouldContinue?: Effect.Effect<boolean>;
  /** Checked synchronously inside each delete's transaction, right before it. */
  readonly mayDelete?: () => boolean;
  /** Pacing between deletes, outside transactions; offline callers omit it. */
  readonly betweenBatches?: Effect.Effect<void>;
  /** Rows per delete statement. */
  readonly batchSize?: number;
  /** Threads one pass handles at most; the rest wait for the next pass. */
  readonly maxThreads?: number;
  /** Removes attachment files by id; omitted, attachments are left alone. */
  readonly removeAttachments?: (attachmentIds: ReadonlyArray<string>) => Effect.Effect<void>;
}

export interface ThreadHistoryRetentionResult {
  readonly dryRun: boolean;
  readonly interrupted: boolean;
  /** Deleted threads purged (or, in a dry run, that would be). */
  readonly purgedThreadCount: number;
  /** Archived threads whose events went (or would go). */
  readonly compactedThreadCount: number;
  /** Threads old enough but skipped, by reason. */
  readonly skipped: {
    readonly linked: number;
    readonly busy: number;
    readonly legacy: number;
  };
  /** Threads left for a later pass by `maxThreads`. */
  readonly deferredThreadCount: number;
  readonly deletedEventCount: number;
  readonly deletedRowsByTable: Readonly<Record<string, number>>;
  readonly attachmentIds: number;
  /**
   * Bytes the deleted rows hold, estimated from sampled row sizes plus a
   * per-row allowance for indexes and page slack. A rewrite (VACUUM) returns
   * them to the disk; until then new writes reuse them.
   */
  readonly estimatedBytes: { readonly low: number; readonly high: number };
}

/** Rows per delete statement by default: well under a millisecond of work each. */
export const RETENTION_BATCH_SIZE = 100;
/** Threads one background pass handles; `db compact` handles all. */
export const RETENTION_MAX_THREADS_PER_PASS = 100;
const DAY_MS = 24 * 60 * 60_000;
/** Row bytes beyond the sampled payload: ids, index entries, slack (as DatabaseReclaim). */
const ROW_OVERHEAD_BYTES = { low: 200, high: 1_500 } as const;
/** Sampled rows per table for the size estimate. */
const SIZE_SAMPLES = 64;

/** Projection tables keyed by `thread_id` whose rows a purged thread loses. */
export const PURGED_THREAD_TABLES = [
  "orchestration_v2_projection_turn_items",
  "orchestration_v2_projection_nodes",
  "orchestration_v2_projection_messages",
  "orchestration_v2_projection_provider_turns",
  "orchestration_v2_projection_runtime_requests",
  "orchestration_v2_projection_run_attempts",
  "orchestration_v2_projection_runs",
  "orchestration_v2_projection_plans",
  "orchestration_v2_projection_checkpoints",
  "orchestration_v2_projection_checkpoint_scopes",
  "orchestration_v2_projection_context_handoffs",
  "orchestration_v2_projection_subagents",
  "orchestration_v2_turn_item_positions",
] as const;
type PurgedTable = (typeof PURGED_THREAD_TABLES)[number];
const EVENTS = "orchestration_events";

const ACTIVE_RUN_STATUSES = ["preparing", "queued", "starting", "running", "waiting"];

type Candidate = {
  readonly thread_id: string;
  readonly kind: "deleted" | "archived";
  readonly linked: number;
  readonly legacy_pending: number;
  readonly active_runs: number;
  readonly compacted_kind: string | null;
  readonly compacted_through: number | null;
  readonly compacted_complete: number;
};

/** JSON text a column returned, or None when this build cannot read it. */
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

export const MARKER_TABLE = "orchestration_v2_thread_history_compactions";

/** Whether migration 070 created the marker table in this database. */
export const markerTableExists = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly found: number }>`
    SELECT EXISTS (
      SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ${MARKER_TABLE}
    ) AS found
  `;
  return (rows[0]?.found ?? 0) !== 0;
});

export const runThreadHistoryRetention = (
  options: ThreadHistoryRetentionOptions,
): Effect.Effect<ThreadHistoryRetentionResult, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const dryRun = options.dryRun === true;
    const batchSize = Math.max(1, options.batchSize ?? RETENTION_BATCH_SIZE);
    const maxThreads = options.maxThreads ?? Number.POSITIVE_INFINITY;
    const { deletedAfterDays, archivedAfterDays } = options.policy;
    let interrupted = false;
    let purgedThreadCount = 0;
    let compactedThreadCount = 0;
    let deferredThreadCount = 0;
    let deletedEventCount = 0;
    let attachmentIds = 0;
    const skipped = { linked: 0, busy: 0, legacy: 0 };
    const deletedRowsByTable: Record<string, number> = {};
    const count = (table: string, rows: number) => {
      if (rows > 0) deletedRowsByTable[table] = (deletedRowsByTable[table] ?? 0) + rows;
    };
    const result = (estimatedBytes: ThreadHistoryRetentionResult["estimatedBytes"]) =>
      ({
        dryRun,
        interrupted,
        purgedThreadCount,
        compactedThreadCount,
        skipped,
        deferredThreadCount,
        deletedEventCount,
        deletedRowsByTable,
        attachmentIds,
        estimatedBytes,
      }) satisfies ThreadHistoryRetentionResult;

    if (deletedAfterDays === null && archivedAfterDays === null) {
      return result({ low: 0, high: 0 });
    }
    const deletedCutoff =
      deletedAfterDays === null ? null : isoAt(options.nowMs - deletedAfterDays * DAY_MS);
    const archivedCutoff =
      archivedAfterDays === null ? null : isoAt(options.nowMs - archivedAfterDays * DAY_MS);

    // A database the service has not migrated yet has no markers (and nothing to write them to).
    const hasMarkers = yield* markerTableExists;
    if (!hasMarkers && !dryRun) {
      return yield* Effect.die(
        new Error(
          `${MARKER_TABLE} is missing: start the updated SpecWithCode once so it migrates the database.`,
        ),
      );
    }
    // Cheap: the projection's thread rows, a few thousand at most.
    const candidates = yield* sql<Candidate>`
      SELECT
        thread.thread_id,
        CASE WHEN thread.deleted_at IS NOT NULL THEN 'deleted' ELSE 'archived' END AS kind,
        (
          json_type(thread.payload_json, '$.execution') = 'object'
          OR json_extract(thread.payload_json, '$.movedTo.kind') = 'handoff'
          OR json_extract(thread.payload_json, '$.movedFrom.kind') = 'handoff'
        ) IS 1 AS linked,
        EXISTS (
          SELECT 1 FROM orchestration_v2_legacy_imports AS legacy
          WHERE legacy.thread_id = thread.thread_id
            AND legacy.transcript_imported_at IS NULL
        ) AS legacy_pending,
        EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs AS run
          WHERE run.thread_id = thread.thread_id
            AND run.status IN ${sql.in(ACTIVE_RUN_STATUSES)}
        ) AS active_runs,
        ${
          hasMarkers
            ? sql`(
              SELECT marker.kind FROM orchestration_v2_thread_history_compactions AS marker
              WHERE marker.thread_id = thread.thread_id
            )`
            : sql`NULL`
        } AS compacted_kind,
        ${
          hasMarkers
            ? sql`(
              SELECT marker.through_sequence FROM orchestration_v2_thread_history_compactions AS marker
              WHERE marker.thread_id = thread.thread_id
            )`
            : sql`NULL`
        } AS compacted_through,
        ${
          hasMarkers
            ? sql`EXISTS (
              SELECT 1 FROM orchestration_v2_thread_history_compactions AS marker
              WHERE marker.thread_id = thread.thread_id
                AND marker.completed_at IS NOT NULL
            )`
            : sql`0`
        } AS compacted_complete
      FROM orchestration_v2_projection_threads AS thread
      WHERE ${
        deletedCutoff === null
          ? sql`0`
          : sql`(thread.deleted_at IS NOT NULL AND thread.deleted_at < ${deletedCutoff})`
      }
        OR ${
          archivedCutoff === null
            ? sql`0`
            : sql`(
              thread.deleted_at IS NULL
              AND thread.archived_at IS NOT NULL
              AND thread.archived_at < ${archivedCutoff}
              AND thread.updated_at < ${archivedCutoff}
            )`
        }
      ORDER BY thread.thread_id
    `;
    // Effects in flight, read once through the outbox's status index.
    const busyThreads = new Set(
      (yield* sql<{ readonly thread_id: string }>`
        SELECT DISTINCT thread_id FROM orchestration_v2_effect_outbox
        WHERE status IN ('pending', 'running')
      `).map((row) => row.thread_id),
    );

    /** Runs one write unless told to stop; false once stopped. */
    const write = <A, E, R>(statement: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        if (interrupted) return false;
        if (options.shouldContinue !== undefined && !(yield* options.shouldContinue)) {
          interrupted = true;
          return false;
        }
        const ran =
          options.mayDelete === undefined
            ? yield* Effect.as(statement, true)
            : yield* sql.withTransaction(
                Effect.suspend(() =>
                  options.mayDelete?.() === false
                    ? Effect.succeed(false)
                    : Effect.as(statement, true),
                ),
              );
        if (!ran) {
          interrupted = true;
          return false;
        }
        yield* Effect.yieldNow;
        if (options.betweenBatches !== undefined) yield* options.betweenBatches;
        return true;
      });

    /** The sequences a thread keeps: creation, newest lifecycle event, stream end. */
    const keptSequences = (threadId: string, kind: Candidate["kind"]) =>
      Effect.gen(function* () {
        const ends = yield* sql<{ readonly newest: number | null; readonly total: number }>`
          SELECT MAX(sequence) AS newest, COUNT(*) AS total
          FROM orchestration_events INDEXED BY idx_orchestration_events_agent_stream_sequence
          WHERE application_event_version = 2
            AND aggregate_kind = 'thread'
            AND stream_id = ${threadId}
        `;
        const created = yield* sql<{ readonly sequence: number }>`
          SELECT sequence
          FROM orchestration_events INDEXED BY orchestration_events_v2_created_threads_idx
          WHERE application_event_version = 2
            AND aggregate_kind = 'thread'
            AND event_type = 'thread.created'
            AND stream_id = ${threadId}
        `;
        // Newest first from the stream's end: the lifecycle event is near it.
        const lifecycle = yield* sql<{ readonly sequence: number }>`
          SELECT sequence
          FROM orchestration_events INDEXED BY idx_orchestration_events_agent_stream_sequence
          WHERE application_event_version = 2
            AND aggregate_kind = 'thread'
            AND stream_id = ${threadId}
            AND event_type = ${kind === "deleted" ? "thread.deleted" : "thread.archived"}
          ORDER BY sequence DESC
          LIMIT 1
        `;
        const newest = ends[0]?.newest ?? null;
        const kept = new Set<number>([
          ...created.map((row) => row.sequence),
          ...lifecycle.map((row) => row.sequence),
          ...(newest === null ? [] : [newest]),
        ]);
        return { newest, total: ends[0]?.total ?? 0, kept };
      });

    /** Deletes a thread's events outside `kept`, oldest first, a batch per statement. */
    const deleteEvents = (threadId: string, kept: ReadonlySet<number>, newest: number) =>
      Effect.gen(function* () {
        const keptList = [...kept];
        let after = 0;
        while (!interrupted) {
          const page = yield* sql<{ readonly sequence: number }>`
            SELECT sequence
            FROM orchestration_events INDEXED BY idx_orchestration_events_agent_stream_sequence
            WHERE application_event_version = 2
              AND aggregate_kind = 'thread'
              AND stream_id = ${threadId}
              AND sequence > ${after}
              AND sequence < ${newest}
              AND sequence NOT IN ${sql.in(keptList)}
            ORDER BY sequence
            LIMIT ${batchSize}
          `;
          if (page.length === 0) return;
          const sequences = page.map((row) => row.sequence);
          const deleted = yield* write(
            sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(sequences)}`,
          );
          if (!deleted) return;
          deletedEventCount += sequences.length;
          count(EVENTS, sequences.length);
          after = sequences.at(-1) ?? after;
          if (page.length < batchSize) return;
        }
      });

    const countRows = (table: PurgedTable, threadId: string) =>
      Effect.map(
        sql.unsafe<{ readonly count: number }>(
          `SELECT COUNT(*) AS count FROM ${table} WHERE thread_id = ?`,
          [threadId],
        ),
        (rows) => rows[0]?.count ?? 0,
      );

    const deleteRows = (table: PurgedTable, threadId: string) =>
      Effect.gen(function* () {
        while (!interrupted) {
          const rowids = (yield* sql.unsafe<{ readonly id: number }>(
            `SELECT rowid AS id FROM ${table} WHERE thread_id = ? LIMIT ${batchSize}`,
            [threadId],
          )).map((row) => row.id);
          if (rowids.length === 0) return;
          const deleted = yield* write(
            sql.unsafe(
              `DELETE FROM ${table} WHERE rowid IN (${rowids.map(() => "?").join(", ")})`,
              rowids,
            ),
          );
          if (!deleted) return;
          count(table, rowids.length);
          if (rowids.length < batchSize) return;
        }
      });

    /** Between two reads of a lookup: yield, pace, and stop when told to. */
    const betweenReads = Effect.gen(function* () {
      yield* Effect.yieldNow;
      if (options.betweenBatches !== undefined) yield* options.betweenBatches;
      if (options.shouldContinue !== undefined && !(yield* options.shouldContinue)) {
        interrupted = true;
      }
      return !interrupted;
    });

    /**
     * The attachment ids a thread's messages and HTML renders name, read a
     * page of rows per statement (rowid order) with pacing between pages, so
     * a thread with a long tool history never holds the connection for one
     * long read. Only the attachments array and, for render tools, the
     * output reach JS. Null when the pass was stopped.
     */
    const threadAttachmentIds = (threadId: string) =>
      Effect.gen(function* () {
        const ids = new Set<string>();
        let after = 0;
        for (;;) {
          const page = yield* sql<{ readonly id: number; readonly attachments: string | null }>`
            SELECT rowid AS id, json_extract(payload_json, '$.attachments') AS attachments
            FROM orchestration_v2_projection_messages
            WHERE thread_id = ${threadId} AND rowid > ${after}
            ORDER BY rowid
            LIMIT ${batchSize}
          `;
          for (const row of page) {
            // A payload this build cannot read names no attachment it knows.
            const list = Option.getOrNull(parseJson(row.attachments));
            if (!Array.isArray(list)) continue;
            for (const entry of list as ReadonlyArray<unknown>) {
              const id = (entry as { readonly id?: unknown } | null)?.id;
              if (typeof id === "string") ids.add(id);
            }
          }
          if (page.length < batchSize) break;
          after = page.at(-1)?.id ?? after;
          if (!(yield* betweenReads)) return null;
        }
        after = 0;
        for (;;) {
          const page = yield* sql<{
            readonly id: number;
            readonly tool_name: string | null;
            readonly output: string | null;
          }>`
            SELECT
              rowid AS id,
              json_extract(payload_json, '$.toolName') AS tool_name,
              CASE
                WHEN json_extract(payload_json, '$.toolName') LIKE ${`%${HTML_RENDER_TOOL_NAME}`}
                  OR json_extract(payload_json, '$.toolName') LIKE ${`%${HTML_VISUAL_TOOL_NAME}`}
                THEN json_extract(payload_json, '$.output')
              END AS output
            FROM orchestration_v2_projection_turn_items
            WHERE thread_id = ${threadId} AND type = 'dynamic_tool' AND rowid > ${after}
            ORDER BY rowid
            LIMIT ${batchSize}
          `;
          const renderItems = page.flatMap((row) =>
            Option.match(parseJson(row.output), {
              onNone: () => [],
              onSome: (output) => [{ toolName: row.tool_name, output }],
            }),
          );
          for (const id of threadHtmlRenderAttachmentIds(threadId, renderItems)) ids.add(id);
          if (page.length < batchSize) break;
          after = page.at(-1)?.id ?? after;
          if (!(yield* betweenReads)) return null;
        }
        return [...ids];
      });

    let handled = 0;
    for (const candidate of candidates) {
      if (interrupted) break;
      if (candidate.linked === 1) {
        skipped.linked += 1;
        continue;
      }
      if (candidate.legacy_pending === 1) {
        skipped.legacy += 1;
        continue;
      }
      if (candidate.active_runs === 1 || busyThreads.has(candidate.thread_id)) {
        skipped.busy += 1;
        continue;
      }
      const { newest, total, kept } = yield* keptSequences(candidate.thread_id, candidate.kind);
      const purge = candidate.kind === "deleted";
      // Done before, and nothing new since: an archived thread's marker also
      // covers its later purge only once that purge ran.
      const done =
        candidate.compacted_complete === 1 &&
        candidate.compacted_through !== null &&
        newest !== null &&
        candidate.compacted_through >= newest &&
        (candidate.compacted_kind === "deleted" || !purge);
      if (done) continue;
      if (handled >= maxThreads) {
        deferredThreadCount += 1;
        continue;
      }
      handled += 1;
      const removableEvents = newest === null ? 0 : total - kept.size;

      if (dryRun) {
        deletedEventCount += removableEvents;
        count(EVENTS, removableEvents);
        if (purge) {
          for (const table of PURGED_THREAD_TABLES) {
            count(table, yield* countRows(table, candidate.thread_id));
          }
          purgedThreadCount += 1;
        } else {
          compactedThreadCount += 1;
        }
        continue;
      }

      // The marker first: from here a rebuild keeps this thread's rows and a
      // resuming client takes a snapshot, however far the deletes below get.
      const through = newest ?? 0;
      const marked = yield* write(sql`
        INSERT INTO orchestration_v2_thread_history_compactions (
          thread_id, kind, through_sequence, compacted_at
        )
        VALUES (${candidate.thread_id}, ${candidate.kind}, ${through}, ${isoAt(options.nowMs)})
        ON CONFLICT(thread_id) DO UPDATE SET
          kind = excluded.kind,
          through_sequence = excluded.through_sequence,
          compacted_at = excluded.compacted_at,
          completed_at = NULL
      `);
      if (!marked) break;
      if (purge && options.removeAttachments !== undefined) {
        const ids = yield* threadAttachmentIds(candidate.thread_id);
        if (ids === null) break;
        if (ids.length > 0) {
          if (options.shouldContinue !== undefined && !(yield* options.shouldContinue)) {
            interrupted = true;
            break;
          }
          yield* options.removeAttachments(ids);
          attachmentIds += ids.length;
        }
      }
      if (newest !== null) yield* deleteEvents(candidate.thread_id, kept, newest);
      if (purge) {
        for (const table of PURGED_THREAD_TABLES) {
          if (interrupted) break;
          yield* deleteRows(table, candidate.thread_id);
        }
      }
      if (interrupted) break;
      // Every delete ran: only now may a later pass take this thread as done.
      const completed = yield* write(sql`
        UPDATE orchestration_v2_thread_history_compactions
        SET completed_at = ${isoAt(options.nowMs)}
        WHERE thread_id = ${candidate.thread_id}
      `);
      if (!completed) break;
      if (purge) purgedThreadCount += 1;
      else compactedThreadCount += 1;
    }

    return result(yield* estimateBytes(deletedRowsByTable));
  });

/**
 * Bytes the counted rows hold: each table's average row text from up to
 * SIZE_SAMPLES rows spread over its rowids (point reads), plus an allowance per row.
 */
const estimateBytes = (rowsByTable: Readonly<Record<string, number>>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    let low = 0;
    let high = 0;
    for (const [table, rows] of Object.entries(rowsByTable)) {
      if (rows <= 0) continue;
      const size =
        table === EVENTS
          ? "length(payload_json) + length(metadata_json)"
          : table === "orchestration_v2_turn_item_positions"
            ? "length(thread_id) + length(turn_item_id) + 8"
            : "length(payload_json) + length(thread_id)";
      const bounds = yield* sql.unsafe<{
        readonly low: number | null;
        readonly high: number | null;
      }>(`SELECT MIN(rowid) AS low, MAX(rowid) AS high FROM ${table}`);
      const first = bounds[0]?.low ?? null;
      const last = bounds[0]?.high ?? null;
      let average = 0;
      if (first !== null && last !== null) {
        const step = Math.max(1, Math.floor((last - first) / SIZE_SAMPLES));
        let total = 0;
        let samples = 0;
        for (let at = first; at <= last && samples < SIZE_SAMPLES; at += step) {
          const sample = yield* sql.unsafe<{ readonly size: number | null }>(
            `SELECT ${size} AS size FROM ${table} WHERE rowid >= ? ORDER BY rowid LIMIT 1`,
            [at],
          );
          if (sample[0]?.size === undefined || sample[0].size === null) continue;
          total += sample[0].size;
          samples += 1;
        }
        average = samples === 0 ? 0 : total / samples;
      }
      low += rows * (average + ROW_OVERHEAD_BYTES.low);
      high += rows * (average + ROW_OVERHEAD_BYTES.high);
    }
    return { low: Math.round(low), high: Math.round(high) };
  });
