import {
  verifiedTerminalElevationState,
  type EnvironmentId,
  type TerminalAttachStreamEvent,
  type TerminalElevationState,
  type TerminalMetadataStreamEvent,
  type TerminalSessionSnapshot,
  type TerminalSummary,
  type ThreadId,
} from "@specweave-studio/contracts";
import {
  appendOutput,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  EMPTY_TERMINAL_OUTPUT_STATE,
  resetOutput,
  type TerminalOutputState,
} from "./terminalOutput.ts";

export {
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
  terminalOutputText,
  type TerminalOutputCursor,
  type TerminalOutputState,
  type TerminalOutputUpdate,
} from "./terminalOutput.ts";

export interface TerminalSessionState {
  readonly summary: TerminalSummary | null;
  readonly output: TerminalOutputState;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  /** The process's exit code once it exits; null while it runs or when unknown. */
  readonly exitCode: number | null;
  /** A positive signal means the process was terminated, even when its raw exit code is zero. */
  readonly exitSignal: number | null;
  readonly elevationState: TerminalElevationState | null;
  readonly hasRunningSubprocess: boolean;
  readonly updatedAt: string | null;
  readonly runId: string | null;
  readonly version: number;
  readonly lifecycleVersion: number;
}

export interface TerminalBufferState {
  readonly output: TerminalOutputState;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
  readonly elevationState: TerminalElevationState | null;
  readonly updatedAt: string | null;
  readonly runId: string | null;
  readonly version: number;
  readonly lifecycleVersion: number;
}

export interface KnownTerminalSessionTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

export interface KnownTerminalSession {
  readonly target: KnownTerminalSessionTarget;
  readonly state: TerminalSessionState;
}

export function selectRunningSubprocessTerminalIds(
  sessions: ReadonlyArray<KnownTerminalSession>,
): ReadonlyArray<string> {
  return sessions
    .filter((session) => session.state.hasRunningSubprocess)
    .map((session) => session.target.terminalId);
}

export const EMPTY_TERMINAL_BUFFER_STATE = Object.freeze<TerminalBufferState>({
  output: EMPTY_TERMINAL_OUTPUT_STATE,
  status: "closed",
  error: null,
  exitCode: null,
  exitSignal: null,
  elevationState: null,
  updatedAt: null,
  runId: null,
  version: 0,
  lifecycleVersion: 0,
});

export const EMPTY_TERMINAL_SESSION_STATE = Object.freeze<TerminalSessionState>({
  summary: null,
  output: EMPTY_TERMINAL_OUTPUT_STATE,
  status: "closed",
  error: null,
  exitCode: null,
  exitSignal: null,
  elevationState: null,
  hasRunningSubprocess: false,
  updatedAt: null,
  runId: null,
  version: 0,
  lifecycleVersion: 0,
});

let terminalAttachGeneration = 0;

/** A reinstalled attach stream must not reuse an old renderer's output cursor. */
export function nextTerminalAttachSeedState(): TerminalBufferState {
  return {
    ...EMPTY_TERMINAL_BUFFER_STATE,
    output: {
      ...EMPTY_TERMINAL_OUTPUT_STATE,
      generation: ++terminalAttachGeneration,
    },
  };
}

function terminalBufferStateFromSnapshot(
  snapshot: TerminalSessionSnapshot,
  maxBufferBytes: number,
  current: TerminalBufferState = EMPTY_TERMINAL_BUFFER_STATE,
): TerminalBufferState {
  return {
    output: resetOutput(current.output, snapshot.history, maxBufferBytes),
    status: snapshot.status,
    error: null,
    exitCode: snapshot.exitCode,
    exitSignal: snapshot.exitSignal,
    elevationState: snapshot.elevationState ?? verifiedTerminalElevationState(snapshot.history),
    updatedAt: snapshot.updatedAt,
    runId: snapshot.runId ?? null,
    version: current.version + 1,
    lifecycleVersion: current.lifecycleVersion,
  };
}

