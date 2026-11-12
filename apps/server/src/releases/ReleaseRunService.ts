/**
 * Release run records for the Releases view (increment 1239, AC-23).
 *
 * A release writes one record per run, `updates/runs/release-<v>-<runId>.json`
 * under the service's base directory (scripts/release/run_record.py), beside
 * the update runs the desktop archives there. This service only reads: it
 * lists the release records, decodes each with the contract's schema, and
 * answers the newest first. A missing folder holds no runs; a file that is
 * not a record (a partial copy, a newer schema, one too large) is counted in
 * `skipped`, never an error, so one bad file never hides the others.
 *
 * For Speed by version it also answers the timings of more runs than it sends
 * whole (`timings`), and how long each verified update install took on this
 * machine (`installs`). Those come from update.py's receipts,
 * `updates/receipts/update-<version>-<stamp>.json`, which the update keeps
 * only its last few of; the timings are copied into a small history file of
 * their own (`updates/install-timings.json`, newest INSTALL_HISTORY_LIMIT) so
 * an install stays comparable after its receipt is pruned. Receipts are read
 * in the background, never while a request waits: `list` answers the history
 * as it stands and starts a read when none runs; the next refresh has it. A
 * receipt the history already holds is never parsed again, after a restart too.
 */
import {
  ReleaseInstallTiming,
  ReleaseRun,
  releaseRunTiming,
  type ReleaseRunsSnapshot,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

/** run_record.PREFIX: the records release.sh writes; update runs (`<uuid>.json`) are not listed. */
export const RELEASE_RUN_PREFIX = "release-";
/** Runs answered, newest first. */
export const RELEASE_RUNS_LIMIT = 10;
/** run_record.RECORD_LIMIT: a larger file is no record this release wrote. */
export const RELEASE_RUN_MAX_BYTES = 4 << 20;

/** Runs whose timings Speed by version gets, newest first. */
export const RELEASE_TIMINGS_LIMIT = 30;
/** update_agent.py names each attempt's receipt `update-<version>-<stamp>.json`. */
export const INSTALL_RECEIPT = /^update-(.+)-(\d{8})T(\d{6})(\d{0,6})Z\.json$/;
/** install_progress.expected_ms reads no larger receipt either. */
export const INSTALL_RECEIPT_MAX_BYTES = 16 << 20;
/** Receipts read, newest by name; the update keeps ten (release_retention.RECEIPTS_KEPT). */
export const INSTALL_RECEIPTS_READ = 12;
/** Verified installs kept in the history file and answered, newest first. */
export const INSTALL_HISTORY_LIMIT = 30;
export const INSTALL_HISTORY_FILE = "install-timings.json";
const INSTALL_HISTORY_MAX_BYTES = 1 << 20;
const MAX_PHASES = 32;

const decodeRun = Schema.decodeUnknownOption(Schema.fromJsonString(ReleaseRun));
const InstallHistory = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  installs: Schema.Array(ReleaseInstallTiming),
  /** Receipt names whose install is in `installs`, so a restart does not parse them again. */
  receipts: Schema.optionalKey(Schema.Array(Schema.String)),
});
type InstallHistory = typeof InstallHistory.Type;
const decodeHistory = Schema.decodeUnknownOption(Schema.fromJsonString(InstallHistory));
/** Only the version, to tell a newer service's history (kept as it is) from a damaged one. */
const decodeHistoryVersion = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ schemaVersion: Schema.Number })),
);
const encodeHistory = Schema.encodeSync(Schema.fromJsonString(InstallHistory));

/** The few fields of an update receipt this reads; the rest of it is never decoded. */
const InstallReceipt = Schema.Struct({
  phase: Schema.optionalKey(Schema.Unknown),
  timings: Schema.optionalKey(Schema.Unknown),
  verifiedAt: Schema.optionalKey(Schema.Unknown),
});
const decodeReceipt = Schema.decodeUnknownOption(Schema.fromJsonString(InstallReceipt));

const isMs = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isoOf = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : null;
};

