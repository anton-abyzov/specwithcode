/**
 * `specweave-studio db`: the supported way to read the live database.
 *
 * Opening `userdata/statev2.sqlite` directly, even read-only (`sqlite3
 * -readonly`, Python `?mode=ro`), can truncate the `-shm` index the running
 * service has mapped and crash it. These commands open the database through
 * `openLiveDatabaseReadOnly`, which cannot change it, its `-wal` or its `-shm`.
 * `reclaim` is the exception: it writes only once the service is stopped and
 * it holds an exclusive lock (see persistence/DatabaseReclaim.ts); its
 * `--dry-run` reads with the same read-only flags.
 */
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import * as DatabaseReclaim from "../persistence/DatabaseReclaim.ts";
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

/** The home of `--base-dir`, else of STUDIO_HOME, else the default home, with its paths. */
const resolveHome = Effect.fn("cli.db.resolve_home")(function* (baseDir: Option.Option<string>) {
  const envHome = yield* Config.String("STUDIO_HOME").pipe(Config.option);
  const home = yield* resolveBaseDir(Option.getOrUndefined(Option.orElse(baseDir, () => envHome)));
  return { home, paths: yield* ServerConfig.deriveServerPaths(home, undefined) };
});

/** The database of `--base-dir`, else of STUDIO_HOME, else of the default home. */
export const resolveDatabasePath = Effect.fn("cli.db.resolve_path")(function* (
  baseDir: Option.Option<string>,
) {
  return (yield* resolveHome(baseDir)).paths.dbPath;
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

const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MiB`
      : `${Math.ceil(bytes / 1024)} KiB`;

const formatDeleted = (byType: Readonly<Record<string, number>>) =>
  Object.entries(byType)
    .toSorted(([, left], [, right]) => right - left)
    .map(([type, count]) => `${count} ${type}`)
    .join(", ") || "none";

const reclaimCommand = Command.make("reclaim", {
  baseDir: baseDirFlag,
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription(
      "Report what reclaim would delete and the expected file size; change nothing. Works while SpecWithCode runs.",
    ),
    Flag.withDefault(false),
  ),
  workDir: Flag.String("work-dir").pipe(
    Flag.withDescription(
      "Folder for the rewritten copy (needs about the database's used size free). Beside the database by default.",
    ),
    Flag.optional,
  ),
  incremental: Flag.Boolean("incremental").pipe(
    Flag.withDescription(
      "Also turn on auto_vacuum=INCREMENTAL so later compaction returns space by itself. Updates then always read the database in full a second time: the update helper's page proof refuses auto-vacuum databases.",
    ),
    Flag.withDefault(false),
  ),
  forceStalePid: Flag.Boolean("force-stale-pid").pipe(
    Flag.withDescription(
      "Ignore the pid in server-runtime.json, updates/hold.json and statev2.sqlite.reclaim-lock when it no longer names SpecWithCode or a reclaim (a crash or reboot left the file and another process took the pid). Reclaim still refuses while any process has the database open.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Delete superseded event history and rewrite the database to return the space to the disk. Stop SpecWithCode first; refused while it runs or an update is in progress. The original is kept beside it as statev2.sqlite.before-reclaim-<time>. Not available on Windows.",
  ),
  Command.withHandler(
    Effect.fn("cli.db.reclaim")(function* (flags) {
      const { home, paths } = yield* resolveHome(flags.baseDir);
      const log = (line: string) => Console.log(line);
      const result = yield* DatabaseReclaim.reclaim({
        dbPath: paths.dbPath,
        baseDir: home,
        serverRuntimeStatePath: paths.serverRuntimeStatePath,
        dryRun: flags.dryRun,
        incremental: flags.incremental,
        forceStalePid: flags.forceStalePid,
        log,
        ...(Option.isSome(flags.workDir) ? { workDir: flags.workDir.value } : {}),
      });
      if (result.dryRun) {
        const { storage, compaction, expectedBytes } = result;
        yield* Console.log(
          [
            `Database ${paths.dbPath}: ${formatBytes(storage.fileBytes)}, auto_vacuum ${storage.autoVacuum}.`,
            `Free list: ${storage.freelistPages} pages (${formatBytes(storage.freelistPages * storage.pageSize)}).`,
            `Superseded events: ${compaction.deletedEventCount} (${formatDeleted(compaction.deletedByType)}), ${formatBytes(compaction.deletedEventChars)} of payload and metadata; ${compaction.deletedReceiptCount} legacy receipts.`,
            `Expected size after VACUUM INTO: ${formatBytes(expectedBytes.low)} to ${formatBytes(expectedBytes.high)}.`,
            "Dry run: nothing changed.",
          ].join("\n"),
        );
        return;
      }
      yield* Console.log(
        [
          `Done: ${formatBytes(result.before.fileBytes)} -> ${formatBytes(result.afterBytes)} in ${Math.round(result.elapsedMs / 1000)} s.`,
          `Deleted ${result.compaction.deletedEventCount} superseded events (${formatDeleted(result.compaction.deletedByType)}) and ${result.compaction.deletedReceiptCount} legacy receipts.`,
          `Checked ${result.checkedTables} tables; the log still ends at sequence ${result.maxSequence}. auto_vacuum ${result.autoVacuum}.`,
          `The original is kept at ${result.backupPath}; delete it once SpecWithCode starts normally.`,
        ].join("\n"),
      );
    }),
  ),
);

export const dbCommand = Command.make("db").pipe(
  Command.withDescription(
    "Read the live database safely, or reclaim its space while stopped. Never open userdata/statev2.sqlite with sqlite3, Python or Node directly.",
  ),
  Command.withSubcommands([snapshotCommand, queryCommand, reclaimCommand]),
);
