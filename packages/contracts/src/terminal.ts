import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Client-side id for the first shell opened on a thread. Ids are uniformly
 * `term-N`; there's no "default" intrinsic. Kept as a named constant so callers
 * that want "the primary shell" don't hardcode `"term-1"`.
 */
export const DEFAULT_TERMINAL_ID = "term-1";

/**
 * Terminals that run one command from a chat code block use ids with this
 * prefix. Their output shows under the block, so terminal tabs skip them.
 */
export const INLINE_RUN_TERMINAL_ID_PREFIX = "run-";

export function isInlineRunTerminalId(terminalId: string): boolean {
  return terminalId.startsWith(INLINE_RUN_TERMINAL_ID_PREFIX);
}

/**
 * Where an administrator run stands. The run's wrapper writes these into the
 * terminal as operating system commands (OSC), which never show as text.
 * `waiting`: the password prompt is up. `started`: the command itself runs.
 * `terminal-app`: the command was handed to the Mac's Terminal app instead.
 * The rest end the run before the command starts.
 */
export const TERMINAL_ELEVATION_STATES = [
  "waiting",
  "started",
  "cancelled",
  "timeout",
  "denied",
  "unavailable",
  "terminal-app",
] as const;
export type TerminalElevationState = (typeof TERMINAL_ELEVATION_STATES)[number];
export const TerminalElevationStateSchema = Schema.Literals(TERMINAL_ELEVATION_STATES);

/** OSC number of the elevation marker: `ESC ] 7717 ; elevation=<state> ; <nonce> BEL`. */
export const TERMINAL_ELEVATION_OSC = "7717";

/** A value only the server and wrapper know, so text a command prints cannot pose as a marker. */
export const TERMINAL_ELEVATION_NONCE_REGEX = /^[A-Za-z0-9]{16,64}$/;

export function terminalElevationMarker(state: TerminalElevationState, nonce: string): string {
  return `\u001b]${TERMINAL_ELEVATION_OSC};elevation=${state};${nonce}\u0007`;
}

/**
 * Nonce-free elevation marker emitted by the server after verifying a PTY
 * marker's per-run nonce and stripping all unverified `OSC 7717` sequences.
 */
export function terminalVerifiedElevationMarker(state: TerminalElevationState): string {
  return `\u001b]${TERMINAL_ELEVATION_OSC};elevation=${state}\u0007`;
}

/**
 * Where the run stands, from the markers in raw terminal output that carry
 * this run's nonce. `waiting` may be followed by one other state; that state
 * is final, so nothing printed later can change what the panel says.
 */
export function terminalElevationState(
  rawOutput: string,
  nonce: string | null,
): TerminalElevationState | null {
  if (nonce === null || !TERMINAL_ELEVATION_NONCE_REGEX.test(nonce)) return null;
  const marker = new RegExp(
    `\\u001b\\]${TERMINAL_ELEVATION_OSC};elevation=(${TERMINAL_ELEVATION_STATES.join("|")});${nonce}\\u0007`,
    "g",
  );
  let state: TerminalElevationState | null = null;
  for (const match of rawOutput.matchAll(marker)) {
    state = match[1] as TerminalElevationState;
    if (state !== "waiting") break;
  }
  return state;
}

const VERIFIED_ELEVATION_MARKER_REGEX = new RegExp(
  `\\u001b\\]${TERMINAL_ELEVATION_OSC};elevation=(${TERMINAL_ELEVATION_STATES.join("|")})\\u0007`,
  "g",
);

/**
 * Where the run stands, from server-verified nonce-free markers in terminal
 * output. The server strips every raw `OSC 7717` sequence from PTY output and
 * emits these only after validating the run's secret nonce.
 */
export function verifiedTerminalElevationState(rawOutput: string): TerminalElevationState | null {
  let state: TerminalElevationState | null = null;
  for (const match of rawOutput.matchAll(VERIFIED_ELEVATION_MARKER_REGEX)) {
    state = match[1] as TerminalElevationState;
    if (state !== "waiting") break;
  }
  return state;
}

