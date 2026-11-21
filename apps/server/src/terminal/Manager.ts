/**
 * TerminalManager - Terminal session orchestration service interface.
 *
 * Owns terminal lifecycle operations, output fanout, and session state
 * transitions for thread-scoped terminals.
 *
 * @module TerminalManager
 */
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import {
  DEFAULT_TERMINAL_ID,
  TERMINAL_ELEVATION_OSC,
  TERMINAL_ELEVATION_STATES,
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalProviderInstanceNotFoundError,
  TerminalProviderEnvironmentError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalStopError,
  TerminalWriteError,
  terminalHistoryTail,
  terminalVerifiedElevationMarker,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalElevationState,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalObserveInput,
  type TerminalResizeInput,
  type ResourceMonitorProcessTableEntry,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  type TerminalSummary,
  type TerminalWriteInput,
  ClaudeSettings,
  CodexSettings,
  ProviderInstanceId,
} from "@specweave-studio/contracts";
import { makeKeyedCoalescingWorker } from "@specweave-studio/shared/KeyedCoalescingWorker";
import * as KeyedLock from "@specweave-studio/shared/KeyedLock";
import { HostProcessArchitecture, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { listLoginShellCandidates, mergePathEntries } from "@specweave-studio/shared/shell";
import * as NodeOS from "node:os";

import { acpRegistryManagedBinaryDirectories } from "../provider/acp/AcpRegistrySupport.ts";
import { getTerminalLabel } from "@specweave-studio/shared/terminalLabels";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ServerConfig from "../config.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import {
  increment,
  terminalRestartsTotal,
  terminalSessionsTotal,
} from "../observability/Metrics.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ProcessRunner from "../processRunner.ts";
import { launchctlGetenvSshAuthSock, makeSshAgentSocketLookup } from "./sshAgentSocket.ts";
import { withGitHubSpawnEnvironment } from "../sourceControl/gitHubSpawnEnvironment.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import {
  ELEVATION_CLEANUP_TIMEOUT_SECONDS,
  elevatedRunApplies,
  elevationStateCommand,
  prepareElevatedRunHandle,
} from "./elevatedRun.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

export {
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalProviderInstanceNotFoundError,
  TerminalProviderEnvironmentError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalStopError,
  TerminalWriteError,
};

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_HISTORY_BYTE_LIMIT = 8 * 1024 * 1024;
const MAX_HISTORY_CHUNK_LENGTH = 16 * 1024;
const DEFAULT_PERSIST_DEBOUNCE_MS = 40;
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
const MAX_SUBPROCESS_POLL_INTERVAL_MS = 60_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;
const TERMINAL_ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const MAX_TERMINAL_LABEL_LENGTH = 128;
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

class TerminalSubprocessCheckError extends Schema.TaggedError<TerminalSubprocessCheckError>()(
  "TerminalSubprocessCheckError",
  {
    cause: Schema.optional(Schema.Defect()),
    command: Schema.Literals(["powershell", "ps", "resource-monitor"]),
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
    timedOut: Schema.optional(Schema.Boolean),
    stdoutTruncated: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    const details = [
      this.exitCode !== undefined && this.exitCode !== null ? `exit code ${this.exitCode}` : null,
      this.timedOut ? "timed out" : null,
      this.stdoutTruncated ? "output truncated" : null,
    ]
      .filter((detail) => detail !== null)
      .join(", ");
    return `Failed to inspect terminal subprocesses with ${this.command}${details.length > 0 ? ` (${details})` : ""}`;
  }
}

class TerminalProcessSignalError extends Schema.TaggedError<TerminalProcessSignalError>()(
  "TerminalProcessSignalError",
  {
    cause: Schema.optional(Schema.Defect()),
    signal: Schema.Literals(["SIGTERM", "SIGKILL"]),
    terminalPid: Schema.Number,
  },
) {
  override get message(): string {
    return `Failed to send ${this.signal} to terminal process ${this.terminalPid}`;
  }
}

/**
 * TerminalManager - Service tag for terminal session orchestration.
 */
export class TerminalManager extends Context.Service<
  TerminalManager,
  {
    /**
     * Serialize a lifecycle decision with open, attach-spawn, restart and close.
     * Non-reentrant: the effect must not call terminal lifecycle methods for this thread.
     */
    readonly withThreadLifecycleLock: <A, E, R>(
      threadId: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;

    /**
     * Open or attach to a terminal session.
     *
     * Reuses an existing session for the same thread/terminal id and restores
     * persisted history on first open.
     */
    readonly open: (
      input: TerminalOpenInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError | TerminalStopError>;

    /**
     * Attach to a terminal and stream its initial snapshot followed by live events.
     *
     * Returns an unsubscribe function.
     */
    readonly attachStream: (
      input: TerminalAttachInput,
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void, TerminalError | TerminalStopError>;

    /** Observe an existing session without starting or changing its process. */
    readonly observeStream: (
      input: TerminalObserveInput,
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void, TerminalError>;

    /**
     * Write input bytes to a terminal session.
     */
    readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>;

    /**
     * Resize the PTY backing a terminal session.
     */
    readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, TerminalError>;

    /**
     * Clear terminal output history.
     */
    readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;

    /**
     * Restart a terminal session in place.
     *
     * Always resets history before spawning the new process.
     */
    readonly restart: (
      input: TerminalRestartInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError | TerminalStopError>;

    /**
     * Close an active terminal session.
     *
     * When `terminalId` is omitted, closes all sessions for the thread.
     */
    readonly close: (
      input: TerminalCloseInput,
    ) => Effect.Effect<void, TerminalError | TerminalStopError>;

    /**
     * Close a thread's terminals that wait at an idle shell prompt. A terminal
     * that runs a command stays open. When `terminalId` is set, only that
     * terminal is considered. Used when a thread settles, when a setup
     * script finishes and when the user hides the terminal drawer. Returns the
     * ids it closed.
     */
    readonly closeIdle: (input: {
      readonly threadId: string;
      readonly terminalId?: string;
      readonly deleteHistory?: boolean;
    }) => Effect.Effect<ReadonlyArray<string>>;

    /**
     * Closes every terminal, whatever runs in it, and keeps each one's history.
     * Returns how many were running. Used before a service update, whose helper
     * refuses while any shell still runs under the service.
     */
    readonly closeAll: Effect.Effect<number>;

    /** How many terminals have a running shell. */
    readonly countOpen: Effect.Effect<number>;

    /**
     * Subscribe to terminal runtime events with a direct callback.
     *
     * Returns an unsubscribe function.
     */
    readonly subscribe: (
      listener: (event: TerminalEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;

    /**
     * Subscribe to lightweight terminal metadata with an initial full snapshot.
     *
     * Returns an unsubscribe function.
     */
    readonly subscribeMetadata: (
      listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;
  }
>()("specweave-studio/terminal/Manager/TerminalManager") {}

interface TerminalSubprocessInspectResult {
  readonly hasRunningSubprocess: boolean;
  readonly childCommand: string | null;
  readonly processIds: ReadonlyArray<number>;
}

interface TerminalSubprocessInspector {
  (
    terminalPid: number,
  ): Effect.Effect<TerminalSubprocessInspectResult, TerminalSubprocessCheckError>;
}

const resizePtyProcess = (
  session: TerminalSessionState,
  process: PtyAdapter.PtyProcess,
  cols: number,
  rows: number,
) =>
  Effect.try({
    try: () => process.resize(cols, rows),
    catch: (cause) =>
      new TerminalResizeError({
        threadId: session.threadId,
        terminalId: session.terminalId,
        terminalPid: process.pid,
        cols,
        rows,
        cause,
      }),
  });

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

export interface TerminalStartInput extends TerminalOpenInput {
  cols: number;
  rows: number;
}

interface TerminalSessionState {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  lastPid: number | null;
  history: BoundedTerminalHistory;
  pendingHistoryControlSequence: string;
  pendingElevationControlSequence: string;
  pendingProcessEvents: Array<PendingProcessEvent>;
  pendingProcessEventIndex: number;
  processEventDrainRunning: boolean;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  eventSequence: number;
  /** Counts writes, so closeIdle can see input that has not echoed yet. */
  inputCount: number;
  cols: number;
  rows: number;
  process: PtyAdapter.PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  /** Normalized child command name when `hasRunningSubprocess`; cleared when idle. */
  childCommandLabel: string | null;
  runtimeEnv: Record<string, string> | null;
  /** One command run through the shell's `-c`; null for an interactive shell. */
  command: string | null;
  /** Original un-wrapped command when running via elevatedRun; null for plain runs. */
  elevatedCommand: string | null;
  /** Active elevation delivery mode ("prompt" | "terminal-app"); null for plain runs. */
  elevationMode: "prompt" | "terminal-app" | null;
  /** Server-only elevation marker nonce for the active elevated run; never exposed on wire. */
  elevationNonce: string | null;
  /** Server-verified elevation state for the active elevated run; null otherwise. */
  elevationState: TerminalElevationState | null;
  /** Staging directory whose removal acknowledges elevated wrapper/watcher teardown. */
  elevatedRunDir: string | null;
  /** Sibling marker created right before `open -a Terminal`; absent if launcher exited early. */
  elevatedHandoffMarker: string | null;
  /** Pre-handoff cleanup for a staged Terminal.app `.command` file (runs only if unstarted). */
  cleanupStagedPreHandoff: Effect.Effect<void> | null;
}

interface PersistHistoryRequest {
  history: BoundedTerminalHistory;
  immediate: boolean;
}

type PendingProcessEvent =
  | { type: "output"; data: string }
  | { type: "exit"; event: PtyAdapter.PtyExitEvent };

type StagedTerminalAppPreHandoff = {
  readonly handoffMarker: string;
  readonly cleanup: Effect.Effect<void>;
};

type DrainProcessEventAction =
  | { type: "idle" }
  | { type: "skip" }
  | {
      type: "output";
      threadId: string;
      terminalId: string;
      sequence: number;
      history: BoundedTerminalHistory | null;
      data: string;
    }
  | {
      type: "exit";
      process: PtyAdapter.PtyProcess | null;
      stagedPreHandoff: StagedTerminalAppPreHandoff | null;
      threadId: string;
      terminalId: string;
      sequence: number;
      exitCode: number | null;
      exitSignal: number | null;
    };

interface TerminalManagerState {
  disposed: boolean;
  sessions: Map<string, TerminalSessionState>;
  killFibers: Map<PtyAdapter.PtyProcess, Fiber.Fiber<void, never>>;
}

function truncateTerminalWireLabel(value: string): string {
  if (value.length <= MAX_TERMINAL_LABEL_LENGTH) return value;
  return value.slice(0, MAX_TERMINAL_LABEL_LENGTH);
}

function normalizeChildCommandName(raw: string, platform: NodeJS.Platform): string | null {
  let trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("(") && trimmed.endsWith(")"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  const firstToken = (trimmed.split(/\s+/)[0] ?? trimmed).trim();
  if (firstToken.length === 0) return null;
  const separators = platform === "win32" ? /[\\/]/ : /\//;
  const base = firstToken.split(separators).at(-1) ?? firstToken;
  const withoutExe =
    platform === "win32" && base.toLowerCase().endsWith(".exe") ? base.slice(0, -4) : base;
  return withoutExe.length > 0 ? withoutExe : null;
}

function terminalWireLabel(session: TerminalSessionState): string {
  if (session.hasRunningSubprocess && session.childCommandLabel) {
    const trimmed = session.childCommandLabel.trim();
    if (trimmed.length > 0) {
      return truncateTerminalWireLabel(trimmed);
    }
  }
  return truncateTerminalWireLabel(getTerminalLabel(session.terminalId));
}

function snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    history: session.history.value(),
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    label: terminalWireLabel(session),
    updatedAt: session.updatedAt,
    sequence: session.eventSequence,
    ...(session.elevationState !== null ? { elevationState: session.elevationState } : {}),
  };
}

function summary(session: TerminalSessionState): TerminalSummary {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    hasRunningSubprocess: session.hasRunningSubprocess,
    label: terminalWireLabel(session),
    updatedAt: session.updatedAt,
  };
}

function shouldPublishTerminalMetadataEvent(event: TerminalEvent): boolean {
  switch (event.type) {
    case "started":
    case "restarted":
    case "exited":
    case "closed":
    case "error":
    case "activity":
      return true;
    case "output":
    case "cleared":
      return false;
  }
}

/** Sends a client that states its buffer size only the history it keeps. */
function boundAttachHistory(
  maxHistoryBytes: number | undefined,
  listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
): (event: TerminalAttachStreamEvent) => Effect.Effect<void> {
  if (maxHistoryBytes === undefined) return listener;
  return (event) =>
    listener(
      "snapshot" in event
        ? {
            ...event,
            snapshot: {
              ...event.snapshot,
              history: terminalHistoryTail(event.snapshot.history, maxHistoryBytes),
            },
          }
        : event,
    );
}

function terminalEventToAttachEvent(event: TerminalEvent): TerminalAttachStreamEvent | null {
  switch (event.type) {
    case "started":
      return {
        type: "snapshot",
        snapshot: event.snapshot,
      };
    case "output":
    case "exited":
    case "closed":
    case "error":
    case "cleared":
    case "restarted":
    case "activity":
      return event;
  }
}

function isDuplicateAttachSnapshotEvent(
  event: TerminalEvent,
  initialSnapshot: TerminalSessionSnapshot,
) {
  return typeof event.sequence === "number" && typeof initialSnapshot.sequence === "number"
    ? event.sequence <= initialSnapshot.sequence
    : event.type === "started" &&
        event.snapshot.threadId === initialSnapshot.threadId &&
        event.snapshot.terminalId === initialSnapshot.terminalId &&
        event.snapshot.updatedAt <= initialSnapshot.updatedAt;
}

function advanceEventSequence(session: TerminalSessionState): {
  readonly updatedAt: string;
  readonly sequence: number;
} {
  const updatedAt = DateTime.formatIso(DateTime.nowUnsafe());
  session.eventSequence += 1;
  session.updatedAt = updatedAt;
  return { updatedAt, sequence: session.eventSequence };
}

function cleanupProcessHandles(session: TerminalSessionState): void {
  session.unsubscribeData?.();
  session.unsubscribeData = null;
  session.unsubscribeExit?.();
  session.unsubscribeExit = null;
}

function enqueueProcessEvent(
  session: TerminalSessionState,
  expectedPid: number,
  event: PendingProcessEvent,
): boolean {
  if (!session.process || session.status !== "running" || session.pid !== expectedPid) {
    return false;
  }

  session.pendingProcessEvents.push(event);
  if (session.processEventDrainRunning) {
    return false;
  }

  session.processEventDrainRunning = true;
  return true;
}

function defaultShellResolver(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") {
    return "pwsh.exe";
  }
  // A service started by launchd has no SHELL; the account's login shell
  // (zsh on macOS) is what the user's own terminal would open.
  return listLoginShellCandidates(platform, env.SHELL)[0] ?? "bash";
}

function normalizeShellCommand(
  value: string | undefined,
  platform: NodeJS.Platform,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function basenameForPlatform(command: string, platform: NodeJS.Platform): string {
  const normalized =
    platform === "win32" ? command.replaceAll("/", "\\") : command.replaceAll("\\", "/");
  const parts = normalized
    .split(platform === "win32" ? /\\+/ : /\/+/)
    .filter((part) => part.length > 0);
  return parts.at(-1) ?? normalized;
}

function joinWindowsPath(...parts: ReadonlyArray<string>): string {
  return parts
    .map((part, index) => {
      if (index === 0) return part.replace(/[\\/]+$/g, "");
      return part.replace(/^[\\/]+|[\\/]+$/g, "");
    })
    .filter((part) => part.length > 0)
    .join("\\");
}

function shellCandidateFromCommand(
  command: string | null,
  platform: NodeJS.Platform,
): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = basenameForPlatform(command, platform).toLowerCase();
  if (platform === "win32" && (shellName === "pwsh.exe" || shellName === "powershell.exe")) {
    return { shell: command, args: ["-NoLogo"] };
  }
  // macOS terminals open login shells, so ~/.zprofile and friends load.
  const login = platform === "darwin" && LOGIN_SHELL_NAMES.has(shellName) ? ["-l"] : [];
  if (platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: [...login, "-o", "nopromptsp"] };
  }
  return login.length > 0 ? { shell: command, args: login } : { shell: command };
}

const LOGIN_SHELL_NAMES = new Set(["zsh", "bash", "fish", "ksh", "sh", "dash"]);

/** Arguments that make a shell candidate run one command and exit with its code. */
export function shellCandidateArgs(
  candidate: ShellCandidate,
  command: string | null,
  platform: NodeJS.Platform,
): string[] | undefined {
  if (command === null) return candidate.args;
  const shellName = basenameForPlatform(candidate.shell, platform).toLowerCase();
  if (platform === "win32") {
    if (shellName === "cmd.exe" || shellName === "cmd") return ["/d", "/s", "/c", command];
    return ["-NoLogo", "-Command", command];
  }
  return [...(candidate.args ?? []), "-c", command];
}

function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
}

function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(
    windowsSystemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function windowsCmdPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(windowsSystemRoot(env), "System32", "cmd.exe");
}

function formatShellCandidate(candidate: ShellCandidate): string {
  if (!candidate.args || candidate.args.length === 0) return candidate.shell;
  return `${candidate.shell} ${candidate.args.join(" ")}`;
}

function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

function resolveShellCandidates(
  shellResolver: () => string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ShellCandidate[] {
  const requested = shellCandidateFromCommand(
    normalizeShellCommand(shellResolver(), platform),
    platform,
  );

  if (platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand("pwsh.exe", platform),
      shellCandidateFromCommand(windowsPowerShellPath(env), platform),
      shellCandidateFromCommand("powershell.exe", platform),
      shellCandidateFromCommand(env.ComSpec ?? null, platform),
      shellCandidateFromCommand(windowsCmdPath(env), platform),
      shellCandidateFromCommand("cmd.exe", platform),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    ...listLoginShellCandidates(platform, env.SHELL).map((shell) =>
      shellCandidateFromCommand(normalizeShellCommand(shell, platform), platform),
    ),
    shellCandidateFromCommand("/bin/zsh", platform),
    shellCandidateFromCommand("/bin/bash", platform),
    shellCandidateFromCommand("/bin/sh", platform),
    shellCandidateFromCommand("zsh", platform),
    shellCandidateFromCommand("bash", platform),
    shellCandidateFromCommand("sh", platform),
  ]);
}

function isRetryableShellSpawnError(error: PtyAdapter.PtySpawnError): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      continue;
    }

    if (current instanceof Error) {
      messages.push(current.message);
      if (current.cause) {
        queue.push(current.cause);
      }
      continue;
    }

    if (typeof current === "object") {
      const value = current as { message?: unknown; cause?: unknown };
      if (typeof value.message === "string") {
        messages.push(value.message);
      }
      if (value.cause) {
        queue.push(value.cause);
      }
    }
  }

  const message = messages.join(" ").toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file")
  );
}

