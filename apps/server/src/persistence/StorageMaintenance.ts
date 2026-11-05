/**
 * Background compaction of the state database's event log.
 *
 * Every `COMPACTION_INTERVAL_MS` (and once `FIRST_CHECK_DELAY_MS` after start)
 * the service deletes events a newer retained event supersedes
 * (`ProjectionMaintenanceV2.compactEventStoreWith`): node and message
 * snapshots between each entity's oldest and newest, thread-state snapshots
 * before the thread's newest, and imported legacy history. When it completes,
 * `storage-maintenance.json` beside the database records when and through
 * which sequence, so a restart neither repeats the pass early nor reads the
 * whole log again: the next pass reads only the threads that changed since,
 * with a full pass at least every `FULL_PASS_INTERVAL_MS` as a backstop.
 *
 * Never during an update. The update helper proves that no log row below its
 * boundary changed across the restart (`scripts/studio-fleet/after_proof.py`,
 * `old-log-row-changed`), and its page proof tracks which pages moved. So
 * nothing here deletes a row or moves a page while an update helper's snapshot
 * marker is live (`update.py` writes it before every snapshot and apply, held
 * or not), while the service is held for an update or the helper's install
 * gate is live (`isHeld`), while an install request is open, or while an
 * automatic install waits for quiet or installs.
 * The check runs before every delete and every reclaim step, not only when a
 * pass starts. Right before each statement, holding the connection, the
 * marker and the install gate files are also read again synchronously and
 * uncached, so no delete starts after the helper wrote either one; each delete
 * is one page, so it commits well within the helper's settle time. A pass that
 * meets an update stops and is retried later.
 *
 * Each pass, and each check between passes, also deletes auth rows nothing can
 * use again (`AuthRowPruning`: sessions and pairing links revoked or expired
 * over a week ago, never a renewable worker grant), in batches behind the same
 * per-statement gate. The update helper hashes those tables too.
 *
 * Deleted pages go to the free list, where new writes reuse them. Only a
 * database with `auto_vacuum = INCREMENTAL` returns them to the file system
 * here, in small `incremental_vacuum` steps; see `specweave-studio db reclaim`
 * for why that mode is opt-in.
 *
 * After a completed pass the same pass applies the owner's history retention
 * (Settings > Storage, `storageCleanup.deletedThreadHistoryAfterDays`,
 * `archivedThreadHistoryAfterDays` and `threadHistoryDays`; on by default at
 * 7, 2 and 7 days, null turns each off): it purges old deleted threads, drops
 * old archived threads' events and folds every other thread's events older
 * than the horizon into its projection rows (ThreadHistoryRetention.ts), for
 * up to RETENTION_PASS_BUDGET_MS per pass, behind the same update checks
 * before every delete. A pass every COMPACTION_INTERVAL_MS (30 minutes) also
 * removes a finished turn's running snapshots soon, so the file's high-water
 * mark stays low.
 *
 * With history retention on, the pass then caps tool bodies saved before the
 * write-time cap existed (TurnItemBodyRecap.ts): old command and tool items'
 * projection rows only, never the event log, behind the same checks before
 * every update and within what retention left of RETENTION_PASS_BUDGET_MS. Its cursor is kept in
 * `storage-maintenance.json`, so each pass resumes where the last stopped; a
 * cycle that reached the table's end starts over after RECAP_CYCLE_INTERVAL_MS.
 *
 * Active runs do not stop a pass. Every statement shares the server's one
 * connection, so a delete never interleaves with an event write, and a
 * deleted event always has a newer retained one for the same entity: a
 * replay, an `afterSequence` catch-up and a live subscriber reach the same
 * state. Passes read in pages of `COMPACTION_PAGE_SIZE` with a short pause
 * between them so requests keep flowing.
 *
 * @module StorageMaintenance
 */
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the check right before each delete must not yield, so it reads the files synchronously.
import * as NodeFS from "node:fs";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as AuthRowPruning from "./AuthRowPruning.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ThreadHistoryRetention from "../orchestration-v2/ThreadHistoryRetention.ts";
import * as TurnItemBodyRecap from "../orchestration-v2/TurnItemBodyRecap.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import * as UpdateInstallGate from "../serviceUpdate/UpdateInstallGate.ts";

