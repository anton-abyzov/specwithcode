/**
 * Whether a running SpecWithCode service owns a home's live database, for
 * code outside that service (the CLI) that must not open it then.
 *
 * A read-write connection from another process is harmless while the service
 * holds its SQLite locks. Once it has lost them (M4: October 15, 16, 19 and
 * 26, 2026), that connection believes it is the database's only user: when
 * it closes it checkpoints and deletes `-wal` and `-shm` while the service
 * still writes to them, and those writes are lost. So nothing outside the
 * service opens the database read-write while the service runs; readers use
 * `openLiveDatabaseReadOnly` (`mode=ro&readonly_shm=1`).
 *
 * Two records say a service owns the database:
 * - `server-runtime.json`, written once the service is activated and
 *   listening, removed when it stops;
 * - `database-owner.json` beside it, written by the service before it opens
 *   the database (`layerServiceDatabaseOwner`, before migrations) and removed
 *   only after the database has closed. It covers the minutes of migrations
 *   on a large database before the runtime file exists, and the end of a
 *   shutdown after the runtime file is gone.
 * Either one, while the process that wrote it runs, refuses an outside
 * read-write open, and refuses a second service on the same home.
 *
 * @module liveServiceOwner
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import {
  type PersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import { recordedProcess } from "./processIdentity.ts";

/** `<stateDir>/database-owner.json`, beside `server-runtime.json`. */
export const DATABASE_OWNER_FILE = "database-owner.json";

const DatabaseOwnerRecord = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  startedAt: Schema.String,
});
type DatabaseOwnerRecord = typeof DatabaseOwnerRecord.Type;
const DatabaseOwnerJson = Schema.fromJsonString(DatabaseOwnerRecord);
const decodeDatabaseOwner = Schema.decodeUnknownEffect(DatabaseOwnerJson);
const encodeDatabaseOwner = Schema.encodeEffect(DatabaseOwnerJson);

const databaseOwnerPathFor = (serverRuntimeStatePath: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(path.dirname(serverRuntimeStatePath), DATABASE_OWNER_FILE);
  });

const readDatabaseOwner = (ownerPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(ownerPath);
    return yield* decodeDatabaseOwner(raw);
  }).pipe(
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none<DatabaseOwnerRecord>()),
  );

/** The service whose `database-owner.json` names a process that still runs. */
const runningDatabaseOwnerOf = (
  serverRuntimeStatePath: string,
  unknownStart: "running" | "stale" = "running",
) =>
  Effect.gen(function* () {
    const owner = yield* readDatabaseOwner(yield* databaseOwnerPathFor(serverRuntimeStatePath));
    if (Option.isNone(owner)) return Option.none<DatabaseOwnerRecord>();
    const process = yield* recordedProcess(owner.value.pid, owner.value.startedAt, unknownStart);
    return process === "running" ? owner : Option.none<DatabaseOwnerRecord>();
  });

export class LiveDatabaseOwnedError extends Schema.TaggedError<LiveDatabaseOwnedError>()(
  "LiveDatabaseOwnedError",
  {
    dbPath: Schema.String,
    pid: Schema.Number,
    origin: Schema.String,
  },
) {
  override get message(): string {
    return (
      `SpecWithCode is running (pid ${this.pid}, ${this.origin}) and owns ${this.dbPath}. ` +
      "This command would open that database directly, which can delete the running service's " +
      "unsaved changes, so it does not run while the service does. Do this in the SpecWithCode " +
      "app instead, or stop SpecWithCode first."
    );
  }
}

/**
 * The service recorded in `server-runtime.json`, while the process that wrote
 * it still runs. A pid another process took over after a crash does not
 * count; where the start time cannot be read, a live pid does.
 */
export const runningServiceOf = (
  serverRuntimeStatePath: string,
  unknownStart: "running" | "stale" = "running",
) =>
  Effect.gen(function* () {
    const state = yield* readPersistedServerRuntimeState(serverRuntimeStatePath).pipe(
      Effect.orElseSucceed(() => Option.none<PersistedServerRuntimeState>()),
    );
    if (Option.isNone(state)) return Option.none<PersistedServerRuntimeState>();
    const process = yield* recordedProcess(state.value.pid, state.value.startedAt, unknownStart);
    return process === "running" ? state : Option.none<PersistedServerRuntimeState>();
  });

/**
 * Fails with `LiveDatabaseOwnedError` while a running service owns `dbPath`:
 * one that is serving (`server-runtime.json`), or one that has the database
 * open while it starts or stops (`database-owner.json`).
 */
export const refuseWhileServiceRuns = (input: {
  readonly dbPath: string;
  readonly serverRuntimeStatePath: string;
}) =>
  Effect.gen(function* () {
    const running = yield* runningServiceOf(input.serverRuntimeStatePath);
    if (Option.isSome(running)) {
      return yield* new LiveDatabaseOwnedError({
        dbPath: input.dbPath,
        pid: running.value.pid,
        origin: running.value.origin,
      });
    }
    const owner = yield* runningDatabaseOwnerOf(input.serverRuntimeStatePath);
    if (Option.isSome(owner)) {
      return yield* new LiveDatabaseOwnedError({
        dbPath: input.dbPath,
        pid: owner.value.pid,
        origin: "starting or stopping",
      });
    }
  });

export class DatabaseOwnerError extends Schema.TaggedError<DatabaseOwnerError>()(
  "DatabaseOwnerError",
  { ownerPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not record this service as the database's owner at ${this.ownerPath}.`;
  }
}

/**
 * For the service only: records this process in `database-owner.json` before
 * the database opens and removes the record after it has closed (provide it
 * to the persistence layer, so it is acquired first and released last). A
 * second service on the same home, one another process still runs, is
 * refused with `LiveDatabaseOwnedError` before it opens the database. A
 * record whose process start time cannot be read does not block a start.
 */
export const layerServiceDatabaseOwner = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const ownerPath = yield* databaseOwnerPathFor(config.serverRuntimeStatePath);
    const running = yield* runningServiceOf(config.serverRuntimeStatePath, "stale");
    if (Option.isSome(running) && running.value.pid !== process.pid) {
      return yield* new LiveDatabaseOwnedError({
        dbPath: config.dbPath,
        pid: running.value.pid,
        origin: running.value.origin,
      });
    }
    const owner = yield* runningDatabaseOwnerOf(config.serverRuntimeStatePath, "stale");
    if (Option.isSome(owner) && owner.value.pid !== process.pid) {
      return yield* new LiveDatabaseOwnedError({
        dbPath: config.dbPath,
        pid: owner.value.pid,
        origin: "starting or stopping",
      });
    }
    const record: DatabaseOwnerRecord = {
      version: 1,
      pid: process.pid,
      startedAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* Effect.acquireRelease(
      encodeDatabaseOwner(record).pipe(
        Effect.flatMap((contents) =>
          writeFileStringAtomically({ filePath: ownerPath, contents: `${contents}\n` }),
        ),
        Effect.mapError((cause) => new DatabaseOwnerError({ ownerPath, cause })),
      ),
      () =>
        readDatabaseOwner(ownerPath).pipe(
          Effect.flatMap((current) =>
            Option.isSome(current) && current.value.pid === process.pid
              ? fs.remove(ownerPath, { force: true })
              : Effect.void,
          ),
          Effect.ignore,
        ),
    );
  }),
);
