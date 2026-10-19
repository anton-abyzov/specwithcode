// @effect-diagnostics nodeBuiltinImport:off
/**
 * Best-effort provider event logging with one shared writer per thread.
 *
 * Native and canonical views share batching, rotation, and retention state so
 * they cannot race while appending to the same thread-scoped file.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ThreadId } from "@specweave-studio/contracts";
import { RotatingFileSink, rotatingFileSinkErrorCode } from "@specweave-studio/shared/logging";
import { errorTag } from "@specweave-studio/shared/observability";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import type { ResourceAttribution } from "../resourceTelemetry/ResourceAttribution.ts";

const MEBIBYTE = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 10 * MEBIBYTE;
const DEFAULT_MAX_FILES = 10;
const DEFAULT_BATCH_WINDOW_MS = 1_000;
const DEFAULT_MAX_TOTAL_BYTES = 512 * MEBIBYTE;
const DEFAULT_MAX_AGE_MS = 14 * DAY_MS;
const DEFAULT_RETENTION_CHECK_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_BUFFERED_BYTES = MEBIBYTE;
const DEFAULT_MAX_BUFFERED_RECORDS = 512;
/** After a write fails because the disk is full or erroring, no write is
    attempted for this long; records are dropped before serialization. */
export const EVENT_LOG_DISK_FAILURE_BACKOFF_MS = 60_000;
const MAX_RECORD_CHARACTERS = 64 * 1024;
const MAX_RECORD_FIELDS = 1_024;
const MAX_RECORD_DEPTH = 16;
const GLOBAL_THREAD_SEGMENT = "_global";
const LOG_SCOPE = "provider-observability";
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const transientCanonicalEventTypes = new Set([
  "content.delta",
  "hook.progress",
  "item.updated",
  "task.progress",
  "thread.realtime.audio.delta",
  "tool.progress",
  "turn.proposed.delta",
]);
const transientNativeMethods = new Set([
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/transcript/delta",
  "turn/diff/updated",
]);
const transientAcpUpdates = new Set(["agent_message_chunk", "agent_thought_chunk"]);

export type EventNdjsonStream = "native" | "canonical" | "orchestration";

export interface EventNdjsonLogger {
  readonly filePath: string;
  readonly write: (event: unknown, threadId: ThreadId | null) => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
}

export interface EventNdjsonLogStore {
  readonly filePath: string;
  readonly logger: (stream: EventNdjsonStream) => EventNdjsonLogger;
  readonly close: () => Effect.Effect<void>;
}

export interface EventNdjsonLogStoreOptions {
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly batchWindowMs?: number;
  readonly maxTotalBytes?: number;
  readonly maxAgeMs?: number;
  readonly retentionCheckIntervalMs?: number;
  readonly maxBufferedBytes?: number;
  readonly maxBufferedRecords?: number;
  readonly attribution?: ResourceAttribution["Service"];
}

export interface EventNdjsonLoggerOptions extends EventNdjsonLogStoreOptions {
  readonly stream: EventNdjsonStream;
}

export class EventNdjsonLogConfigurationError extends Schema.TaggedError<EventNdjsonLogConfigurationError>()(
  "EventNdjsonLogConfigurationError",
  {
    filePath: Schema.String,
    option: Schema.String,
    value: Schema.Number,
    minimum: Schema.Number,
  },
) {
  override get message(): string {
    return `Provider event log option '${this.option}' must be an integer >= ${this.minimum}; received ${this.value} for '${this.filePath}'`;
  }
}