/**
 * The timings of a verified install from its receipt, or none: a receipt still
 * being written (`prepared`, `restart-requested`), a refusal or a failure took
 * another time than an install. `timings.total` is the whole apply.
 */
export function parseInstallReceipt(
  name: string,
  text: string,
): Option.Option<ReleaseInstallTiming> {
  const match = INSTALL_RECEIPT.exec(name);
  const decoded = match ? decodeReceipt(text) : Option.none();
  if (!match || Option.isNone(decoded)) return Option.none();
  const { phase, timings, verifiedAt } = decoded.value;
  if (phase !== "verified" || typeof timings !== "object" || timings === null) return Option.none();
  const { total, ...rest } = timings as Record<string, unknown>;
  if (!isMs(total) || total <= 0) return Option.none();
  const phases = Object.fromEntries(
    Object.entries(rest)
      .filter(([phaseName, ms]) => phaseName.length <= 64 && isMs(ms))
      .slice(0, MAX_PHASES),
  ) as Record<string, number>;
  const [, version, day, time, fraction] = match;
  const stamped = `${day!.slice(0, 4)}-${day!.slice(4, 6)}-${day!.slice(6)}T${time!.slice(0, 2)}:${time!.slice(2, 4)}:${time!.slice(4)}${fraction ? `.${fraction.slice(0, 3).padEnd(3, "0")}` : ""}Z`;
  const installedAt = isoOf(verifiedAt) ?? isoOf(stamped);
  if (installedAt === null) return Option.none();
  return Option.some({
    version: version!,
    installedAt,
    totalMs: total,
    ...(Object.keys(phases).length > 0 ? { phases } : {}),
  });
}

/** Receipt names by their stamp, newest first: the version in a name does not sort by time. */
export function newestReceiptsFirst(names: ReadonlyArray<string>): ReadonlyArray<string> {
  const stampOf = (name: string) => {
    const match = INSTALL_RECEIPT.exec(name);
    return match ? `${match[2]}${match[3]}${match[4]!.padEnd(6, "0")}` : "";
  };
  return [...names].sort(
    (left, right) => stampOf(right).localeCompare(stampOf(left)) || right.localeCompare(left),
  );
}

const installKey = (install: ReleaseInstallTiming) => `${install.version}@${install.installedAt}`;

/** Both lists' installs once each, newest first, at most `limit`. */
export function mergeInstalls(
  kept: ReadonlyArray<ReleaseInstallTiming>,
  read: ReadonlyArray<ReleaseInstallTiming>,
  limit = INSTALL_HISTORY_LIMIT,
): ReadonlyArray<ReleaseInstallTiming> {
  const byKey = new Map<string, ReleaseInstallTiming>();
  for (const install of [...kept, ...read]) byKey.set(installKey(install), install);
  return [...byKey.values()]
    .sort(
      (left, right) =>
        right.installedAt.localeCompare(left.installedAt) ||
        right.version.localeCompare(left.version),
    )
    .slice(0, Math.max(0, limit));
}

/** The record a file holds, or none when it is not one. */
export function parseReleaseRun(text: string): Option.Option<ReleaseRun> {
  return decodeRun(text);
}

/** Newest first by start time, then by name for runs that started the same second. */
export function newestFirst(runs: ReadonlyArray<ReleaseRun>): ReadonlyArray<ReleaseRun> {
  return [...runs].sort(
    (left, right) =>
      right.startedAt.localeCompare(left.startedAt) || right.runId.localeCompare(left.runId),
  );
}

export interface ReleaseRunServiceShape {
  /** The newest `limit` release runs; never fails. */
  readonly list: (limit?: number) => Effect.Effect<ReleaseRunsSnapshot>;
}

export class ReleaseRunService extends Context.Service<ReleaseRunService, ReleaseRunServiceShape>()(
  "specweave-studio/releases/ReleaseRunService",
) {}

export interface InstallTimingFiles {
  /** update.py's receipts, `updates/receipts`. */
  readonly receiptsDirectory: string;
  /** The history this service keeps, `updates/install-timings.json`. */
  readonly historyFile: string;
}

