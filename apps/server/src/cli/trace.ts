/**
 * `specweave-studio trace summary` - per-span counts, rates, and latency percentiles from
 * the local server trace file and its rotated backups. It reads the files
 * directly, so it works while the server is stalled or stopped.
 *
 * `specweave-studio doctor` reads the same files to explain a slow send.
 */
import { PositiveInt } from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import * as ServerConfig from "../config.ts";
import {
  checkDatabaseFiles,
  checkRendererMemory,
  formatDoctorReport,
  makeSessionDoctor,
} from "../diagnostics/SessionDoctor.ts";
import { streamTraceFileLines, toRotatedTracePaths } from "../diagnostics/TraceDiagnostics.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag, DurationFromString, traceFileConfig, traceMaxFilesConfig } from "./config.ts";

// Only the fields the summary needs. Other record fields are ignored.
const decodeTraceSpanLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      durationMs: Schema.Finite,
      endTimeUnixNano: Schema.FiniteFromString,
      // Server (`effect-span`) records.
      exit: Schema.optional(Schema.Struct({ _tag: Schema.String })),
      // Browser (`otlp-span`) records. Effect's OTLP tracer writes code "2" for
      // errors and code "1" with message "Interrupted" for interrupts.
      status: Schema.optional(
        Schema.Struct({
          code: Schema.optional(Schema.String),
          message: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

/**
 * Groups trace NDJSON by span name. Call `addLine` once per line as the files
 * stream in, then `finish` for the summary. Spans that ended before `sinceMs`
 * are left out. Rates are per minute between the first and last span end,
 * since spans are written when they end.
 */
export function makeTraceSpanSummary(sinceMs = -Infinity) {
  // Keep each span's duration (8 bytes, a few MB for the default 110 MB of
  // rotated traces) for exact percentiles. A bounded sketch would save little
  // and make p50 and p90 approximate.
  const byName = new Map<string, { durations: number[]; interrupted: number; failures: number }>();
  let spanCount = 0;
  let skippedLineCount = 0;
  let firstEndMs = Infinity;
  let lastEndMs = -Infinity;

  const addLine = (line: string) => {
    if (line.trim().length === 0) return;
    const span = Option.getOrUndefined(decodeTraceSpanLine(line));
    if (span === undefined) {
      skippedLineCount += 1;
      return;
    }
    const endMs = span.endTimeUnixNano / 1_000_000;
    // The report prints end times as dates, so skip ones outside the Date range.
    if (Option.isNone(DateTime.make(endMs))) {
      skippedLineCount += 1;
      return;
    }
    if (endMs < sinceMs) return;

    spanCount += 1;
    firstEndMs = Math.min(firstEndMs, endMs);
    lastEndMs = Math.max(lastEndMs, endMs);
    const stats = byName.get(span.name) ?? { durations: [], interrupted: 0, failures: 0 };
    stats.durations.push(span.durationMs);
    if (span.exit?._tag === "Interrupted" || span.status?.message === "Interrupted") {
      stats.interrupted += 1;
    }
    if (span.exit?._tag === "Failure" || span.status?.code === "2") stats.failures += 1;
    byName.set(span.name, stats);
  };

  const finish = () => {
    const minutes = (lastEndMs - firstEndMs) / 60_000;
    const spans = [...byName]
      .map(([name, { durations, interrupted, failures }]) => {
        const sorted = durations.toSorted((left, right) => left - right);
        // Nearest-rank percentile.
        const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]!;
        return {
          name,
          count: sorted.length,
          perMinute: minutes > 0 ? sorted.length / minutes : undefined,
          p50Ms: percentile(0.5),
          p90Ms: percentile(0.9),
          maxMs: sorted[sorted.length - 1]!,
          interrupted,
          failures,
        };
      })
      .toSorted((left, right) => right.count - left.count || left.name.localeCompare(right.name));

    return { spanCount, skippedLineCount, firstEndMs, lastEndMs, minutes, spans };
  };

  return { addLine, finish };
}

const formatMs = (ms: number) =>
  ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(1)}s`;

function formatTraceSummary(
  summary: ReturnType<ReturnType<typeof makeTraceSpanSummary>["finish"]>,
  limit: number,
) {
  const header = ["span", "count", "/min", "p50", "p90", "max", "interrupted", "failed"];
  const rows = summary.spans
    .slice(0, limit)
    .map((span) => [
      span.name,
      String(span.count),
      span.perMinute === undefined
        ? "-"
        : span.perMinute < 0.1
          ? "<0.1"
          : span.perMinute.toFixed(1),
      formatMs(span.p50Ms),
      formatMs(span.p90Ms),
      formatMs(span.maxMs),
      String(span.interrupted),
      String(span.failures),
    ]);
  const table = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...table.map((row) => row[column]!.length)));
  const formatIso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
  return [
    `${summary.spanCount} spans ended from ${formatIso(summary.firstEndMs)} to ${formatIso(summary.lastEndMs)} (${summary.minutes.toFixed(1)} min).`,
    ...(summary.skippedLineCount > 0
      ? [`Skipped ${summary.skippedLineCount} lines that are not spans.`]
      : []),
    "",
    ...table.map((row) =>
      row
        .map((cell, column) =>
          column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!),
        )
        .join("  "),
    ),
    ...(summary.spans.length > limit
      ? ["", `${summary.spans.length - limit} more span names. Use --limit to show more.`]
      : []),
  ].join("\n");
}

const traceSummaryCommand = Command.make("summary", {
  baseDir: baseDirFlag,
  since: Flag.String("since").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription("Only count spans that ended in this window, for example 30m or 2h."),
    Flag.optional,
  ),
  limit: Flag.Int("limit").pipe(
    Flag.withSchema(PositiveInt),
    Flag.withDescription("Number of span names to show, busiest first."),
    Flag.withDefault(25),
  ),
}).pipe(
  Command.withDescription("Summarize the local server trace file: counts, rates, and latency."),
  Command.withHandler(
    Effect.fn("cli.trace.summary")(function* (flags) {
      const fs = yield* FileSystem.FileSystem;
      // STUDIO_TRACE_FILE, else the userdata trace file for --base-dir or
      // STUDIO_HOME. Implicit dev runs write elsewhere; set STUDIO_TRACE_FILE.
      const envHome = yield* Config.String("STUDIO_HOME").pipe(Config.option);
      const baseDir = yield* resolveBaseDir(
        Option.getOrUndefined(Option.orElse(flags.baseDir, () => envHome)),
      );
      const traceFilePath =
        (yield* traceFileConfig) ??
        (yield* ServerConfig.deriveServerPaths(baseDir, undefined)).serverTracePath;
      const sinceMs = Option.isSome(flags.since)
        ? (yield* Clock.currentTimeMillis) - Duration.toMillis(flags.since.value)
        : undefined;
      const summarizer = makeTraceSpanSummary(sinceMs);
      yield* Effect.forEach(
        toRotatedTracePaths(traceFilePath, yield* traceMaxFilesConfig),
        (path) => streamTraceFileLines(fs, path, summarizer.addLine),
        { discard: true },
      );
      const summary = summarizer.finish();

      yield* Console.log(
        summary.spanCount === 0
          ? `No spans found in ${traceFilePath} or its rotated files${sinceMs === undefined ? "" : " in that window"}.${summary.skippedLineCount > 0 ? ` Skipped ${summary.skippedLineCount} lines that are not spans.` : ""}`
          : formatTraceSummary(summary, flags.limit),
      );
    }),
  ),
);

export const traceCommand = Command.make("trace").pipe(
  Command.withDescription("Inspect the local server trace file."),
  Command.withSubcommands([traceSummaryCommand]),
);

export const doctorCommand = Command.make("doctor", {
  baseDir: baseDirFlag,
  since: Flag.String("since").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription("Only look at spans that ended in this window, for example 30m or 2h."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Check why sending a message is slow: send latency, slow database reads, database and window memory.",
  ),
  Command.withHandler(
    Effect.fn("cli.doctor")(function* (flags) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const envHome = yield* Config.String("STUDIO_HOME").pipe(Config.option);
      const baseDir = yield* resolveBaseDir(
        Option.getOrUndefined(Option.orElse(flags.baseDir, () => envHome)),
      );
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      const traceFilePath = (yield* traceFileConfig) ?? paths.serverTracePath;
      const nowMs = yield* Clock.currentTimeMillis;
      const doctor = makeSessionDoctor(
        Option.isSome(flags.since) ? nowMs - Duration.toMillis(flags.since.value) : undefined,
      );
      yield* Effect.forEach(
        toRotatedTracePaths(traceFilePath, yield* traceMaxFilesConfig),
        (tracePath) => streamTraceFileLines(fs, tracePath, doctor.addLine),
        { discard: true },
      );
      const report = doctor.finish();
      // Sizes only: opening the live database from a second process is not safe.
      const sizeOf = (file: string) =>
        fs.stat(file).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.orElseSucceed(() => undefined),
        );
      report.checks.push(
        checkDatabaseFiles({
          databaseBytes: yield* sizeOf(paths.dbPath),
          walBytes: yield* sizeOf(`${paths.dbPath}-wal`),
        }),
      );
      const rendererLines = yield* fs
        .readFileString(path.join(paths.logsDir, "renderer-history.ndjson"))
        .pipe(Effect.orElseSucceed(() => ""));
      report.checks.push(checkRendererMemory(rendererLines.split("\n"), nowMs));
      yield* Console.log(formatDoctorReport(report));
      if (report.checks.some((check) => check.level === "fail")) process.exitCode = 1;
    }),
  ),
);
