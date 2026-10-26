/**
 * Offline reclaim of the state database: `specweave-studio db reclaim`.
 *
 * Deleting events (StorageMaintenance) frees pages inside the file; only a
 * rewrite returns them to the disk. With the service stopped, this:
 *
 * 1. refuses while the service runs (its runtime state names a live pid) or an
 *    update is under way (StorageMaintenance.updateBlocker over `updates/`,
 *    or the update agent reports a busy status);
 * 2. takes an exclusive lock, which SQLite refuses while any other connection
 *    has the file open, even an idle one;
 * 3. checks the file (`PRAGMA quick_check`) and its projections (`verify`);
 * 4. compacts the event log in full and checks the projections again;
 * 5. writes a rewritten copy with `VACUUM INTO` (into `workDir` when given),
 *    in the current auto_vacuum mode, or INCREMENTAL with `incremental`;
 * 6. checks the copy: quick_check, its auto_vacuum mode, every table's row
 *    count, the log's sequences (event ids with their sequence, the last
 *    sequence, `sqlite_sequence`), and checksums of every projection and log
 *    table with rowids;
 * 7. closes the database, then takes exclusive locks on it and on the copy,
 *    refuses again if any connection, the service or an update started, and,
 *    holding both and uninterruptibly, hard-links the original to
 *    `statev2.sqlite.before-reclaim-<time>` beside it and renames the copy
 *    over it in one step (on a volume without hard links, two renames, the
 *    original put back if the second fails). Before that it syncs a copy
 *    made across volumes to disk, and checks, under the copy's lock, its last
 *    sequence and empty log (`wal_checkpoint(TRUNCATE)`): once the locks go,
 *    the service may open the new file, so nothing reopens it.
 *
 * From before step 2 to the end, `statev2.sqlite.reclaim-lock` names this
 * process; the service will not open the database while it does
 * (`reclaimLock.ts`). Should the database ever be missing with reclaim files
 * beside it, the service refuses to start and names the file to move back
 * (`Sqlite.ts`). Refused on Windows, which cannot rename an open database.
 * Space for the copy (and its second copy beside the
 * database when `workDir` is on another volume) is checked before step 4.
 *
 * VACUUM keeps every rowid of `orchestration_events` and
 * `orchestration_v2_events`, whose `sequence` is INTEGER PRIMARY KEY
 * AUTOINCREMENT, and `sqlite_sequence` is copied as a table. Step 6 checks the
 * same for every table it hashes.
 *
 * INCREMENTAL is opt-in: the update helper's page proof refuses any
 * auto-vacuum database (`scripts/studio-fleet/after_proof.py`, refusal
 * `auto-vacuum`), so each update would read the database in full once more.
 *
 * `dryRun` changes nothing and works while the service runs: it opens the
 * database read-only with the flags that cannot disturb a live service
 * (liveDatabaseSnapshot), runs the compaction's discovery without deleting,
 * and reports the free list and the expected size after `VACUUM INTO`.
 *
 * @module DatabaseReclaim
 */
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import { sha256 } from "../nodeCrypto.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import { liveDatabaseReadOnlyUri } from "./liveDatabaseSnapshot.ts";
import { recordedProcess } from "./processIdentity.ts";
import { acquireReclaimLock, reclaimLockPath, releaseReclaimLock } from "./reclaimLock.ts";
import * as StorageMaintenance from "./StorageMaintenance.ts";

