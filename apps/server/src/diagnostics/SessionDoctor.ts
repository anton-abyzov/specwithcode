/**
 * What `specweave-studio doctor` checks: whether sending a message has become
 * slow, and where the time goes. Slow send RPCs, slow database reads with the
 * code that ran them, a write-ahead log that has stopped shrinking, and window
 * memory. Everything here reads trace lines and file sizes; nothing opens the
 * database, so it is safe while the server runs, is stalled or is stopped.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** What a person waits on between pressing Enter and seeing their message land. */
export const SEND_PATH_SPANS = [
  { name: "ws.rpc.projects.coordinatorSend", label: "Send to the coordinator" },
  { name: "ws.rpc.orchestration.dispatchCommand", label: "Thread commands" },
  { name: "orchestrationV2.providerTurnStart.start", label: "Start an agent turn" },
] as const;

const SEND_WARN_MS = 1_000;
const SEND_FAIL_MS = 3_000;
const SQL_WARN_MS = 250;
const SQL_FAIL_MS = 1_000;
const WAL_WARN_BYTES = 256 * 1024 ** 2;
const RENDERER_WARN_BYTES = 1.5 * 1024 ** 3;
/** Renderer samples older than this belong to a window that is gone. */
const RENDERER_SAMPLE_MAX_AGE_MS = 15 * 60_000;

const decodeSpanLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      spanId: Schema.optional(Schema.String),
      parentSpanId: Schema.optional(Schema.String),
      durationMs: Schema.Finite,
      endTimeUnixNano: Schema.FiniteFromString,
      attributes: Schema.optional(
        Schema.Struct({ "db.query.text": Schema.optional(Schema.String) }),
      ),
      resourceAttributes: Schema.optional(
        Schema.Struct({ "service.version": Schema.optional(Schema.String) }),
      ),
    }),
  ),
);

const decodeRendererSample = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      event: Schema.String,
      surface: Schema.optional(Schema.String),
      rendererPid: Schema.optional(Schema.Finite),
      timestampUnixMs: Schema.Finite,
      memory: Schema.optional(Schema.Struct({ workingSetBytes: Schema.Finite })),
    }),
  ),
);

export type DoctorLevel = "ok" | "warn" | "fail";
export type DoctorCheck = {
  readonly level: DoctorLevel;
  readonly title: string;
  readonly details: readonly string[];
};

