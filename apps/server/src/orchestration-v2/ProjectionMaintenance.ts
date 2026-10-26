import { ThreadId } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export interface ProjectionVerificationV2 {
  readonly valid: boolean;
  readonly schemaVersion: number;
  readonly expectedSequence: number;
  readonly projectionSequence: number;
  readonly unreadableThreadIds: ReadonlyArray<ThreadId>;
  readonly missingThreadIds: ReadonlyArray<ThreadId>;
  readonly unexpectedThreadIds: ReadonlyArray<ThreadId>;
}

export class ProjectionMaintenanceError extends Schema.TaggedError<ProjectionMaintenanceError>()(
  "ProjectionMaintenanceError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface CompactEventStoreOptions {
  /** Count what would be deleted without deleting anything. */
  readonly dryRun?: boolean;
  /**
   * Checked before every delete statement. When it returns false the pass
   * stops before that delete and reports `interrupted`; what it already
   * deleted stays deleted (each delete is its own small transaction).
   */
  readonly shouldContinue?: Effect.Effect<boolean>;
  /**
   * Checked synchronously inside each delete's transaction, after the
   * connection is taken and right before the statement, so nothing runs
   * between the check and the write. False stops the pass like
   * `shouldContinue`. For checks of files another process writes.
   */
  readonly mayDelete?: () => boolean;
  /**
   * `throughSequence` of the last completed pass. Only threads with events
   * after it (and imported legacy threads) are read again. 0 or absent reads
   * the whole log; a cursor past the log's end does too.
   */
  readonly sinceSequence?: number;
  /** Events read per discovery query; bounds how long one query holds the connection. */
  readonly pageSize?: number;
  /** Waited between discovery pages instead of a bare yield, for background passes. */
  readonly pauseBetweenPages?: Duration.Input;
}

export interface CompactEventStoreResult {
  readonly deletedEventCount: number;
  readonly deletedReceiptCount: number;
  /** Free pages times the page size, after the pass. */
  readonly reclaimableBytes: number;
  /** Characters of payload_json plus metadata_json in the deleted events. */
  readonly deletedEventChars: number;
  readonly deletedByType: Readonly<Record<string, number>>;
  readonly scannedEventCount: number;
  /** Threads read again by an incremental pass; null for a full pass. */
  readonly scannedStreamCount: number | null;
  /** The log's last sequence when the pass began: the next pass's `sinceSequence`. */
  readonly throughSequence: number;
  readonly interrupted: boolean;
  readonly dryRun: boolean;
}

export interface ProjectionMaintenanceV2Shape {
  readonly verify: Effect.Effect<ProjectionVerificationV2, ProjectionMaintenanceError>;
  readonly rebuild: Effect.Effect<ProjectionVerificationV2, ProjectionMaintenanceError>;
  /** A full pass that deletes superseded history (see `compactEventStoreWith`). */
  readonly compactEventStore: Effect.Effect<CompactEventStoreResult, ProjectionMaintenanceError>;
  readonly compactEventStoreWith: (
    options?: CompactEventStoreOptions,
  ) => Effect.Effect<CompactEventStoreResult, ProjectionMaintenanceError>;
}

/** Events per discovery query: about 40 ms of reads on a cold 20 GB log at 500 rows. */
export const COMPACTION_PAGE_SIZE = 100;
const COMPACTION_RECEIPT_PAGE_SIZE = 500;

export class ProjectionMaintenanceV2 extends Context.Service<
  ProjectionMaintenanceV2,
  ProjectionMaintenanceV2Shape
>()("specweave-studio/orchestration-v2/ProjectionMaintenance/ProjectionMaintenanceV2") {}

type ProjectionMetadataRow = {
  readonly schema_version: number;
  readonly last_sequence: number;
};

const encodeEntityKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.NullOr(Schema.String)])),
);

export const layer: Layer.Layer<
  ProjectionMaintenanceV2,
  never,
  EventStore.EventStoreV2 | ProjectionStore.ProjectionStoreV2 | SqlClient.SqlClient