export class DatabaseReclaimError extends Schema.TaggedError<DatabaseReclaimError>()(
  "DatabaseReclaimError",
  {
    reason: Schema.Literals([
      "missing",
      "service-running",
      "update-in-progress",
      "in-use",
      "integrity",
      "projections-invalid",
      "no-space",
      "copy-differs",
      "log-not-empty",
      "unsupported",
      "failed",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const fail = (reason: DatabaseReclaimError["reason"], detail: string) =>
  Effect.fail(new DatabaseReclaimError({ reason, detail }));

/** Rows per checksum query. */
const HASH_PAGE_ROWS = 2_000;
/** Events per discovery query offline, where nothing else waits on the connection. */
const OFFLINE_PAGE_SIZE = 2_000;
/**
 * Bytes a deleted event frees beyond its payload and metadata: ids, index entries, slack.
 * The rewrite also packs every other page, so the high end is taken from a 20 GB copy,
 * where 946,462 deleted events freed 4.29 GB, about 2,770 bytes each beyond their text.
 */
export const ROW_OVERHEAD_BYTES = { low: 600, high: 3_000 } as const;

export interface DatabaseStorageReading {
  readonly fileBytes: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly freelistPages: number;
  readonly autoVacuum: number;
}

export interface ReclaimDryRun {
  readonly dryRun: true;
  readonly storage: DatabaseStorageReading;
  readonly compaction: ProjectionMaintenance.CompactEventStoreResult;
  /** Expected file size after VACUUM INTO: used pages, less what the compaction frees. */
  readonly expectedBytes: { readonly low: number; readonly high: number };
}

export interface ReclaimResult {
  readonly dryRun: false;
  readonly before: DatabaseStorageReading;
  readonly afterBytes: number;
  readonly autoVacuum: number;
  readonly compaction: ProjectionMaintenance.CompactEventStoreResult;
  readonly backupPath: string;
  readonly checkedTables: number;
  readonly maxSequence: number;
  readonly elapsedMs: number;
}

export interface ReclaimOptions {
  readonly dbPath: string;
  /** The SpecWithCode home: `updates/` and the runtime state live under it. */
  readonly baseDir: string;
  readonly serverRuntimeStatePath: string;
  /** Where VACUUM INTO writes the copy; beside the database by default. */
  readonly workDir?: string;
  readonly incremental?: boolean;
  readonly dryRun?: boolean;
  /**
   * Ignore pids in the runtime state, the hold marker and the reclaim lock
   * that `ps` cannot date.
   */
  readonly forceStalePid?: boolean;
  /** Progress lines for the CLI. */
  readonly log?: (line: string) => Effect.Effect<void>;
  /** Tests: runs after the copy is checked and the database closed, before the swap. */
  readonly beforeSwap?: Effect.Effect<void>;
  /** Tests: runs while the swap holds both locks, before the first rename. */
  readonly duringSwap?: Effect.Effect<void>;
}

const readStorage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const one = <A>(rows: ReadonlyArray<Record<string, unknown>>, key: string) =>
    Number(rows[0]?.[key] ?? 0) as A & number;
  const pageSize = one<number>(yield* sql`PRAGMA page_size`, "page_size");
  const pageCount = one<number>(yield* sql`PRAGMA page_count`, "page_count");
  const freelistPages = one<number>(yield* sql`PRAGMA freelist_count`, "freelist_count");
  const autoVacuum = one<number>(yield* sql`PRAGMA auto_vacuum`, "auto_vacuum");
  return { pageSize, pageCount, freelistPages, autoVacuum };
});

const layerMaintenance = (filename: string, readonly: boolean) =>
  ProjectionMaintenance.layer.pipe(
    Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
    Layer.provideMerge(NodeSqliteClient.layer({ filename, readonly })),
  );

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeMarker = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      pid: Schema.optional(Schema.Unknown),
      startedAt: Schema.optional(Schema.Unknown),
    }),
  ),
);
const decodeAgentStatus = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ status: Schema.optional(Schema.Unknown) })),
);

/**
 * Why the service or an update must finish first, or null. Reads files only.
 *
 * A pid counts only while it still names the process that recorded it: one
 * that started after the record (`startedAt`) took the pid over. Where the
 * start time cannot be read, `forceStalePid` ignores the recorded pids; the
 * exclusive lock still refuses a service that has the database open.
 */
