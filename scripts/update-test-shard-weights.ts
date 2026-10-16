#!/usr/bin/env node

// Rewrites apps/server/src/testUtils/shardWeights.json, the recorded per-file test times that
// WeightedShardSequencer splits `--shard` runs by, from vitest JSON reports, such as the
// per-shard reports scripts/release/test-sharded.mjs writes:
//
//   node scripts/release/test-sharded.mjs --shards 3 --out /tmp/t
//   node scripts/update-test-shard-weights.ts /tmp/t/server-1.json /tmp/t/server-2.json /tmp/t/server-3.json
//
// apps/server/scripts/update-test-shard-weights.ts runs the whole suite in one process and
// records it through this script.
//
// A file's time is its first test's start to its last test's end, the same span the recorded
// times have always held; the sequencer adds its own per-file import overhead. Keys are paths
// relative to the server package, as the sequencer looks them up. Files under --min-seconds
// are left out and count as fast files. Without --merge the reports replace every entry, so
// pass every shard of one full run; --merge keeps entries for files the reports do not have.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import { fromJsonStringPretty } from "@specweave-studio/shared/schemaJson";

export class ShardWeightsError extends Schema.TaggedError<ShardWeightsError>()(
  "ShardWeightsError",
  {
    operation: Schema.Literals(["read", "decode", "encode", "write", "locate"]),
    filePath: Schema.String,
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} '${this.filePath}'${this.detail ? `: ${this.detail}` : "."}`;
  }
}

const VitestJsonReport = Schema.Struct({
  testResults: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      startTime: Schema.Number,
      endTime: Schema.Number,
    }),
  ),
});
const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(VitestJsonReport));

const ShardWeights = Schema.Record(Schema.String, Schema.Number);
const ShardWeightsJson = fromJsonStringPretty(ShardWeights);
const decodeWeights = Schema.decodeUnknownEffect(ShardWeightsJson);
const encodeWeights = Schema.encodeEffect(ShardWeightsJson);

export const DEFAULT_MIN_SECONDS = 0.5;

interface UpdateShardWeightsOptions {
  /** The directory the suite ran in: report paths are made relative to it. */
  readonly serverRoot: string;
  readonly weightsFile: string;
  readonly reports: ReadonlyArray<string>;
  readonly minSeconds?: number | undefined;
  readonly merge?: boolean | undefined;
}

const roundTenth = (seconds: number) => Math.round(seconds * 10) / 10;

export const updateShardWeights = Effect.fn("updateShardWeights")(function* (
  options: UpdateShardWeightsOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const minSeconds = options.minSeconds ?? DEFAULT_MIN_SECONDS;
  const serverRoot = path.resolve(options.serverRoot);
  const measured = new Map<string, number>();

  for (const reportFile of options.reports) {
    const text = yield* fs
      .readFileString(reportFile)
      .pipe(
        Effect.mapError(
          (cause) => new ShardWeightsError({ operation: "read", filePath: reportFile, cause }),
        ),
      );
    const report = yield* decodeReport(text).pipe(
      Effect.mapError(
        (cause) => new ShardWeightsError({ operation: "decode", filePath: reportFile, cause }),
      ),
    );
    for (const result of report.testResults) {
      const key = path.relative(serverRoot, result.name).replaceAll("\\", "/");
      if (key.startsWith("../") || path.isAbsolute(key)) {
        return yield* new ShardWeightsError({
          operation: "locate",
          filePath: result.name,
          detail: `outside ${serverRoot}; pass the server directory the suite ran in with --root`,
        });
      }
      const seconds = Math.max(0, result.endTime - result.startTime) / 1000;
      measured.set(key, Math.max(measured.get(key) ?? 0, seconds));
    }
  }

  const previous: Record<string, number> = (yield* fs.exists(options.weightsFile))
    ? yield* fs.readFileString(options.weightsFile).pipe(
        Effect.flatMap(decodeWeights),
        Effect.mapError(
          (cause) =>
            new ShardWeightsError({ operation: "decode", filePath: options.weightsFile, cause }),
        ),
      )
    : {};

  const next = new Map<string, number>();
  if (options.merge) {
    for (const [key, seconds] of Object.entries(previous)) {
      if (!measured.has(key)) next.set(key, seconds);
    }
  }
  for (const [key, seconds] of measured) {
    if (seconds >= minSeconds) next.set(key, roundTenth(seconds));
    else next.delete(key);
  }

  const weights = Object.fromEntries(
    [...next.entries()].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const json = yield* encodeWeights(weights).pipe(
    Effect.mapError(
      (cause) =>
        new ShardWeightsError({ operation: "encode", filePath: options.weightsFile, cause }),
    ),
  );
  yield* fs
    .writeFileString(options.weightsFile, `${json}\n`)
    .pipe(
      Effect.mapError(
        (cause) =>
          new ShardWeightsError({ operation: "write", filePath: options.weightsFile, cause }),
      ),
    );

  const total = (values: Iterable<number>) => roundTenth([...values].reduce((a, b) => a + b, 0));
  return {
    measuredFiles: measured.size,
    recordedFiles: next.size,
    recordedSeconds: total(next.values()),
    previousFiles: Object.keys(previous).length,
    previousSeconds: total(Object.values(previous)),
  };
});

export const updateShardWeightsCommand = Command.make(
  "update-test-shard-weights",
  {
    reports: Argument.String("report").pipe(
      Argument.withDescription("vitest JSON reporter output; pass every shard of the run."),
      Argument.atLeast(1),
    ),
    root: Flag.String("root").pipe(
      Flag.withDescription(
        "Server directory the suite ran in (default: this checkout's apps/server).",
      ),
      Flag.optional,
    ),
    out: Flag.String("out").pipe(
      Flag.withDescription(
        "Weights file to write (default: <root>/src/testUtils/shardWeights.json).",
      ),
      Flag.optional,
    ),
    minSeconds: Flag.Finite("min-seconds").pipe(
      Flag.withDescription("Leave out files faster than this (default 0.5)."),
      Flag.withDefault(DEFAULT_MIN_SECONDS),
    ),
    merge: Flag.Boolean("merge").pipe(
      Flag.withDescription("Keep entries for files the reports do not include."),
      Flag.withDefault(false),
    ),
  },
  ({ reports, root, out, minSeconds, merge }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverRoot = path.resolve(
        Option.getOrElse(root, () => path.join(import.meta.dirname, "../apps/server")),
      );
      const weightsFile = path.resolve(
        Option.getOrElse(out, () => path.join(serverRoot, "src/testUtils/shardWeights.json")),
      );
      const summary = yield* updateShardWeights({
        serverRoot,
        weightsFile,
        reports,
        minSeconds,
        merge,
      });
      yield* Console.log(
        `Wrote ${summary.recordedFiles} file times (${summary.recordedSeconds}s) from ` +
          `${summary.measuredFiles} measured files to ${weightsFile}; it held ` +
          `${summary.previousFiles} (${summary.previousSeconds}s)`,
      );
    }),
).pipe(Command.withDescription("Regenerate server test shard weights from vitest JSON reports."));

if (import.meta.main) {
  Command.run(updateShardWeightsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
