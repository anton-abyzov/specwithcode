// @effect-diagnostics nodeBuiltinImport:off - only node:fs/promises exposes statfs.
import * as NodeFSP from "node:fs/promises";

import {
  formatStorageFreeSpace,
  statfsBytes,
  type StorageStatus,
  type StorageStatusLevel,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";

// Decimal units, as the banner and a Mac's own Finder show free space.
const CRITICAL_BELOW_BYTES = 1e9;
const LOW_BELOW_BYTES = 5e9;
// Clearing needs more room than raising, so a disk hovering at a line does
// not flip the level, and resend the config, every minute.
const CRITICAL_CLEAR_ABOVE_BYTES = 1.5e9;
const CLEAR_ABOVE_BYTES = 6e9;
// Free space within this of the last report reads the same to a person, so
// a disk drifting by a few megabytes does not resend the config each check.
const REPORT_STEP_BYTES = 100e6;
const REPORT_STEP_UNDER_1_GB_BYTES = 50e6;
const SAMPLE_INTERVAL = "60 seconds";
// The first config snapshot should already carry the status, but a slow disk
// must not hold up startup.
const FIRST_SAMPLE_WAIT = "2 seconds";

/** One read of the disk holding the app's data. */
export interface DiskSpaceReading {
  readonly freeBytes: number;
  readonly totalBytes: number;
}

export class DiskSpaceReadError extends Schema.TaggedError<DiskSpaceReadError>()(
  "DiskSpaceReadError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read free disk space.";
  }
}

export class DiskSpaceMonitor extends Context.Service<
  DiskSpaceMonitor,
  {
    /** The latest check, or none before the first one lands. */
    readonly current: Effect.Effect<Option.Option<StorageStatus>>;
    /** The latest check if there is one, then every later check. */
    readonly changes: Stream.Stream<StorageStatus>;
  }
>()("specweave-studio/observability/DiskSpaceMonitor") {}

/** The level for a reading, given the level before it. */
export const storageLevel = (
  previous: StorageStatusLevel,
  freeBytes: number,
): StorageStatusLevel => {
  if (freeBytes < CRITICAL_BELOW_BYTES) return "critical";
  if (previous === "critical" && freeBytes <= CRITICAL_CLEAR_ABOVE_BYTES) return "critical";
  if (freeBytes < LOW_BELOW_BYTES) return "low";
  if (freeBytes > CLEAR_ABOVE_BYTES) return "ok";
  return previous === "ok" ? "ok" : "low";
};

/**
 * Whether a check reads the same to a person as the last one sent: the same
 * level and, while the disk is low, free space within 100 MB (50 MB under
 * 1 GB). Coarser than the shown figure, so a full disk losing a few
 * megabytes a minute does not resend the whole config to every client each
 * check. Compare against the last status sent, not the last check, so slow
 * drift still adds up to a resend.
 */
export const sameStorageReport = (left: StorageStatus, right: StorageStatus): boolean => {
  if (left.level !== right.level) return false;
  if (right.level === "ok") return true;
  const step =
    Math.min(left.freeBytes, right.freeBytes) < 1e9
      ? REPORT_STEP_UNDER_1_GB_BYTES
      : REPORT_STEP_BYTES;
  return Math.abs(left.freeBytes - right.freeBytes) < step;
};

/** A statfs result as a reading, capped so huge mounts stay wire-safe. */
export const readingFromStatfs = (stats: {
  readonly bavail: bigint;
  readonly blocks: bigint;
  readonly bsize: bigint;
}): DiskSpaceReading => ({
  freeBytes: statfsBytes(stats.bavail, stats.bsize),
  totalBytes: statfsBytes(stats.blocks, stats.bsize),
});

const readNodeDiskSpace = (path: string) =>
  Effect.tryPromise({
    try: () => NodeFSP.statfs(path, { bigint: true }),
    catch: (cause) => new DiskSpaceReadError({ path, cause }),
  }).pipe(Effect.map(readingFromStatfs));

/**
 * Checks free space on the disk holding the app's data once at start and then
 * every 60 s, and logs one warning when the level changes, not on every check.
 * Takes the reader so tests can inject readings.
 */
export const layerWith = (
  read: (path: string) => Effect.Effect<DiskSpaceReading, DiskSpaceReadError>,
) =>
  Layer.effect(
    DiskSpaceMonitor,
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const status = yield* SubscriptionRef.make(Option.none<StorageStatus>());

      const check = Effect.gen(function* () {
        const { freeBytes, totalBytes } = yield* read(stateDir);
        const previous = Option.match(yield* SubscriptionRef.get(status), {
          onNone: (): StorageStatusLevel => "ok",
          onSome: (current) => current.level,
        });
        const level = storageLevel(previous, freeBytes);
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        yield* SubscriptionRef.set(
          status,
          Option.some({ level, freeBytes, totalBytes, checkedAt }),
        );
        if (level === previous) return;
        const free = formatStorageFreeSpace(freeBytes);
        const annotations = { level, freeBytes, totalBytes };
        yield* level === "ok"
          ? Effect.logInfo(`disk space recovered: ${free} free`).pipe(
              Effect.annotateLogs(annotations),
            )
          : Effect.logWarning(`disk space is ${level}: ${free} free`).pipe(
              Effect.annotateLogs(annotations),
            );
      }).pipe(
        // A failed read keeps the last status; the next check tries again.
        Effect.catch((error) =>
          Effect.logDebug("disk space check failed").pipe(Effect.annotateLogs({ error })),
        ),
      );

      const firstCheck = yield* Deferred.make<void>();
      yield* check.pipe(
        Effect.ensuring(Deferred.succeed(firstCheck, undefined)),
        Effect.andThen(Effect.sleep(SAMPLE_INTERVAL).pipe(Effect.andThen(check), Effect.forever)),
        Effect.forkScoped,
      );
      yield* Deferred.await(firstCheck).pipe(Effect.timeoutOption(FIRST_SAMPLE_WAIT));

      return DiskSpaceMonitor.of({
        current: SubscriptionRef.get(status),
        changes: SubscriptionRef.changes(status).pipe(
          Stream.filter(Option.isSome),
          Stream.map((current) => current.value),
        ),
      });
    }),
  );

export const layer = layerWith(readNodeDiskSpace);