export class EventNdjsonLogDirectoryError extends Schema.TaggedError<EventNdjsonLogDirectoryError>()(
  "EventNdjsonLogDirectoryError",
  {
    directory: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create provider event log directory '${this.directory}'`;
  }
}

export type EventNdjsonLogStoreError =
  | EventNdjsonLogConfigurationError
  | EventNdjsonLogDirectoryError;

interface ResolvedOptions {
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
  readonly maxTotalBytes: number;
  readonly maxAgeMs: number;
  readonly retentionCheckIntervalMs: number;
  readonly maxBufferedBytes: number;
  readonly maxBufferedRecords: number;
  readonly attribution: ResourceAttribution["Service"] | undefined;
}

export interface PendingRecord {
  readonly stream: EventNdjsonStream;
  readonly threadSegment: string;
  readonly line: string;
  readonly bytes: number;
}

/** A run of failing writes, from the first failure to the next successful write. */
interface WriteFailureEpisode {
  readonly filePath: string;
  readonly errorCode: string | undefined;
  /** Records dropped from failed batches (pre-serialization drops are counted separately). */
  readonly droppedCount: number;
}

/** A disk-wide failure (full, over quota or erroring): it suspends the whole store. */
interface DiskFailureEpisode extends WriteFailureEpisode {
  /** Until this time records are dropped before serialization and nothing is written. */
  readonly retryAt: number;
}

interface StoreState {
  readonly pending: Array<PendingRecord>;
  readonly pendingBytes: number;
  readonly sinks: ReadonlyMap<string, RotatingFileSink>;
  readonly flushScheduled: boolean;
  readonly closed: boolean;
  readonly lastRetentionAt: number;
  /** Set while the disk itself fails; suspends every stream and thread. */
  readonly diskFailure: DiskFailureEpisode | undefined;
  /** Failures confined to one thread's file (for example EACCES), by thread segment. */
  readonly segmentFailures: ReadonlyMap<string, WriteFailureEpisode>;
}

interface AttributionSummary {
  readonly stream: EventNdjsonStream;
  readonly count: number;
  readonly logicalWriteBytes: number;
}

interface FileOperationFailure {
  readonly filePath: string;
  readonly cause: unknown;
}

interface RetentionResult {
  readonly failures: ReadonlyArray<FileOperationFailure>;
}

interface DrainResult {
  readonly attributions: ReadonlyArray<AttributionSummary>;
  /** Set when this drain started a disk-wide failure episode. */
  readonly diskFailureStarted: DiskFailureEpisode | undefined;
  /** Set when this drain ended a disk-wide failure episode with a successful write. */
  readonly diskFailureRecovered: DiskFailureEpisode | undefined;
  /** Per-file failure episodes this drain started. */
  readonly segmentFailuresStarted: ReadonlyArray<WriteFailureEpisode>;
  /** Per-file failure episodes this drain ended with a successful write to that file. */
  readonly segmentFailuresRecovered: ReadonlyArray<WriteFailureEpisode>;
  /** The paths of active sinks when retention is due (not while the disk fails). */
  readonly retentionActivePaths: ReadonlySet<string> | undefined;
}

const isDiskFullCode = (code: string | undefined): boolean =>
  code === "ENOSPC" || code === "EDQUOT";

const isDiskFailureCode = (code: string | undefined): boolean =>
  isDiskFullCode(code) || code === "EIO";

function logWarning(message: string, context: Record<string, unknown>): Effect.Effect<void> {
  return Effect.logWarning(message, context).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
}

function resolveThreadSegment(raw: string | null | undefined): string {
  const normalized = typeof raw === "string" ? toSafeThreadAttachmentSegment(raw) : null;
  return normalized ?? GLOBAL_THREAD_SEGMENT;
}

function resolveStreamLabel(stream: EventNdjsonStream): string {
  return stream === "native" ? "NTIVE" : stream === "orchestration" ? "ORCH" : "CANON";
}

function providerLogPrefix(filePath: string): string {
  const basename = NodePath.basename(filePath);
  const extension = NodePath.extname(basename);
  return `${extension.length > 0 ? basename.slice(0, -extension.length) : basename}.`;
}

function providerLogPath(directory: string, prefix: string, threadSegment: string): string {
  return NodePath.join(directory, `${prefix}${threadSegment}.log`);
}

export function shouldPersistProviderEvent(stream: EventNdjsonStream, event: unknown): boolean {
  if (stream === "orchestration" || typeof event !== "object" || event === null) {
    return true;
  }
  try {
    const type = Reflect.get(event, "type");
    if (typeof type === "string" && transientCanonicalEventTypes.has(type)) {
      return false;
    }
    if (stream !== "native") return true;

    const nested = Reflect.get(event, "event");
    const envelope = typeof nested === "object" && nested !== null ? nested : event;
    // Decoded frames carry the same information as raw frames without another
    // copy of every token delta. Decode failures have their own diagnostic frame.
    if (Reflect.get(envelope, "stage") === "raw") return false;
    const decodedPayload = Reflect.get(envelope, "payload");
    const nativeEvent =
      Reflect.get(envelope, "stage") === "decoded" &&
      typeof decodedPayload === "object" &&
      decodedPayload !== null
        ? decodedPayload
        : envelope;
    const method = Reflect.get(nativeEvent, "method");
    if (
      typeof method === "string" &&
      (transientNativeMethods.has(method) ||
        method.startsWith("claude/stream_event/content_block_delta/"))
    ) {
      return false;
    }

    const nativeType = Reflect.get(nativeEvent, "type");
    if (nativeType === "message.part.delta") return false;
    if (nativeType === "stream_event") {
      const streamEvent = Reflect.get(nativeEvent, "event");
      if (
        typeof streamEvent === "object" &&
        streamEvent !== null &&
        Reflect.get(streamEvent, "type") === "content_block_delta"
      ) {
        return false;
      }
    }

    const payload = Reflect.get(nativeEvent, "payload");
    if (typeof payload !== "object" || payload === null) return true;

    if (method === "session/update") {
      const update = Reflect.get(payload, "update");
      if (typeof update !== "object" || update === null) return true;
      const updateType = Reflect.get(update, "sessionUpdate");
      return typeof updateType !== "string" || !transientAcpUpdates.has(updateType);
    }

    if (nativeType === "message.part.updated") {
      const properties = Reflect.get(payload, "properties");
      if (typeof properties !== "object" || properties === null) return true;
      const part = Reflect.get(properties, "part");
      if (typeof part !== "object" || part === null) return true;
      const partType = Reflect.get(part, "type");
      if (partType === "text" || partType === "reasoning") return false;
      if (partType === "tool") {
        // Running snapshots repeat growing output. Pending and terminal states stay in the log.
        const state = Reflect.get(part, "state");
        if (typeof state === "object" && state !== null) {
          return Reflect.get(state, "status") !== "running";
        }
      }
      return true;
    }

    return true;
  } catch {
    return true;
  }
}

const summaryFields = [
  "provider",
  "protocol",
  "kind",
  "providerSessionId",
  "direction",
  "stage",
  "type",
  "subtype",
  "method",
  "id",
  "threadId",
  "turnId",
  "requestId",
  "session_id",
  "status",
  "is_error",
  "api_error_status",
  "terminal_reason",
  "stop_reason",
  "operation",
  "code",
  "willRetry",
  "message",
  "event",
  "payload",
  "params",
  "result",
  "thread",
  "turn",
  "error",
  "turns",
  "items",
  "content",
] as const;

function summarizeProviderEvent(event: unknown): unknown {
  let remainingFields = 128;
  let remainingCharacters = 8 * 1024;
  const summarize = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") {
      if (value.length > Math.min(1_024, remainingCharacters)) {
        return { omittedCharacters: value.length };
      }
      remainingCharacters -= value.length;
      return value;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value !== "object") return undefined;
    if (Array.isArray(value)) return { itemCount: value.length };
    const summary: Record<string, unknown> = { truncated: true };
    if (depth >= 6) return summary;
    for (const key of summaryFields) {
      if (remainingFields <= 0) break;
      const nested = Reflect.get(value, key);
      if (nested === undefined) continue;
      remainingFields -= 1;
      summary[key] = summarize(nested, depth + 1);
    }
    return summary;
  };
  try {
    return summarize(event, 0);
  } catch {
    return { truncated: true };
  }
}

/** Bounds traversal before adapters copy payloads or the logger encodes them. */
export function boundProviderEventForLogging(event: unknown): unknown {
  let remainingCharacters = MAX_RECORD_CHARACTERS;
  let remainingFields = MAX_RECORD_FIELDS;
  const ancestors = new WeakSet<object>();
  const fits = (value: unknown, depth: number): boolean => {
    if (typeof value === "string") {
      remainingCharacters -= value.length;
      return remainingCharacters >= 0;
    }
    if (typeof value !== "object" || value === null) return true;
    if (depth > MAX_RECORD_DEPTH || ancestors.has(value)) return false;
    if (Array.isArray(value) && value.length > remainingFields) return false;
    ancestors.add(value);
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      remainingFields -= 1;
      remainingCharacters -= key.length;
      if (
        remainingFields < 0 ||
        remainingCharacters < 0 ||
        !fits(Reflect.get(value, key), depth + 1)
      )
        return false;
    }
    ancestors.delete(value);
    return true;
  };
  try {
    if (fits(event, 0)) return event;
  } catch {
    // A failing accessor must not escape into provider processing.
  }
  return summarizeProviderEvent(event);
}

export function writeBatchedMessages(
  sink: Pick<RotatingFileSink, "write">,
  records: ReadonlyArray<PendingRecord>,
  maxBytes: number,
  onWritten: (records: ReadonlyArray<PendingRecord>) => void,
): void {
  let pendingRecords: Array<PendingRecord> = [];
  let pendingBytes = 0;

  const flush = () => {
    if (pendingRecords.length === 0) return;
    const writtenRecords = pendingRecords;
    sink.write(writtenRecords.map((record) => record.line).join(""));
    onWritten(writtenRecords);
    pendingRecords = [];
    pendingBytes = 0;
  };

  for (const record of records) {
    if (pendingBytes > 0 && pendingBytes + record.bytes > maxBytes) {
      flush();
    }
    pendingRecords.push(record);
    pendingBytes += record.bytes;
    if (pendingBytes >= maxBytes) {
      flush();
    }
  }
  flush();
}

async function isProviderLogFile(
  filePath: string,
  fileName: string,
  filePrefix: string,
): Promise<boolean> {
  if (!/\.log(?:\.\d+)?$/u.test(fileName)) return false;
  if (fileName.startsWith(filePrefix)) return true;

  const handle = await NodeFSP.open(filePath, "r");
  try {
    const header = Buffer.alloc(256);
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    return /^\[[^\]\r\n]+\] (?:NTIVE|CANON|ORCH): /u.test(header.toString("utf8", 0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** Ages out and size-caps provider logs with async fs, so a slow or full
    disk delays only this scan, never the event loop. `isActive` is asked
    right before each removal, so a sink opened during the scan is kept. */
async function enforceRetentionAsync(input: {
  readonly directory: string;
  readonly maxTotalBytes: number;
  readonly maxAgeMs: number;
  readonly isActive: (filePath: string) => boolean;
  readonly filePrefix: string;
  readonly now: number;
}): Promise<RetentionResult> {
  const failures: Array<FileOperationFailure> = [];
  const files: Array<{ filePath: string; mtimeMs: number; size: number }> = [];

  let entries: ReadonlyArray<NodeFS.Dirent>;
  try {
    entries = await NodeFSP.readdir(input.directory, { withFileTypes: true });
  } catch (cause) {
    return { failures: [{ filePath: input.directory, cause }] };
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = NodePath.join(input.directory, entry.name);
    try {
      if (!(await isProviderLogFile(filePath, entry.name, input.filePrefix))) continue;
      const stat = await NodeFSP.stat(filePath);
      files.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch (cause) {
      failures.push({ filePath, cause });
    }
  }

  let totalBytes = files.reduce((total, file) => total + file.size, 0);
  const remove = async (file: (typeof files)[number]) => {
    if (input.isActive(file.filePath)) return false;
    try {
      await NodeFSP.rm(file.filePath, { force: true });
      totalBytes -= file.size;
      return true;
    } catch (cause) {
      failures.push({ filePath: file.filePath, cause });
      return false;
    }
  };

  const retained: typeof files = [];
  for (const file of files) {
    if (input.now - file.mtimeMs <= input.maxAgeMs || !(await remove(file))) {
      retained.push(file);
    }
  }

  for (const file of retained.toSorted(
    (left, right) => left.mtimeMs - right.mtimeMs || left.filePath.localeCompare(right.filePath),
  )) {
    if (totalBytes <= input.maxTotalBytes) break;
    await remove(file);
  }

  return { failures };
}

const enforceRetention = (input: Parameters<typeof enforceRetentionAsync>[0]) =>
  Effect.promise(() =>
    enforceRetentionAsync(input).catch((cause: unknown): RetentionResult => ({
      failures: [{ filePath: input.directory, cause }],
    })),
  );

function validateOption(input: {
  readonly filePath: string;
  readonly option: string;
  readonly value: number;
  readonly minimum: number;
}): EventNdjsonLogConfigurationError | undefined {
  if (Number.isInteger(input.value) && input.value >= input.minimum) return undefined;
  return new EventNdjsonLogConfigurationError(input);
}

function resolveOptions(
  filePath: string,
  options: EventNdjsonLogStoreOptions,
): Effect.Effect<ResolvedOptions, EventNdjsonLogConfigurationError> {
  const resolved = {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    batchWindowMs: options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    retentionCheckIntervalMs:
      options.retentionCheckIntervalMs ?? DEFAULT_RETENTION_CHECK_INTERVAL_MS,
    maxBufferedBytes: options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
    maxBufferedRecords: options.maxBufferedRecords ?? DEFAULT_MAX_BUFFERED_RECORDS,
    attribution: options.attribution,
  } satisfies ResolvedOptions;

  const validations = [
    ["maxBytes", resolved.maxBytes, 1],
    ["maxFiles", resolved.maxFiles, 1],
    ["batchWindowMs", resolved.batchWindowMs, 0],
    ["maxTotalBytes", resolved.maxTotalBytes, 1],
    ["maxAgeMs", resolved.maxAgeMs, 1],
    ["retentionCheckIntervalMs", resolved.retentionCheckIntervalMs, 1],
    ["maxBufferedBytes", resolved.maxBufferedBytes, 1],
    ["maxBufferedRecords", resolved.maxBufferedRecords, 1],
  ] as const;

  for (const [option, value, minimum] of validations) {
    const error = validateOption({ filePath, option, value, minimum });
    if (error) return Effect.fail(error);
  }
  return Effect.succeed(resolved);
}

function drainPending(input: {
  readonly directory: string;
  readonly options: ResolvedOptions;
  readonly state: StoreState;
  readonly filePrefix: string;
  readonly now: number;
  readonly timerFired: boolean;
  readonly close: boolean;
}): readonly [DrainResult, StoreState] {
  if (input.state.closed) {
    return [
      {
        attributions: [],
        diskFailureStarted: undefined,
        diskFailureRecovered: undefined,
        segmentFailuresStarted: [],
        segmentFailuresRecovered: [],
        retentionActivePaths: undefined,
      },
      input.state,
    ];
  }

  const sinks = new Map(input.state.sinks);
  const attributionByStream = new Map<
    EventNdjsonStream,
    { count: number; logicalWriteBytes: number }
  >();
  const recordsBySegment = new Map<string, Array<PendingRecord>>();
  const segmentFailures = new Map(input.state.segmentFailures);
  const segmentFailuresStarted: Array<WriteFailureEpisode> = [];
  const segmentFailuresRecovered: Array<WriteFailureEpisode> = [];
  let diskFailure: { filePath: string; errorCode: string | undefined } | undefined;
  let diskFailedRecords = 0;
  let writtenRecordCount = 0;

  // A disk-wide code suspends the whole store; any other code (EACCES,
  // EISDIR, ENAMETOOLONG, ...) belongs to this one file, so only its records
  // are dropped and the other threads keep writing.
  const recordFailure = (
    threadSegment: string,
    filePath: string,
    cause: unknown,
    failedCount: number,
  ) => {
    const errorCode = rotatingFileSinkErrorCode(cause);
    if (isDiskFailureCode(errorCode)) {
      diskFailure ??= { filePath, errorCode };
      diskFailedRecords += failedCount;
      return;
    }
    const previous = segmentFailures.get(threadSegment);
    const episode = {
      filePath,
      errorCode: previous?.errorCode ?? errorCode,
      droppedCount: (previous?.droppedCount ?? 0) + failedCount,
    };
    segmentFailures.set(threadSegment, episode);
    if (previous === undefined) segmentFailuresStarted.push(episode);
  };

  for (const record of input.state.pending) {
    const records = recordsBySegment.get(record.threadSegment) ?? [];
    records.push(record);
    recordsBySegment.set(record.threadSegment, records);
  }

  for (const [threadSegment, records] of recordsBySegment) {
    const filePath = providerLogPath(input.directory, input.filePrefix, threadSegment);
    let sink = sinks.get(threadSegment);
    if (!sink) {
      try {
        sink = new RotatingFileSink({
          filePath,
          maxBytes: input.options.maxBytes,
          maxFiles: input.options.maxFiles,
          throwOnError: true,
        });
        sinks.set(threadSegment, sink);
      } catch (cause) {
        recordFailure(threadSegment, filePath, cause, records.length);
        continue;
      }
    }

    let writtenInSegment = 0;
    try {
      writeBatchedMessages(sink, records, input.options.maxBytes, (writtenRecords) => {
        writtenInSegment += writtenRecords.length;
        for (const record of writtenRecords) {
          const current = attributionByStream.get(record.stream) ?? {
            count: 0,
            logicalWriteBytes: 0,
          };
          attributionByStream.set(record.stream, {
            count: current.count + 1,
            logicalWriteBytes: current.logicalWriteBytes + record.bytes,
          });
        }
      });
    } catch (cause) {
      sinks.delete(threadSegment);
      recordFailure(threadSegment, filePath, cause, records.length - writtenInSegment);
      writtenRecordCount += writtenInSegment;
      continue;
    }
    writtenRecordCount += writtenInSegment;
    const recovered = segmentFailures.get(threadSegment);
    if (recovered !== undefined) {
      segmentFailures.delete(threadSegment);
      segmentFailuresRecovered.push(recovered);
    }
  }

  const previousDiskFailure = input.state.diskFailure;
  let nextDiskFailure = previousDiskFailure;
  let diskFailureStarted: DiskFailureEpisode | undefined;
  let diskFailureRecovered: DiskFailureEpisode | undefined;
  if (diskFailure !== undefined) {
    // A full or erroring disk is left alone for a minute: every attempt is a
    // blocking syscall, and the records would only be dropped again.
    nextDiskFailure = {
      retryAt: input.now + EVENT_LOG_DISK_FAILURE_BACKOFF_MS,
      filePath: previousDiskFailure?.filePath ?? diskFailure.filePath,
      errorCode: previousDiskFailure?.errorCode ?? diskFailure.errorCode,
      droppedCount: (previousDiskFailure?.droppedCount ?? 0) + diskFailedRecords,
    };
    if (previousDiskFailure === undefined) diskFailureStarted = nextDiskFailure;
  } else if (previousDiskFailure !== undefined && writtenRecordCount > 0) {
    diskFailureRecovered = previousDiskFailure;
    nextDiskFailure = undefined;
  }

  // The retention scan is skipped while the disk fails; it would only add
  // I/O to a disk that is already failing. A failure in one thread's file
  // does not stop it.
  const retentionDue =
    nextDiskFailure === undefined &&
    input.now - input.state.lastRetentionAt >= input.options.retentionCheckIntervalMs;

  return [
    {
      attributions: Array.from(attributionByStream, ([stream, value]) => ({
        stream,
        ...value,
      })),
      diskFailureStarted,
      diskFailureRecovered,
      segmentFailuresStarted,
      segmentFailuresRecovered,
      retentionActivePaths: retentionDue
        ? new Set(
            Array.from(sinks.keys(), (threadSegment) =>
              providerLogPath(input.directory, input.filePrefix, threadSegment),
            ),
          )
        : undefined,
    },
    {
      pending: [],
      pendingBytes: 0,
      sinks,
      flushScheduled: input.timerFired ? false : input.state.flushScheduled,
      closed: input.close,
      lastRetentionAt: retentionDue ? input.now : input.state.lastRetentionAt,
      diskFailure: nextDiskFailure,
      segmentFailures,
    },
  ];
}

const serializeEvent = Effect.fnUntraced(function* (event: unknown) {
  return yield* encodeUnknownJsonString(event).pipe(
    Effect.catch((error) =>
      logWarning("failed to serialize provider event log record", {
        errorTag: errorTag(error),
      }).pipe(Effect.as(undefined)),
    ),
  );
});

export const makeEventNdjsonLogStore = Effect.fnUntraced(function* (
  filePath: string,
  options: EventNdjsonLogStoreOptions = {},
): Effect.fn.Return<EventNdjsonLogStore, EventNdjsonLogStoreError> {
  const resolved = yield* resolveOptions(filePath, options);
  const directory = NodePath.dirname(filePath);
  const filePrefix = providerLogPrefix(filePath);

  yield* Effect.try({
    try: () => NodeFS.mkdirSync(directory, { recursive: true }),
    catch: (cause) => new EventNdjsonLogDirectoryError({ directory, cause }),
  });

  const initializedAt = yield* Clock.currentTimeMillis;
  const initialRetention = yield* enforceRetention({
    directory,
    maxTotalBytes: resolved.maxTotalBytes,
    maxAgeMs: resolved.maxAgeMs,
    isActive: () => false,
    filePrefix,
    now: initializedAt,
  });
  for (const failure of initialRetention.failures) {
    yield* logWarning("provider event log retention failed", {
      filePath: failure.filePath,
      errorTag: errorTag(failure.cause),
    });
  }

  const stateRef = yield* SynchronizedRef.make<StoreState>({
    pending: [],
    pendingBytes: 0,
    sinks: new Map(),
    flushScheduled: false,
    closed: false,
    lastRetentionAt: initializedAt,
    diskFailure: undefined,
    segmentFailures: new Map(),
  });
  const timerScope = yield* Scope.make();
  // Records dropped before serialization while writes are suspended.
  let droppedBeforeSerialization = 0;
  const isActiveLogPath = (filePath: string) =>
    Array.from(SynchronizedRef.getUnsafe(stateRef).sinks.keys()).some(
      (threadSegment) => providerLogPath(directory, filePrefix, threadSegment) === filePath,
    );

  const flush = Effect.fnUntraced(function* (timerFired: boolean, close: boolean) {
    const startedAt = yield* Clock.currentTimeMillis;
    const result = yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
      Effect.sync(() =>
        drainPending({
          directory,
          options: resolved,
          state,
          filePrefix,
          now: startedAt,
          timerFired,
          close,
        }),
      ),
    );

    // One line when writes start failing and one when they recover, so a
    // full disk costs two log lines, not one per batch.
    const failureContext = (episode: WriteFailureEpisode) => ({
      filePath: episode.filePath,
      ...(episode.errorCode === undefined ? {} : { errorCode: episode.errorCode }),
    });
    if (result.diskFailureStarted !== undefined) {
      yield* logWarning(
        isDiskFullCode(result.diskFailureStarted.errorCode)
          ? "provider event log writes are failing because the disk is out of space, dropping records until space is freed"
          : "provider event log writes are failing because the disk is erroring, dropping records until it recovers",
        failureContext(result.diskFailureStarted),
      );
    }
    for (const episode of result.segmentFailuresStarted) {
      yield* logWarning(
        "provider event log writes to this file are failing, dropping its records until they recover",
        failureContext(episode),
      );
    }
    if (result.diskFailureRecovered !== undefined) {
      const droppedCount = result.diskFailureRecovered.droppedCount + droppedBeforeSerialization;
      droppedBeforeSerialization = 0;
      yield* Effect.logInfo("provider event log writes recovered", {
        filePath: result.diskFailureRecovered.filePath,
        droppedCount,
      }).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
    }
    for (const episode of result.segmentFailuresRecovered) {
      yield* Effect.logInfo("provider event log writes recovered", {
        filePath: episode.filePath,
        droppedCount: episode.droppedCount,
      }).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
    }
    if (result.retentionActivePaths !== undefined) {
      const activePaths = result.retentionActivePaths;
      const retention = yield* enforceRetention({
        directory,
        maxTotalBytes: resolved.maxTotalBytes,
        maxAgeMs: resolved.maxAgeMs,
        isActive: (candidate) => activePaths.has(candidate) || isActiveLogPath(candidate),
        filePrefix,
        now: startedAt,
      });
      for (const failure of retention.failures) {
        yield* logWarning("provider event log retention failed", {
          filePath: failure.filePath,
          errorTag: errorTag(failure.cause),
        });
      }
    }

    if (resolved.attribution && result.attributions.length > 0) {
      const completedAt = yield* Clock.currentTimeMillis;
      const durationMs = Math.max(0, completedAt - startedAt);
      const totalBytes = result.attributions.reduce(
        (total, entry) => total + entry.logicalWriteBytes,
        0,
      );
      yield* Effect.forEach(
        result.attributions,
        (entry) =>
          resolved.attribution?.record({
            component: "provider-event-log",
            operation: `${entry.stream}.append`,
            logicalWriteBytes: entry.logicalWriteBytes,
            count: entry.count,
            durationMs:
              totalBytes === 0
                ? 0
                : Math.round(durationMs * (entry.logicalWriteBytes / totalBytes)),
          }) ?? Effect.void,
        { discard: true },
      );
    }
  });

  const scheduleFlush = Effect.fnUntraced(function* () {
    yield* Effect.forkIn(
      Effect.sleep(resolved.batchWindowMs).pipe(Effect.andThen(flush(true, false))),
      timerScope,
      { startImmediately: true },
    );
  });

  const close = Effect.fnUntraced(function* () {
    yield* flush(false, true);
    yield* Scope.close(timerScope, Exit.void);
  });

  const loggerViews = new Map<EventNdjsonStream, EventNdjsonLogger>();
  const logger = (stream: EventNdjsonStream): EventNdjsonLogger => {
    const existing = loggerViews.get(stream);
    if (existing) return existing;

    const write = Effect.fnUntraced(function* (event: unknown, threadId: ThreadId | null) {
      if (!shouldPersistProviderEvent(stream, event)) return;
      const diskFailure = SynchronizedRef.getUnsafe(stateRef).diskFailure;
      if (diskFailure !== undefined && (yield* Clock.currentTimeMillis) < diskFailure.retryAt) {
        // Serializing a record that cannot be written only costs the event loop.
        droppedBeforeSerialization += 1;
        return;
      }
      let payload = yield* serializeEvent(boundProviderEventForLogging(event));
      if (payload === undefined) return;
      // Escaping can expand strings beyond their input size. Keep that bounded
      // serialization out of the file too, while retaining routing/error fields.
      if (Buffer.byteLength(payload) > MAX_RECORD_CHARACTERS) {
        payload = yield* serializeEvent(summarizeProviderEvent(event));
        if (payload === undefined) return;
      }

      const observedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const line = `[${observedAt}] ${resolveStreamLabel(stream)}: ${payload}\n`;
      const bytes = Buffer.byteLength(line);
      const action = yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
        if (state.closed) {
          return Effect.succeed([{ flush: false }, state] as const);
        }
        const pending = state.pending;
        pending.push({ stream, threadSegment: resolveThreadSegment(threadId), line, bytes });
        const pendingBytes = state.pendingBytes + bytes;
        const flush =
          resolved.batchWindowMs === 0 ||
          pending.length >= resolved.maxBufferedRecords ||
          pendingBytes >= resolved.maxBufferedBytes;
        const schedule = !flush && !state.flushScheduled;
        const nextState = {
          ...state,
          pending,
          pendingBytes,
          flushScheduled: state.flushScheduled || schedule,
        };
        return (schedule ? scheduleFlush() : Effect.void).pipe(
          Effect.as([{ flush }, nextState] as const),
        );
      }).pipe(Effect.uninterruptible);

      if (action.flush) {
        yield* flush(false, false);
      }
    });

    const view = { filePath, write, close: () => Effect.void } satisfies EventNdjsonLogger;
    loggerViews.set(stream, view);
    return view;
  };

  return { filePath, logger, close } satisfies EventNdjsonLogStore;
});

export const makeEventNdjsonLogger = Effect.fnUntraced(function* (
  filePath: string,
  options: EventNdjsonLoggerOptions,
): Effect.fn.Return<EventNdjsonLogger | undefined> {
  const store = yield* makeEventNdjsonLogStore(filePath, options).pipe(
    Effect.catch((error) =>
      logWarning(error.message, { error }).pipe(
        Effect.as<EventNdjsonLogStore | undefined>(undefined),
      ),
    ),
  );
  if (!store) return undefined;
  return { ...store.logger(options.stream), close: store.close };
});