function advanceElevationState(
  current: TerminalElevationState | null,
  chunk: string,
): TerminalElevationState | null {
  if (current !== null && current !== "waiting") return current;
  const next = verifiedTerminalElevationState(chunk);
  if (next === null) return current;
  if (current === null || next !== "waiting") return next;
  return current;
}

function latestTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function latestRunId(summary: TerminalSummary | null, buffer: TerminalBufferState): string | null {
  if (buffer.status === "closed" && buffer.version > 0) {
    return null;
  }
  const summaryRunId = summary?.runId ?? null;
  if (summaryRunId === null) return buffer.runId;
  if (buffer.runId === null) return summaryRunId;
  if (summaryRunId === buffer.runId) return buffer.runId;
  if (summary?.updatedAt != null && buffer.updatedAt !== null) {
    return Date.parse(summary.updatedAt) > Date.parse(buffer.updatedAt)
      ? summaryRunId
      : buffer.runId;
  }
  return buffer.runId;
}

export function combineTerminalSessionState(
  summary: TerminalSummary | null,
  buffer: TerminalBufferState,
): TerminalSessionState {
  return {
    summary,
    output: buffer.output,
    status: buffer.version > 0 ? buffer.status : (summary?.status ?? buffer.status),
    error: buffer.error,
    exitCode: buffer.version > 0 ? buffer.exitCode : (summary?.exitCode ?? buffer.exitCode),
    exitSignal: buffer.version > 0 ? buffer.exitSignal : (summary?.exitSignal ?? buffer.exitSignal),
    elevationState: buffer.elevationState,
    hasRunningSubprocess: summary?.hasRunningSubprocess ?? false,
    updatedAt: latestTimestamp(summary?.updatedAt ?? null, buffer.updatedAt),
    runId: latestRunId(summary, buffer),
    version: buffer.version,
    lifecycleVersion: buffer.lifecycleVersion,
  };
}

export function applyTerminalAttachStreamEvent(
  current: TerminalBufferState,
  event: TerminalAttachStreamEvent,
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): TerminalBufferState {
  switch (event.type) {
    case "snapshot":
      return {
        ...terminalBufferStateFromSnapshot(event.snapshot, maxBufferBytes, current),
        lifecycleVersion:
          current.version === 0 ? current.lifecycleVersion : current.lifecycleVersion + 1,
      };
    case "restarted":
      return {
        ...terminalBufferStateFromSnapshot(event.snapshot, maxBufferBytes, current),
        lifecycleVersion: current.lifecycleVersion + 1,
      };
    case "output":
      return {
        ...current,
        output: appendOutput(current.output, event.data, maxBufferBytes),
        status: current.status === "closed" ? "running" : current.status,
        elevationState: advanceElevationState(current.elevationState, event.data),
        error: null,
        version: current.version + 1,
      };
    case "cleared":
      return {
        ...current,
        output: resetOutput(current.output, "", maxBufferBytes),
        elevationState: event.elevationState ?? current.elevationState,
        error: null,
        version: current.version + 1,
      };
    case "exited":
      return {
        ...current,
        status: "exited",
        error: null,
        exitCode: event.exitCode,
        exitSignal: event.exitSignal,
        version: current.version + 1,
      };
    case "closed":
      return {
        ...current,
        status: "closed",
        elevationState: null,
        runId: null,
        error: null,
        version: current.version + 1,
      };
    case "error":
      return {
        ...current,
        status: "error",
        error: event.message,
        version: current.version + 1,
      };
    case "activity":
      return current;
  }
}

export function applyTerminalMetadataStreamEvent(
  current: ReadonlyArray<TerminalSummary>,
  event: TerminalMetadataStreamEvent,
): ReadonlyArray<TerminalSummary> {
  if (event.type === "snapshot") {
    return event.terminals;
  }
  if (event.type === "remove") {
    return current.filter(
      (terminal) =>
        terminal.threadId !== event.threadId || terminal.terminalId !== event.terminalId,
    );
  }
  const next = current.filter(
    (terminal) =>
      terminal.threadId !== event.terminal.threadId ||
      terminal.terminalId !== event.terminal.terminalId,
  );
  return [...next, event.terminal];
}
