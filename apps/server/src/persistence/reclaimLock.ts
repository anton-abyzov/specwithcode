/**
 * The reclaim lock: `statev2.sqlite.reclaim-lock` beside the database while
 * `db reclaim` rewrites it.
 *
 * Reclaim renames the database away and moves a rewritten copy into its
 * place. A process that opened the old file before the rename keeps writing
 * to it, and to a `-wal` named after the new one, so the service checks this
 * file before it opens the database and again once it holds SQLite's shared
 * lock (`Sqlite.ts`). The lock counts only while the reclaim that wrote it
 * still runs (`processIdentity`): a crashed reclaim never keeps the service
 * down. Where a pid's start time cannot be read, the service treats the lock
 * as stale (reclaim's exclusive SQLite lock still keeps it off the file),
 * while another reclaim treats it as live unless told `--force-stale-pid`.
 *
 * @module reclaimLock
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { recordedProcess } from "./processIdentity.ts";

export const RECLAIM_LOCK_SUFFIX = ".reclaim-lock";

export const reclaimLockPath = (dbPath: string) => `${dbPath}${RECLAIM_LOCK_SUFFIX}`;

const ReclaimLock = Schema.Struct({ pid: Schema.Int, startedAt: Schema.String });
const decodeLock = Schema.decodeUnknownOption(Schema.fromJsonString(ReclaimLock));
const encodeLock = Schema.encodeSync(Schema.fromJsonString(ReclaimLock));

/** How to clear a lock no reclaim holds, for every refusal that names one. */
export const staleLockHint = (dbPath: string) =>
  `If no db reclaim is running, delete ${reclaimLockPath(dbPath)}.`;

/**
 * The pid of the reclaim that holds the lock and still runs, or null.
 * `unknownStart` decides a holder whose start time cannot be read.
 */
export const activeReclaim = (dbPath: string, unknownStart: "running" | "stale" = "running") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(reclaimLockPath(dbPath)).pipe(Effect.option);
    const lock = Option.flatMap(text, decodeLock);
    if (Option.isNone(lock)) return null;
    const state = yield* recordedProcess(lock.value.pid, lock.value.startedAt, unknownStart);
    return state === "running" ? lock.value.pid : null;
  });

/**
 * Takes the lock for this process. Returns the holder's pid while another
 * reclaim holds it; a lock left by a reclaim that no longer runs is replaced.
 * `forceStalePid` also replaces a lock whose pid `ps` cannot date, never one
 * whose process `ps` dates to before the lock: that reclaim still runs.
 */
export const acquireReclaimLock = (
  dbPath: string,
  options?: { readonly forceStalePid?: boolean | undefined },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const holder = yield* activeReclaim(
      dbPath,
      options?.forceStalePid === true ? "stale" : "running",
    );
    if (holder !== null && holder !== process.pid) return Option.some(holder);
    // Wall-clock time, compared with the process start time `ps` reports.
    // @effect-diagnostics-next-line globalDateInEffect:off -- a test clock would date the lock wrongly.
    const startedAt = yield* Effect.sync(() => DateTime.formatIso(DateTime.makeUnsafe(Date.now())));
    const temporary = `${reclaimLockPath(dbPath)}.${process.pid}.tmp`;
    yield* fs.writeFileString(temporary, encodeLock({ pid: process.pid, startedAt }));
    yield* fs.rename(temporary, reclaimLockPath(dbPath));
    return Option.none<number>();
  });

export const releaseReclaimLock = (dbPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(reclaimLockPath(dbPath), { force: true });
  }).pipe(Effect.ignore);
