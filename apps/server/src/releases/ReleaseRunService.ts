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
 */
import { ReleaseRun, type ReleaseRunsSnapshot } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

/** run_record.PREFIX: the records release.sh writes; update runs (`<uuid>.json`) are not listed. */
export const RELEASE_RUN_PREFIX = "release-";
/** Runs answered, newest first. */
export const RELEASE_RUNS_LIMIT = 10;
/** run_record.RECORD_LIMIT: a larger file is no record this release wrote. */
export const RELEASE_RUN_MAX_BYTES = 4 << 20;

const decodeRun = Schema.decodeUnknownOption(Schema.fromJsonString(ReleaseRun));

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

export const makeWithDirectory = (runsDirectory: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

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
        const runs = read.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []));
        return {
          runs: newestFirst(runs).slice(0, Math.max(0, limit)),
          skipped: read.length - runs.length,
        } satisfies ReleaseRunsSnapshot;
      });

    return ReleaseRunService.of({ list });
  });

export const layer = Layer.effect(
  ReleaseRunService,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* makeWithDirectory(path.join(config.baseDir, "updates", "runs"));
  }),
);