const terminalHistoryEncoder = new TextEncoder();
// A byte order mark at the cut is terminal output, not an encoding marker.
const terminalHistoryDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * The newest `maxBytes` of UTF-8 in `history`, starting at a code point
 * boundary. Servers send this much to a client that states its buffer size,
 * and clients keep this much after a reset.
 */
export function terminalHistoryTail(history: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  // A UTF-16 code unit is at most 3 UTF-8 bytes, so short strings need no encoding.
  if (history.length * 3 <= maxBytes) return history;
  const encoded = terminalHistoryEncoder.encode(history);
  if (encoded.byteLength <= maxBytes) return history;
  let start = encoded.byteLength - maxBytes;
  while (start < encoded.byteLength && ((encoded[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return terminalHistoryDecoder.decode(encoded.subarray(start));
}

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const TerminalColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(1000),
);
const TerminalRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(500),
);
const TerminalIdSchema = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(128));
const TerminalEnvKeySchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
).check(Schema.isMaxLength(128));
const TerminalEnvValueSchema = Schema.String.check(Schema.isMaxLength(8_192));
const TerminalEnvSchema = Schema.Record(TerminalEnvKeySchema, TerminalEnvValueSchema).check(
  Schema.isMaxProperties(128),
);
/** History bytes the client keeps; snapshots carry at most this much. Older servers ignore it. */
const TerminalMaxHistoryBytesSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const TerminalThreadInput = Schema.Struct({
  threadId: TrimmedNonEmptyStringSchema,
});
export type TerminalThreadInput = typeof TerminalThreadInput.Type;

/** Terminal ids are ALWAYS chosen by the client and sent explicitly — no server-side allocation. */
const TerminalSessionInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: TerminalIdSchema,
});
export type TerminalSessionInput = Schema.Codec.Encoded<typeof TerminalSessionInput>;

/** What the administrator prompt says about who asked. Both are shown as plain text. */
export const TerminalElevationRequest = Schema.Struct({
  threadTitle: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  /** The device that pressed Run, when it is not the machine that runs the command. */
  requestedFrom: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
  /** Runs the command in the Mac's Terminal app instead of this terminal. */
  openIn: Schema.optional(Schema.Literal("terminal-app")),
  /** Carried by the run's state markers; see `TERMINAL_ELEVATION_NONCE_REGEX`. */
  nonce: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
});
export type TerminalElevationRequest = typeof TerminalElevationRequest.Type;

export const TerminalOpenInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  /** Used when `cwd` no longer exists (e.g. a removed worktree); home is the last resort. */
  fallbackCwd: Schema.optional(TrimmedNonEmptyStringSchema),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
  env: Schema.optional(TerminalEnvSchema),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  /** Runs this command with the login shell's `-c` instead of an interactive
      shell; the session exits with the command's exit code. */
  command: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(16_384))),
  /** Asks for the administrator password with the machine's own prompt before
      `command` runs. Honoured for code-block runs only, and sent only to
      servers reporting the `terminalElevationPrompt` capability. */
  elevation: Schema.optional(TerminalElevationRequest),
});
export type TerminalOpenInput = typeof TerminalOpenInput.Type;

export const TerminalAttachInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: Schema.optional(TrimmedNonEmptyStringSchema),
  fallbackCwd: Schema.optional(TrimmedNonEmptyStringSchema),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
  env: Schema.optional(TerminalEnvSchema),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  restartIfNotRunning: Schema.optional(Schema.Boolean),
  maxHistoryBytes: Schema.optional(TerminalMaxHistoryBytesSchema),
});
export type TerminalAttachInput = typeof TerminalAttachInput.Type;

export const TerminalObserveInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  maxHistoryBytes: Schema.optional(TerminalMaxHistoryBytesSchema),
});
export type TerminalObserveInput = Schema.Codec.Encoded<typeof TerminalObserveInput>;

export const TerminalWriteInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
});
export type TerminalWriteInput = Schema.Codec.Encoded<typeof TerminalWriteInput>;