interface TerminalProcessTableSnapshot {
  readonly childrenByParent: ReadonlyMap<number, ReadonlyArray<number>>;
  readonly commandById: ReadonlyMap<number, string>;
}

export function subprocessSnapshotPollDelayMs(
  pollIntervalMs: number,
  failureCount: number,
): number {
  return Math.min(pollIntervalMs * 2 ** failureCount, MAX_SUBPROCESS_POLL_INTERVAL_MS);
}

function parsePosixProcessTable(stdout: string): TerminalProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  const commandById = new Map<number, string>();
  for (const line of stdout.split(/\r?\n/g)) {
    // `comm=` is the final column and may itself contain spaces, so only the
    // first two tokens are structural.
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    commandById.set(pid, (match[3] ?? "").trim());
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  return { childrenByParent, commandById };
}

function processTableSnapshotFromProcesses(
  processes: ReadonlyArray<ResourceMonitorProcessTableEntry>,
): TerminalProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  const commandById = new Map<number, string>();
  for (const process of processes) {
    const { pid, ppid: parentPid, name } = process;
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
    commandById.set(pid, name.trim());
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  return { childrenByParent, commandById };
}

function deriveSubprocessInspectResult(
  snapshot: TerminalProcessTableSnapshot,
  terminalPid: number,
  platform: NodeJS.Platform,
): TerminalSubprocessInspectResult {
  const commandName = (pid: number) =>
    normalizeChildCommandName(snapshot.commandById.get(pid) ?? "", platform);
  const shellName = commandName(terminalPid);
  // Async prompt themes fork the shell into a helper that waits with no
  // children of its own. That copy is not a command the user started.
  const childPid = (snapshot.childrenByParent.get(terminalPid) ?? []).find(
    (pid) =>
      shellName === null ||
      commandName(pid) !== shellName ||
      (snapshot.childrenByParent.get(pid)?.length ?? 0) > 0,
  );
  if (childPid === undefined) {
    return { hasRunningSubprocess: false, childCommand: null, processIds: [] };
  }
  const processIds = new Set<number>([terminalPid]);
  const pending = [terminalPid];
  while (pending.length > 0) {
    const parentPid = pending.pop();
    if (parentPid === undefined) continue;
    for (const pid of snapshot.childrenByParent.get(parentPid) ?? []) {
      if (processIds.has(pid)) continue;
      processIds.add(pid);
      pending.push(pid);
    }
  }
  const normalized = commandName(childPid);
  return {
    hasRunningSubprocess: true,
    childCommand: normalized ? truncateTerminalWireLabel(normalized) : null,
    processIds: [...processIds],
  };
}

const POSIX_PS_ABSOLUTE_PATHS = ["/bin/ps", "/usr/bin/ps"] as const;

// Resolve `ps` to an absolute path once at startup. Spawning by bare name
// walks every PATH entry per spawn (one failed posix_spawn per directory
// until the hit), which is measurable at a 1s poll cadence on long PATHs.
const resolvePosixPsCommand = Effect.fn("terminal.resolvePosixPsCommand")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const candidate of POSIX_PS_ABSOLUTE_PATHS) {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) return candidate;
  }
  return "ps";
});

const posixProcessTableSnapshot = Effect.fn("terminal.posixProcessTableSnapshot")(function* (
  psCommand: string,
): Effect.fn.Return<
  TerminalProcessTableSnapshot,
  TerminalSubprocessCheckError,
  ProcessRunner.ProcessRunner
> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({
      command: psCommand,
      args: ["-eo", "pid=,ppid=,comm="],
      timeout: "1 second",
      maxOutputBytes: 524_288,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new TerminalSubprocessCheckError({
            cause,
            command: "ps",
          }),
      ),
    );
  if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
    // Not authoritative: an empty or partial table would mark every terminal
    // idle and clear its registered process ids. Failing skips the tick.
    return yield* new TerminalSubprocessCheckError({
      command: "ps",
      exitCode: result.code,
      timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated,
    });
  }
  return parsePosixProcessTable(result.stdout);
});

const windowsProcessTableSnapshot = Effect.fn("terminal.windowsProcessTableSnapshot")(
  function* (): Effect.fn.Return<
    TerminalProcessTableSnapshot,
    TerminalSubprocessCheckError,
    ProcessRunner.ProcessRunner
  > {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const command =
      'Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { Write-Output "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }';
    const result = yield* processRunner
      .run({
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", command],
        timeout: "1500 millis",
        maxOutputBytes: 262_144,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.mapError(
          (cause) => new TerminalSubprocessCheckError({ cause, command: "powershell" }),
        ),
      );
    if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
      return yield* new TerminalSubprocessCheckError({
        command: "powershell",
        exitCode: result.code,
        timedOut: result.timedOut,
        stdoutTruncated: result.stdoutTruncated,
      });
    }
    const processes = result.stdout.split(/\r?\n/g).flatMap((line) => {
      const [pidRaw, ppidRaw, name = ""] = line.trim().split("|", 3);
      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      return Number.isInteger(pid) && pid > 0 && Number.isInteger(ppid)
        ? [{ pid, ppid, name }]
        : [];
    });
    return processTableSnapshotFromProcesses(processes);
  },
);

interface TerminalHistoryChunk {
  data: string;
  byteLength: number;
  lineBreaks: number;
}

export class BoundedTerminalHistory {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private chunks: Array<TerminalHistoryChunk | undefined> = [];
  private start = 0;
  private byteLength = 0;
  private lineBreaks = 0;
  // Reading the old string's tail on each append can force chunk concatenation.
  private lastCodeUnit: number | undefined;
  private cachedValue: string | null = "";

  constructor(maxLines: number, initial: string, maxBytes = DEFAULT_HISTORY_BYTE_LIMIT) {
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
    this.append(initial);
  }

  append(text: string): void {
    if (text.length === 0) return;
    this.cachedValue = null;
    if (this.maxBytes <= 0 || this.maxLines <= 0) {
      this.clear();
      // Preserve the existing zero-line limit's trailing newline behavior.
      if (this.maxBytes > 0 && text.endsWith("\n")) this.appendChunk("\n");
      return;
    }

    let offset = 0;
    const previous = this.chunks.at(-1);
    const lastCode = this.lastCodeUnit;
    const firstCode = text.charCodeAt(0);
    if (
      previous &&
      lastCode !== undefined &&
      lastCode >= 0xd800 &&
      lastCode <= 0xdbff &&
      firstCode >= 0xdc00 &&
      firstCode <= 0xdfff
    ) {
      // Joining a split surrogate changes its UTF-8 size from 3 to 4 bytes.
      previous.data += text[0];
      previous.byteLength += 1;
      this.byteLength += 1;
      this.lastCodeUnit = firstCode;
      offset = 1;
      this.trim();
    }

    while (offset < text.length) {
      let end = Math.min(offset + MAX_HISTORY_CHUNK_LENGTH, text.length);
      const before = text.charCodeAt(end - 1);
      const after = text.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
        end -= 1;
      }
      const data = text.slice(offset, end);
      // Detach small chunks from large input strings so evicted prefixes can be collected.
      this.appendChunk(
        text.length > MAX_HISTORY_CHUNK_LENGTH
          ? Buffer.from(data, "utf16le").toString("utf16le")
          : data,
      );
      this.trim();
      offset = end;
    }
  }

  private appendChunk(data: string): void {
    const byteLength = Buffer.byteLength(data);
    let lineBreaks = 0;
    for (let index = data.indexOf("\n"); index !== -1; index = data.indexOf("\n", index + 1)) {
      lineBreaks += 1;
    }
    const previous = this.chunks.at(-1);
    if (previous && previous.data.length + data.length <= MAX_HISTORY_CHUNK_LENGTH) {
      previous.data += data;
      previous.byteLength += byteLength;
      previous.lineBreaks += lineBreaks;
    } else {
      this.chunks.push({ data, byteLength, lineBreaks });
    }
    this.byteLength += byteLength;
    this.lineBreaks += lineBreaks;
    this.lastCodeUnit = data.charCodeAt(data.length - 1);
    this.cachedValue = null;
  }

  private discardChunk(): void {
    const first = this.chunks[this.start]!;
    this.byteLength -= first.byteLength;
    this.lineBreaks -= first.lineBreaks;
    this.chunks[this.start++] = undefined;
  }

  private trimChunk(offset: number, byteLength: number, lineBreaks: number): void {
    const first = this.chunks[this.start]!;
    if (offset === first.data.length) {
      this.discardChunk();
      return;
    }
    first.data = first.data.slice(offset);
    first.byteLength -= byteLength;
    first.lineBreaks -= lineBreaks;
    this.byteLength -= byteLength;
    this.lineBreaks -= lineBreaks;
  }

  private trim(): void {
    const trailingNewline = this.lastCodeUnit === 10;
    let linesToDrop = this.lineBreaks + (trailingNewline ? 0 : 1) - this.maxLines;
    while (linesToDrop > 0) {
      const first = this.chunks[this.start]!;
      if (first.lineBreaks < linesToDrop) {
        linesToDrop -= first.lineBreaks;
        this.discardChunk();
        continue;
      }
      let offset = 0;
      for (let line = 0; line < linesToDrop; line += 1) {
        offset = first.data.indexOf("\n", offset) + 1;
      }
      this.trimChunk(offset, Buffer.byteLength(first.data.slice(0, offset)), linesToDrop);
      linesToDrop = 0;
    }

    while (this.byteLength > this.maxBytes) {
      const first = this.chunks[this.start]!;
      const bytesToDrop = this.byteLength - this.maxBytes;
      if (first.byteLength <= bytesToDrop) {
        this.discardChunk();
        continue;
      }
      if (first.byteLength === first.data.length && first.lineBreaks === 0) {
        // ASCII without newlines needs no scan to find the byte cutoff.
        this.trimChunk(bytesToDrop, bytesToDrop, 0);
        continue;
      }
      let offset = 0;
      let bytes = 0;
      let lineBreaks = 0;
      // Scan only the discarded prefix of one small chunk, never all history.
      while (bytes < bytesToDrop) {
        const codePoint = first.data.codePointAt(offset)!;
        bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
        offset += codePoint <= 0xffff ? 1 : 2;
        if (codePoint === 10) lineBreaks += 1;
      }
      this.trimChunk(offset, bytes, lineBreaks);
    }
    if (
      this.start === this.chunks.length ||
      (this.start > 2_048 && this.start * 2 >= this.chunks.length)
    ) {
      this.chunks = this.chunks.slice(this.start);
      this.start = 0;
      if (this.chunks.length === 0) this.lastCodeUnit = undefined;
    }
  }

  clear(): void {
    this.chunks = [];
    this.start = 0;
    this.byteLength = 0;
    this.lineBreaks = 0;
    this.lastCodeUnit = undefined;
    this.cachedValue = "";
  }

  value(): string {
    if (this.cachedValue !== null) return this.cachedValue;
    this.cachedValue = this.chunks
      .slice(this.start)
      .map((chunk) => chunk!.data)
      .join("");
    return this.cachedValue;
  }
}

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function isControlSequenceCancel(codePoint: number): boolean {
  return codePoint === 0x18 || codePoint === 0x1a;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  if (finalByte === "n") {
    return true;
  }
  if (finalByte === "R" && /^[0-9;?]*$/.test(body)) {
    return true;
  }
  if (finalByte === "c" && /^[>0-9;?]*$/.test(body)) {
    return true;
  }
  // DECRQM mode queries (…$p) and DECRPM replies (…$y): replaying a stored
  // query makes the terminal answer again, and the shell echoes the answer as
  // junk at the prompt. The `$` guard keeps setters like DECSTR (!p) and
  // DECSCL ("p) intact.
  if ((finalByte === "p" || finalByte === "y") && /^[0-9;?]*\$$/.test(body)) {
    return true;
  }
  // XTVERSION query (>q). DECSCUSR (space-intermediate q) stays.
  if (finalByte === "q" && /^>[0-9;]*$/.test(body)) {
    return true;
  }
  // Kitty keyboard protocol query/reply (?u). Restore-cursor (bare u) stays.
  if (finalByte === "u" && body.startsWith("?")) {
    return true;
  }
  return false;
}

// DECRQSS ($q) and XTGETTCAP (+q) queries plus their replies ([01]$r / [01]+r):
// pure request/response traffic with no visual value, and replaying a stored
// query triggers a fresh reply.
function shouldStripDcsSequence(content: string): boolean {
  return /^[01]?[$+][qr]/.test(content);
}

function shouldStripOscSequence(content: string): boolean {
  return /^(10|11|12);(?:\?|rgb:)/.test(content);
}

function stripStringTerminator(value: string): string {
  if (value.endsWith("\u001b\\")) {
    return value.slice(0, -2);
  }
  const lastCharacter = value.at(-1);
  if (lastCharacter === "\u0007" || lastCharacter === "\u009c") {
    return value.slice(0, -1);
  }
  return value;
}

function findStringTerminatorIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x07 || codePoint === 0x9c || isControlSequenceCancel(codePoint)) {
      return index + 1;
    }
    if (codePoint === 0x1b && input.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
  }
  return null;
}

function isEscapeIntermediateByte(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x2f;
}

function isEscapeFinalByte(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x7e;
}

function findEscapeSequenceEndIndex(input: string, start: number): number | null {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= input.length) {
    return null;
  }
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

const ELEVATION_OSC_PREFIX = `${TERMINAL_ELEVATION_OSC};`;
const MAX_PENDING_ELEVATION_OSC_CHARS = 512;
const ELEVATION_MARKER_PAYLOAD_REGEX = new RegExp(
  `^elevation=(${TERMINAL_ELEVATION_STATES.join("|")});([A-Za-z0-9]{16,64})$`,
);