export const serviceOrUpdateBlocker = (options: {
  readonly baseDir: string;
  readonly serverRuntimeStatePath: string;
  readonly forceStalePid?: boolean;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const force = options.forceStalePid === true;
      const stalePidHint = (file: string, pid: number) =>
        ` If no SpecWithCode process has pid ${pid}, ${file} is stale: pass --force-stale-pid.`;
      const runtime = yield* readPersistedServerRuntimeState(options.serverRuntimeStatePath).pipe(
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isSome(runtime) && !force) {
        const state = yield* recordedProcess(runtime.value.pid, runtime.value.startedAt);
        if (state === "running") {
          return {
            reason: "service-running" as const,
            detail:
              `SpecWithCode is running (pid ${runtime.value.pid}). Stop the service and the desktop app first.` +
              stalePidHint(options.serverRuntimeStatePath, runtime.value.pid),
          };
        }
      }
      const updates = path.join(options.baseDir, "updates");
      const statePath = path.join(updates, "state.json");
      const hold = yield* ServiceUpdateHold.makeWithOptions({ agentStatePath: statePath });
      const blocker = yield* StorageMaintenance.updateBlocker(
        Option.some(hold),
        StorageMaintenance.databaseSnapshotPending(
          path.join(updates, StorageMaintenance.SNAPSHOT_MARKER_FILE),
        ),
      );
      const markerPath = path.join(updates, ServiceUpdateHold.HOLD_MARKER_FILE);
      const marker = Option.flatMap(
        yield* fs.readFileString(markerPath).pipe(Effect.option),
        decodeMarker,
      );
      const markerPid =
        Option.isSome(marker) && typeof marker.value.pid === "number" && !force
          ? (yield* recordedProcess(
              marker.value.pid,
              typeof marker.value.startedAt === "string" ? marker.value.startedAt : null,
            )) === "running"
            ? marker.value.pid
            : null
          : null;
      const status = Option.getOrUndefined(
        Option.flatMap(yield* fs.readFileString(statePath).pipe(Effect.option), decodeAgentStatus),
      );
      const busy = (ServiceUpdateHold.AGENT_BUSY_STATUSES as ReadonlyArray<unknown>).includes(
        status?.status,
      );
      if (blocker !== null || markerPid !== null || busy) {
        return {
          reason: "update-in-progress" as const,
          detail:
            `An update is in progress (${blocker ?? (busy ? `agent ${String(status?.status)}` : "update hold")}). Try again after it finishes.` +
            (markerPid !== null && blocker === null && !busy
              ? stalePidHint(markerPath, markerPid)
              : ""),
        };
      }
      return null;
    }),
  );