> = Layer.effect(
  ProjectionMaintenanceV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* EventStore.EventStoreV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;

    /**
     * EventSink commits the event, its projection updates, and projection metadata in one SQL
     * transaction. Startup verification therefore checks that transaction boundary and that every
     * stored projection can be decoded. It intentionally does not replay domain events through a
     * second projector: doing so creates another implementation of projection semantics that must
     * evolve in lockstep with ProjectionStore.
     */
    const verify = Effect.gen(function* () {
      const expectedThreadRows = yield* sql<{ readonly thread_id: string }>`
        SELECT DISTINCT stream_id AS thread_id
        FROM orchestration_events INDEXED BY orchestration_events_v2_created_threads_idx
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND event_type = 'thread.created'
        ORDER BY stream_id ASC
      `;
      const projectionRows = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id
        FROM orchestration_v2_projection_threads
        ORDER BY thread_id ASC
      `;
      const actualIds = projectionRows.map((row) => ThreadId.make(row.thread_id));
      const expectedIds = expectedThreadRows.map((row) => ThreadId.make(row.thread_id));
      const actualSet = new Set(actualIds);
      const expectedSet = new Set(expectedIds);
      const missingThreadIds = expectedIds.filter((threadId) => !actualSet.has(threadId));
      const unexpectedThreadIds = actualIds.filter((threadId) => !expectedSet.has(threadId));
      const unreadableThreadIds = yield* projectionStore.getUnreadableThreadIds();
      const metadata = yield* sql<ProjectionMetadataRow>`
        SELECT schema_version, last_sequence
        FROM orchestration_v2_projection_metadata
        WHERE projection_name = 'thread-projections'
        LIMIT 1
      `;
      const expectedSequence = yield* eventStore.latestSequence();
      const schemaVersion = metadata[0]?.schema_version ?? 0;
      const projectionSequence = metadata[0]?.last_sequence ?? 0;
      return {
        valid:
          schemaVersion === ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION &&
          projectionSequence === expectedSequence &&
          missingThreadIds.length === 0 &&
          unexpectedThreadIds.length === 0 &&
          unreadableThreadIds.length === 0,
        schemaVersion,
        expectedSequence,
        projectionSequence,
        unreadableThreadIds,
        missingThreadIds,
        unexpectedThreadIds,
      } satisfies ProjectionVerificationV2;
    }).pipe(sql.withTransaction);

    const rebuild = Effect.gen(function* () {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const throughSequence = yield* eventStore.latestSequence();
          yield* sql`DELETE FROM orchestration_v2_projection_context_transfers`;
          yield* sql`DELETE FROM orchestration_v2_projection_context_handoffs`;
          yield* sql`DELETE FROM orchestration_v2_projection_checkpoints`;
          yield* sql`DELETE FROM orchestration_v2_projection_checkpoint_scopes`;
          yield* sql`DELETE FROM orchestration_v2_projection_turn_items`;
          yield* sql`DELETE FROM orchestration_v2_projection_plans`;
          yield* sql`DELETE FROM orchestration_v2_projection_messages`;
          yield* sql`DELETE FROM orchestration_v2_projection_runtime_requests`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_turns`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_threads`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_session_bindings`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_sessions`;
          yield* sql`DELETE FROM orchestration_v2_projection_subagents`;
          yield* sql`DELETE FROM orchestration_v2_projection_nodes`;
          yield* sql`DELETE FROM orchestration_v2_projection_run_attempts`;
          yield* sql`DELETE FROM orchestration_v2_projection_runs`;
          yield* sql`DELETE FROM orchestration_v2_projection_threads`;
          yield* sql`DELETE FROM orchestration_v2_turn_item_positions`;

          const pageSize = 500;
          let lastSequence = 0;
          while (true) {
            const page = yield* eventStore
              .read({ afterSequence: lastSequence, throughSequence, limit: pageSize })
              .pipe(Stream.runCollect);
            for (const stored of page) {
              yield* projectionStore.apply(stored.event);
              if (stored.event.type === "turn-item.updated") {
                yield* sql`
                INSERT INTO orchestration_v2_turn_item_positions (
                  thread_id,
                  turn_item_id,
                  ordinal
                )
                VALUES (
                  ${stored.event.threadId},
                  ${stored.event.payload.id},
                  ${stored.event.payload.ordinal}
                )
                ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET
                  ordinal = excluded.ordinal
                `;
              }
              lastSequence = stored.sequence;
            }
            if (page.length < pageSize) break;
            yield* Effect.yieldNow;
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name,
              schema_version,
              last_sequence,
              updated_at
            )
            VALUES (
              'thread-projections',
              ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
              ${lastSequence},
              ${now}
            )
            ON CONFLICT(projection_name) DO UPDATE SET
              schema_version = excluded.schema_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
        }),
      );
      return yield* verify;
    });

    const mapError =
      (operation: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.mapError((cause) => new ProjectionMaintenanceError({ operation, cause })),
        );

    // Thread-state events whose payload is the complete thread: only the
    // newest per thread can influence a replay or an afterSequence catch-up.
    // thread.created stays out: verify derives the expected thread set from
    // it, and it anchors replay ordering. thread.deleted stays out too: the
    // shell stream and deletion consumers read the deletion itself.
    const SUPERSEDABLE_THREAD_EVENT_TYPES = [
      "thread.archived",
      "thread.unarchived",
      "thread.settled",
      "thread.unsettled",
      "thread.snoozed",
      "thread.unsnoozed",
      "thread.pinned",
      "thread.auto-settle-set",
      "thread.unpinned",
      "thread.pin-reordered",
      "thread.active-reordered",
      "thread.metadata-updated",
      "thread.pull-request-synced",
      "thread.runtime-mode-updated",
      "thread.interaction-mode-updated",
      "thread.model-selection-updated",
      "thread.provider-switched",
    ];
    // Read-state events keep the thread's activity time in a client's live
    // projection (they skip its updatedAt bump), so they supersede only each
    // other. Activity events supersede both groups.
    const READ_STATE_THREAD_EVENT_TYPES = ["thread.visited", "thread.marked-unread"];
    // Whole-entity snapshots keyed by payload id. turn-item.updated stays
    // intact because replay assigns positions on first write.
    const KEYED_EVENT_TYPES = ["message.updated", "node.updated"];

    const supersedableThreadEventTypes = new Set(SUPERSEDABLE_THREAD_EVENT_TYPES);
    const readStateThreadEventTypes = new Set(READ_STATE_THREAD_EVENT_TYPES);
    const candidateEventTypes = [
      ...SUPERSEDABLE_THREAD_EVENT_TYPES,
      ...READ_STATE_THREAD_EVENT_TYPES,
      ...KEYED_EVENT_TYPES,
    ];

    type ScannedEvent = {
      readonly sequence: number;
      readonly application_event_version: number;
      readonly aggregate_kind: string;
      readonly stream_id: string;
      readonly event_type: string;
      readonly entity_id: string | null;
      readonly stored_chars: number;
      readonly imported_legacy_thread: number;
    };
    type Obsolete = {
      readonly sequence: number;
      readonly eventType: string;
      readonly storedChars: number;
    };
    const obsoleteOf = (row: ScannedEvent): Obsolete => ({
      sequence: row.sequence,
      eventType: row.event_type,
      storedChars: row.stored_chars,
    });

    /**
     * Decides, newest first, which events a newer retained event supersedes.
     * Keyed snapshots keep their newest and their oldest event: the oldest
     * fixes where replay first inserts the entity, so rebuilt rows keep their
     * insertion order (and rowids) and a client catching up from before it
     * still sees the entity appear where it did.
     */
    const makeRetention = () => {
      const activityThreadIds = new Set<string>();
      const readStateThreadIds = new Set<string>();
      // null: only the newest is retained so far. Otherwise the oldest seen,
      // retained until an even older one appears.
      const oldestCandidateByEntityKey = new Map<string, Obsolete | null>();
      return (row: ScannedEvent): Obsolete | undefined => {
        if (row.imported_legacy_thread === 1) return obsoleteOf(row);
        if (row.application_event_version !== 2) return undefined;
        if (row.aggregate_kind === "thread" && supersedableThreadEventTypes.has(row.event_type)) {
          if (activityThreadIds.has(row.stream_id)) return obsoleteOf(row);
          activityThreadIds.add(row.stream_id);
          return undefined;
        }
        if (row.aggregate_kind === "thread" && readStateThreadEventTypes.has(row.event_type)) {
          if (activityThreadIds.has(row.stream_id) || readStateThreadIds.has(row.stream_id))
            return obsoleteOf(row);
          readStateThreadIds.add(row.stream_id);
          return undefined;
        }
        if (row.event_type === "message.updated" || row.event_type === "node.updated") {
          const key = encodeEntityKey([row.event_type, row.stream_id, row.entity_id]);
          const candidate = oldestCandidateByEntityKey.get(key);
          oldestCandidateByEntityKey.set(key, candidate === undefined ? null : obsoleteOf(row));
          return candidate ?? undefined;
        }
        return undefined;
      };
    };

    const compactEventStoreWith = (options: CompactEventStoreOptions = {}) =>
      Effect.gen(function* () {
        const pageSize = options.pageSize ?? COMPACTION_PAGE_SIZE;
        const dryRun = options.dryRun === true;
        const pause =
          options.pauseBetweenPages === undefined
            ? Effect.yieldNow
            : Effect.sleep(options.pauseBetweenPages);
        const bounds = yield* sql<{
          readonly event_sequence: number;
          readonly receipt_row_id: number;
        }>`
          SELECT
            COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0) AS event_sequence,
            COALESCE((SELECT MAX(rowid) FROM orchestration_command_receipts), 0) AS receipt_row_id
        `;
        const boundSequence = bounds[0]?.event_sequence ?? 0;
        let throughReceiptRowId = bounds[0]?.receipt_row_id ?? 0;
        let deletedEventCount = 0;
        let deletedEventChars = 0;
        let deletedReceiptCount = 0;
        let scannedEventCount = 0;
        let interrupted = false;
        const deletedByType: Record<string, number> = {};

        /** Runs one delete statement unless `mayDelete` refuses it; false when refused. */
        const deleteChecked = <A, E, R>(statement: Effect.Effect<A, E, R>) =>
          options.mayDelete === undefined
            ? Effect.as(statement, true)
            : sql.withTransaction(
                Effect.suspend(() => {
                  if (options.mayDelete?.() === false) {
                    interrupted = true;
                    return Effect.succeed(false);
                  }
                  return Effect.as(statement, true);
                }),
              );

        /** Deletes one page's obsolete events in one statement; false once told to stop. */
        const remove = (obsolete: ReadonlyArray<Obsolete>) =>
          Effect.gen(function* () {
            if (obsolete.length === 0) return true;
            if (options.shouldContinue !== undefined && !(yield* options.shouldContinue)) {
              interrupted = true;
              return false;
            }
            if (
              !dryRun &&
              !(yield* deleteChecked(
                sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(
                  obsolete.map((entry) => entry.sequence),
                )}`,
              ))
            ) {
              return false;
            }
            deletedEventCount += obsolete.length;
            for (const entry of obsolete) {
              deletedEventChars += entry.storedChars;
              deletedByType[entry.eventType] = (deletedByType[entry.eventType] ?? 0) + 1;
            }
            yield* Effect.yieldNow;
            return true;
          });

        const selectColumns = sql`
          event.sequence,
          event.application_event_version,
          event.aggregate_kind,
          event.stream_id,
          event.event_type,
          CASE
            WHEN event.application_event_version = 2
              AND event.event_type IN ('message.updated', 'node.updated')
            THEN json_extract(event.payload_json, '$.id')
            ELSE NULL
          END AS entity_id,
          CASE
            WHEN event.application_event_version = 1
              OR event.event_type IN ${sql.in(candidateEventTypes)}
            THEN length(event.payload_json) + length(event.metadata_json)
            ELSE 0
          END AS stored_chars,
          CASE
            WHEN event.application_event_version = 1 AND event.aggregate_kind = 'thread'
            THEN EXISTS (
              SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
              WHERE legacy_import.thread_id = event.stream_id
                AND legacy_import.transcript_imported_at IS NOT NULL
            )
            ELSE 0
          END AS imported_legacy_thread
        `;

        /**
         * Pages events newest first through `readPage`, every event including
         * non-candidates: filtering before LIMIT could still scan the entire
         * history when superseded events are sparse. Payloads are read only for
         * candidates, so a page of turn items stays cheap.
         */
        const scan = (
          readPage: (through: number) => Effect.Effect<ReadonlyArray<ScannedEvent>, SqlError>,
        ) =>
          Effect.gen(function* () {
            const retain = makeRetention();
            let through = boundSequence;
            while (through > 0) {
              const rows = yield* readPage(through);
              scannedEventCount += rows.length;
              const obsolete: Obsolete[] = [];
              for (const row of rows) {
                const entry = retain(row);
                if (entry !== undefined) obsolete.push(entry);
              }
              // Discovery and deletion share the synchronous connection. Yield
              // even when nothing is deleted so requests can progress.
              yield* pause;
              if (!(yield* remove(obsolete))) return;
              through = (rows.at(-1)?.sequence ?? 1) - 1;
              if (rows.length < pageSize) return;
            }
          });

        const readGlobalPage = (through: number) =>
          sql<ScannedEvent>`
            SELECT ${selectColumns}
            FROM orchestration_events AS event
            WHERE event.sequence <= ${through}
            ORDER BY event.sequence DESC
            LIMIT ${pageSize}
          `;
        const readStreamPage = (streamId: string) => (through: number) =>
          sql<ScannedEvent>`
            SELECT ${selectColumns}
            FROM orchestration_events AS event INDEXED BY idx_orch_events_stream_sequence
            WHERE event.aggregate_kind = 'thread'
              AND event.stream_id = ${streamId}
              AND event.sequence <= ${through}
            ORDER BY event.sequence DESC
            LIMIT ${pageSize}
          `;

        const since = options.sinceSequence ?? 0;
        let scannedStreamCount: number | null = null;
        // A cursor past the log's end belongs to another database (a restored
        // copy): read everything again.
        if (since <= 0 || since > boundSequence) {
          yield* scan(readGlobalPage);
        } else {
          // Every key includes its stream, so a stream with no event after
          // `since` has nothing newer to supersede what the last pass kept.
          // Only streams that changed, and imported legacy threads, are read.
          const touched = yield* sql<{ readonly stream_id: string }>`
            SELECT DISTINCT stream_id
            FROM orchestration_events
            WHERE sequence > ${since}
              AND sequence <= ${boundSequence}
              AND aggregate_kind = 'thread'
            UNION
            SELECT DISTINCT event.stream_id
            FROM orchestration_events AS event
              INDEXED BY idx_orchestration_events_application_sequence
            WHERE event.application_event_version = 1
              AND event.aggregate_kind = 'thread'
              AND EXISTS (
                SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
                WHERE legacy_import.thread_id = event.stream_id
                  AND legacy_import.transcript_imported_at IS NOT NULL
              )
          `;
          scannedStreamCount = touched.length;
          for (const row of touched) {
            if (interrupted) break;
            yield* scan(readStreamPage(row.stream_id));
          }
        }

        // Legacy receipts are removable only after their thread's v1 import finishes.
        // Page by rowid before checking eligibility, as with event discovery above.
        while (throughReceiptRowId > 0 && !interrupted) {
          const rows = yield* sql<{
            readonly row_id: number;
            readonly command_id: string;
            readonly imported_legacy_thread: number;
          }>`
            SELECT
              receipt.rowid AS row_id,
              receipt.command_id,
              CASE
                WHEN receipt.command_type = 'legacy' AND receipt.aggregate_kind = 'thread'
                THEN EXISTS (
                  SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
                  WHERE legacy_import.thread_id = receipt.aggregate_id
                    AND legacy_import.transcript_imported_at IS NOT NULL
                )
                ELSE 0
              END AS imported_legacy_thread
            FROM orchestration_command_receipts AS receipt
            WHERE receipt.rowid <= ${throughReceiptRowId}
            ORDER BY receipt.rowid DESC
            LIMIT ${COMPACTION_RECEIPT_PAGE_SIZE}
          `;
          const obsolete = rows
            .filter((row) => row.imported_legacy_thread === 1)
            .map((row) => row.command_id);
          yield* pause;
          if (obsolete.length > 0) {
            if (options.shouldContinue !== undefined && !(yield* options.shouldContinue)) {
              interrupted = true;
              break;
            }
            if (
              !dryRun &&
              !(yield* deleteChecked(
                sql`DELETE FROM orchestration_command_receipts WHERE command_id IN ${sql.in(obsolete)}`,
              ))
            ) {
              break;
            }
            deletedReceiptCount += obsolete.length;
            yield* Effect.yieldNow;
          }
          throughReceiptRowId = (rows.at(-1)?.row_id ?? 1) - 1;
          if (rows.length < COMPACTION_RECEIPT_PAGE_SIZE) break;
        }

        const freelistRows = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
        const pageSizeRows = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
        const reclaimableBytes =
          (freelistRows[0]?.freelist_count ?? 0) * (pageSizeRows[0]?.page_size ?? 0);

        return {
          deletedEventCount,
          deletedReceiptCount,
          reclaimableBytes,
          deletedEventChars,
          deletedByType,
          scannedEventCount,
          scannedStreamCount,
          throughSequence: boundSequence,
          interrupted,
          dryRun,
        } satisfies CompactEventStoreResult;
      });
    return ProjectionMaintenanceV2.of({
      verify: mapError("verify")(verify),
      rebuild: mapError("rebuild")(rebuild),
      compactEventStore: mapError("compact event store")(compactEventStoreWith()),
      compactEventStoreWith: (options) =>
        mapError("compact event store")(compactEventStoreWith(options)),
    });
  }),
);