function generateServerElevationNonce(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Strips every raw `OSC 7717` sequence (both 7-bit `ESC ]` and 8-bit `0x9d`,
 * including chunk-split sequences) before PTY output reaches live subscribers
 * or replay history, so the per-run secret nonce never leaves the server.
 * When a 7-bit `OSC 7717` carries this session's exact secret nonce and a
 * valid state transition (`null -> any` or `waiting -> final`), emits a
 * nonce-free verified marker and records `elevationState`.
 */
function filterElevationOscChunk(
  pendingSequence: string,
  data: string,
  elevationNonce: string | null,
  currentState: TerminalElevationState | null,
): {
  readonly output: string;
  readonly pendingSequence: string;
  readonly elevationState: TerminalElevationState | null;
} {
  const input = `${pendingSequence}${data}`;
  let output = "";
  let elevationState = currentState;
  let index = 0;

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    if (codePoint === 0x1b) {
      if (index + 1 >= input.length) {
        return { output, pendingSequence: input.slice(index), elevationState };
      }
      if (input.charCodeAt(index + 1) !== 0x5d) {
        output += "\u001b";
        index += 1;
        continue;
      }
      const afterOsc = input.slice(index + 2);
      if (afterOsc.length < ELEVATION_OSC_PREFIX.length) {
        if (ELEVATION_OSC_PREFIX.startsWith(afterOsc)) {
          return { output, pendingSequence: input.slice(index), elevationState };
        }
        output += "\u001b]";
        index += 2;
        continue;
      }
      if (!afterOsc.startsWith(ELEVATION_OSC_PREFIX)) {
        output += "\u001b]";
        index += 2;
        continue;
      }
      const terminatorIndex = findStringTerminatorIndex(input, index + 2);
      if (terminatorIndex === null) {
        if (input.length - index <= MAX_PENDING_ELEVATION_OSC_CHARS) {
          return { output, pendingSequence: input.slice(index), elevationState };
        }
        return { output, pendingSequence: "", elevationState };
      }
      const terminatorCodePoint = input.charCodeAt(terminatorIndex - 1);
      if (!isControlSequenceCancel(terminatorCodePoint) && elevationNonce !== null) {
        const body = stripStringTerminator(
          input.slice(index + 2 + ELEVATION_OSC_PREFIX.length, terminatorIndex),
        );
        const match = ELEVATION_MARKER_PAYLOAD_REGEX.exec(body);
        if (match && match[2] === elevationNonce) {
          const nextState = match[1] as TerminalElevationState;
          if (
            elevationState === null ||
            (elevationState === "waiting" && nextState !== "waiting")
          ) {
            elevationState = nextState;
            output += terminalVerifiedElevationMarker(nextState);
          }
        }
      }
      index = terminatorIndex;
      continue;
    }

    if (codePoint === 0x9d) {
      const afterOsc = input.slice(index + 1);
      if (afterOsc.length < ELEVATION_OSC_PREFIX.length) {
        if (ELEVATION_OSC_PREFIX.startsWith(afterOsc)) {
          return { output, pendingSequence: input.slice(index), elevationState };
        }
        output += input[index] ?? "";
        index += 1;
        continue;
      }
      if (!afterOsc.startsWith(ELEVATION_OSC_PREFIX)) {
        output += input[index] ?? "";
        index += 1;
        continue;
      }
      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
      if (terminatorIndex === null) {
        if (input.length - index <= MAX_PENDING_ELEVATION_OSC_CHARS) {
          return { output, pendingSequence: input.slice(index), elevationState };
        }
        return { output, pendingSequence: "", elevationState };
      }
      // 8-bit OSC 7717 sequences are never produced by our wrapper; strip unconditionally.
      index = terminatorIndex;
      continue;
    }

    output += input[index] ?? "";
    index += 1;
  }

  return { output, pendingSequence: "", elevationState };
}

function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string,
): { visibleText: string; pendingControlSequence: string } {
  const input = `${pendingControlSequence}${data}`;
  let visibleText = "";
  let index = 0;

  const append = (value: string) => {
    visibleText += value;
  };

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    if (codePoint === 0x1b) {
      const nextCodePoint = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodePoint)) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }

      if (nextCodePoint === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length) {
          const cancelled = isControlSequenceCancel(input.charCodeAt(cursor));
          if (cancelled || isCsiFinalByte(input.charCodeAt(cursor))) {
            const sequence = input.slice(index, cursor + 1);
            const body = input.slice(index + 2, cursor);
            if (cancelled || !shouldStripCsiSequence(body, input[cursor] ?? "")) {
              append(sequence);
            }
            index = cursor + 1;
            break;
          }
          cursor += 1;
        }
        if (cursor >= input.length) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        continue;
      }

      if (
        nextCodePoint === 0x5d ||
        nextCodePoint === 0x50 ||
        nextCodePoint === 0x5e ||
        nextCodePoint === 0x5f
      ) {
        const terminatorIndex = findStringTerminatorIndex(input, index + 2);
        if (terminatorIndex === null) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        const sequence = input.slice(index, terminatorIndex);
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        const strip =
          (nextCodePoint === 0x5d && shouldStripOscSequence(content)) ||
          (nextCodePoint === 0x50 && shouldStripDcsSequence(content));
        if (!strip) {
          append(sequence);
        }
        index = terminatorIndex;
        continue;
      }

      const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
      if (escapeSequenceEndIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      append(input.slice(index, escapeSequenceEndIndex));
      index = escapeSequenceEndIndex;
      continue;
    }

    if (codePoint === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length) {
        const cancelled = isControlSequenceCancel(input.charCodeAt(cursor));
        if (cancelled || isCsiFinalByte(input.charCodeAt(cursor))) {
          const sequence = input.slice(index, cursor + 1);
          const body = input.slice(index + 1, cursor);
          if (cancelled || !shouldStripCsiSequence(body, input[cursor] ?? "")) {
            append(sequence);
          }
          index = cursor + 1;
          break;
        }
        cursor += 1;
      }
      if (cursor >= input.length) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      continue;
    }

    if (codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f) {
      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
      if (terminatorIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      const sequence = input.slice(index, terminatorIndex);
      const content = stripStringTerminator(input.slice(index + 1, terminatorIndex));
      const strip =
        (codePoint === 0x9d && shouldStripOscSequence(content)) ||
        (codePoint === 0x90 && shouldStripDcsSequence(content));
      if (!strip) {
        append(sequence);
      }
      index = terminatorIndex;
      continue;
    }

    append(input[index] ?? "");
    index += 1;
  }

  return { visibleText, pendingControlSequence: "" };
}

function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toSafeThreadId(threadId: string): string {
  return `terminal_${Base64Url.encode(threadId)}`;
}

function toSafeTerminalId(terminalId: string): string {
  return Base64Url.encode(terminalId);
}

function toSessionKey(threadId: string, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}

function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("STUDIO_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

// Marker variables the AppImage runtime injects into the process it launches.
// They describe the AppImage itself, not the user's session, so terminals must
// not inherit them.
const APPIMAGE_RUNTIME_ENV_KEYS = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] as const;
// Colon-separated search-path variables the AppImage runtime points at its
// temporary mount (e.g. /tmp/.mount_Studio-XXXX/usr/bin, the bundled glib schemas,
// and an $APPDIR/usr/share XDG data entry). Only the mount segments are
// dropped; the user's real entries are preserved. When nothing but mount
// segments remain the variable is removed entirely so consumers fall back to
// their platform default (e.g. gsettings finds the host schemas instead of
// reporting "No schemas installed"). See issues #1699 and #5059.
const APPIMAGE_PATH_LIKE_ENV_KEYS = [
  "PATH",
  "LD_LIBRARY_PATH",
  "XDG_DATA_DIRS",
  "GSETTINGS_SCHEMA_DIR",
] as const;

function isPathSegmentUnderAppDir(segment: string, appDir: string): boolean {
  return segment === appDir || segment.startsWith(`${appDir}/`);
}

// On Linux AppImage builds the runtime mounts the app under a temporary dir and
// injects APPIMAGE/APPDIR/ARGV0/OWD plus mount entries on PATH/LD_LIBRARY_PATH.
// The integrated terminal inherits the server process environment, so without
// this scrub those leak into the PTY and tools resolve against the AppImage
// mount instead of the user's real environment (e.g. `php` reporting
// PHP_BINARY as the AppImage path). See issue #1699. The scrub is gated on an
// actual AppImage launch so non-AppImage environments are left untouched.
function stripAppImageRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.APPIMAGE === undefined && env.APPDIR === undefined) return env;

  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const key of APPIMAGE_RUNTIME_ENV_KEYS) {
    delete scrubbed[key];
  }

  const appDir = env.APPDIR?.replace(/\/+$/, "");
  if (appDir) {
    for (const key of APPIMAGE_PATH_LIKE_ENV_KEYS) {
      const value = scrubbed[key];
      if (value === undefined) continue;
      const kept = value
        .split(":")
        .filter((segment) => segment.length > 0 && !isPathSegmentUnderAppDir(segment, appDir));
      if (kept.length > 0) {
        scrubbed[key] = kept.join(":");
      } else {
        delete scrubbed[key];
      }
    }
  }

  return scrubbed;
}

function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv: Record<string, string> | null | undefined,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      const existingKey =
        platform === "win32"
          ? Object.keys(spawnEnv).find((candidate) => candidate.toLowerCase() === key.toLowerCase())
          : undefined;
      spawnEnv[existingKey ?? key] =
        key === "CODEX_HOME" || key === "CLAUDE_CONFIG_DIR" ? expandHomePath(value) : value;
    }
  }
  // An explicit empty override opts out for terminals started without a client.
  // Otherwise both PTY backends feed truecolor-capable terminal clients.
  if (!spawnEnv.COLORTERM && runtimeEnv?.COLORTERM === undefined) {
    spawnEnv.COLORTERM = "truecolor";
  }
  return stripAppImageRuntimeEnv(spawnEnv);
}

function normalizedRuntimeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
}

interface TerminalManagerOptions {
  logsDir: string;
  historyLineLimit?: number;
  historyByteLimit?: number;
  ptyAdapter: PtyAdapter.PtyAdapter["Service"];
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  /** Test seam for the private directory that holds staged elevated run artifacts. */
  elevatedRunsDir?: string;
  /** Test seam for staging elevated run artifacts. */
  prepareElevatedRun?: typeof prepareElevatedRunHandle;
  /** Test seam for the macOS `launchctl getenv SSH_AUTH_SOCK` lookup. */
  launchctlGetenvSshAuthSock?: Effect.Effect<string | undefined>;
  /**
   * Catalog cache and tool directories for managed ACP Registry installs. Their
   * install directories are appended to the terminal PATH so users can run
   * managed agents by name (e.g. `kimi login`).
   */
  managedBinaryCacheDir?: string;
  managedBinaryToolsDir?: string;
  subprocessInspector?: TerminalSubprocessInspector;
  processTable?: Effect.Effect<
    ReadonlyArray<ResourceMonitorProcessTableEntry>,
    TerminalSubprocessCheckError
  >;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  /** Bounded wait for elevated wrapper/watcher teardown (`$runDir` removal) after PTY exit. */
  elevatedCleanupTimeoutMs?: number;
  maxRetainedInactiveSessions?: number;
  registerTerminalProcesses?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly processIds: ReadonlyArray<number>;
  }) => Effect.Effect<void>;
  unregisterTerminal?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) => Effect.Effect<void>;
  resolveProviderInstanceEnvironment?: (
    providerInstanceId: string,
    env: Record<string, string> | undefined,
  ) => Effect.Effect<
    Record<string, string>,
    TerminalProviderInstanceNotFoundError | TerminalProviderEnvironmentError
  >;
}