export const TerminalResizeInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
});
export type TerminalResizeInput = Schema.Codec.Encoded<typeof TerminalResizeInput>;

export const TerminalClearInput = TerminalSessionInput;
export type TerminalClearInput = Schema.Codec.Encoded<typeof TerminalClearInput>;

export const TerminalRestartInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  fallbackCwd: Schema.optional(TrimmedNonEmptyStringSchema),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
  env: Schema.optional(TerminalEnvSchema),
  providerInstanceId: Schema.optional(ProviderInstanceId),
});
export type TerminalRestartInput = typeof TerminalRestartInput.Type;

export const TerminalCloseInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: Schema.optional(TerminalIdSchema),
  deleteHistory: Schema.optional(Schema.Boolean),
});
export type TerminalCloseInput = typeof TerminalCloseInput.Type;

/** Closes the thread's shells that sit at an idle prompt; a running command keeps its terminal. */
export const TerminalCloseIdleInput = TerminalThreadInput;
export type TerminalCloseIdleInput = typeof TerminalCloseIdleInput.Type;

export const TerminalCloseIdleResult = Schema.Struct({
  closedTerminalIds: Schema.Array(TerminalIdSchema),
});
export type TerminalCloseIdleResult = typeof TerminalCloseIdleResult.Type;

export const TerminalSessionStatus = Schema.Literals(["starting", "running", "exited", "error"]);
export type TerminalSessionStatus = typeof TerminalSessionStatus.Type;

export const TerminalSessionSnapshot = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  cwd: Schema.String.check(Schema.isNonEmpty()),
  worktreePath: Schema.NullOr(TrimmedNonEmptyStringSchema),
  status: TerminalSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  history: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  /** Server-computed display title (idle shell vs subprocess command). */
  label: Schema.String.check(Schema.isMaxLength(128)),
  updatedAt: Schema.String,
  sequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Server-verified elevation state for an administrator code-block run. */
  elevationState: Schema.optional(Schema.NullOr(TerminalElevationStateSchema)),
  /** Deprecated: kept optional for wire compatibility; the server never emits nonces on the wire. */
  elevationNonce: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(64)))),
});
export type TerminalSessionSnapshot = typeof TerminalSessionSnapshot.Type;

export const TerminalSummary = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  cwd: Schema.String.check(Schema.isNonEmpty()),
  worktreePath: Schema.NullOr(TrimmedNonEmptyStringSchema),
  status: TerminalSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  hasRunningSubprocess: Schema.Boolean,
  /** Server-computed display title (idle shell vs subprocess command). */
  label: Schema.String.check(Schema.isMaxLength(128)),
  updatedAt: Schema.String,
});
export type TerminalSummary = typeof TerminalSummary.Type;

const TerminalMetadataSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  terminals: Schema.Array(TerminalSummary),
});

const TerminalMetadataUpsertEvent = Schema.Struct({
  type: Schema.Literal("upsert"),
  terminal: TerminalSummary,
});

const TerminalMetadataRemoveEvent = Schema.Struct({
  type: Schema.Literal("remove"),
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
});

export const TerminalMetadataStreamEvent = Schema.Union([
  TerminalMetadataSnapshotEvent,
  TerminalMetadataUpsertEvent,
  TerminalMetadataRemoveEvent,
]);
export type TerminalMetadataStreamEvent = typeof TerminalMetadataStreamEvent.Type;

const TerminalEventBaseSchema = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  sequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

const TerminalStartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("started"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalOutputEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("output"),
  data: Schema.String,
});

const TerminalExitedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("exited"),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});

const TerminalClosedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("closed"),
});

const TerminalErrorEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("error"),
  message: Schema.String.check(Schema.isNonEmpty()),
});

const TerminalClearedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("cleared"),
  elevationState: Schema.optional(TerminalElevationStateSchema),
});

const TerminalRestartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("restarted"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalActivityEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("activity"),
  hasRunningSubprocess: Schema.Boolean,
  label: Schema.String.check(Schema.isMaxLength(128)),
});