/** Holds an exclusive lock; refused while any other connection has the file open. */
const lockExclusively = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA busy_timeout = 0`;
  yield* sql`PRAGMA locking_mode = EXCLUSIVE`;
  yield* sql`BEGIN EXCLUSIVE`.pipe(
    Effect.catch((cause) =>
      isSqlError(cause)
        ? fail("in-use", "Another process has the database open. Stop SpecWithCode first.")
        : Effect.fail(cause),
    ),
  );
  yield* sql`COMMIT`;
});

const quickCheck = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly quick_check: string }>`PRAGMA quick_check`;
  return rows.map((row) => row.quick_check).join("; ");
});

const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

export interface DatabaseFingerprint {
  readonly counts: Readonly<Record<string, number>>;
  readonly checksums: Readonly<Record<string, string>>;
  readonly maxSequence: number;
  readonly sqliteSequence: string;
}

/** Tables whose rows and rowids the copy must keep exactly. */
const isHashedTable = (name: string) =>
  name.startsWith("orchestration_v2_projection_") ||
  name === "orchestration_v2_turn_item_positions" ||
  name === "orchestration_command_receipts" ||
  name === "orchestration_v2_command_receipts" ||
  name === "orchestration_v2_events";

/**
 * Row counts of every table, the log's (event id, sequence) pairs and last
 * sequence, `sqlite_sequence`, and a hash chain over the rows (rowid first)
 * of every projection and log table but `orchestration_events`, whose
 * payloads are too large to hash twice and whose rows VACUUM copies as pages.
 */
export const fingerprint = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `;
  const counts: Record<string, number> = {};
  const checksums: Record<string, string> = {};
  for (const { name } of tables) {
    const rows = yield* sql.unsafe<{ readonly count: number }>(
      `SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`,
    );
    counts[name] = rows[0]?.count ?? 0;
    if (!isHashedTable(name)) continue;
    let digest = sha256([name], "hex");
    let after = Number.MIN_SAFE_INTEGER;
    while (true) {
      const page = yield* sql.unsafe<Record<string, unknown>>(
        `SELECT rowid AS __rowid, * FROM ${quoteIdentifier(name)} WHERE rowid > ? ORDER BY rowid LIMIT ${HASH_PAGE_ROWS}`,
        [after],
      );
      if (page.length === 0) break;
      digest = sha256([digest, encodeJson(page)], "hex");
      after = Number(page.at(-1)?.["__rowid"]);
      if (page.length < HASH_PAGE_ROWS) break;
      yield* Effect.yieldNow;
    }
    checksums[name] = digest;
  }
  // The log's ids and sequences, from the event_id index alone.
  let digest = sha256(["orchestration_events"], "hex");
  let afterId = "";
  while (true) {
    const page = yield* sql<{ readonly event_id: string; readonly sequence: number }>`
      SELECT event_id, sequence FROM orchestration_events
      WHERE event_id > ${afterId}
      ORDER BY event_id
      LIMIT ${HASH_PAGE_ROWS * 10}
    `;
    if (page.length === 0) break;
    digest = sha256([digest, encodeJson(page)], "hex");
    afterId = page.at(-1)?.event_id ?? afterId;
    if (page.length < HASH_PAGE_ROWS * 10) break;
    yield* Effect.yieldNow;
  }
  checksums["orchestration_events (event_id, sequence)"] = digest;
  const max = yield* sql<{ readonly max_sequence: number | null }>`
    SELECT MAX(sequence) AS max_sequence FROM orchestration_events
  `;
  const sequenceRows = yield* sql<{ readonly name: string; readonly seq: number }>`
    SELECT name, seq FROM sqlite_sequence ORDER BY name
  `;
  return {
    counts,
    checksums,
    maxSequence: max[0]?.max_sequence ?? 0,
    sqliteSequence: encodeJson(sequenceRows),
  } satisfies DatabaseFingerprint;
});

const describeDifference = (expected: DatabaseFingerprint, actual: DatabaseFingerprint) => {
  if (expected.maxSequence !== actual.maxSequence)
    return `last sequence ${actual.maxSequence}, expected ${expected.maxSequence}`;
  if (expected.sqliteSequence !== actual.sqliteSequence) return "sqlite_sequence differs";
  for (const [table, count] of Object.entries(expected.counts)) {
    if (actual.counts[table] !== count)
      return `${table} has ${actual.counts[table] ?? 0} rows, expected ${count}`;
  }
  if (Object.keys(actual.counts).length !== Object.keys(expected.counts).length)
    return "the copy has other tables";
  for (const [table, checksum] of Object.entries(expected.checksums)) {
    if (actual.checksums[table] !== checksum) return `${table} differs`;
  }
  return null;
};

const formatStamp = (now: DateTime.Utc) =>
  DateTime.formatIso(now).replaceAll(":", "").replaceAll("-", "").replace(/\..*$/, "Z");

