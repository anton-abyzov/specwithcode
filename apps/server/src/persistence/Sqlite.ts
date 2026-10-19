import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";

import { runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import { registerLiveDatabase } from "./liveDatabaseGuard.ts";
import * as ServerConfig from "../config.ts";

// Size the -wal file is cut back to on the first commit after a WAL reset.
export const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

// SQLite page cache for the server connection: 64 MiB.
export const PAGE_CACHE_KIB = 64 * 1024;

const layerSetup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
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

export const layerFromPath = Effect.fn("makeSqlitePersistenceLive")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    layerSetup,
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
    yield* initializeV2Database(dbPath);
    return layerFromPath(dbPath);
  }),
);