/** Incremental passes read only threads that changed, so they can run often. */
export const COMPACTION_INTERVAL_MS = 30 * 60_000;
/** A full pass reads the whole log; incremental passes read changed threads only. */
export const FULL_PASS_INTERVAL_MS = 7 * 24 * 60 * 60_000;
/** After start: long enough for startup reads and the update helper's checks to finish. */
export const FIRST_CHECK_DELAY_MS = 10 * 60_000;
/** How often the service checks whether a pass is due, or was blocked last time. */
export const CHECK_INTERVAL_MS = 10 * 60_000;
/** Pause between discovery pages of a background pass. */
export const PAGE_PAUSE_MS = 2;
/** Pages one `incremental_vacuum` statement frees, and the most one reclaim pass frees. */
export const RECLAIM_PAGES_PER_STEP = 64;
export const RECLAIM_MAX_PAGES_PER_PASS = 16_384;
/** How long a gate reading is reused inside one pass. */
export const GATE_CACHE_MS = 1_000;
export const STATE_FILE = "storage-maintenance.json";
/** After a body-recap cycle reached the end, the next one starts this much later. */
export const RECAP_CYCLE_INTERVAL_MS = 24 * 60 * 60_000;

/** Why database maintenance must wait, or null when it may run. */
export type MaintenanceBlocker =
  | "update-hold"
  | "update-snapshot"
  | "install-request"
  | "install-underway";

/**
 * `updates/database-snapshot.json`: `scripts/studio-fleet/update.py` writes it
 * before every snapshot and apply, whoever runs it (the update agent, an
 * install request, `remote_update.py`), and removes it when the apply ends.
 * `update.py` SNAPSHOT_MARKER_FILE.
 */
export const SNAPSHOT_MARKER_FILE = "database-snapshot.json";
/** A marker no apply removed lapses: `update.py` SNAPSHOT_MARKER_MAX_SECONDS. */
export const SNAPSHOT_MARKER_MAX_MS = 2 * 60 * 60_000;
const SNAPSHOT_MARKER_FUTURE_SKEW_MS = 60_000;

const SnapshotMarker = Schema.Struct({ at: Schema.String });
const decodeSnapshotMarker = Schema.decodeUnknownOption(Schema.fromJsonString(SnapshotMarker));

/**
 * Whether a marker with this text is live at `nowMs`. A marker being written,
 * or a broken one, counts until it lapses by its file time (`mtimeMs`).
 */
export const snapshotMarkerLive = (text: string, mtimeMs: number | null, nowMs: number) => {
  const at = Option.flatMap(decodeSnapshotMarker(text), (marker) =>
    Option.map(DateTime.make(marker.at), DateTime.toEpochMillis),
  );
  const atMs = Option.getOrElse(at, () => mtimeMs ?? Number.NaN);
  const age = nowMs - atMs;
  return age >= -SNAPSHOT_MARKER_FUTURE_SKEW_MS && age < SNAPSHOT_MARKER_MAX_MS;
};

/** Whether an update helper took, or is applying, a snapshot of the database. */
export const databaseSnapshotPending = (markerPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(markerPath).pipe(Effect.option);
    if (Option.isNone(text)) return false;
    const mtimeMs = yield* fs.stat(markerPath).pipe(
      Effect.map((info) => Option.getOrNull(Option.map(info.mtime, (mtime) => mtime.getTime()))),
      Effect.orElseSucceed(() => null),
    );
    return snapshotMarkerLive(text.value, mtimeMs, yield* Clock.currentTimeMillis);
  });