export const reclaim = Effect.fn("DatabaseReclaim.reclaim")(function* (options: ReclaimOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const log = options.log ?? (() => Effect.void);
  const dbPath = path.resolve(options.dbPath);
  if (!(yield* fs.exists(dbPath))) {
    return yield* fail("missing", `No SpecWithCode database at ${dbPath}.`);
  }

  if (options.dryRun === true) {
    // Read-only and safe beside a running service; nothing is deleted.
    return yield* Effect.gen(function* () {
      const storage = yield* readStorage;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* log("Reading the event log; nothing is changed.");
      const compaction = yield* maintenance.compactEventStoreWith({
        dryRun: true,
        pageSize: OFFLINE_PAGE_SIZE,
      });
      const usedBytes = (storage.pageCount - storage.freelistPages) * storage.pageSize;
      const freed = (overhead: number) =>
        compaction.deletedEventChars + compaction.deletedEventCount * overhead;
      return {
        dryRun: true,
        storage: { ...storage, fileBytes: storage.pageCount * storage.pageSize },
        compaction,
        expectedBytes: {
          low: Math.max(0, usedBytes - freed(ROW_OVERHEAD_BYTES.high)),
          high: Math.max(0, usedBytes - freed(ROW_OVERHEAD_BYTES.low)),
        },
      } satisfies ReclaimDryRun;
    }).pipe(Effect.provide(layerMaintenance(liveDatabaseReadOnlyUri(dbPath), true)));
  }

  // Windows refuses to rename a file any process has open, so the swap would
  // fail every time, and only after the whole compaction. Background
  // compaction still runs there.
  if ((yield* HostProcessPlatform) === "win32") {
    return yield* fail(
      "unsupported",
      "db reclaim cannot replace the database on Windows; nothing was changed. SpecWithCode still deletes superseded events in the background, and new writes reuse the freed space.",
    );
  }

  yield* refuseIfBusy(options);

  // The service refuses to open the database while this lock names a running
  // reclaim (Sqlite.ts). Where it cannot date the pid it opens anyway, and the
  // exclusive locks below refuse the swap instead.
  const holder = yield* acquireReclaimLock(dbPath, { forceStalePid: options.forceStalePid });
  if (Option.isSome(holder)) {
    return yield* fail(
      "in-use",
      options.forceStalePid === true
        ? `Another db reclaim (pid ${holder.value}) is rewriting ${dbPath}: that process started before it wrote ${reclaimLockPath(dbPath)}, so --force-stale-pid does not override it. If no db reclaim is running, delete that file.`
        : `Another db reclaim (pid ${holder.value}) is rewriting ${dbPath}. If no db reclaim is running, delete ${reclaimLockPath(dbPath)} or pass --force-stale-pid.`,
    );
  }
  return yield* rewrite(options, dbPath).pipe(Effect.ensuring(releaseReclaimLock(dbPath)));
});

const MIB = 1024 * 1024;

const refuseIfBusy = (options: ReclaimOptions) =>
  Effect.gen(function* () {
    const blocker = yield* serviceOrUpdateBlocker(options);
    if (blocker !== null) return yield* fail(blocker.reason, blocker.detail);
  });

/** Refuses when the volume holding `directory` has less than `neededBytes` free. */
const requireFreeSpace = (directory: string, neededBytes: number, hint: string) =>
  Effect.gen(function* () {
    const free = yield* freeBytes(directory);
    if (free !== null && free < neededBytes) {
      return yield* fail(
        "no-space",
        `${directory} has ${free} bytes free; reclaim needs about ${neededBytes} there. ${hint}`,
      );
    }
  });