export const TerminalEvent = Schema.Union([
  TerminalStartedEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalClosedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
]);
export type TerminalEvent = typeof TerminalEvent.Type;

const TerminalAttachSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  snapshot: TerminalSessionSnapshot,
});

export const TerminalAttachStreamEvent = Schema.Union([
  TerminalAttachSnapshotEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalClosedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
]);
export type TerminalAttachStreamEvent = typeof TerminalAttachStreamEvent.Type;

export class TerminalCwdNotFoundError extends Schema.TaggedError<TerminalCwdNotFoundError>()(
  "TerminalCwdNotFoundError",
  {
    cwd: Schema.String,
  },
) {
  override get message() {
    return `Terminal cwd does not exist: ${this.cwd}`;
  }
}

export class TerminalCwdNotDirectoryError extends Schema.TaggedError<TerminalCwdNotDirectoryError>()(
  "TerminalCwdNotDirectoryError",
  {
    cwd: Schema.String,
  },
) {
  override get message() {
    return `Terminal cwd is not a directory: ${this.cwd}`;
  }
}

export class TerminalCwdStatError extends Schema.TaggedError<TerminalCwdStatError>()(
  "TerminalCwdStatError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to access terminal cwd: ${this.cwd}`;
  }
}

export const TerminalCwdError = Schema.Union([
  TerminalCwdNotFoundError,
  TerminalCwdNotDirectoryError,
  TerminalCwdStatError,
]);
export type TerminalCwdError = typeof TerminalCwdError.Type;

export class TerminalHistoryError extends Schema.TaggedError<TerminalHistoryError>()(
  "TerminalHistoryError",
  {
    operation: Schema.Literals(["read", "truncate", "migrate"]),
    threadId: Schema.String,
    terminalId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Failed to ${this.operation} terminal history for thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalSessionLookupError extends Schema.TaggedError<TerminalSessionLookupError>()(
  "TerminalSessionLookupError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Unknown terminal thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalProviderInstanceNotFoundError extends Schema.TaggedError<TerminalProviderInstanceNotFoundError>()(
  "TerminalProviderInstanceNotFoundError",
  {
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message() {
    return `Provider instance is not available: ${this.providerInstanceId}`;
  }
}

export class TerminalProviderEnvironmentError extends Schema.TaggedError<TerminalProviderEnvironmentError>()(
  "TerminalProviderEnvironmentError",
  {
    providerInstanceId: ProviderInstanceId,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not prepare the terminal environment for provider instance: ${this.providerInstanceId}`;
  }
}

export class TerminalNotRunningError extends Schema.TaggedError<TerminalNotRunningError>()(
  "TerminalNotRunningError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Terminal is not running for thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalWriteError extends Schema.TaggedError<TerminalWriteError>()(
  "TerminalWriteError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
    terminalPid: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to write to terminal for thread: ${this.threadId}, terminal: ${this.terminalId}, PID: ${this.terminalPid}`;
  }
}

export class TerminalResizeError extends Schema.TaggedError<TerminalResizeError>()(
  "TerminalResizeError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
    terminalPid: Schema.Number,
    cols: TerminalColsSchema,
    rows: TerminalRowsSchema,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to resize terminal for thread: ${this.threadId}, terminal: ${this.terminalId}, PID: ${this.terminalPid} to ${this.cols}x${this.rows}`;
  }
}

export class TerminalStopError extends Schema.TaggedError<TerminalStopError>()(
  "TerminalStopError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
    terminalPid: Schema.Number,
  },
) {
  override get message() {
    return `Could not stop the previous command (PID ${this.terminalPid}) before starting a replacement.`;
  }
}

export const TerminalError = Schema.Union([
  TerminalCwdError,
  TerminalHistoryError,
  TerminalSessionLookupError,
  TerminalProviderInstanceNotFoundError,
  TerminalProviderEnvironmentError,
  TerminalNotRunningError,
  TerminalWriteError,
  TerminalResizeError,
  TerminalStopError,
]);
export type TerminalError = typeof TerminalError.Type;