export const makeWithDirectory = (runsDirectory: string, installFiles?: InstallTimingFiles) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const installLock = yield* Semaphore.make(1);
    /** Receipts already read, by name, while their size and time stay the same. */
    const receiptCache = new Map<
      string,
      { readonly stamp: string; readonly install: Option.Option<ReleaseInstallTiming> }
    >();
    let history: InstallHistory | null = null;
    /** False once the file on disk is a newer service's history: it is read, never replaced. */
    let historyWritable = true;
    let scanning = false;
    /** The receipt read `list` started last, so a caller can wait for it to finish. */
    let scanFiber: Fiber.Fiber<void> | undefined;

    const readReceipt = (directory: string, name: string) =>
      Effect.gen(function* () {
        const file = path.join(directory, name);
        const info = yield* fileSystem.stat(file);
        if (info.type !== "File" || Number(info.size) > INSTALL_RECEIPT_MAX_BYTES) {
          return Option.none<ReleaseInstallTiming>();
        }
        const stamp = `${Number(info.size)}:${Option.getOrUndefined(info.mtime)?.getTime() ?? 0}`;
        const cached = receiptCache.get(name);
        if (cached?.stamp === stamp) return cached.install;
        const install = parseInstallReceipt(name, yield* fileSystem.readFileString(file));
        receiptCache.set(name, { stamp, install });
        return install;
      }).pipe(Effect.orElseSucceed(() => Option.none<ReleaseInstallTiming>()));

    const emptyHistory: InstallHistory = { schemaVersion: 1, installs: [] };

    /** The history on disk; a missing, damaged or oversized file reads as none and is replaced. */
    const readHistory = (file: string) =>
      Effect.gen(function* () {
        const info = yield* fileSystem.stat(file);
        if (info.type !== "File" || Number(info.size) > INSTALL_HISTORY_MAX_BYTES) {
          return { history: emptyHistory, writable: true };
        }
        const text = yield* fileSystem.readFileString(file);
        const decoded = decodeHistory(text);
        if (Option.isSome(decoded)) return { history: decoded.value, writable: true };
        const version = decodeHistoryVersion(text);
        return {
          history: emptyHistory,
          writable: !(Option.isSome(version) && version.value.schemaVersion > 1),
        };
      }).pipe(Effect.orElseSucceed(() => ({ history: emptyHistory, writable: true })));

    const loadHistory = (file: string) =>
      Effect.gen(function* () {
        const loaded = yield* readHistory(file);
        if (!loaded.writable) historyWritable = false;
        history ??= loaded.history;
        return history;
      });

    /**
     * A new file beside it, renamed over it: a reader sees the old history or the new one.
     * Writes run one at a time (installLock), so the one temporary name is enough.
     */
    const writeHistory = (file: string, value: InstallHistory) =>
      Effect.gen(function* () {
        const temporary = `${file}.tmp`;
        yield* fileSystem.writeFileString(temporary, `${encodeHistory(value)}\n`, { mode: 0o600 });
        yield* fileSystem.rename(temporary, file);
      }).pipe(Effect.ignore);

    /** Reads the receipts the history does not hold yet and keeps their installs. */
    const scanInstalls = (files: InstallTimingFiles) =>
      installLock.withPermits(1)(
        Effect.gen(function* () {
          const present = (yield* fileSystem
            .readDirectory(files.receiptsDirectory)
            .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))).filter((name) =>
            INSTALL_RECEIPT.test(name),
          );
          const names = newestReceiptsFirst(present).slice(0, INSTALL_RECEIPTS_READ);
          for (const name of receiptCache.keys()) {
            if (!names.includes(name)) receiptCache.delete(name);
          }
          const current = history ?? (yield* loadHistory(files.historyFile));
          const known = new Set(current.receipts ?? []);
          const fresh = names.filter((name) => !known.has(name));
          const read = yield* Effect.forEach(
            fresh,
            (name) =>
              readReceipt(files.receiptsDirectory, name).pipe(
                Effect.map((install) => [name, install] as const),
              ),
            { concurrency: 4 },
          );
          const found = read.flatMap(([name, install]) =>
            Option.isSome(install) ? [[name, install.value] as const] : [],
          );
          const merged = mergeInstalls(
            current.installs,
            found.map(([, install]) => install),
          );
          const stillPresent = new Set(present);
          const receipts = [...new Set([...found.map(([name]) => name), ...known])].filter((name) =>
            stillPresent.has(name),
          );
          const changed =
            merged.length !== current.installs.length ||
            merged.some(
              (install, index) => installKey(install) !== installKey(current.installs[index]!),
            ) ||
            receipts.length !== known.size;
          const next: InstallHistory = { schemaVersion: 1, installs: merged, receipts };
          history = next;
          if (changed && historyWritable) yield* writeHistory(files.historyFile, next);
          return merged;
        }),
      );

    /**
     * The installs the history holds now. A receipt read runs in the background, one at a
     * time, so a request never waits on receipts; the next refresh answers what it found.
     */
    const installs = (files: InstallTimingFiles) =>
      Effect.gen(function* () {
        const current = history ?? (yield* loadHistory(files.historyFile));
        if (!scanning) {
          scanning = true;
          scanFiber = yield* scanInstalls(files).pipe(
            Effect.ignore,
            Effect.ensuring(
              Effect.sync(() => {
                scanning = false;
              }),
            ),
            Effect.forkDetach,
          );
        }
        return current.installs;
      });

    const readOne = (name: string) =>
      Effect.gen(function* () {
        const file = path.join(runsDirectory, name);
        const info = yield* fileSystem.stat(file);
        if (info.type !== "File" || Number(info.size) > RELEASE_RUN_MAX_BYTES) {
          return Option.none<ReleaseRun>();
        }
        return parseReleaseRun(yield* fileSystem.readFileString(file));
      }).pipe(Effect.orElseSucceed(() => Option.none<ReleaseRun>()));

    const list = (limit = RELEASE_RUNS_LIMIT) =>
      Effect.gen(function* () {
        const names = yield* fileSystem
          .readDirectory(runsDirectory)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        const records = names.filter(
          (name) => name.startsWith(RELEASE_RUN_PREFIX) && name.endsWith(".json"),
        );
        const read = yield* Effect.forEach(records, readOne, { concurrency: 4 });
        const runs = newestFirst(
          read.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : [])),
        );
        const now = yield* Clock.currentTimeMillis;
        return {
          runs: runs.slice(0, Math.max(0, limit)),
          skipped: read.length - runs.length,
          timings: runs.slice(0, RELEASE_TIMINGS_LIMIT).map((run) => releaseRunTiming(run, now)),
          ...(installFiles ? { installs: yield* installs(installFiles) } : {}),
        } satisfies ReleaseRunsSnapshot;
      });

    return {
      ...ReleaseRunService.of({ list }),
      /** Reads the receipts now and answers the installs kept; what `list` starts in the background. */
      refreshInstalls: installFiles
        ? scanInstalls(installFiles)
        : Effect.succeed<ReadonlyArray<ReleaseInstallTiming>>([]),
      /**
       * Waits until no receipt read started by `list` is running, so whoever owns the
       * directories can remove them without a read still writing the history.
       */
      awaitBackgroundScan: Effect.gen(function* () {
        while (scanning && scanFiber) {
          yield* Fiber.await(scanFiber);
          // A read just being started may not have its fiber stored yet: let it run.
          yield* Effect.yieldNow;
        }
      }),
    };
  });

export const layer = Layer.effect(
  ReleaseRunService,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const updates = path.join(config.baseDir, "updates");
    const service = yield* makeWithDirectory(path.join(updates, "runs"), {
      receiptsDirectory: path.join(updates, "receipts"),
      historyFile: path.join(updates, INSTALL_HISTORY_FILE),
    });
    // Startup never waits on it: the first Releases view usually finds it done.
    yield* service.refreshInstalls.pipe(Effect.ignore, Effect.forkDetach);
    return ReleaseRunService.of({ list: service.list });
  }),
);