const readTextSync = (file: string): string | null => {
  try {
    return NodeFS.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
const mtimeSync = (file: string): number | null => {
  try {
    return NodeFS.statSync(file).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * The update helper's files, read synchronously and uncached: its snapshot
 * marker and its install gate. Called right before each delete statement, in
 * the same synchronous step, so no write starts after either file appears.
 */
export const updateFilesBlockerSync = (input: {
  readonly snapshotMarkerPath?: string | undefined;
  readonly installGatePath?: string | undefined;
  readonly nowMs: number;
  readonly bootMs: number | null;
  readonly isAlive: (pid: number) => boolean;
}): MaintenanceBlocker | null => {
  if (input.snapshotMarkerPath !== undefined) {
    const text = readTextSync(input.snapshotMarkerPath);
    if (
      text !== null &&
      snapshotMarkerLive(text, mtimeSync(input.snapshotMarkerPath), input.nowMs)
    ) {
      return "update-snapshot";
    }
  }
  if (input.installGatePath !== undefined) {
    const text = readTextSync(input.installGatePath);
    if (
      text !== null &&
      UpdateInstallGate.installGateUntil({
        marker: UpdateInstallGate.parseInstallGate(text),
        mtimeMs: mtimeSync(input.installGatePath),
        nowMs: input.nowMs,
        bootMs: input.bootMs,
        isAlive: input.isAlive,
      }) !== null
    ) {
      return "update-hold";
    }
  }
  return null;
};

/**
 * Reads the update hold the way a background pass needs it. Without a hold in
 * the service graph (tests, tools) nothing blocks.
 */
export const updateBlocker = <R = never>(
  hold: Option.Option<ServiceUpdateHold.ServiceUpdateHoldShape>,
  snapshotPending: Effect.Effect<boolean, never, R> = Effect.succeed(false),
): Effect.Effect<MaintenanceBlocker | null, never, R> =>
  Effect.gen(function* () {
    // An update helper's snapshot: its checks after the restart compare the log with it.
    if (yield* snapshotPending) return "update-snapshot";
    if (Option.isNone(hold)) return null;
    // Held for an update, or gated by the helper after the restart.
    if (yield* hold.value.isHeld) return "update-hold";
    // A forced request need not hold the service, and its snapshot is the before-read.
    if (yield* hold.value.installRequestOpen) return "install-request";
    // An automatic install snapshots while it waits for quiet, then installs.
    if (yield* hold.value.automaticInstallUnderway) return "install-underway";
    return null;
  });

const PersistedState = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  /** When the last pass completed. */
  completedAt: Schema.String,
  /** When the last full pass completed. */
  fullPassAt: Schema.String,
  /** The log's last sequence when the last pass began. */
  throughSequence: Schema.Number,
  /** Where the old tool-body cap stands (TurnItemBodyRecap). */
  bodyRecap: Schema.optionalKey(
    Schema.Struct({
      /** Rowid the last pass stopped after; 0 once a cycle completed. */
      afterRowid: Schema.Number,
      /** When the last cycle reached the end; null while the first runs. */
      cycleCompletedAt: Schema.NullOr(Schema.String),
      /** Rows capped since the first cycle began. */
      cappedItemCount: Schema.Number,
    }),
  ),
});
type PersistedState = typeof PersistedState.Type;
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(PersistedState));
const encodeState = Schema.encodeSync(Schema.fromJsonString(PersistedState));

export interface StorageMaintenanceRun {
  readonly status: "completed" | "skipped" | "interrupted" | "not-due";
  readonly blocker: MaintenanceBlocker | null;
  readonly mode: "full" | "incremental" | null;
  readonly compaction: ProjectionMaintenance.CompactEventStoreResult | null;
  /** Expired and revoked auth rows deleted; null when the pass never reached that step. */
  readonly authPruning: AuthRowPruning.PruneAuthRowsResult | null;
  /** Thread history retention after the pass; null when off or not reached. */
  readonly retention: ThreadHistoryRetention.ThreadHistoryRetentionResult | null;
  /** Old tool bodies capped after retention; null when off, not due or not reached. */
  readonly bodyRecap: TurnItemBodyRecap.TurnItemBodyRecapResult | null;
  readonly reclaimedPages: number;
}

export interface StorageMaintenanceOptions {
  readonly statePath: string;
  /** `updates/database-snapshot.json` of this home; none in tests that pass none. */
  readonly snapshotMarkerPath?: string;
  /** `updates/install-gate.json` of this home, read right before each delete. */
  readonly installGatePath?: string;
  /** For the install gate: when the machine started, and whether a helper pid runs. */
  readonly bootMs?: number | null;
  readonly isAlive?: (pid: number) => boolean;
  readonly intervalMs?: number;
  readonly fullPassIntervalMs?: number;
  readonly pagePause?: Duration.Input;
  /** How long an expired or revoked auth row stays: AuthRowPruning.AUTH_ROW_RETENTION_MS. */
  readonly authRowRetentionMs?: number;
  /** Wall-clock budget of the retention step of one pass (ThreadHistoryRetention). */
  readonly retentionBudgetMs?: number;
  /** The owner's retention choice, read at each pass; absent or off retains everything. */
  readonly retentionPolicy?: Effect.Effect<ThreadHistoryRetention.ThreadHistoryRetentionPolicy>;
  /** Removes a purged thread's attachment files. */
  readonly removeAttachments?: (attachmentIds: ReadonlyArray<string>) => Effect.Effect<void>;
}

/** After 25 ms of work, rest nine times its duration, outside the connection lock. */
export const makeCompactionPacer = Effect.gen(function* () {
  let sliceStarted = yield* Clock.monotonicTimeNanos;
  return Effect.gen(function* () {
    const elapsed = (yield* Clock.monotonicTimeNanos) - sliceStarted;
    if (elapsed < 25_000_000n) return;
    yield* Effect.sleep((Number(elapsed) / 1_000_000) * 9);
    sliceStarted = yield* Clock.monotonicTimeNanos;
  });
});

export const make = (options: StorageMaintenanceOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const hold = yield* Effect.serviceOption(ServiceUpdateHold.ServiceUpdateHold);
    const intervalMs = options.intervalMs ?? COMPACTION_INTERVAL_MS;
    const fullPassIntervalMs = options.fullPassIntervalMs ?? FULL_PASS_INTERVAL_MS;
    const pagePause = options.pagePause ?? Duration.millis(PAGE_PAUSE_MS);
    const permit = yield* Semaphore.make(1);
    const clock = yield* Clock.Clock;
    const bootMs =
      options.bootMs === undefined ? UpdateInstallGate.machineBootMs() : options.bootMs;
    const isAlive = options.isAlive ?? UpdateInstallGate.isHelperRunning;

    const snapshotMarkerPath = options.snapshotMarkerPath;
    const blocker = updateBlocker(
      hold,
      snapshotMarkerPath === undefined
        ? Effect.succeed(false)
        : databaseSnapshotPending(snapshotMarkerPath).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
          ),
    );
    /** `blocker`, read again at most every GATE_CACHE_MS; remembers the first refusal. */
    const makeGate = Effect.sync(() => {
      let checkedAt = Number.NEGATIVE_INFINITY;
      let reason: MaintenanceBlocker | null = null;
      const check = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (reason === null && now - checkedAt >= GATE_CACHE_MS) {
          reason = yield* blocker;
          checkedAt = now;
        }
        return reason === null;
      });
      /** Synchronous and uncached: runs right before each delete statement. */
      const mayDelete = () => {
        if (reason !== null) return false;
        reason = updateFilesBlockerSync({
          snapshotMarkerPath,
          installGatePath: options.installGatePath,
          nowMs: clock.currentTimeMillisUnsafe(),
          bootMs,
          isAlive,
        });
        return reason === null;
      };
      return { check, mayDelete, reason: () => reason };
    });

    const readState = fs.readFileString(options.statePath).pipe(
      Effect.map(decodeState),
      Effect.orElseSucceed(() => Option.none<PersistedState>()),
    );
    const writeState = (state: PersistedState) =>
      Effect.gen(function* () {
        const temporary = `${options.statePath}.tmp`;
        yield* fs.makeDirectory(path.dirname(options.statePath), { recursive: true });
        yield* fs.writeFileString(temporary, encodeState(state));
        yield* fs.rename(temporary, options.statePath);
      });

    const epochOf = (iso: string) =>
      Option.getOrElse(Option.map(DateTime.make(iso), DateTime.toEpochMillis), () => 0);

    /** Frees up to RECLAIM_MAX_PAGES_PER_PASS pages; only on an incremental auto_vacuum database. */
    const reclaimWith = (gate: {
      readonly check: Effect.Effect<boolean>;
      readonly mayDelete: () => boolean;
    }) =>
      Effect.gen(function* () {
        const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
        if (mode[0]?.auto_vacuum !== 2) return 0;
        const freePages = Effect.map(
          sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`,
          (rows) => rows[0]?.freelist_count ?? 0,
        );
        let reclaimed = 0;
        while (reclaimed < RECLAIM_MAX_PAGES_PER_PASS) {
          const pages = Math.min(
            yield* freePages,
            RECLAIM_PAGES_PER_STEP,
            RECLAIM_MAX_PAGES_PER_PASS - reclaimed,
          );
          if (pages === 0 || !(yield* gate.check)) break;
          // Counted from the free list itself, read on the same connection around the step.
          const freed = yield* sql.withTransaction(
            Effect.gen(function* () {
              if (!gate.mayDelete()) return 0;
              const before = yield* freePages;
              yield* sql.unsafe(`PRAGMA incremental_vacuum(${pages})`);
              return before - (yield* freePages);
            }),
          );
          if (freed <= 0) break;
          reclaimed += freed;
          yield* Effect.sleep(pagePause);
        }
        return reclaimed;
      });

    /** Deletes dead auth rows in batches; stops, like compaction, when an update begins. */
    const pruneAuthWith = (gate: {
      readonly check: Effect.Effect<boolean>;
      readonly mayDelete: () => boolean;
      readonly reason: () => MaintenanceBlocker | null;
    }) =>
      Effect.gen(function* () {
        if (!(yield* gate.check)) return null;
        const startedAt = yield* Clock.currentTimeMillis;
        const result = yield* AuthRowPruning.pruneAuthRows({
          cutoff: AuthRowPruning.authPruneCutoff(
            startedAt,
            options.authRowRetentionMs ?? AuthRowPruning.AUTH_ROW_RETENTION_MS,
          ),
          shouldContinue: gate.check,
          mayDelete: gate.mayDelete,
          betweenBatches: yield* makeCompactionPacer,
          pauseBetweenBatches: pagePause,
        });
        if (
          result.deletedSessionCount > 0 ||
          result.deletedPairingLinkCount > 0 ||
          result.interrupted
        )
          yield* Effect.logInfo("storage-maintenance.auth-rows.pruned", {
            ...result,
            blocker: gate.reason(),
            elapsedMs: (yield* Clock.currentTimeMillis) - startedAt,
          });
        return result;
      });

    /** The owner's retention, behind the pass's gate; null when it is off. */
    const runRetention = (gate: {
      readonly check: Effect.Effect<boolean>;
      readonly mayDelete: () => boolean;
      readonly reason: () => MaintenanceBlocker | null;
    }) =>
      Effect.gen(function* () {
        const policy =
          options.retentionPolicy === undefined
            ? ThreadHistoryRetention.RETENTION_OFF
            : yield* options.retentionPolicy;
        if (!ThreadHistoryRetention.retentionEnabled(policy)) return null;
        const startedAt = yield* Clock.currentTimeMillis;
        const result = yield* ThreadHistoryRetention.runThreadHistoryRetention({
          policy,
          nowMs: startedAt,
          shouldContinue: gate.check,
          mayDelete: gate.mayDelete,
          betweenBatches: Effect.andThen(Effect.sleep(pagePause), yield* makeCompactionPacer),
          timeBudgetMs:
            options.retentionBudgetMs ?? ThreadHistoryRetention.RETENTION_PASS_BUDGET_MS,
          ...(options.removeAttachments === undefined
            ? {}
            : { removeAttachments: options.removeAttachments }),
        });
        yield* Effect.logInfo("storage-maintenance.retention.completed", {
          purgedThreadCount: result.purgedThreadCount,
          compactedThreadCount: result.compactedThreadCount,
          foldedThreadCount: result.foldedThreadCount,
          budgetExhausted: result.budgetExhausted,
          deferredThreadCount: result.deferredThreadCount,
          skipped: result.skipped,
          deletedEventCount: result.deletedEventCount,
          deletedRowsByTable: result.deletedRowsByTable,
          interrupted: result.interrupted,
          blocker: gate.reason(),
          elapsedMs: (yield* Clock.currentTimeMillis) - startedAt,
        });
        return result;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("storage-maintenance.retention.failed", { cause }).pipe(
            Effect.as(null),
          ),
        ),
      );

    /**
     * Caps old tool bodies with the write path's cap, behind the pass's gate;
     * null when retention is off or the next cycle is not due yet.
     */
    const runBodyRecap = (
      gate: {
        readonly check: Effect.Effect<boolean>;
        readonly mayDelete: () => boolean;
        readonly reason: () => MaintenanceBlocker | null;
      },
      budgetMs: number,
    ) =>
      Effect.gen(function* () {
        if (budgetMs <= 0) return null;
        const policy =
          options.retentionPolicy === undefined
            ? ThreadHistoryRetention.RETENTION_OFF
            : yield* options.retentionPolicy;
        if (!ThreadHistoryRetention.retentionEnabled(policy)) return null;
        if (!(yield* gate.check)) return null;
        const state = yield* readState;
        if (Option.isNone(state)) return null;
        const startedAt = yield* Clock.currentTimeMillis;
        const previous = state.value.bodyRecap;
        if (
          previous !== undefined &&
          previous.afterRowid === 0 &&
          previous.cycleCompletedAt !== null &&
          startedAt - epochOf(previous.cycleCompletedAt) < RECAP_CYCLE_INTERVAL_MS
        ) {
          return null;
        }
        const result = yield* TurnItemBodyRecap.runTurnItemBodyRecap({
          historyDays: policy.historyDays,
          nowMs: startedAt,
          afterRowid: previous?.afterRowid ?? 0,
          shouldContinue: gate.check,
          mayDelete: gate.mayDelete,
          betweenBatches: Effect.andThen(Effect.sleep(pagePause), yield* makeCompactionPacer),
          timeBudgetMs: budgetMs,
        });
        const completedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
        yield* writeState({
          ...state.value,
          bodyRecap: {
            afterRowid: result.reachedEnd ? 0 : result.throughRowid,
            cycleCompletedAt: result.reachedEnd
              ? completedAt
              : (previous?.cycleCompletedAt ?? null),
            cappedItemCount: (previous?.cappedItemCount ?? 0) + result.cappedItemCount,
          },
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("storage-maintenance.state.write-failed", { cause }),
          ),
        );
        yield* Effect.logInfo("storage-maintenance.body-recap.completed", {
          ...result,
          blocker: gate.reason(),
          elapsedMs: (yield* Clock.currentTimeMillis) - startedAt,
        });
        return result;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("storage-maintenance.body-recap.failed", { cause }).pipe(
            Effect.as(null),
          ),
        ),
      );

    /** One pass now, whether due or not; still never while an update blocks it. */
    const runNow = (input?: { readonly forceFull?: boolean }) =>
      permit.withPermit(
        Effect.gen(function* () {
          const gate = yield* makeGate;
          if (!(yield* gate.check)) {
            return {
              status: "skipped",
              blocker: gate.reason(),
              mode: null,
              compaction: null,
              authPruning: null,
              retention: null,
              bodyRecap: null,
              reclaimedPages: 0,
            } satisfies StorageMaintenanceRun;
          }
          const now = yield* Clock.currentTimeMillis;
          const state = yield* readState;
          const full =
            input?.forceFull === true ||
            Option.isNone(state) ||
            now - epochOf(state.value.fullPassAt) >= fullPassIntervalMs;
          const startedAt = yield* Clock.currentTimeMillis;
          const betweenPages = yield* makeCompactionPacer;
          const compaction = yield* maintenance.compactEventStoreWith({
            betweenPages,
            pageSize: 50,
            sinceSequence: full || Option.isNone(state) ? 0 : state.value.throughSequence,
            shouldContinue: gate.check,
            mayDelete: gate.mayDelete,
            pauseBetweenPages: pagePause,
          });
          const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
          if (compaction.interrupted) {
            yield* Effect.logInfo("storage-maintenance.compaction.interrupted", {
              blocker: gate.reason(),
              deletedEventCount: compaction.deletedEventCount,
              elapsedMs,
            });
            return {
              status: "interrupted",
              blocker: gate.reason(),
              mode: full ? "full" : "incremental",
              compaction,
              authPruning: null,
              retention: null,
              bodyRecap: null,
              reclaimedPages: 0,
            } satisfies StorageMaintenanceRun;
          }
          const completedAt = DateTime.formatIso(
            DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
          );
          yield* writeState({
            schemaVersion: 1,
            completedAt,
            fullPassAt: full || Option.isNone(state) ? completedAt : state.value.fullPassAt,
            throughSequence: compaction.throughSequence,
            ...(Option.isSome(state) && state.value.bodyRecap !== undefined
              ? { bodyRecap: state.value.bodyRecap }
              : {}),
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("storage-maintenance.state.write-failed", { cause }),
            ),
          );
          const authPruning = yield* pruneAuthWith(gate);
          const retentionStartedAt = yield* Clock.currentTimeMillis;
          const retention = yield* runRetention(gate);
          // Retention and the recap share one budget, so a pass holds the permit no longer than before.
          const bodyRecap = yield* runBodyRecap(
            gate,
            (options.retentionBudgetMs ?? ThreadHistoryRetention.RETENTION_PASS_BUDGET_MS) -
              ((yield* Clock.currentTimeMillis) - retentionStartedAt),
          );
          const reclaimedPages = yield* reclaimWith(gate);
          yield* Effect.logInfo("storage-maintenance.compaction.completed", {
            mode: full ? "full" : "incremental",
            deletedEventCount: compaction.deletedEventCount,
            deletedReceiptCount: compaction.deletedReceiptCount,
            deletedEventChars: compaction.deletedEventChars,
            deletedByType: compaction.deletedByType,
            scannedEventCount: compaction.scannedEventCount,
            scannedStreamCount: compaction.scannedStreamCount,
            reclaimableBytes: compaction.reclaimableBytes,
            reclaimedPages,
            elapsedMs,
          });
          return {
            status: "completed",
            blocker: gate.reason(),
            mode: full ? "full" : "incremental",
            compaction,
            authPruning,
            retention,
            bodyRecap,
            reclaimedPages,
          } satisfies StorageMaintenanceRun;
        }),
      );

    /** A pass when the last completed one is `intervalMs` old; otherwise only a reclaim step. */
    const runIfDue = Effect.gen(function* () {
      const state = yield* readState;
      const now = yield* Clock.currentTimeMillis;
      if (Option.isSome(state) && now - epochOf(state.value.completedAt) < intervalMs) {
        const gate = yield* makeGate;
        const { authPruning, reclaimedPages } = yield* permit.withPermit(
          Effect.gen(function* () {
            const authPruning = yield* pruneAuthWith(gate);
            return { authPruning, reclaimedPages: yield* reclaimWith(gate) };
          }),
        );
        return {
          status: "not-due",
          blocker: gate.reason(),
          mode: null,
          compaction: null,
          authPruning,
          retention: null,
          bodyRecap: null,
          reclaimedPages,
        } satisfies StorageMaintenanceRun;
      }
      return yield* runNow();
    });

    return {
      runNow,
      runIfDue,
      blocker,
      /** Only the auth-row step, under the same gate: for tests and tools. */
      pruneAuthRows: permit.withPermit(Effect.flatMap(makeGate, pruneAuthWith)),
    } as const;
  });

/** Starts the schedule in the server: first check after FIRST_CHECK_DELAY_MS, then every CHECK_INTERVAL_MS. */
export const layerStart = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    const service = yield* make({
      statePath: path.join(path.dirname(config.dbPath), STATE_FILE),
      snapshotMarkerPath: path.join(config.baseDir, "updates", SNAPSHOT_MARKER_FILE),
      installGatePath: path.join(config.baseDir, "updates", UpdateInstallGate.INSTALL_GATE_FILE),
      retentionPolicy: Option.match(settings, {
        onNone: () => Effect.succeed(ThreadHistoryRetention.RETENTION_OFF),
        onSome: (service) =>
          service.getSettings.pipe(
            Effect.map(({ storageCleanup }) => ({
              deletedAfterDays: storageCleanup.deletedThreadHistoryAfterDays,
              archivedAfterDays: storageCleanup.archivedThreadHistoryAfterDays,
              historyDays: storageCleanup.threadHistoryDays,
            })),
            Effect.orElseSucceed(() => ThreadHistoryRetention.RETENTION_OFF),
          ),
      }),
      removeAttachments: (attachmentIds) =>
        Effect.forEach(
          attachmentIds,
          (attachmentId) => {
            const file = resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId,
            });
            return file === null ? Effect.void : Effect.ignore(fs.remove(file, { force: true }));
          },
          { discard: true },
        ),
    });
    yield* forkParked(
      Effect.sleep(Duration.millis(FIRST_CHECK_DELAY_MS)).pipe(
        Effect.andThen(
          service.runIfDue.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("storage-maintenance.failed", { cause }),
            ),
            Effect.andThen(Effect.sleep(Duration.millis(CHECK_INTERVAL_MS))),
            Effect.forever,
          ),
        ),
      ),
    );
  }),
);
