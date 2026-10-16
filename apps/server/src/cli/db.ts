/**
 * `specweave-studio db`: the supported way to read the live database.
 *
 * Opening `userdata/statev2.sqlite` directly, even read-only (`sqlite3
 * -readonly`, Python `?mode=ro`), can truncate the `-shm` index the running
 * service has mapped and crash it. These commands open the database through
 * `openLiveDatabaseReadOnly`, which cannot change it, its `-wal` or its `-shm`.
 */
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/cli";

import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import {
  openLiveDatabaseReadOnly,
  snapshotLiveDatabase,
} from "../persistence/liveDatabaseSnapshot.ts";
import { baseDirFlag } from "./config.ts";

export class CliDatabaseError extends Schema.TaggedError<CliDatabaseError>()("CliDatabaseError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

const failure = (cause: unknown) =>
  new CliDatabaseError({ reason: cause instanceof Error ? cause.message : String(cause) });

/** The database of `--base-dir`, else of STUDIO_HOME, else of the default home. */
const resolveDatabasePath = Effect.fn("cli.db.resolve_path")(function* (
  baseDir: Option.Option<string>,
) {
  const envHome = yield* Config.String("STUDIO_HOME").pipe(Config.option);
  const home = yield* resolveBaseDir(Option.getOrUndefined(Option.orElse(baseDir, () => envHome)));
  return (yield* ServerConfig.deriveServerPaths(home, undefined)).dbPath;
});

/** JSON for one cell: integers past 2^53 as strings, blobs as hex. */
const cellJson = (_key: string, value: unknown): unknown => {
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Uint8Array) return { blobHex: Buffer.from(value).toString("hex") };
  return value;
};

const snapshotCommand = Command.make("snapshot", {
  baseDir: baseDirFlag,
  output: Argument.String("output").pipe(
    Argument.withDescription("New file to write the copy to. It must not exist yet."),
  ),
}).pipe(
  Command.withDescription(
    "Copy the live database to a new file without disturbing the running service.",
  ),
  Command.withHandler(
    Effect.fn("cli.db.snapshot")(function* (flags) {
      const dbPath = yield* resolveDatabasePath(flags.baseDir);
      const snapshot = yield* Effect.tryPromise({
        try: () => snapshotLiveDatabase(dbPath, flags.output),
        catch: failure,
      });
      yield* Console.log(
        `Wrote ${snapshot.path} (${snapshot.bytes} bytes, ${snapshot.pages} pages, quick_check ${snapshot.quickCheck}) from ${dbPath}.`,
      );
    }),
  ),
);

const queryCommand = Command.make("query", {
  baseDir: baseDirFlag,
  sql: Argument.String("sql").pipe(
    Argument.withDescription("One SQL statement. The connection is read-only."),
  ),
}).pipe(
  Command.withDescription(
    "Run a read-only SQL query against the live database and print each row as a JSON line.",
  ),
  Command.withHandler(
    Effect.fn("cli.db.query")(function* (flags) {
      const dbPath = yield* resolveDatabasePath(flags.baseDir);
      const lines = yield* Effect.try({
        try: () => {
          const database = openLiveDatabaseReadOnly(dbPath);
          try {
            const statement = database.prepare(flags.sql);
            statement.setReadBigInts(true);
            return statement.all().map((row) => JSON.stringify(row, cellJson));
          } finally {
            database.close();
          }
        },
        catch: failure,
      });
      for (const line of lines) yield* Console.log(line);
    }),
  ),
);

export const dbCommand = Command.make("db").pipe(
  Command.withDescription(
    "Read the live database safely. Never open userdata/statev2.sqlite with sqlite3, Python or Node directly.",
  ),
  Command.withSubcommands([snapshotCommand, queryCommand]),
);
