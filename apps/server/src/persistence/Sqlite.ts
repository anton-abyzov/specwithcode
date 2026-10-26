import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";
import * as Option from "effect/Option";

import { runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import { registerLiveDatabase } from "./liveDatabaseGuard.ts";
import { activeReclaim, staleLockHint } from "./reclaimLock.ts";
import * as ServerConfig from "../config.ts";

// Size the -wal file is cut back to on the first commit after a WAL reset.
export const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

// SQLite page cache for the server connection: 64 MiB.
export const PAGE_CACHE_KIB = 64 * 1024;

/**
 * Whether a database created from nothing starts with `auto_vacuum =
 * INCREMENTAL`, so StorageMaintenance can return freed pages to the file
 * system. Off: the update helper's page proof refuses any auto-vacuum database
 * (`scripts/studio-fleet/after_proof.py`, `auto-vacuum`: pointer-map pages
 * belong to no tree) and every update would then read the database in full a
 * second time. Freed pages still go to the free list and new writes reuse
 * them. `specweave-studio db reclaim --incremental` turns it on for one database.
 */
export const INCREMENTAL_AUTO_VACUUM_FOR_NEW_DATABASES = false;

/**
 * `afterOpen` runs once the connection has read the database and so holds
 * SQLite's shared lock, before anything is written.
 */
const layerSetupWith = <R>(afterOpen: Effect.Effect<void, never, R>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
      yield* sql`PRAGMA busy_timeout = 5000;`;
      yield* sql`PRAGMA foreign_keys = ON;`;
      if (INCREMENTAL_AUTO_VACUUM_FOR_NEW_DATABASES) {
        // Only an empty database can change mode without a VACUUM.
        const tables = yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'`;
        if (tables[0]?.count === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL;`;
      }
      yield* sql`PRAGMA journal_mode = WAL;`;
      yield* afterOpen;
      // In WAL mode NORMAL is still crash-safe (a power loss can drop only the
      // last commits, never corrupt the database) and skips the fsync on every
      // commit, which on a slow or nearly full disk held the event loop.
      yield* sql`PRAGMA synchronous = NORMAL;`;
      // PASSIVE checkpoints never shrink the -wal file, so it otherwise keeps its
      // largest size until the last connection closes.
      yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
      // The default 2 MiB page cache cannot hold one full shell scan, so every
      // scan read its pages back from the file. A negative value is in KiB.
      yield* sql.unsafe(`PRAGMA cache_size = -${PAGE_CACHE_KIB};`);
      yield* runMigrations();
    }),
  );

const layerSetup = layerSetupWith(Effect.void);

/**
 * `db reclaim` renames the database away and moves a rewritten copy into its
 * place. Refuses to open while a reclaim runs (`reclaimLock.ts`), and, once
 * the connection holds its shared lock, when the file at `dbPath` is no longer
 * the one it opened: that connection would write to the renamed original and
 * to a `-wal` named after the new file.
 */
const refuseDuringReclaim = (dbPath: string) =>
  Effect.gen(function* () {
    // A pid whose start time cannot be read counts as stale: refusing would keep
    // SpecWithCode down for good, and a live reclaim's exclusive lock still holds.
    const pid = yield* activeReclaim(dbPath, "stale");
    if (pid !== null) {
      return yield* Effect.die(
        new Error(
          `db reclaim (pid ${pid}) is rewriting ${dbPath}; SpecWithCode starts once it finishes. ${staleLockHint(dbPath)}`,
        ),
      );
    }
  });

/**
 * What to move back when `dbPath` is missing but `db reclaim` left its files
 * beside it, or null. Opening would otherwise create an empty database, or
 * import the old `state.sqlite` again, and hide the real one. The newest
 * `<db>.before-reclaim-<time>` is the database from before the reclaim; a
 * `<db>.reclaim-<time>` is its checked copy, used when no backup is there.
 */
export const missingDatabaseHint = (dbPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (yield* fs.exists(dbPath)) return null;
    const directory = path.dirname(dbPath);
    const base = path.basename(dbPath);
    const entries = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    const sidecar = /-(wal|shm|journal)$/;
    const matching = (prefix: string) =>
      entries
        .filter(
          (name) =>
            name.startsWith(`${base}${prefix}`) &&
            !sidecar.test(name) &&
            !name.endsWith(".tmp") &&
            !name.startsWith(`${base}.reclaim-lock`),
        )
        .toSorted()
        .toReversed();
    const backups = matching(".before-reclaim-");
    const copies = matching(".reclaim-");
    const found = backups[0] ?? copies[0];
    if (found === undefined) return null;
    const what =
      backups[0] !== undefined
        ? "the database from before db reclaim"
        : "the copy db reclaim checked";
    return `${dbPath} is missing, but db reclaim left ${[...backups, ...copies].join(", ")} beside it. Move ${path.join(directory, found)} (${what}) to ${dbPath}, then start SpecWithCode again. To start with an empty database instead, move those files out of ${directory}.`;
  });

const refuseMissingAfterReclaim = (dbPath: string) =>
  Effect.gen(function* () {
    const hint = yield* missingDatabaseHint(dbPath);
    if (hint !== null) return yield* Effect.die(new Error(hint));
  });

const fileIdentity = (dbPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(dbPath).pipe(Effect.option);
    return Option.isSome(info)
      ? `${info.value.dev}:${Option.getOrElse(info.value.ino, () => 0)}`
      : null;
  });

const sameFileAfterOpen = (dbPath: string, before: string | null) =>
  Effect.gen(function* () {
    const after = yield* fileIdentity(dbPath);
    if (before !== null && after !== before) {
      return yield* Effect.die(
        new Error(`${dbPath} was replaced while it was being opened; start SpecWithCode again.`),
      );
    }
    yield* refuseDuringReclaim(dbPath);
  });

export const layerFromPath = Effect.fn("makeSqlitePersistenceLive")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
  yield* refuseDuringReclaim(dbPath);
  yield* refuseMissingAfterReclaim(dbPath);
  const identity = yield* fileIdentity(dbPath);

  return Layer.provideMerge(
    layerSetupWith(
      sameFileAfterOpen(dbPath, identity).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
    ),
    NodeSqliteClient.layer({
      filename: dbPath,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "studio-server",
      },
    }),
  ).pipe(Layer.merge(layerLiveDatabaseRegistration(dbPath)));
}, Layer.unwrap);

/**
 * While the connection is open, node:fs in this process refuses the database
 * files (see liveDatabaseGuard.ts): a plain open and close of one of them
 * would drop SQLite's locks on it.
 */
const layerLiveDatabaseRegistration = (dbPath: string) =>
  Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.sync(() => registerLiveDatabase(dbPath)),
      (unregister) => Effect.sync(unregister),
    ),
  );

export const layerMemory = Layer.provideMerge(
  layerSetup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    // Before the V1 import, which would otherwise fill the missing path.
    yield* refuseDuringReclaim(dbPath);
    yield* refuseMissingAfterReclaim(dbPath);
    yield* initializeV2Database(dbPath);
    return layerFromPath(dbPath);
  }),
);