const rewrite = Effect.fn("DatabaseReclaim.rewrite")(function* (
  options: ReclaimOptions,
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const log = options.log ?? (() => Effect.void);
  const started = yield* DateTime.now;
  const stamp = formatStamp(started);
  const workDir = path.resolve(options.workDir ?? path.dirname(dbPath));
  yield* fs.makeDirectory(workDir, { recursive: true });
  const copyPath = path.join(workDir, `${path.basename(dbPath)}.reclaim-${stamp}`);
  const backupPath = `${dbPath}.before-reclaim-${stamp}`;
  // A copy on another volume is copied beside the database before the swap;
  // on the same volume it is renamed into place.
  const [workInfo, dbDirInfo] = yield* Effect.all([
    fs.stat(workDir),
    fs.stat(path.dirname(dbPath)),
  ]);
  const crossesVolumes = workInfo.dev !== dbDirInfo.dev;
  const staged = crossesVolumes ? `${dbPath}.reclaim-${stamp}` : copyPath;
  const removeFiles = (base: string) =>
    Effect.forEach(["", "-wal", "-shm", "-journal"], (suffix) =>
      fs.remove(base + suffix, { force: true }).pipe(Effect.ignore),
    );
  const removeCopy = removeFiles(copyPath);

  // Phase 1, under the exclusive lock: check, compact, copy, check the copy.
  const phase = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    yield* lockExclusively;
    const before = yield* readStorage;
    // Before anything is deleted: room for the copy, and for its second copy
    // beside the database when the work folder is on another volume. The used
    // size before compaction bounds the copy.
    const neededBytes =
      Math.ceil((before.pageCount - before.freelistPages) * before.pageSize * 1.05) + 256 * MIB;
    yield* requireFreeSpace(workDir, neededBytes, "Pass --work-dir on a larger volume.");
    if (crossesVolumes) {
      yield* requireFreeSpace(
        path.dirname(dbPath),
        neededBytes,
        "The checked copy is copied beside the database before the swap.",
      );
    }
    yield* log("Checking the database (quick_check).");
    const check = yield* quickCheck;
    if (check !== "ok") return yield* fail("integrity", `quick_check: ${check}`);
    if (!(yield* maintenance.verify).valid) {
      return yield* fail(
        "projections-invalid",
        "The projections need repair first: start SpecWithCode once so it rebuilds them. If this CLI is older than the service that wrote the database, update it first.",
      );
    }
    yield* log("Deleting superseded events.");
    const compaction = yield* maintenance.compactEventStoreWith({ pageSize: OFFLINE_PAGE_SIZE });
    if (!(yield* maintenance.verify).valid) {
      return yield* fail(
        "projections-invalid",
        "The projections stopped verifying after compaction.",
      );
    }
    yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
    yield* log("Fingerprinting the database.");
    const expected = yield* fingerprint;
    const autoVacuum = options.incremental === true ? 2 : before.autoVacuum;
    yield* sql.unsafe(`PRAGMA auto_vacuum = ${autoVacuum}`);
    yield* log(`Writing the rewritten copy to ${copyPath}.`);
    yield* sql.unsafe(`VACUUM INTO ?`, [copyPath]);

    yield* log("Checking the copy.");
    yield* Effect.gen(function* () {
      const copySql = yield* SqlClient.SqlClient;
      const copyCheck = yield* quickCheck;
      if (copyCheck !== "ok") return yield* fail("copy-differs", `copy quick_check: ${copyCheck}`);
      const storage = yield* readStorage;
      if (storage.autoVacuum !== autoVacuum)
        return yield* fail(
          "copy-differs",
          `the copy has auto_vacuum ${storage.autoVacuum}, expected ${autoVacuum}`,
        );
      yield* copySql`PRAGMA journal_mode = WAL`;
      const actual = yield* fingerprint;
      const difference = describeDifference(expected, actual);
      if (difference !== null)
        return yield* fail("copy-differs", `The copy differs: ${difference}.`);
      yield* copySql`PRAGMA wal_checkpoint(TRUNCATE)`;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: copyPath })), Effect.scoped);
    return { before, compaction, autoVacuum, expected };
  }).pipe(Effect.provide(layerMaintenance(dbPath, false)), Effect.scoped);

  const result = yield* phase.pipe(Effect.onError(() => removeCopy));
  if (options.beforeSwap !== undefined) yield* options.beforeSwap;

  // Phase 2: the swap, under exclusive locks on the original and on the copy
  // from before the original is linked aside until the copy is in place. Any
  // other connection refuses it; one that tries to open meanwhile waits on the
  // lock or fails. The original's connection closes first: SQLite deletes
  // `-wal` by the name it opened, which then belongs to the new file, still
  // locked by the copy's.
  //
  // `stage` says what a failure may remove. Before the replace, the original
  // is untouched and every copy may go. From the replace on, nothing is
  // removed unless the database is known to be the original again ("intact"),
  // and then only the copy beside the database: the checked copy in the work
  // folder stays for the person to use or delete.
  let stage: "before" | "replacing" | "intact" | "swapped" = "before";
  const intactHint = `${dbPath} is unchanged; the checked copy is ${copyPath}.`;
  /**
   * Hard-links the original to `backupPath`, then renames the copy over
   * `dbPath` in one step, so `dbPath` always names a whole database. Where the
   * volume has no hard links (exFAT) it renames the original away first; the
   * service refuses to start in that gap (`Sqlite.ts`, missingDatabaseHint).
   * Uninterruptible: Ctrl+C and SIGTERM reach the CLI as an interrupt
   * (`NodeRuntime.runMain`), which waits until the database is whole again.
   */
  const replace = Effect.uninterruptible(
    Effect.gen(function* () {
      stage = "replacing";
      const linked = yield* fs.link(dbPath, backupPath).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (linked) {
        yield* fs.rename(staged, dbPath).pipe(
          Effect.catchCause((cause) =>
            // A failed rename changed nothing: drop the second name of the original.
            fs
              .remove(backupPath, { force: true })
              .pipe(
                Effect.ignore,
                Effect.andThen(Effect.sync(() => (stage = "intact"))),
                Effect.andThen(
                  fail(
                    "failed",
                    `Could not move the copy into place (${Cause.pretty(cause)}). ${intactHint}`,
                  ),
                ),
              ),
          ),
        );
      } else {
        yield* fs
          .rename(dbPath, backupPath)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => (stage = "intact")).pipe(
                Effect.andThen(
                  fail(
                    "failed",
                    `Could not move the original aside (${Cause.pretty(cause)}). ${intactHint}`,
                  ),
                ),
              ),
            ),
          );
        yield* fs.rename(staged, dbPath).pipe(
          Effect.catchCause((cause) =>
            fs.rename(backupPath, dbPath).pipe(
              Effect.matchEffect({
                onSuccess: () =>
                  Effect.sync(() => (stage = "intact")).pipe(
                    Effect.andThen(
                      fail(
                        "failed",
                        `Could not move the copy into place (${Cause.pretty(cause)}). The original is back: ${intactHint}`,
                      ),
                    ),
                  ),
                onFailure: () =>
                  fail(
                    "failed",
                    `Could not move the copy into place (${Cause.pretty(cause)}) nor the original back. Move ${backupPath} to ${dbPath} before starting SpecWithCode (the checked copy is ${staged}).`,
                  ),
              }),
            ),
          ),
        );
      }
      stage = "swapped";
      // The original's sidecars; the new file has none of its own yet.
      for (const suffix of ["-wal", "-shm"]) {
        yield* fs.remove(dbPath + suffix, { force: true }).pipe(Effect.ignore);
      }
    }),
  );
  const swap = Effect.gen(function* () {
    const originalScope = yield* Scope.make();
    const copyScope = yield* Scope.make();
    const closeLocks = Scope.close(originalScope, Exit.void).pipe(
      Effect.andThen(Scope.close(copyScope, Exit.void)),
    );
    yield* Effect.gen(function* () {
      const original = yield* Layer.buildWithScope(
        NodeSqliteClient.layer({ filename: dbPath }),
        originalScope,
      );
      yield* lockExclusively.pipe(Effect.provide(original));
      for (const suffix of ["-wal", "-journal"]) {
        const info = yield* fs.stat(dbPath + suffix).pipe(Effect.option);
        if (Option.isSome(info) && Number(info.value.size) > 0) {
          return yield* fail(
            "log-not-empty",
            `${dbPath}${suffix} is not empty under the lock; nothing was swapped.`,
          );
        }
      }
      yield* refuseIfBusy(options);
      if (staged !== copyPath) {
        yield* log(`Copying the checked copy beside the database (${staged}).`);
        yield* fs.copyFile(copyPath, staged);
        const [source, target] = yield* Effect.all([fs.stat(copyPath), fs.stat(staged)]);
        if (source.size !== target.size)
          return yield* fail("copy-differs", "The copy beside the database has another size.");
      }
      // On disk before it takes the database's name: a power loss after the
      // rename must not leave a name over unwritten pages. Node's fsync is
      // F_FULLFSYNC on macOS.
      yield* syncFile(staged);
      yield* syncDirectory(path.dirname(dbPath));
      const copy = yield* Layer.buildWithScope(
        NodeSqliteClient.layer({ filename: staged }),
        copyScope,
      );
      yield* lockExclusively.pipe(Effect.provide(copy));
      if (options.duringSwap !== undefined) yield* options.duringSwap;
      // The file about to become the database, under its lock: the last sequence and an
      // empty log. Checked here because once the locks go, the service may open it.
      const copyMax = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly max_sequence: number | null }>`
          SELECT MAX(sequence) AS max_sequence FROM orchestration_events
        `;
        yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
        return rows[0]?.max_sequence ?? 0;
      }).pipe(Effect.provide(copy));
      if (copyMax !== result.expected.maxSequence) {
        return yield* fail(
          "copy-differs",
          `The copy ends at ${copyMax}, expected ${result.expected.maxSequence}; nothing was swapped.`,
        );
      }
      yield* replace;
      yield* syncDirectory(path.dirname(dbPath));
    }).pipe(Effect.ensuring(closeLocks));
    // Sidecars the copy's lock left under its old name, and the copy in the work folder.
    yield* removeFiles(staged);
    if (staged !== copyPath) yield* removeCopy;
  });
  yield* swap.pipe(
    Effect.onError(() => {
      switch (stage) {
        case "before":
          return staged === copyPath
            ? removeCopy
            : removeFiles(staged).pipe(Effect.andThen(removeCopy));
        case "intact":
          return staged === copyPath ? Effect.void : removeFiles(staged);
        default:
          // Mid-replace or after it: every file may be the database or its only copy.
          return Effect.void;
      }
    }),
  );

  // Done: the service may open the new file from here on, so nothing below
  // reopens it. The swap checked it under the lock.
  const maxSequence = result.expected.maxSequence;
  const afterBytes = Number((yield* fs.stat(dbPath)).size);
  const finished = yield* DateTime.now;
  return {
    dryRun: false,
    before: { ...result.before, fileBytes: result.before.pageCount * result.before.pageSize },
    afterBytes,
    autoVacuum: result.autoVacuum,
    compaction: result.compaction,
    backupPath,
    checkedTables: Object.keys(result.expected.counts).length,
    maxSequence,
    elapsedMs: DateTime.toEpochMillis(finished) - DateTime.toEpochMillis(started),
  } satisfies ReclaimResult;
});

/** fsync of a file (F_FULLFSYNC on macOS, through libuv). */
const syncFile = (target: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* fs.open(target, { flag: "r" });
      yield* file.sync;
    }),
  );

/** fsync of a directory, so a new name in it lasts; best effort where the platform refuses. */
const syncDirectory = (target: string) => Effect.ignore(syncFile(target));

/** Free bytes on the volume holding `directory`, or null where the platform cannot tell. */
const freeBytes = (directory: string) =>
  Effect.tryPromise(async () => {
    const { statfs } = await import("node:fs/promises");
    const info = await statfs(directory);
    return Number(info.bavail) * Number(info.bsize);
  }).pipe(Effect.orElseSucceed(() => null));