const formatMs = (ms: number) =>
  ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`;
const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : `${Math.round(bytes / 1024 ** 2)} MiB`;
const percentile = (sorted: readonly number[], p: number) =>
  sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Reads trace NDJSON one line at a time. Spans are written when they end, so a
 * slow query is written before the span that ran it; callers are resolved in
 * `finish`, once every line has been read.
 */
export function makeSessionDoctor(sinceMs = -Infinity) {
  const sendDurations = new Map<string, number[]>();
  const parents = new Map<string, { readonly name: string; readonly parent: string | undefined }>();
  const slowQueries: Array<{ durationMs: number; query: string; parent: string | undefined }> = [];
  const versions = new Set<string>();
  let spanCount = 0;

  const addLine = (line: string) => {
    if (line.trim().length === 0) return;
    const span = Option.getOrUndefined(decodeSpanLine(line));
    if (span === undefined || span.endTimeUnixNano / 1_000_000 < sinceMs) return;
    spanCount += 1;
    const version = span.resourceAttributes?.["service.version"];
    if (version !== undefined) versions.add(version);
    if (span.name === "sql.execute") {
      if (span.durationMs >= SQL_WARN_MS)
        slowQueries.push({
          durationMs: span.durationMs,
          query: oneLine(span.attributes?.["db.query.text"] ?? "").slice(0, 90),
          parent: span.parentSpanId,
        });
      return;
    }
    if (span.spanId !== undefined)
      parents.set(span.spanId, { name: span.name, parent: span.parentSpanId });
    if (SEND_PATH_SPANS.some((watched) => watched.name === span.name)) {
      const durations = sendDurations.get(span.name) ?? [];
      durations.push(span.durationMs);
      sendDurations.set(span.name, durations);
    }
  };

  /** The nearest span above a query that is not itself a database span. */
  const callerOf = (spanId: string | undefined) => {
    for (let id = spanId, depth = 0; id !== undefined && depth < 8; depth += 1) {
      const span = parents.get(id);
      if (span === undefined) break;
      if (!span.name.startsWith("sql.")) return span.name;
      id = span.parent;
    }
    return "unknown caller";
  };

  const finish = (): { spanCount: number; versions: string[]; checks: DoctorCheck[] } => {
    const checks: DoctorCheck[] = [];
    const sendRows = SEND_PATH_SPANS.flatMap(({ name, label }) => {
      const durations = sendDurations.get(name)?.toSorted((a, b) => a - b);
      if (!durations?.length) return [];
      return [
        {
          label,
          count: durations.length,
          p50: percentile(durations, 0.5),
          p90: percentile(durations, 0.9),
          max: durations.at(-1)!,
        },
      ];
    });
    const worstSend = Math.max(0, ...sendRows.map((row) => row.p90));
    checks.push({
      level: worstSend >= SEND_FAIL_MS ? "fail" : worstSend >= SEND_WARN_MS ? "warn" : "ok",
      title:
        sendRows.length === 0
          ? "Sending messages: no sends in the trace window"
          : `Sending messages: slowest step p90 ${formatMs(worstSend)}`,
      details: [
        ...sendRows.map(
          (row) =>
            `${row.label}: ${row.count} calls, p50 ${formatMs(row.p50)}, p90 ${formatMs(row.p90)}, max ${formatMs(row.max)}`,
        ),
        ...(worstSend >= SEND_WARN_MS
          ? [
              "The database reads below show where the time went. Update SpecWithCode if one is listed.",
            ]
          : []),
      ],
    });

    const groups = new Map<string, { caller: string; query: string; durations: number[] }>();
    for (const query of slowQueries) {
      const caller = callerOf(query.parent);
      const key = `${caller}\n${query.query}`;
      const group = groups.get(key) ?? { caller, query: query.query, durations: [] };
      group.durations.push(query.durationMs);
      groups.set(key, group);
    }
    const ranked = [...groups.values()]
      .map((group) => ({ ...group, max: Math.max(...group.durations) }))
      .toSorted((left, right) => right.max - left.max);
    const slowest = ranked[0]?.max ?? 0;
    checks.push({
      level: slowest >= SQL_FAIL_MS ? "fail" : slowest > 0 ? "warn" : "ok",
      title:
        ranked.length === 0
          ? `Database reads: none over ${formatMs(SQL_WARN_MS)}`
          : `Database reads: ${slowQueries.length} over ${formatMs(SQL_WARN_MS)}, slowest ${formatMs(slowest)}`,
      details: ranked
        .slice(0, 5)
        .map(
          (group) =>
            `${formatMs(group.max)} max, ${group.durations.length}x in ${group.caller}: ${group.query}`,
        ),
    });
    return { spanCount, versions: [...versions].toSorted(), checks };
  };

  return { addLine, finish };
}

/** The write-ahead log is folded back into the database at checkpoints; a large one means they stall. */
export function checkDatabaseFiles(sizes: {
  readonly databaseBytes: number | undefined;
  readonly walBytes: number | undefined;
}): DoctorCheck {
  const { databaseBytes, walBytes } = sizes;
  if (databaseBytes === undefined)
    return { level: "ok", title: "Database: no database file yet", details: [] };
  const wal = walBytes ?? 0;
  return {
    level: wal >= WAL_WARN_BYTES ? "warn" : "ok",
    title: `Database: ${formatBytes(databaseBytes)}, write-ahead log ${formatBytes(wal)}`,
    details:
      wal >= WAL_WARN_BYTES
        ? [
            "The write-ahead log is not being checkpointed, so every read searches it. Restart the local service to checkpoint it.",
          ]
        : [],
  };
}

/** The newest memory sample of each window that wrote one recently. */
export function checkRendererMemory(lines: readonly string[], nowMs: number): DoctorCheck {
  const latest = new Map<
    number,
    { at: number; bytes: number; first: { at: number; bytes: number } }
  >();
  for (const line of lines) {
    const sample = Option.getOrUndefined(decodeRendererSample(line));
    if (
      sample?.event !== "sample" ||
      sample.memory === undefined ||
      sample.rendererPid === undefined
    )
      continue;
    const point = { at: sample.timestampUnixMs, bytes: sample.memory.workingSetBytes };
    const known = latest.get(sample.rendererPid);
    latest.set(
      sample.rendererPid,
      known ? { ...point, first: known.first } : { ...point, first: point },
    );
  }
  const live = [...latest.values()].filter(
    (window) => nowMs - window.at <= RENDERER_SAMPLE_MAX_AGE_MS,
  );
  if (live.length === 0)
    return { level: "ok", title: "Window memory: no recent samples", details: [] };
  const largest = Math.max(...live.map((window) => window.bytes));
  return {
    level: largest >= RENDERER_WARN_BYTES ? "warn" : "ok",
    title: `Window memory: largest window ${formatBytes(largest)}`,
    details: live.map((window) => {
      const hours = (window.at - window.first.at) / 3_600_000;
      const growth =
        hours >= 0.25
          ? `, ${formatBytes(Math.max(0, (window.bytes - window.first.bytes) / hours))}/h growth`
          : "";
      return `${formatBytes(window.bytes)} after ${hours.toFixed(1)} h${growth}`;
    }),
  };
}

export function formatDoctorReport(report: {
  readonly spanCount: number;
  readonly versions: readonly string[];
  readonly checks: readonly DoctorCheck[];
}) {
  const mark = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;
  return [
    `Read ${report.spanCount} trace spans${report.versions.length ? ` from version ${report.versions.join(", ")}` : ""}.`,
    "",
    ...report.checks.flatMap((check) => [
      `${mark[check.level]}  ${check.title}`,
      ...check.details.map((detail) => `        ${detail}`),
    ]),
  ].join("\n");
}