export const resolveProviderInstanceTerminalEnvironment = Effect.fn(
  "terminal.resolveProviderInstanceTerminalEnvironment",
)(function* (input: {
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  readonly path: Path.Path;
  readonly rawProviderInstanceId: string;
  readonly env: Record<string, string> | undefined;
}) {
  const providerInstanceId = ProviderInstanceId.make(input.rawProviderInstanceId);
  const settings = yield* input.serverSettings.getSettings.pipe(
    Effect.mapError((cause) => new TerminalProviderEnvironmentError({ providerInstanceId, cause })),
  );
  const instance = deriveProviderInstanceConfigMap(settings)[providerInstanceId];
  if (instance === undefined) {
    return yield* new TerminalProviderInstanceNotFoundError({ providerInstanceId });
  }

  let resolved = mergeProviderInstanceEnvironment(instance.environment, input.env ?? {});
  if (instance.driver === "codex") {
    const config = decodeCodexSettings(instance.config ?? {});
    if (Option.isSome(config)) {
      const layout = yield* resolveCodexHomeLayout(config.value).pipe(
        Effect.provideService(Path.Path, input.path),
      );
      if (layout.effectiveHomePath)
        resolved = { ...resolved, CODEX_HOME: layout.effectiveHomePath };
    }
  } else if (instance.driver === "claudeAgent") {
    const config = decodeClaudeSettings(instance.config ?? {});
    if (Option.isSome(config)) {
      resolved = yield* makeClaudeEnvironment(config.value, resolved).pipe(
        Effect.provideService(Path.Path, input.path),
      );
    }
  }

  return Object.fromEntries(
    Object.entries(resolved).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("TerminalManager.make")(function* () {
  const { terminalLogsDir, providerStatusCacheDir, baseDir } = yield* ServerConfig.ServerConfig;
  const ptyAdapter = yield* PtyAdapter.PtyAdapter;
  const portDiscovery = yield* PortScanner.PortDiscovery;
  const nativeTelemetry = yield* NativeTelemetryClient.NativeTelemetryClient;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const resolveProviderInstanceEnvironment = Effect.fn(
    "terminal.resolveProviderInstanceEnvironment",
  )((rawProviderInstanceId: string, env: Record<string, string> | undefined) =>
    resolveProviderInstanceTerminalEnvironment({
      serverSettings,
      path,
      rawProviderInstanceId,
      env,
    }),
  );
  return yield* makeWithOptions({
    logsDir: terminalLogsDir,
    ptyAdapter,
    processTable: nativeTelemetry.processTable.pipe(
      Effect.mapError(
        (cause) => new TerminalSubprocessCheckError({ cause, command: "resource-monitor" }),
      ),
    ),
    managedBinaryCacheDir: providerStatusCacheDir,
    managedBinaryToolsDir: path.join(baseDir, "tools"),
    registerTerminalProcesses: portDiscovery.registerTerminalProcesses,
    unregisterTerminal: portDiscovery.unregisterTerminal,
    resolveProviderInstanceEnvironment,
  });
});

export const makeWithOptions = Effect.fn("TerminalManager.makeWithOptions")(function* (
  options: TerminalManagerOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const updateHold = yield* ServiceUpdateHold.optional;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  const logsDir = options.logsDir;
  const historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
  const historyByteLimit = options.historyByteLimit ?? DEFAULT_HISTORY_BYTE_LIMIT;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  // Terminals must inherit the user's full environment (minus the blocklist
  // applied in createTerminalSpawnEnv) — an allowlist here silently strips
  // things like PSModulePath, DISPLAY, proxies, and toolchain variables.
  // `options.env` is the test seam.
  const baseEnv = options.env ?? process.env;
  const shellResolver = options.shellResolver ?? (() => defaultShellResolver(platform, baseEnv));
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const sshAgentSocket = makeSshAgentSocketLookup({
    env: baseEnv,
    platform,
    socketExists: (socketPath) =>
      fileSystem.exists(socketPath).pipe(Effect.orElseSucceed(() => false)),
    launchctlGetenv:
      options.launchctlGetenvSshAuthSock ??
      launchctlGetenvSshAuthSock.pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      ),
    runFork: (effect) => {
      runFork(effect);
    },
  });
  const isDirectory = (candidate: string) =>
    fileSystem.stat(candidate).pipe(
      Effect.map((stats) => stats.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
  // A client that sends `fallbackCwd` accepts a nearby folder when the thread's
  // own one is gone (a removed worktree): the project root, then home. Elevated
  // runs never fall back to `$HOME` so a missing worktree/project cwd fails
  // instead of executing privileged commands in the user's home directory.
  const resolveLaunchCwd = <
    Input extends TerminalOpenInput | TerminalAttachInput | TerminalRestartInput,
  >(
    input: Input,
  ): Effect.Effect<Input> =>
    Effect.gen(function* () {
      const elevated = "elevation" in input && input.elevation !== undefined;
      const stripStaleWorktree = (next: Input): Effect.Effect<Input> =>
        elevated && "worktreePath" in next && typeof next.worktreePath === "string"
          ? isDirectory(next.worktreePath).pipe(
              Effect.map((exists) => (exists ? next : { ...next, worktreePath: null })),
            )
          : Effect.succeed(next);
      const home = baseEnv.HOME?.trim() || NodeOS.homedir();
      // "~" asks for this machine's home folder (machine terminals opened from
      // another machine do not know its path).
      if (input.cwd === "~") return yield* stripStaleWorktree({ ...input, cwd: home });
      if (input.cwd === undefined || input.fallbackCwd === undefined) {
        return yield* stripStaleWorktree(input);
      }
      const candidates = elevated
        ? [input.cwd, input.fallbackCwd]
        : [input.cwd, input.fallbackCwd, home];
      for (const candidate of candidates) {
        if (yield* isDirectory(candidate)) {
          return yield* stripStaleWorktree(
            candidate === input.cwd ? input : { ...input, cwd: candidate },
          );
        }
      }
      return yield* stripStaleWorktree(input);
    });
  const resolveLaunchInputEnvironment = Effect.fn("terminal.resolveLaunchInputEnvironment")(
    function* <Input extends TerminalOpenInput | TerminalAttachInput | TerminalRestartInput>(
      input: Input,
    ): Effect.fn.Return<
      Input,
      TerminalProviderInstanceNotFoundError | TerminalProviderEnvironmentError
    > {
      const located = yield* resolveLaunchCwd(input);
      if (located.providerInstanceId === undefined) return located;
      const resolver = options.resolveProviderInstanceEnvironment;
      if (resolver === undefined) {
        return yield* new TerminalProviderInstanceNotFoundError({
          providerInstanceId: ProviderInstanceId.make(located.providerInstanceId),
        });
      }
      const env = yield* resolver(located.providerInstanceId, located.env);
      return { ...located, env };
    },
  );
  // One process-table snapshot per poll tick, shared across every terminal.
  // Per-terminal `pgrep`/`ps` calls multiply spawn load by terminal count and
  // can exhaust the PID space on hosts with many sessions (#6332).
  const fallbackProcessTableSnapshot = (
    platform === "win32"
      ? windowsProcessTableSnapshot()
      : posixProcessTableSnapshot(yield* resolvePosixPsCommand())
  ).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner));
  const fetchProcessTableSnapshot: Effect.Effect<
    {
      readonly snapshot: TerminalProcessTableSnapshot;
      /**
       * False when the sidecar snapshot failed and this table came from the
       * spawned fallback. The data is still applied, but the tick counts as
       * a failure so polling backs off instead of hot-looping the fallback.
       */
      readonly snapshotSucceeded: boolean;
    },
    TerminalSubprocessCheckError
  > = options.processTable
    ? options.processTable.pipe(
        Effect.map((entries) => ({
          snapshot: processTableSnapshotFromProcesses(entries),
          snapshotSucceeded: true,
        })),
        Effect.catch(() =>
          fallbackProcessTableSnapshot.pipe(
            Effect.map((snapshot) => ({ snapshot, snapshotSucceeded: false })),
          ),
        ),
      )
    : fallbackProcessTableSnapshot.pipe(
        Effect.map((snapshot) => ({ snapshot, snapshotSucceeded: true })),
      );
  const customSubprocessInspector = options.subprocessInspector;
  const acquireSubprocessInspector: Effect.Effect<
    {
      readonly inspector: TerminalSubprocessInspector;
      readonly snapshotSucceeded: boolean;
    },
    TerminalSubprocessCheckError
  > =
    customSubprocessInspector !== undefined
      ? Effect.succeed({ inspector: customSubprocessInspector, snapshotSucceeded: true })
      : Effect.map(
          fetchProcessTableSnapshot,
          ({
            snapshot,
            snapshotSucceeded,
          }): {
            readonly inspector: TerminalSubprocessInspector;
            readonly snapshotSucceeded: boolean;
          } => ({
            inspector: (terminalPid) =>
              Effect.succeed(deriveSubprocessInspectResult(snapshot, terminalPid, platform)),
            snapshotSucceeded,
          }),
        );
  const subprocessPollIntervalMs =
    options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
  const processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
  const elevatedCleanupTimeoutMs =
    options.elevatedCleanupTimeoutMs ??
    Math.max(processKillGraceMs, (ELEVATION_CLEANUP_TIMEOUT_SECONDS + 3) * 1_000);
  const maxRetainedInactiveSessions =
    options.maxRetainedInactiveSessions ?? DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS;
  const registerTerminalProcesses = options.registerTerminalProcesses ?? (() => Effect.void);
  const unregisterTerminal = options.unregisterTerminal ?? (() => Effect.void);

  yield* fileSystem.makeDirectory(logsDir, { recursive: true }).pipe(Effect.orDie);

  const managerStateRef = yield* SynchronizedRef.make<TerminalManagerState>({
    disposed: false,
    sessions: new Map(),
    killFibers: new Map(),
  });
  const threadLocks = yield* KeyedLock.make<string>();
  const terminalEventListeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const workerScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));

  const publishEvent = (event: TerminalEvent) =>
    Effect.gen(function* () {
      for (const listener of terminalEventListeners) {
        yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
      }
    });

  const historyPath = (threadId: string, terminalId: string) => {
    const threadPart = toSafeThreadId(threadId);
    if (terminalId === DEFAULT_TERMINAL_ID) {
      return path.join(logsDir, `${threadPart}.log`);
    }
    return path.join(logsDir, `${threadPart}_${toSafeTerminalId(terminalId)}.log`);
  };

  const legacyHistoryPath = (threadId: string) =>
    path.join(logsDir, `${legacySafeThreadId(threadId)}.log`);

  const readManagerState = SynchronizedRef.get(managerStateRef);

  const modifyManagerState = <A>(
    f: (state: TerminalManagerState) => readonly [A, TerminalManagerState],
  ) => SynchronizedRef.modify(managerStateRef, f);

  const withThreadLock = <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => threadLocks.withLock(threadId, effect);

  const clearKillFiber = Effect.fn("terminal.clearKillFiber")(function* (
    process: PtyAdapter.PtyProcess | null,
  ) {
    if (!process) return;
    const fiber: Option.Option<Fiber.Fiber<void, never>> = yield* modifyManagerState<
      Option.Option<Fiber.Fiber<void, never>>
    >((state) => {
      const existing: Option.Option<Fiber.Fiber<void, never>> = Option.fromNullishOr(
        state.killFibers.get(process),
      );
      if (Option.isNone(existing)) {
        return [Option.none<Fiber.Fiber<void, never>>(), state] as const;
      }
      const killFibers = new Map(state.killFibers);
      killFibers.delete(process);
      return [existing, { ...state, killFibers }] as const;
    });
    if (Option.isSome(fiber)) {
      yield* Fiber.interrupt(fiber.value).pipe(Effect.ignore);
    }
  });

  const registerKillFiber = Effect.fn("terminal.registerKillFiber")(function* (
    process: PtyAdapter.PtyProcess,
    fiber: Fiber.Fiber<void, never>,
  ) {
    yield* modifyManagerState((state) => {
      // A fast exit can finish the fiber, and its cleanup, before this runs.
      if (fiber.pollUnsafe() !== undefined) {
        return [undefined, state] as const;
      }
      const killFibers = new Map(state.killFibers);
      killFibers.set(process, fiber);
      return [undefined, { ...state, killFibers }] as const;
    });
  });

  const runKillEscalation = Effect.fn("terminal.runKillEscalation")(function* (
    process: PtyAdapter.PtyProcess,
    threadId: string,
    terminalId: string,
    awaitPostSigkillExit = false,
  ): Effect.fn.Return<boolean> {
    // Listen before SIGTERM so an immediate exit is seen, and stop waiting as
    // soon as it comes: Windows shells often exit at once, and a fixed sleep
    // made every close wait the whole grace period.
    const exited = Deferred.makeUnsafe<void>();
    let hasExited = false;
    const unsubscribeExit = process.onExit(() => {
      hasExited = true;
      Deferred.doneUnsafe(exited, Effect.void);
    });
    return yield* Effect.gen(function* () {
      if (hasExited) {
        return true;
      }
      const terminated = yield* Effect.try({
        try: () => process.kill("SIGTERM"),
        catch: (cause) =>
          new TerminalProcessSignalError({
            cause,
            signal: "SIGTERM",
            terminalPid: process.pid,
          }),
      }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("failed to kill terminal process", {
            threadId,
            terminalId,
            signal: "SIGTERM",
            cause: error,
          }).pipe(Effect.as(false)),
        ),
      );
      if (!terminated) {
        return hasExited;
      }

      const exitedInGrace = yield* Deferred.await(exited).pipe(
        Effect.as(true),
        Effect.timeoutOrElse({
          duration: processKillGraceMs,
          orElse: () => Effect.succeed(false),
        }),
      );
      if (exitedInGrace) {
        return true;
      }

      const forceKilled = yield* Effect.try({
        try: () => process.kill("SIGKILL"),
        catch: (cause) =>
          new TerminalProcessSignalError({
            cause,
            signal: "SIGKILL",
            terminalPid: process.pid,
          }),
      }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("failed to force-kill terminal process", {
            threadId,
            terminalId,
            signal: "SIGKILL",
            cause: error,
          }).pipe(Effect.as(false)),
        ),
      );
      if (!forceKilled || !awaitPostSigkillExit) {
        return hasExited;
      }

      return yield* Deferred.await(exited).pipe(
        Effect.as(true),
        Effect.timeoutOrElse({
          duration: processKillGraceMs,
          orElse: () => Effect.succeed(false),
        }),
      );
      // Interruption skips a JS finally, so the listener is released here.
    }).pipe(Effect.ensuring(Effect.sync(unsubscribeExit)));
  });

  const startKillEscalation = Effect.fn("terminal.startKillEscalation")(function* (
    process: PtyAdapter.PtyProcess,
    threadId: string,
    terminalId: string,
  ) {
    const fiber = yield* runKillEscalation(process, threadId, terminalId).pipe(
      Effect.asVoid,
      Effect.ensuring(
        modifyManagerState((state) => {
          if (!state.killFibers.has(process)) {
            return [undefined, state] as const;
          }
          const killFibers = new Map(state.killFibers);
          killFibers.delete(process);
          return [undefined, { ...state, killFibers }] as const;
        }),
      ),
      Effect.forkIn(workerScope),
    );

    yield* registerKillFiber(process, fiber);
  });

  const persistWorker = yield* makeKeyedCoalescingWorker<
    string,
    PersistHistoryRequest,
    never,
    never
  >({
    merge: (current, next) => ({
      history: next.history,
      immediate: current.immediate || next.immediate,
    }),
    process: Effect.fn("terminal.persistHistoryWorker")(function* (sessionKey, request) {
      if (!request.immediate) {
        yield* Effect.sleep(DEFAULT_PERSIST_DEBOUNCE_MS);
      }

      const [threadId, terminalId] = sessionKey.split("\u0000");
      if (!threadId || !terminalId) {
        return;
      }

      yield* fileSystem
        .writeFileString(historyPath(threadId, terminalId), request.history.value())
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to persist terminal history", {
              threadId,
              terminalId,
              error,
            }),
          ),
        );
    }),
  });

  const queuePersist = Effect.fn("terminal.queuePersist")(function* (
    threadId: string,
    terminalId: string,
    history: BoundedTerminalHistory,
  ) {
    yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
      history,
      immediate: false,
    });
  });

  const flushPersist = Effect.fn("terminal.flushPersist")(function* (
    threadId: string,
    terminalId: string,
  ) {
    yield* persistWorker.drainKey(toSessionKey(threadId, terminalId));
  });

  const persistHistory = Effect.fn("terminal.persistHistory")(function* (
    threadId: string,
    terminalId: string,
    history: BoundedTerminalHistory,
  ) {
    yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
      history,
      immediate: true,
    });
    yield* flushPersist(threadId, terminalId);
  });

  const readHistoryTail = Effect.fn("terminal.readHistoryTail")(function* (filePath: string) {
    const file = yield* fileSystem.open(filePath, { flag: "r" });
    const info = yield* file.stat;
    const limit = BigInt(historyByteLimit);
    const offset = info.size > limit ? info.size - limit : 0n;
    yield* file.seek(offset, "start");
    const bytes = new Uint8Array(Number(info.size - offset));
    let length = 0;
    while (length < bytes.length) {
      const read = Number(yield* file.read(bytes.subarray(length)));
      if (read === 0) break;
      length += read;
    }
    let start = 0;
    if (offset > 0n) {
      // A tail read can start inside a UTF-8 code point. Skip its remaining bytes.
      while (start < length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
    }
    return {
      history: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(start, length)),
      truncated: offset > 0n,
    };
  });

  const readHistory = Effect.fn("terminal.readHistory")(function* (
    threadId: string,
    terminalId: string,
  ) {
    const nextPath = historyPath(threadId, terminalId);
    if (
      yield* fileSystem
        .exists(nextPath)
        .pipe(
          Effect.mapError(
            (cause) => new TerminalHistoryError({ operation: "read", threadId, terminalId, cause }),
          ),
        )
    ) {
      const { history: raw, truncated } = yield* readHistoryTail(nextPath).pipe(
        Effect.scoped,
        Effect.mapError(
          (cause) => new TerminalHistoryError({ operation: "read", threadId, terminalId, cause }),
        ),
      );
      const history = new BoundedTerminalHistory(historyLineLimit, raw, historyByteLimit);
      const capped = history.value();
      if (truncated || capped !== raw) {
        yield* fileSystem
          .writeFileString(nextPath, capped)
          .pipe(
            Effect.mapError(
              (cause) =>
                new TerminalHistoryError({ operation: "truncate", threadId, terminalId, cause }),
            ),
          );
      }
      return history;
    }

    if (terminalId !== DEFAULT_TERMINAL_ID) {
      return new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit);
    }

    const legacyPath = legacyHistoryPath(threadId);
    if (
      !(yield* fileSystem
        .exists(legacyPath)
        .pipe(
          Effect.mapError(
            (cause) =>
              new TerminalHistoryError({ operation: "migrate", threadId, terminalId, cause }),
          ),
        ))
    ) {
      return new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit);
    }

    const { history: raw } = yield* readHistoryTail(legacyPath).pipe(
      Effect.scoped,
      Effect.mapError(
        (cause) => new TerminalHistoryError({ operation: "migrate", threadId, terminalId, cause }),
      ),
    );
    const history = new BoundedTerminalHistory(historyLineLimit, raw, historyByteLimit);
    const capped = history.value();
    yield* fileSystem
      .writeFileString(nextPath, capped)
      .pipe(
        Effect.mapError(
          (cause) =>
            new TerminalHistoryError({ operation: "migrate", threadId, terminalId, cause }),
        ),
      );
    yield* fileSystem.remove(legacyPath, { force: true }).pipe(
      Effect.catch((cleanupError) =>
        Effect.logWarning("failed to remove legacy terminal history", {
          threadId,
          error: cleanupError,
        }),
      ),
    );
    return history;
  });

  const deleteHistory = Effect.fn("terminal.deleteHistory")(function* (
    threadId: string,
    terminalId: string,
  ) {
    yield* fileSystem.remove(historyPath(threadId, terminalId), { force: true }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to delete terminal history", {
          threadId,
          terminalId,
          error,
        }),
      ),
    );
    if (terminalId === DEFAULT_TERMINAL_ID) {
      yield* fileSystem.remove(legacyHistoryPath(threadId), { force: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to delete terminal history", {
            threadId,
            terminalId,
            error,
          }),
        ),
      );
    }
  });

  const deleteAllHistoryForThread = Effect.fn("terminal.deleteAllHistoryForThread")(function* (
    threadId: string,
  ) {
    const threadPrefix = `${toSafeThreadId(threadId)}_`;
    const entries = yield* fileSystem
      .readDirectory(logsDir, { recursive: false })
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    yield* Effect.forEach(
      entries.filter(
        (name) =>
          name === `${toSafeThreadId(threadId)}.log` ||
          name === `${legacySafeThreadId(threadId)}.log` ||
          name.startsWith(threadPrefix),
      ),
      (name) =>
        fileSystem.remove(path.join(logsDir, name), { force: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to delete terminal histories for thread", {
              threadId,
              error,
            }),
          ),
        ),
      { discard: true },
    );
  });

  const assertValidCwd = Effect.fn("terminal.assertValidCwd")(function* (cwd: string) {
    const stats = yield* fileSystem.stat(cwd).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? new TerminalCwdNotFoundError({ cwd })
            : new TerminalCwdStatError({ cwd, cause }),
      }),
    );
    if (stats.type !== "Directory") {
      return yield* new TerminalCwdNotDirectoryError({ cwd });
    }
  });

  const getSession = Effect.fn("terminal.getSession")(function* (
    threadId: string,
    terminalId: string,
  ): Effect.fn.Return<Option.Option<TerminalSessionState>> {
    return yield* Effect.map(readManagerState, (state) =>
      Option.fromNullishOr(state.sessions.get(toSessionKey(threadId, terminalId))),
    );
  });

  const requireSession = Effect.fn("terminal.requireSession")(function* (
    threadId: string,
    terminalId: string,
  ): Effect.fn.Return<TerminalSessionState, TerminalSessionLookupError> {
    return yield* Effect.flatMap(getSession(threadId, terminalId), (session) =>
      Effect.fromOption(session, () => new TerminalSessionLookupError({ threadId, terminalId })),
    );
  });

  const sessionsForThread = Effect.fn("terminal.sessionsForThread")(function* (threadId: string) {
    return yield* readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()].filter((session) => session.threadId === threadId),
      ),
    );
  });

  const pinnedSessionKeys = new Map<string, number>();
  const isInactiveSessionStatus = (status: TerminalSessionStatus): boolean =>
    status === "exited" || status === "error";

  const evictInactiveSessionsIfNeeded = Effect.fn("terminal.evictInactiveSessionsIfNeeded")(
    function* () {
      const snapshotState = yield* readManagerState;
      const inactiveAll = [...snapshotState.sessions.values()].filter(
        (session) =>
          isInactiveSessionStatus(session.status) &&
          !pinnedSessionKeys.has(toSessionKey(session.threadId, session.terminalId)),
      );
      const clearedRunDirs = new Map<string, string>();
      if (inactiveAll.length > maxRetainedInactiveSessions) {
        for (const session of inactiveAll) {
          const runDir = session.elevatedRunDir;
          if (runDir === null) continue;
          const exists = yield* fileSystem.exists(runDir).pipe(Effect.orElseSucceed(() => true));
          if (!exists) {
            clearedRunDirs.set(toSessionKey(session.threadId, session.terminalId), runDir);
          }
        }
      }

      yield* modifyManagerState((state) => {
        for (const [key, runDir] of clearedRunDirs) {
          if (pinnedSessionKeys.has(key)) continue;
          const session = state.sessions.get(key);
          if (
            session &&
            isInactiveSessionStatus(session.status) &&
            session.elevatedRunDir === runDir
          ) {
            session.elevatedRunDir = null;
          }
        }

        const inactiveSessions = [...state.sessions.values()].filter((session) => {
          const key = toSessionKey(session.threadId, session.terminalId);
          return (
            isInactiveSessionStatus(session.status) &&
            !pinnedSessionKeys.has(key) &&
            session.elevatedRunDir === null
          );
        });
        if (inactiveSessions.length <= maxRetainedInactiveSessions) {
          return [undefined, state] as const;
        }

        inactiveSessions.sort(
          (left, right) =>
            left.updatedAt.localeCompare(right.updatedAt) ||
            left.threadId.localeCompare(right.threadId) ||
            left.terminalId.localeCompare(right.terminalId),
        );

        const sessions = new Map(state.sessions);

        const toEvict = inactiveSessions.length - maxRetainedInactiveSessions;
        for (const session of inactiveSessions.slice(0, toEvict)) {
          const key = toSessionKey(session.threadId, session.terminalId);
          sessions.delete(key);
        }

        return [undefined, { ...state, sessions }] as const;
      });
    },
  );

  const withPinnedSessionKey = <A, E, R>(
    sessionKey: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        pinnedSessionKeys.set(sessionKey, (pinnedSessionKeys.get(sessionKey) ?? 0) + 1);
      }),
      () => effect,
      () =>
        Effect.gen(function* () {
          const releasedLastPin = yield* Effect.sync(() => {
            const next = (pinnedSessionKeys.get(sessionKey) ?? 0) - 1;
            if (next <= 0) {
              pinnedSessionKeys.delete(sessionKey);
              return true;
            }
            pinnedSessionKeys.set(sessionKey, next);
            return false;
          });
          if (!releasedLastPin) {
            return;
          }
          const shouldEvict = yield* readManagerState.pipe(
            Effect.map((state) => {
              if (state.disposed) return false;
              const session = state.sessions.get(sessionKey);
              return session !== undefined && isInactiveSessionStatus(session.status);
            }),
          );
          if (shouldEvict) {
            yield* evictInactiveSessionsIfNeeded();
          }
        }),
    );

  const drainProcessEvents = Effect.fn("terminal.drainProcessEvents")(function* (
    session: TerminalSessionState,
    expectedPid: number,
  ) {
    while (true) {
      const action: DrainProcessEventAction = yield* Effect.sync(() => {
        if (session.pid !== expectedPid || !session.process || session.status !== "running") {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return { type: "idle" } as const;
        }

        const nextEvent = session.pendingProcessEvents[session.pendingProcessEventIndex];
        if (!nextEvent) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return { type: "idle" } as const;
        }

        session.pendingProcessEventIndex += 1;
        if (session.pendingProcessEventIndex >= session.pendingProcessEvents.length) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
        }

        if (nextEvent.type === "output") {
          const filtered = filterElevationOscChunk(
            session.pendingElevationControlSequence,
            nextEvent.data,
            session.elevationNonce,
            session.elevationState,
          );
          session.pendingElevationControlSequence = filtered.pendingSequence;
          session.elevationState = filtered.elevationState;
          if (filtered.output.length === 0) {
            return { type: "skip" } as const;
          }
          const sanitized = sanitizeTerminalHistoryChunk(
            session.pendingHistoryControlSequence,
            filtered.output,
          );
          session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
          if (sanitized.visibleText.length > 0) {
            session.history.append(sanitized.visibleText);
          }
          const eventStamp = advanceEventSequence(session);

          return {
            type: "output",
            threadId: session.threadId,
            terminalId: session.terminalId,
            sequence: eventStamp.sequence,
            history: sanitized.visibleText.length > 0 ? session.history : null,
            data: filtered.output,
          } as const;
        }

        const process = session.process;
        const stagedPreHandoff = takeTerminalAppPreHandoff(session);
        cleanupProcessHandles(session);
        session.process = null;
        session.pid = null;
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        session.status = "exited";
        session.pendingHistoryControlSequence = "";
        session.pendingElevationControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        session.exitCode = Number.isInteger(nextEvent.event.exitCode)
          ? nextEvent.event.exitCode
          : null;
        session.exitSignal = Number.isInteger(nextEvent.event.signal)
          ? nextEvent.event.signal
          : null;
        const eventStamp = advanceEventSequence(session);

        return {
          type: "exit",
          process,
          stagedPreHandoff,
          threadId: session.threadId,
          terminalId: session.terminalId,
          sequence: eventStamp.sequence,
          exitCode: session.exitCode,
          exitSignal: session.exitSignal,
        } as const;
      });

      if (action.type === "idle") {
        return;
      }

      if (action.type === "skip") {
        continue;
      }

      if (action.type === "output") {
        if (action.history !== null) {
          yield* queuePersist(action.threadId, action.terminalId, action.history);
        }

        yield* publishEvent({
          type: "output",
          threadId: action.threadId,
          terminalId: action.terminalId,
          sequence: action.sequence,
          data: action.data,
        });
        continue;
      }

      yield* clearKillFiber(action.process);
      yield* runTerminalAppPreHandoffCleanupIfUnstarted(action.stagedPreHandoff);
      yield* unregisterTerminal({
        threadId: action.threadId,
        terminalId: action.terminalId,
      });
      yield* publishEvent({
        type: "exited",
        threadId: action.threadId,
        terminalId: action.terminalId,
        sequence: action.sequence,
        exitCode: action.exitCode,
        exitSignal: action.exitSignal,
      });
      yield* evictInactiveSessionsIfNeeded();
      return;
    }
  });

  const stopProcess = Effect.fn("terminal.stopProcess")(function* (session: TerminalSessionState) {
    const process = session.process;
    if (!process) return;

    const updatedAt = yield* nowIso;
    yield* modifyManagerState((state) => {
      cleanupProcessHandles(session);
      session.process = null;
      session.pid = null;
      session.hasRunningSubprocess = false;
      session.childCommandLabel = null;
      session.status = "exited";
      session.pendingHistoryControlSequence = "";
      session.pendingElevationControlSequence = "";
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
      session.updatedAt = updatedAt;
      return [undefined, state] as const;
    });

    yield* clearKillFiber(process);
    yield* unregisterTerminal({
      threadId: session.threadId,
      terminalId: session.terminalId,
    });
    yield* startKillEscalation(process, session.threadId, session.terminalId);
    yield* evictInactiveSessionsIfNeeded();
  });

  const awaitElevatedCleanup = Effect.fn("terminal.awaitElevatedCleanup")(function* (
    runDir: string,
  ): Effect.fn.Return<boolean> {
    const dirExists = yield* fileSystem.exists(runDir).pipe(Effect.orElseSucceed(() => true));
    if (!dirExists) {
      return true;
    }
    const cleanupFailed = yield* fileSystem
      .exists(path.join(runDir, "cleanup-failed"))
      .pipe(Effect.orElseSucceed(() => false));
    if (cleanupFailed) {
      return false;
    }
    const startedExists = yield* fileSystem
      .exists(path.join(runDir, "started"))
      .pipe(Effect.orElseSucceed(() => true));
    const needDropExists = yield* fileSystem
      .exists(path.join(runDir, "need-drop"))
      .pipe(Effect.orElseSucceed(() => true));
    if (!startedExists && !needDropExists) {
      // Wrapper never wrote `$dir/started` before the PTY exited (or test FakePty);
      // no elevated helper/ticket could have been created yet, so remove directly.
      yield* fileSystem.remove(runDir, { recursive: true, force: true }).pipe(Effect.ignore);
      return !(yield* fileSystem.exists(runDir).pipe(Effect.orElseSucceed(() => true)));
    }
    const deadlineMs = (yield* Clock.currentTimeMillis) + elevatedCleanupTimeoutMs;
    while (true) {
      const stillExists = yield* fileSystem.exists(runDir).pipe(Effect.orElseSucceed(() => true));
      if (!stillExists) {
        return true;
      }
      const failed = yield* fileSystem
        .exists(path.join(runDir, "cleanup-failed"))
        .pipe(Effect.orElseSucceed(() => false));
      if (failed) {
        return false;
      }
      const remainingMs = deadlineMs - (yield* Clock.currentTimeMillis);
      if (remainingMs <= 0) {
        return false;
      }
      yield* Effect.sleep(Math.min(25, remainingMs));
    }
  });

  const takeTerminalAppPreHandoff = (
    session: TerminalSessionState,
    expectedHandoffMarker?: string | null,
  ): StagedTerminalAppPreHandoff | null => {
    const handoffMarker = session.elevatedHandoffMarker;
    const cleanup = session.cleanupStagedPreHandoff;
    if (handoffMarker === null || cleanup === null) {
      return null;
    }
    if (expectedHandoffMarker !== undefined && handoffMarker !== expectedHandoffMarker) {
      return null;
    }
    session.elevatedHandoffMarker = null;
    session.cleanupStagedPreHandoff = null;
    return { handoffMarker, cleanup };
  };

  const runTerminalAppPreHandoffCleanupIfUnstarted = Effect.fn(
    "terminal.runTerminalAppPreHandoffCleanupIfUnstarted",
  )(function* (staged: StagedTerminalAppPreHandoff | null) {
    if (staged === null) {
      return;
    }
    const handoffStarted = yield* fileSystem
      .exists(staged.handoffMarker)
      .pipe(Effect.orElseSucceed(() => true));
    if (!handoffStarted) {
      yield* staged.cleanup;
    }
  });

  const cleanupTerminalAppPreHandoffIfUnstarted = Effect.fn(
    "terminal.cleanupTerminalAppPreHandoffIfUnstarted",
  )(function* (session: TerminalSessionState, expectedHandoffMarker?: string | null) {
    const staged = yield* modifyManagerState(
      (state) => [takeTerminalAppPreHandoff(session, expectedHandoffMarker), state] as const,
    );
    yield* runTerminalAppPreHandoffCleanupIfUnstarted(staged);
  });

  const stopProcessAndAwaitExit = Effect.fn("terminal.stopProcessAndAwaitExit")(function* (
    session: TerminalSessionState,
  ): Effect.fn.Return<boolean> {
    const process = session.process;
    const expectedHandoffMarker = session.elevatedHandoffMarker;
    if (process !== null) {
      yield* clearKillFiber(process);
      const exited = yield* runKillEscalation(process, session.threadId, session.terminalId, true);
      if (!exited) {
        return false;
      }
    }

    yield* cleanupTerminalAppPreHandoffIfUnstarted(session, expectedHandoffMarker);

    const elevatedRunDir = session.elevatedRunDir;
    if (elevatedRunDir !== null) {
      const cleaned = yield* awaitElevatedCleanup(elevatedRunDir);
      if (!cleaned) {
        if (process !== null) {
          const updatedAt = yield* nowIso;
          yield* modifyManagerState((state) => {
            if (session.process === process) {
              cleanupProcessHandles(session);
              session.process = null;
              session.pid = null;
              session.hasRunningSubprocess = false;
              session.childCommandLabel = null;
              session.status = "exited";
              session.pendingHistoryControlSequence = "";
              session.pendingElevationControlSequence = "";
              session.pendingProcessEvents = [];
              session.pendingProcessEventIndex = 0;
              session.processEventDrainRunning = false;
              session.updatedAt = updatedAt;
            }
            return [undefined, state] as const;
          });
        }
        return false;
      }
    }

    const updatedAt = yield* nowIso;
    yield* modifyManagerState((state) => {
      if (process !== null && session.process === process) {
        cleanupProcessHandles(session);
        session.process = null;
        session.pid = null;
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        session.status = "exited";
        session.pendingHistoryControlSequence = "";
        session.pendingElevationControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        session.updatedAt = updatedAt;
      }
      if (elevatedRunDir !== null && session.elevatedRunDir === elevatedRunDir) {
        session.elevatedRunDir = null;
      }
      return [undefined, state] as const;
    });

    if (process !== null) {
      yield* unregisterTerminal({
        threadId: session.threadId,
        terminalId: session.terminalId,
      });
      yield* evictInactiveSessionsIfNeeded();
    }
    return true;
  });

  const trySpawn = Effect.fn("terminal.trySpawn")(function* (
    shellCandidates: ReadonlyArray<ShellCandidate>,
    spawnEnv: NodeJS.ProcessEnv,
    session: TerminalSessionState,
    index = 0,
    lastError: PtyAdapter.PtySpawnError | null = null,
  ): Effect.fn.Return<
    { process: PtyAdapter.PtyProcess; shellLabel: string },
    PtyAdapter.PtySpawnError
  > {
    if (index >= shellCandidates.length) {
      return yield* new PtyAdapter.PtySpawnError({
        adapter: "terminal-manager",
        attemptedShells: shellCandidates.map((candidate) => formatShellCandidate(candidate)),
        ...(lastError ? { cause: lastError } : {}),
      });
    }

    const candidate = shellCandidates[index];
    if (!candidate) {
      return yield* (
        lastError ??
          new PtyAdapter.PtySpawnError({
            adapter: "terminal-manager",
            attemptedShells: [],
          })
      );
    }

    const args = shellCandidateArgs(candidate, session.command, platform);
    const attempt = yield* Effect.result(
      options.ptyAdapter.spawn({
        shell: candidate.shell,
        ...(args ? { args } : {}),
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        env:
          platform === "win32" || spawnEnv.SHELL
            ? spawnEnv
            : { ...spawnEnv, SHELL: candidate.shell },
      }),
    );

    if (attempt._tag === "Success") {
      return {
        process: attempt.success,
        shellLabel: formatShellCandidate(candidate),
      };
    }

    const spawnError = attempt.failure;
    if (!isRetryableShellSpawnError(spawnError)) {
      return yield* spawnError;
    }

    return yield* trySpawn(shellCandidates, spawnEnv, session, index + 1, spawnError);
  });

  const startSession = Effect.fn("terminal.startSession")(function* (
    session: TerminalSessionState,
    input: TerminalStartInput,
    eventType: "started" | "restarted",
    onSpawned?: () => void,
    stagedElevatedRunDir: string | null = null,
    stagedHandoffMarker: string | null = null,
    cleanupStagedPreHandoff: Effect.Effect<void> = Effect.void,
  ) {
    yield* stopProcess(session);
    yield* Effect.annotateCurrentSpan({
      "terminal.thread_id": session.threadId,
      "terminal.id": session.terminalId,
      "terminal.event_type": eventType,
      "terminal.cwd": input.cwd,
    });

    const startingAt = yield* nowIso;
    yield* modifyManagerState((state) => {
      session.status = "starting";
      session.cwd = input.cwd;
      session.worktreePath = input.worktreePath ?? null;
      session.cols = input.cols;
      session.rows = input.rows;
      session.exitCode = null;
      session.exitSignal = null;
      session.hasRunningSubprocess = false;
      session.childCommandLabel = null;
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
      session.updatedAt = startingAt;
      return [undefined, state] as const;
    });

    let ptyProcess: PtyAdapter.PtyProcess | null = null;
    let startedShell: string | null = null;

    const startResult = yield* Effect.result(
      increment(terminalSessionsTotal, { lifecycle: eventType }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const isElevatedPosixWrapper = session.elevationMode !== null && platform !== "win32";
            const resolvedShellCandidates = resolveShellCandidates(
              shellResolver,
              platform,
              baseEnv,
            );
            // Elevated wrappers spawn via `/bin/sh -c` directly so user login
            // shell rc files (`.zshenv`, `.zshrc`, `.bash_profile`, etc.) cannot
            // intercept or influence the privileged auth step before `run.sh`
            // runs. `run.sh` still hands the final command block to `$SHELL`.
            const shellCandidates: ReadonlyArray<ShellCandidate> = isElevatedPosixWrapper
              ? [{ shell: "/bin/sh" }]
              : resolvedShellCandidates;
            // After the runtime env, so GitHub access set there wins.
            const terminalEnv = withGitHubSpawnEnvironment(
              createTerminalSpawnEnv(baseEnv, session.runtimeEnv, platform),
            );
            if (isElevatedPosixWrapper) {
              delete terminalEnv.ENV;
              delete terminalEnv.BASH_ENV;
              delete terminalEnv.ZDOTDIR;
              if (!terminalEnv.SHELL?.trim()) {
                const accountShell = resolvedShellCandidates[0]?.shell;
                if (accountShell) {
                  terminalEnv.SHELL = accountShell;
                }
              }
            }
            // A launchd-started server has no SSH_AUTH_SOCK of its own; give
            // the shell the user's agent unless the runtime env chose one.
            if (session.runtimeEnv?.SSH_AUTH_SOCK === undefined) {
              const agentSocket = yield* sshAgentSocket.current;
              if (agentSocket !== undefined) terminalEnv.SSH_AUTH_SOCK = agentSocket;
            }
            // Append (never prepend) managed ACP agent install directories so
            // `kimi login` and friends resolve by name without shadowing any
            // system or user tool of the same name.
            if (
              options.managedBinaryCacheDir !== undefined &&
              options.managedBinaryToolsDir !== undefined
            ) {
              const managedDirectories = yield* acpRegistryManagedBinaryDirectories({
                fileSystem,
                path,
                cacheDir: options.managedBinaryCacheDir,
                toolsDir: options.managedBinaryToolsDir,
                platform,
                architecture,
              });
              if (managedDirectories.length > 0) {
                const delimiter = platform === "win32" ? ";" : ":";
                const pathKey =
                  platform === "win32"
                    ? (Object.keys(terminalEnv).find(
                        (candidate) => candidate.toLowerCase() === "path",
                      ) ?? "PATH")
                    : "PATH";
                const merged = mergePathEntries(
                  terminalEnv[pathKey],
                  managedDirectories.join(delimiter),
                  platform,
                );
                if (merged !== undefined) {
                  terminalEnv[pathKey] = merged;
                }
              }
            }
            // Keep spawn, session registration, and onSpawned() ownership handoff
            // atomic with respect to fiber interruption so a spawned PTY can never
            // be orphaned outside session tracking.
            yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const sessionStillLive = yield* readManagerState.pipe(
                  Effect.map(
                    (state) =>
                      !state.disposed &&
                      state.sessions.get(toSessionKey(session.threadId, session.terminalId)) ===
                        session,
                  ),
                );
                if (!sessionStillLive) {
                  return yield* new TerminalNotRunningError({
                    threadId: session.threadId,
                    terminalId: session.terminalId,
                  });
                }
                const spawnResult = yield* trySpawn(shellCandidates, terminalEnv, session, 0, null);
                ptyProcess = spawnResult.process;
                startedShell = spawnResult.shellLabel;

                const processPid = ptyProcess.pid;
                let eventsActivated = false;

                let eventStamp: ReturnType<typeof advanceEventSequence> = {
                  updatedAt: session.updatedAt,
                  sequence: session.eventSequence,
                };
                const registered = yield* modifyManagerState((state) => {
                  const sessionKey = toSessionKey(session.threadId, session.terminalId);
                  if (state.disposed || state.sessions.get(sessionKey) !== session) {
                    return [false, state] as const;
                  }
                  session.process = ptyProcess;
                  session.pid = processPid;
                  session.lastPid = processPid;
                  session.status = "running";
                  // Attach elevatedRunDir and staged Terminal.app pre-handoff tracking before
                  // subscribing onExit, so an immediate exit cannot race past cleanup guards.
                  session.elevatedRunDir = stagedElevatedRunDir;
                  session.elevatedHandoffMarker = stagedHandoffMarker;
                  session.cleanupStagedPreHandoff =
                    stagedHandoffMarker !== null ? cleanupStagedPreHandoff : null;
                  onSpawned?.();
                  // onExit may replay an exit immediately; accept it before subscribing.
                  session.unsubscribeData = spawnResult.process.onData((data) => {
                    if (!enqueueProcessEvent(session, processPid, { type: "output", data })) {
                      return;
                    }
                    if (eventsActivated) runFork(drainProcessEvents(session, processPid));
                  });
                  session.unsubscribeExit = spawnResult.process.onExit((event) => {
                    if (!enqueueProcessEvent(session, processPid, { type: "exit", event })) {
                      return;
                    }
                    if (eventsActivated) runFork(drainProcessEvents(session, processPid));
                  });
                  eventStamp = advanceEventSequence(session);
                  return [true, state] as const;
                });

                if (!registered) {
                  // Manager was disposed or this session was removed while spawn was in flight.
                  // Stop the newly spawned PTY inline (workerScope may already be closed), await
                  // confirmed exit, and coordinate elevated staging cleanup before failing so
                  // open()'s finalizer cannot race a started wrapper, its SIGKILL watcher, or a
                  // pending Terminal.app handoff.
                  const orphanedProcess = ptyProcess;
                  ptyProcess = null;
                  if (
                    stagedElevatedRunDir !== null ||
                    stagedHandoffMarker !== null ||
                    session.elevationMode === "terminal-app"
                  ) {
                    onSpawned?.();
                  }
                  const exited = yield* runKillEscalation(
                    orphanedProcess,
                    session.threadId,
                    session.terminalId,
                    true,
                  );
                  if (stagedElevatedRunDir !== null && exited) {
                    yield* awaitElevatedCleanup(stagedElevatedRunDir);
                  } else if (stagedHandoffMarker !== null && exited) {
                    const handoffStarted = yield* fileSystem
                      .exists(stagedHandoffMarker)
                      .pipe(Effect.orElseSucceed(() => true));
                    if (!handoffStarted) {
                      yield* cleanupStagedPreHandoff;
                    }
                  }
                  return yield* new TerminalNotRunningError({
                    threadId: session.threadId,
                    terminalId: session.terminalId,
                  });
                }

                // Publish startup before draining any events replayed during subscription,
                // and still activate draining if publication is interrupted.
                yield* restore(
                  publishEvent({
                    type: eventType,
                    threadId: session.threadId,
                    terminalId: session.terminalId,
                    sequence: eventStamp.sequence,
                    snapshot: snapshot(session),
                  }),
                ).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      eventsActivated = true;
                      if (session.processEventDrainRunning) {
                        runFork(drainProcessEvents(session, processPid));
                      }
                    }),
                  ),
                );
              }),
            );
          }),
        ),
      ),
    );

    if (startResult._tag === "Success") {
      return;
    }

    {
      const error = startResult.failure;
      if (error._tag === "TerminalNotRunningError") {
        yield* modifyManagerState((state) => {
          cleanupProcessHandles(session);
          session.status = "error";
          session.pid = null;
          session.process = null;
          session.hasRunningSubprocess = false;
          session.childCommandLabel = null;
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          advanceEventSequence(session);
          return [undefined, state] as const;
        });
        yield* unregisterTerminal({
          threadId: session.threadId,
          terminalId: session.terminalId,
        });
        return yield* error;
      }

      if (ptyProcess) {
        if (stagedHandoffMarker !== null && session.elevatedHandoffMarker === stagedHandoffMarker) {
          const exited = yield* runKillEscalation(
            ptyProcess,
            session.threadId,
            session.terminalId,
            true,
          );
          if (exited) {
            yield* cleanupTerminalAppPreHandoffIfUnstarted(session, stagedHandoffMarker);
          }
        } else {
          yield* startKillEscalation(ptyProcess, session.threadId, session.terminalId);
        }
      }

      yield* modifyManagerState((state) => {
        cleanupProcessHandles(session);
        session.status = "error";
        session.pid = null;
        session.process = null;
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        advanceEventSequence(session);
        return [undefined, state] as const;
      });
      yield* unregisterTerminal({
        threadId: session.threadId,
        terminalId: session.terminalId,
      });

      yield* evictInactiveSessionsIfNeeded();

      const message = error.message;
      yield* publishEvent({
        type: "error",
        threadId: session.threadId,
        terminalId: session.terminalId,
        sequence: session.eventSequence,
        message,
      });
      yield* Effect.logError("failed to start terminal", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        cause: error,
        ...(startedShell ? { shell: startedShell } : {}),
      });
    }
  });

  /**
   * Register the entire spawn-capable operation before taking the thread lock.
   * A hold waits for admitted shells to register; later opens wait outside the
   * lock so an explicit drain can still close terminals. Retrying admission is
   * atomic with hold acquisition, unlike checking isHeld before the operation.
   */
  const withSpawnAdmission = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    updateHold.admit("terminal.spawn", effect).pipe(
      Effect.catchTags({
        ServiceUpdateInProgressError: () =>
          updateHold.awaitReleased.pipe(
            Effect.andThen(Effect.suspend(() => withSpawnAdmission(effect))),
          ),
      }),
    );

  const closeSession = Effect.fn("terminal.closeSession")(function* (
    threadId: string,
    terminalId: string,
    deleteHistoryOnClose: boolean,
  ) {
    const key = toSessionKey(threadId, terminalId);
    const session = yield* getSession(threadId, terminalId);
    const closedEventSequence = Option.isSome(session) ? session.value.eventSequence + 1 : 0;

    if (Option.isSome(session)) {
      const existingSession = session.value;
      if (existingSession.elevationMode !== null || existingSession.elevatedRunDir !== null) {
        const priorPid = existingSession.process?.pid ?? existingSession.lastPid ?? 0;
        const stopped = yield* stopProcessAndAwaitExit(existingSession);
        if (!stopped) {
          return yield* new TerminalStopError({
            threadId,
            terminalId,
            terminalPid: priorPid,
          });
        }
      } else {
        yield* stopProcess(existingSession);
      }
      yield* unregisterTerminal({ threadId, terminalId });
      yield* persistHistory(threadId, terminalId, existingSession.history);
    }

    yield* flushPersist(threadId, terminalId);

    const removed = yield* modifyManagerState((state) => {
      if (!state.sessions.has(key)) {
        return [false, state] as const;
      }
      const sessions = new Map(state.sessions);
      sessions.delete(key);
      return [true, { ...state, sessions }] as const;
    });

    if (removed) {
      yield* publishEvent({
        type: "closed",
        threadId,
        terminalId,
        sequence: closedEventSequence,
      });
    }

    if (deleteHistoryOnClose) {
      yield* deleteHistory(threadId, terminalId);
    }
  });

  const pollSubprocessActivity = Effect.fn("terminal.pollSubprocessActivity")(function* () {
    const state = yield* readManagerState;
    const runningSessions = [...state.sessions.values()].filter(
      (session): session is TerminalSessionState & { pid: number } =>
        session.status === "running" && Number.isInteger(session.pid),
    );

    if (runningSessions.length === 0) {
      return true;
    }

    const inspectorOption = yield* acquireSubprocessInspector.pipe(
      Effect.asSome,
      Effect.catch((reason) =>
        Effect.logWarning("failed to snapshot processes for terminal subprocess polling", {
          reason,
        }).pipe(
          Effect.as(
            Option.none<{
              readonly inspector: TerminalSubprocessInspector;
              readonly snapshotSucceeded: boolean;
            }>(),
          ),
        ),
      ),
    );

    if (Option.isNone(inspectorOption)) {
      return false;
    }

    const { inspector: subprocessInspector, snapshotSucceeded } = inspectorOption.value;

    const checkSubprocessActivity = Effect.fn("terminal.checkSubprocessActivity")(function* (
      session: TerminalSessionState & { pid: number },
    ) {
      const terminalPid = session.pid;
      const inspectResult = yield* subprocessInspector(terminalPid).pipe(
        Effect.asSome,
        Effect.catch((reason) =>
          Effect.logWarning("failed to check terminal subprocess activity", {
            threadId: session.threadId,
            terminalId: session.terminalId,
            terminalPid,
            reason,
          }).pipe(Effect.as(Option.none<TerminalSubprocessInspectResult>())),
        ),
      );

      if (Option.isNone(inspectResult)) {
        return;
      }

      const next = inspectResult.value;
      yield* registerTerminalProcesses({
        threadId: session.threadId,
        terminalId: session.terminalId,
        processIds: next.processIds,
      });
      const nextChildLabel = next.hasRunningSubprocess ? next.childCommand : null;
      const event = yield* modifyManagerState((state) => {
        const liveSession: Option.Option<TerminalSessionState> = Option.fromNullishOr(
          state.sessions.get(toSessionKey(session.threadId, session.terminalId)),
        );
        if (
          Option.isNone(liveSession) ||
          liveSession.value.status !== "running" ||
          liveSession.value.pid !== terminalPid ||
          (liveSession.value.hasRunningSubprocess === next.hasRunningSubprocess &&
            liveSession.value.childCommandLabel === nextChildLabel)
        ) {
          return [Option.none(), state] as const;
        }

        liveSession.value.hasRunningSubprocess = next.hasRunningSubprocess;
        liveSession.value.childCommandLabel = nextChildLabel;
        const eventStamp = advanceEventSequence(liveSession.value);

        return [
          Option.some({
            type: "activity" as const,
            threadId: liveSession.value.threadId,
            terminalId: liveSession.value.terminalId,
            sequence: eventStamp.sequence,
            hasRunningSubprocess: next.hasRunningSubprocess,
            label: terminalWireLabel(liveSession.value),
          }),
          state,
        ] as const;
      });

      if (Option.isSome(event)) {
        yield* publishEvent(event.value);
      }
    });

    yield* Effect.forEach(runningSessions, checkSubprocessActivity, {
      concurrency: "unbounded",
      discard: true,
    });
    return snapshotSucceeded;
  });

  const hasRunningSessions = readManagerState.pipe(
    Effect.map((state) =>
      [...state.sessions.values()].some((session) => session.status === "running"),
    ),
  );

  let subprocessSnapshotFailureCount = 0;
  yield* Effect.forever(
    hasRunningSessions.pipe(
      Effect.flatMap((active) =>
        active
          ? pollSubprocessActivity().pipe(
              Effect.flatMap((snapshotSucceeded) => {
                subprocessSnapshotFailureCount = snapshotSucceeded
                  ? 0
                  : Math.min(subprocessSnapshotFailureCount + 1, 30);
                const delayMs = subprocessSnapshotPollDelayMs(
                  subprocessPollIntervalMs,
                  subprocessSnapshotFailureCount,
                );
                return Effect.sleep(delayMs);
              }),
            )
          : Effect.sync(() => {
              subprocessSnapshotFailureCount = 0;
            }).pipe(Effect.flatMap(() => Effect.sleep(subprocessPollIntervalMs))),
      ),
    ),
  ).pipe(Effect.forkIn(workerScope));

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const sessions = yield* modifyManagerState(
        (state) =>
          [
            [...state.sessions.values()],
            {
              ...state,
              disposed: true,
              sessions: new Map(),
            },
          ] as const,
      );

      const cleanupSession = Effect.fn("terminal.cleanupSession")(function* (
        session: TerminalSessionState,
      ) {
        cleanupProcessHandles(session);
        if (!session.process) {
          if (session.status === "exited") {
            yield* cleanupTerminalAppPreHandoffIfUnstarted(session);
          }
          return;
        }
        yield* clearKillFiber(session.process);
        const hasPendingPreHandoffCleanup =
          session.elevatedHandoffMarker !== null && session.cleanupStagedPreHandoff !== null;
        const exited = yield* runKillEscalation(
          session.process,
          session.threadId,
          session.terminalId,
          hasPendingPreHandoffCleanup,
        );
        if (exited && hasPendingPreHandoffCleanup) {
          yield* cleanupTerminalAppPreHandoffIfUnstarted(session);
        }
      });

      yield* Effect.forEach(sessions, cleanupSession, {
        concurrency: "unbounded",
        discard: true,
      });
    }).pipe(Effect.ignoreCause({ log: true })),
  );

  const openWithWorkspaceLeasePinned = Effect.fn("terminal.openLocked")(function* (
    input: TerminalOpenInput,
    onSpawned?: () => void,
    elevatedCommand: string | null = null,
    elevationMode: "prompt" | "terminal-app" | null = null,
    elevationNonce: string | null = null,
    elevatedRunDir: string | null = null,
    elevatedHandoffMarker: string | null = null,
    cleanupStagedPreHandoff: Effect.Effect<void> = Effect.void,
  ) {
    const terminalId = input.terminalId;
    yield* assertValidCwd(input.cwd);

    const sessionKey = toSessionKey(input.threadId, terminalId);
    const existing = yield* getSession(input.threadId, terminalId);
    if (Option.isNone(existing)) {
      yield* flushPersist(input.threadId, terminalId);
      const history = yield* readHistory(input.threadId, terminalId);
      const cols = input.cols ?? DEFAULT_OPEN_COLS;
      const rows = input.rows ?? DEFAULT_OPEN_ROWS;
      const session: TerminalSessionState = {
        threadId: input.threadId,
        terminalId,
        cwd: input.cwd,
        worktreePath: input.worktreePath ?? null,
        status: "starting",
        pid: null,
        lastPid: null,
        history,
        pendingHistoryControlSequence: "",
        pendingElevationControlSequence: "",
        pendingProcessEvents: [],
        pendingProcessEventIndex: 0,
        processEventDrainRunning: false,
        exitCode: null,
        exitSignal: null,
        updatedAt: yield* nowIso,
        eventSequence: 0,
        inputCount: 0,
        cols,
        rows,
        process: null,
        unsubscribeData: null,
        unsubscribeExit: null,
        hasRunningSubprocess: false,
        childCommandLabel: null,
        runtimeEnv: normalizedRuntimeEnv(input.env),
        command: input.command ?? null,
        elevatedCommand,
        elevationMode,
        elevationNonce,
        elevationState: null,
        elevatedRunDir: null,
        elevatedHandoffMarker: null,
        cleanupStagedPreHandoff: null,
      };

      const createdSession = session;
      const inserted = yield* modifyManagerState((state) => {
        if (state.disposed) {
          return [false, state] as const;
        }
        const sessions = new Map(state.sessions);
        sessions.set(sessionKey, createdSession);
        return [true, { ...state, sessions }] as const;
      });
      if (!inserted) {
        return yield* new TerminalNotRunningError({
          threadId: input.threadId,
          terminalId,
        });
      }

      yield* evictInactiveSessionsIfNeeded();
      yield* startSession(
        session,
        {
          threadId: input.threadId,
          terminalId,
          cwd: input.cwd,
          ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
          cols,
          rows,
          ...(input.env ? { env: input.env } : {}),
        },
        "started",
        onSpawned,
        elevatedRunDir,
        elevatedHandoffMarker,
        cleanupStagedPreHandoff,
      );
      return snapshot(session);
    }

    const liveSession = existing.value;
    const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
    const currentRuntimeEnv = liveSession.runtimeEnv;
    const targetCols = input.cols ?? liveSession.cols;
    const targetRows = input.rows ?? liveSession.rows;
    const runtimeEnvChanged = !Equal.equals(currentRuntimeEnv, nextRuntimeEnv);
    let nextWorktreePath =
      input.worktreePath !== undefined ? (input.worktreePath ?? null) : liveSession.worktreePath;
    if (input.worktreePath === undefined && nextWorktreePath !== null && elevationMode !== null) {
      if (liveSession.cwd !== input.cwd || !(yield* isDirectory(nextWorktreePath))) {
        nextWorktreePath = null;
      }
    }
    const nextCommand = input.command ?? null;
    const launchContextChanged =
      liveSession.cwd !== input.cwd ||
      runtimeEnvChanged ||
      liveSession.worktreePath !== nextWorktreePath ||
      liveSession.command !== nextCommand ||
      liveSession.elevationMode !== elevationMode;

    if (launchContextChanged) {
      const priorProcess = liveSession.process;
      const needsAwaitedStop =
        (priorProcess !== null && (liveSession.elevationMode !== null || elevationMode !== null)) ||
        liveSession.elevatedRunDir !== null;
      if (needsAwaitedStop) {
        const priorPid = priorProcess?.pid ?? liveSession.lastPid ?? 0;
        const stopped = yield* stopProcessAndAwaitExit(liveSession);
        if (!stopped) {
          return yield* new TerminalStopError({
            threadId: liveSession.threadId,
            terminalId: liveSession.terminalId,
            terminalPid: priorPid,
          });
        }
      } else {
        yield* stopProcess(liveSession);
      }
      liveSession.cwd = input.cwd;
      liveSession.command = nextCommand;
      liveSession.elevatedCommand = elevatedCommand;
      liveSession.elevationMode = elevationMode;
      liveSession.elevationNonce = elevationNonce;
      liveSession.elevationState = null;
      liveSession.worktreePath = nextWorktreePath;
      liveSession.runtimeEnv = nextRuntimeEnv;
      liveSession.history.clear();
      liveSession.pendingHistoryControlSequence = "";
      liveSession.pendingElevationControlSequence = "";
      liveSession.pendingProcessEvents = [];
      liveSession.pendingProcessEventIndex = 0;
      liveSession.processEventDrainRunning = false;
      yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
    } else if (liveSession.status === "exited" || liveSession.status === "error") {
      if (liveSession.elevatedRunDir !== null) {
        const priorPid = liveSession.lastPid ?? 0;
        const stopped = yield* stopProcessAndAwaitExit(liveSession);
        if (!stopped) {
          return yield* new TerminalStopError({
            threadId: liveSession.threadId,
            terminalId: liveSession.terminalId,
            terminalPid: priorPid,
          });
        }
      }
      liveSession.elevatedCommand = elevatedCommand;
      liveSession.elevationMode = elevationMode;
      liveSession.elevationNonce = elevationNonce;
      liveSession.elevationState = null;
      liveSession.runtimeEnv = nextRuntimeEnv;
      liveSession.worktreePath = nextWorktreePath;
      liveSession.history.clear();
      liveSession.pendingHistoryControlSequence = "";
      liveSession.pendingElevationControlSequence = "";
      liveSession.pendingProcessEvents = [];
      liveSession.pendingProcessEventIndex = 0;
      liveSession.processEventDrainRunning = false;
      yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
    }

    if (!liveSession.process) {
      yield* startSession(
        liveSession,
        {
          threadId: input.threadId,
          terminalId,
          cwd: input.cwd,
          worktreePath: liveSession.worktreePath,
          cols: targetCols,
          rows: targetRows,
          ...(input.env ? { env: input.env } : {}),
        },
        "started",
        onSpawned,
        elevatedRunDir,
        elevatedHandoffMarker,
        cleanupStagedPreHandoff,
      );
      return snapshot(liveSession);
    }

    if (liveSession.cols !== targetCols || liveSession.rows !== targetRows) {
      yield* resizePtyProcess(liveSession, liveSession.process, targetCols, targetRows);
      liveSession.cols = targetCols;
      liveSession.rows = targetRows;
      liveSession.updatedAt = yield* nowIso;
    }

    return snapshot(liveSession);
  });

  const openWithWorkspaceLease = (
    input: TerminalOpenInput,
    onSpawned?: () => void,
    elevatedCommand: string | null = null,
    elevationMode: "prompt" | "terminal-app" | null = null,
    elevationNonce: string | null = null,
    elevatedRunDir: string | null = null,
    elevatedHandoffMarker: string | null = null,
    cleanupStagedPreHandoff: Effect.Effect<void> = Effect.void,
  ) =>
    withPinnedSessionKey(
      toSessionKey(input.threadId, input.terminalId),
      openWithWorkspaceLeasePinned(
        input,
        onSpawned,
        elevatedCommand,
        elevationMode,
        elevationNonce,
        elevatedRunDir,
        elevatedHandoffMarker,
        cleanupStagedPreHandoff,
      ),
    );

  const openLocked = (input: TerminalOpenInput) =>
    withWorkspaceLease(
      path.resolve(input.worktreePath ?? input.cwd),
      openWithWorkspaceLease(input),
    );

  const stageElevatedRun = options.prepareElevatedRun ?? prepareElevatedRunHandle;

  /** A code-block run that asked for it runs behind the administrator prompt. */
  const withElevatedRun = (input: TerminalOpenInput) => {
    const preferredShell =
      input.env?.SHELL?.trim() ||
      baseEnv.SHELL?.trim() ||
      resolveShellCandidates(shellResolver, platform, baseEnv)[0]?.shell;
    return input.command !== undefined &&
      input.elevation !== undefined &&
      elevatedRunApplies({
        platform,
        terminalId: input.terminalId,
        command: input.command,
        elevation: input.elevation,
      })
      ? Effect.tryPromise(() =>
          stageElevatedRun({
            command: input.command ?? "",
            cwd: input.cwd,
            ...(input.fallbackCwd ? { fallbackCwd: input.fallbackCwd } : {}),
            threadId: input.threadId,
            terminalId: input.terminalId,
            elevation: input.elevation ?? {},
            platform,
            ...(preferredShell ? { shell: preferredShell } : {}),
            ...(options.elevatedRunsDir !== undefined ? { runsDir: options.elevatedRunsDir } : {}),
          }),
        ).pipe(
          Effect.map((staged) => ({
            input: { ...input, command: staged.command },
            cleanup: Effect.promise(() => staged.cleanup()),
            runDir: staged.runDir ?? null,
            handoffMarker: staged.handoffMarker ?? null,
          })),
          // Without the wrapper nothing runs: the block must not start unasked.
          Effect.orElseSucceed(() => ({
            input: {
              ...input,
              command: elevationStateCommand("unavailable", input.elevation ?? {}),
            },
            cleanup: Effect.void,
            runDir: null,
            handoffMarker: null,
          })),
        )
      : Effect.succeed({ input, cleanup: Effect.void, runDir: null, handoffMarker: null });
  };

  const open: TerminalManager["Service"]["open"] = (input) =>
    withSpawnAdmission(
      withThreadLock(
        input.threadId,
        resolveLaunchInputEnvironment(input).pipe(
          Effect.flatMap((resolvedInput) =>
            withWorkspaceLease(
              path.resolve(resolvedInput.worktreePath ?? resolvedInput.cwd),
              withPinnedSessionKey(
                toSessionKey(resolvedInput.threadId, resolvedInput.terminalId),
                Effect.gen(function* () {
                  yield* assertValidCwd(resolvedInput.cwd);
                  const requestedElevationMode: "prompt" | "terminal-app" | null =
                    resolvedInput.elevation === undefined
                      ? null
                      : resolvedInput.elevation.openIn === "terminal-app"
                        ? "terminal-app"
                        : "prompt";
                  if (requestedElevationMode !== null) {
                    // An elevated code-block run stages a fresh wrapper command each call, so
                    // comparing `liveSession.command !== nextCommand` would always tear down an
                    // already-active elevated run (or open a duplicate Terminal window) on
                    // overlapping requests from another tab/device. Keep an already-elevated
                    // active session running only when the mode AND launch context (cwd,
                    // worktreePath, raw command, runtime env) match, while still allowing a
                    // stuck plain run to escalate, an active prompt run to switch into
                    // `terminal-app`, or a changed launch context to replace the prior run.
                    const existing = yield* getSession(
                      resolvedInput.threadId,
                      resolvedInput.terminalId,
                    );
                    if (
                      Option.isSome(existing) &&
                      existing.value.elevatedCommand !== null &&
                      existing.value.elevationMode === requestedElevationMode &&
                      existing.value.process !== null &&
                      (existing.value.status === "starting" || existing.value.status === "running")
                    ) {
                      const nextRuntimeEnv = normalizedRuntimeEnv(resolvedInput.env);
                      let nextWorktreePath =
                        resolvedInput.worktreePath !== undefined
                          ? (resolvedInput.worktreePath ?? null)
                          : existing.value.worktreePath;
                      if (resolvedInput.worktreePath === undefined && nextWorktreePath !== null) {
                        if (
                          existing.value.cwd !== resolvedInput.cwd ||
                          !(yield* isDirectory(nextWorktreePath))
                        ) {
                          nextWorktreePath = null;
                        }
                      }
                      const sameLaunchContext =
                        existing.value.cwd === resolvedInput.cwd &&
                        existing.value.worktreePath === nextWorktreePath &&
                        existing.value.elevatedCommand === (resolvedInput.command ?? null) &&
                        Equal.equals(existing.value.runtimeEnv, nextRuntimeEnv);
                      if (sameLaunchContext) {
                        return snapshot(existing.value);
                      }
                    }
                  }
                  return yield* Effect.uninterruptibleMask((restore) =>
                    Effect.gen(function* () {
                      const willWrapElevated =
                        resolvedInput.command !== undefined &&
                        resolvedInput.elevation !== undefined &&
                        elevatedRunApplies({
                          platform,
                          terminalId: resolvedInput.terminalId,
                          command: resolvedInput.command,
                          elevation: resolvedInput.elevation,
                        });
                      const elevationMode = willWrapElevated ? requestedElevationMode : null;
                      // Always generate a fresh server-only nonce for wrapped elevated runs so
                      // clients and peers never know or supply it, and filter raw OSC 7717 out
                      // before PTY output reaches history or subscribers.
                      const elevationNonce = willWrapElevated
                        ? generateServerElevationNonce()
                        : null;
                      const resolvedInputForElevation: TerminalOpenInput =
                        willWrapElevated &&
                        resolvedInput.elevation !== undefined &&
                        elevationNonce !== null
                          ? {
                              ...resolvedInput,
                              elevation: { ...resolvedInput.elevation, nonce: elevationNonce },
                            }
                          : resolvedInput;
                      const prepared = yield* withElevatedRun(resolvedInputForElevation);
                      const elevatedCommand =
                        willWrapElevated && resolvedInput.command !== undefined
                          ? resolvedInput.command
                          : null;
                      let keepStaged = false;
                      return yield* restore(
                        openWithWorkspaceLease(
                          prepared.input,
                          () => {
                            keepStaged = true;
                          },
                          elevatedCommand,
                          elevationMode,
                          elevationNonce,
                          prepared.runDir,
                          prepared.handoffMarker,
                          prepared.cleanup,
                        ),
                      ).pipe(
                        Effect.ensuring(
                          Effect.suspend(() => (keepStaged ? Effect.void : prepared.cleanup)),
                        ),
                      );
                    }),
                  );
                }),
              ),
            ),
          ),
        ),
      ),
    );

  const openOrAttachForStream = (input: TerminalAttachInput) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const terminalId = input.terminalId;
        const existing = yield* getSession(input.threadId, terminalId);

        if (Option.isNone(existing)) {
          if (!input.cwd) {
            return yield* new TerminalSessionLookupError({
              threadId: input.threadId,
              terminalId,
            });
          }

          const resolvedInput = yield* resolveLaunchInputEnvironment({
            ...input,
            terminalId,
            cwd: input.cwd,
          });
          return yield* openLocked(resolvedInput);
        }

        const session = existing.value;
        const targetCols = input.cols ?? session.cols;
        const targetRows = input.rows ?? session.rows;

        if (!session.process && input.cwd && input.restartIfNotRunning === true) {
          const resolvedInput = yield* resolveLaunchInputEnvironment({
            ...input,
            terminalId,
            cwd: input.cwd,
          });
          return yield* openLocked(resolvedInput);
        }

        if (
          session.process &&
          session.status === "running" &&
          (session.cols !== targetCols || session.rows !== targetRows)
        ) {
          const process = session.process;
          yield* resizePtyProcess(session, process, targetCols, targetRows);
          session.cols = targetCols;
          session.rows = targetRows;
          session.updatedAt = yield* nowIso;
        }

        return snapshot(session);
      }),
    );

  const readAllTerminalMetadata = () =>
    readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()]
          .map(summary)
          .sort(
            (left, right) =>
              right.updatedAt.localeCompare(left.updatedAt) ||
              left.threadId.localeCompare(right.threadId) ||
              left.terminalId.localeCompare(right.terminalId),
          ),
      ),
    );

  const readTerminalMetadata = (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) =>
    getSession(input.threadId, input.terminalId).pipe(
      Effect.map((session) => (Option.isSome(session) ? summary(session.value) : null)),
    );

  const subscribe: TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      terminalEventListeners.add(listener);
      return () => {
        terminalEventListeners.delete(listener);
      };
    });

  const streamSession = <E>(
    input: TerminalObserveInput,
    initial: Effect.Effect<TerminalSessionSnapshot, E>,
    listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
  ) => {
    let unsubscribe: (() => void) | null = null;

    return Effect.gen(function* () {
      const bufferedEvents: TerminalEvent[] = [];
      let deliverLive = false;

      unsubscribe = yield* subscribe((event) => {
        if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
          return Effect.void;
        }

        if (!deliverLive) {
          bufferedEvents.push(event);
          return Effect.void;
        }

        const attachEvent = terminalEventToAttachEvent(event);
        return attachEvent ? listener(attachEvent) : Effect.void;
      });

      const initialSnapshot = yield* initial;

      yield* listener({
        type: "snapshot",
        snapshot: initialSnapshot,
      });

      for (const event of bufferedEvents) {
        if (isDuplicateAttachSnapshotEvent(event, initialSnapshot)) {
          continue;
        }

        const attachEvent = terminalEventToAttachEvent(event);
        if (attachEvent) {
          yield* listener(attachEvent);
        }
      }

      deliverLive = true;
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(
          Effect.sync(() => {
            unsubscribe?.();
            unsubscribe = null;
          }),
          () => Effect.failCause(cause),
        ),
      ),
    );
  };

  const attachStream: TerminalManager["Service"]["attachStream"] = (input, listener) =>
    streamSession(
      input,
      withSpawnAdmission(openOrAttachForStream(input)),
      boundAttachHistory(input.maxHistoryBytes, listener),
    );

  const observeStream: TerminalManager["Service"]["observeStream"] = (input, listener) =>
    streamSession(
      input,
      withThreadLock(
        input.threadId,
        requireSession(input.threadId, input.terminalId).pipe(Effect.map(snapshot)),
      ),
      boundAttachHistory(input.maxHistoryBytes, listener),
    );

  const metadataEventFromTerminalEvent = (
    event: TerminalEvent,
  ): Effect.Effect<TerminalMetadataStreamEvent | null> => {
    if (!shouldPublishTerminalMetadataEvent(event)) {
      return Effect.succeed(null);
    }

    if (event.type === "closed") {
      return Effect.succeed({
        type: "remove" as const,
        threadId: event.threadId,
        terminalId: event.terminalId,
      });
    }

    return readTerminalMetadata({
      threadId: event.threadId,
      terminalId: event.terminalId,
    }).pipe(
      Effect.map((terminal) =>
        terminal
          ? {
              type: "upsert" as const,
              terminal,
            }
          : null,
      ),
    );
  };

  const offerMetadataEvent = (
    listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    event: TerminalEvent,
  ) =>
    metadataEventFromTerminalEvent(event).pipe(
      Effect.flatMap((metadataEvent) => (metadataEvent ? listener(metadataEvent) : Effect.void)),
    );

  const subscribeMetadata: TerminalManager["Service"]["subscribeMetadata"] = (listener) => {
    let unsubscribe: (() => void) | null = null;

    return Effect.gen(function* () {
      const bufferedEvents: TerminalEvent[] = [];
      let deliverLive = false;

      unsubscribe = yield* subscribe((event) => {
        if (!deliverLive) {
          bufferedEvents.push(event);
          return Effect.void;
        }

        return offerMetadataEvent(listener, event);
      });

      const terminals = yield* readAllTerminalMetadata();
      yield* listener({
        type: "snapshot",
        terminals,
      });

      for (const event of bufferedEvents) {
        yield* offerMetadataEvent(listener, event);
      }

      deliverLive = true;
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(
          Effect.sync(() => {
            unsubscribe?.();
            unsubscribe = null;
          }),
          () => Effect.failCause(cause),
        ),
      ),
    );
  };

  const write: TerminalManager["Service"]["write"] = Effect.fn("terminal.write")(function* (input) {
    const terminalId = input.terminalId;
    const session = yield* requireSession(input.threadId, terminalId);
    const process = session.process;
    if (!process || session.status !== "running") {
      if (session.status === "exited") return;
      return yield* new TerminalNotRunningError({
        threadId: input.threadId,
        terminalId,
      });
    }
    session.inputCount += 1;
    yield* Effect.try({
      try: () => process.write(input.data),
      catch: (cause) =>
        new TerminalWriteError({
          threadId: input.threadId,
          terminalId,
          terminalPid: process.pid,
          cause,
        }),
    });
  });

  const resizeLocked = Effect.fn("terminal.resize")(function* (input: TerminalResizeInput) {
    const session = yield* getSession(input.threadId, input.terminalId);
    // ResizeObserver traffic can already be in flight when the UI closes the session.
    if (Option.isNone(session)) {
      return;
    }
    const process = session.value.process;
    if (!process || session.value.status !== "running") {
      return;
    }
    yield* resizePtyProcess(session.value, process, input.cols, input.rows);
    session.value.cols = input.cols;
    session.value.rows = input.rows;
    session.value.updatedAt = yield* nowIso;
  });

  const resize: TerminalManager["Service"]["resize"] = (input) =>
    withThreadLock(input.threadId, resizeLocked(input));

  const clear: TerminalManager["Service"]["clear"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const terminalId = input.terminalId;
        const session = yield* requireSession(input.threadId, terminalId);
        session.history.clear();
        session.pendingHistoryControlSequence = "";
        // Keep `pendingElevationControlSequence` intact while the PTY is live so
        // a clear mid-OSC-7717 never drops the opening prefix and leaks trailing
        // nonce bytes on the next chunk. Advance the elevation parser across any
        // queued output events we discard, and retain any queued exit event.
        const remainingProcessEvents: Array<PendingProcessEvent> = [];
        for (
          let index = session.pendingProcessEventIndex;
          index < session.pendingProcessEvents.length;
          index += 1
        ) {
          const pendingEvent = session.pendingProcessEvents[index];
          if (!pendingEvent) continue;
          if (pendingEvent.type === "output") {
            const filtered = filterElevationOscChunk(
              session.pendingElevationControlSequence,
              pendingEvent.data,
              session.elevationNonce,
              session.elevationState,
            );
            session.pendingElevationControlSequence = filtered.pendingSequence;
            session.elevationState = filtered.elevationState;
          } else {
            remainingProcessEvents.push(pendingEvent);
          }
        }
        session.pendingProcessEvents = remainingProcessEvents;
        session.pendingProcessEventIndex = 0;
        const eventStamp = advanceEventSequence(session);
        yield* persistHistory(input.threadId, terminalId, session.history);
        yield* publishEvent({
          type: "cleared",
          threadId: input.threadId,
          terminalId,
          sequence: eventStamp.sequence,
          ...(session.elevationState !== null ? { elevationState: session.elevationState } : {}),
        });
      }),
    );

  const restartResolved = (input: TerminalRestartInput) =>
    withPinnedSessionKey(
      toSessionKey(input.threadId, input.terminalId),
      Effect.gen(function* () {
        yield* increment(terminalRestartsTotal, { scope: "thread" });
        const terminalId = input.terminalId;
        yield* assertValidCwd(input.cwd);

        const sessionKey = toSessionKey(input.threadId, terminalId);
        const existingSession = yield* getSession(input.threadId, terminalId);
        let session: TerminalSessionState;
        if (Option.isNone(existingSession)) {
          const cols = input.cols ?? DEFAULT_OPEN_COLS;
          const rows = input.rows ?? DEFAULT_OPEN_ROWS;
          session = {
            threadId: input.threadId,
            terminalId,
            cwd: input.cwd,
            worktreePath: input.worktreePath ?? null,
            status: "starting",
            pid: null,
            lastPid: null,
            history: new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit),
            pendingHistoryControlSequence: "",
            pendingElevationControlSequence: "",
            pendingProcessEvents: [],
            pendingProcessEventIndex: 0,
            processEventDrainRunning: false,
            exitCode: null,
            exitSignal: null,
            updatedAt: yield* nowIso,
            eventSequence: 0,
            inputCount: 0,
            cols,
            rows,
            process: null,
            unsubscribeData: null,
            unsubscribeExit: null,
            hasRunningSubprocess: false,
            childCommandLabel: null,
            runtimeEnv: normalizedRuntimeEnv(input.env),
            command: null,
            elevatedCommand: null,
            elevationMode: null,
            elevationNonce: null,
            elevationState: null,
            elevatedRunDir: null,
            elevatedHandoffMarker: null,
            cleanupStagedPreHandoff: null,
          };
          const createdSession = session;
          const inserted = yield* modifyManagerState((state) => {
            if (state.disposed) {
              return [false, state] as const;
            }
            const sessions = new Map(state.sessions);
            sessions.set(sessionKey, createdSession);
            return [true, { ...state, sessions }] as const;
          });
          if (!inserted) {
            return yield* new TerminalNotRunningError({
              threadId: input.threadId,
              terminalId,
            });
          }
          yield* evictInactiveSessionsIfNeeded();
        } else {
          session = existingSession.value;
          const wasElevated =
            session.elevationMode !== null ||
            session.elevatedCommand !== null ||
            session.elevatedRunDir !== null;
          if (wasElevated) {
            const priorPid = session.process?.pid ?? session.lastPid ?? 0;
            const stopped = yield* stopProcessAndAwaitExit(session);
            if (!stopped) {
              return yield* new TerminalStopError({
                threadId: session.threadId,
                terminalId: session.terminalId,
                terminalPid: priorPid,
              });
            }
          } else {
            yield* stopProcess(session);
          }
          session.cwd = input.cwd;
          session.worktreePath = input.worktreePath ?? null;
          session.runtimeEnv = normalizedRuntimeEnv(input.env);
          if (wasElevated) {
            // One-shot elevated runs (both prompt-mode wrappers and Terminal.app
            // launchers) must never be replayed via generic restart; reset to a
            // plain interactive shell and require a fresh authorized open for
            // another elevated run.
            session.command = null;
          }
          session.elevatedCommand = null;
          session.elevationMode = null;
          session.elevationNonce = null;
          session.elevationState = null;
        }

        const cols = input.cols ?? session.cols;
        const rows = input.rows ?? session.rows;

        session.history.clear();
        session.pendingHistoryControlSequence = "";
        session.pendingElevationControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        yield* persistHistory(input.threadId, terminalId, session.history);
        yield* startSession(
          session,
          {
            threadId: input.threadId,
            terminalId,
            cwd: input.cwd,
            ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
            cols,
            rows,
            ...(input.env ? { env: input.env } : {}),
          },
          "restarted",
        );
        return snapshot(session);
      }),
    );

  const restart: TerminalManager["Service"]["restart"] = (input) =>
    withSpawnAdmission(restartLocked(input));

  const restartLocked = (input: TerminalRestartInput) =>
    withThreadLock(
      input.threadId,
      resolveLaunchInputEnvironment(input).pipe(
        Effect.flatMap((resolved) =>
          withWorkspaceLease(
            path.resolve(resolved.worktreePath ?? resolved.cwd),
            restartResolved(resolved),
          ),
        ),
      ),
    );

  const close: TerminalManager["Service"]["close"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.terminalId) {
          yield* closeSession(input.threadId, input.terminalId, input.deleteHistory === true);
          return;
        }

        const threadSessions = yield* sessionsForThread(input.threadId);
        yield* Effect.forEach(
          threadSessions,
          (session) => closeSession(input.threadId, session.terminalId, false),
          { discard: true },
        );

        if (input.deleteHistory) {
          yield* deleteAllHistoryForThread(input.threadId);
        }
      }),
    );

  const closeIdle: TerminalManager["Service"]["closeIdle"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const running = (yield* sessionsForThread(input.threadId)).filter(
          (session): session is TerminalSessionState & { pid: number } =>
            session.status === "running" &&
            Number.isInteger(session.pid) &&
            (input.terminalId === undefined || session.terminalId === input.terminalId),
        );
        const closed: string[] = [];
        if (running.length === 0) return closed;
        // A command started during the process check can miss the snapshot,
        // but its input or echo still lands. Both counters only grow, so the
        // sum changes when either one does.
        const activityMark = (session: TerminalSessionState) =>
          session.eventSequence + session.inputCount;
        const marks = new Map(
          running.map((session) => [session.terminalId, activityMark(session)]),
        );
        // Inspect now instead of trusting the last poll, so a command started
        // since then keeps its terminal.
        const { inspector } = yield* acquireSubprocessInspector;
        yield* Effect.forEach(
          running,
          (session) =>
            inspector(session.pid).pipe(
              Effect.flatMap((result) =>
                result.hasRunningSubprocess ||
                activityMark(session) !== marks.get(session.terminalId)
                  ? Effect.void
                  : closeSession(
                      input.threadId,
                      session.terminalId,
                      input.deleteHistory === true,
                    ).pipe(Effect.tap(() => Effect.sync(() => closed.push(session.terminalId)))),
              ),
            ),
          { discard: true },
        );
        return closed;
      }),
    ).pipe(
      // The process check failed, so every terminal stays open.
      Effect.catch((error) =>
        Effect.logWarning("failed to close idle terminals", {
          threadId: input.threadId,
          error: error.message,
        }).pipe(Effect.as<ReadonlyArray<string>>([])),
      ),
    );

  const closeAll: TerminalManager["Service"]["closeAll"] = Effect.gen(function* () {
    const sessions = [...(yield* readManagerState).sessions.values()];
    let running = 0;
    for (const session of sessions) {
      if (session.status === "running") running += 1;
      yield* withThreadLock(
        session.threadId,
        closeSession(session.threadId, session.terminalId, false),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to close terminal for update", {
            threadId: session.threadId,
            terminalId: session.terminalId,
            cause,
          }),
        ),
      );
    }
    return running;
  });

  const countOpen: TerminalManager["Service"]["countOpen"] = readManagerState.pipe(
    Effect.map(
      (state) =>
        [...state.sessions.values()].filter((session) => session.status === "running").length,
    ),
  );

  return TerminalManager.of({
    withThreadLifecycleLock: withThreadLock,
    open,
    attachStream,
    observeStream,
    write,
    resize,
    clear,
    restart,
    close,
    closeIdle,
    closeAll,
    countOpen,
    subscribe,
    subscribeMetadata,
  });
});

export const layer = Layer.effect(TerminalManager, make()).pipe(Layer.provide(ProcessRunner.layer));
