import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";
import {
  WS_METHODS,
  type EnvironmentId,
  type HandoffIncomingReplica,
  type HandoffModeSnapshot,
  type HandoffThreadState,
  type ProjectId,
  type ThreadId,
} from "@specweave-studio/contracts";
import { useCallback, useSyncExternalStore } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

/** Handoff mode RPCs; each mutation refreshes the shared snapshot afterwards. */
export const handoffMode = {
  snapshot: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "handoff-mode:snapshot",
    tag: WS_METHODS.handoffModeSnapshot,
  }),
  updateConfig: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "handoff-mode:update-config",
    tag: WS_METHODS.handoffModeUpdateConfig,
  }),
  setThreadMode: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "handoff-mode:set-thread-mode",
    tag: WS_METHODS.handoffModeSetThreadMode,
  }),
  setProjectMode: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "handoff-mode:set-project-mode",
    tag: WS_METHODS.handoffModeSetProjectMode,
  }),
  checkpointNow: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "handoff-mode:checkpoint-now",
    tag: WS_METHODS.handoffModeCheckpointNow,
  }),
  handOff: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "handoff-mode:hand-off",
    tag: WS_METHODS.handoffModeHandOff,
  }),
  handOffMachine: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "handoff-mode:hand-off-machine",
    tag: WS_METHODS.handoffModeHandOffMachine,
  }),
  continueHere: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "handoff-mode:continue-here",
    tag: WS_METHODS.handoffModeContinueHere,
  }),
  resumeFenced: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "handoff-mode:resume-fenced",
    tag: WS_METHODS.handoffModeResumeFenced,
  }),
  preflight: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "handoff-mode:preflight",
    tag: WS_METHODS.handoffModePreflight,
  }),
};

export const HANDOFF_MODE_REFRESH_MS = 15_000;

export type HandoffModeOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string };

/** The server's message for a failed handoff RPC, worded for the user. */
export function handoffModeFailureText(result: { readonly cause: unknown }): string {
  const cause = squashAtomCommandFailure(result as Parameters<typeof squashAtomCommandFailure>[0]);
  if (cause && typeof cause === "object" && "message" in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  return "The server didn't answer. Check the connection, then retry.";
}

function outcome<A, E>(result: AtomCommandResult<A, E>): HandoffModeOutcome<A> {
  return result._tag === "Success"
    ? { ok: true, value: result.value }
    : { ok: false, error: handoffModeFailureText(result) };
}

/** Runs one handoff RPC outside React, then refreshes that machine's snapshot. */
export async function runHandoffMode<W extends { environmentId: EnvironmentId }, A, E>(
  rpc: AtomCommand<W, A, E>,
  value: W,
): Promise<HandoffModeOutcome<A>> {
  const result = await runAtomCommand(appAtomRegistry, rpc, value, {
    label: rpc.label,
    reportFailure: false,
    reportDefect: false,
  });
  const next = outcome(result);
  if (next.ok && isSnapshot(next.value)) store.set(value.environmentId, next.value);
  void refreshHandoffMode(value.environmentId);
  return next;
}

function isSnapshot(value: unknown): value is HandoffModeSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    "threads" in value &&
    "incoming" in value &&
    "config" in value
  );
}

// One poll per machine, shared by every row, header and dialog that reads it.

interface Entry {
  snapshot: HandoffModeSnapshot | null;
  error: string | null;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  view: HandoffModeView;
}

export interface HandoffModeView {
  readonly snapshot: HandoffModeSnapshot | null;
  readonly error: string | null;
}

const EMPTY_VIEW: HandoffModeView = { snapshot: null, error: null };
const entries = new Map<EnvironmentId, Entry>();

const store = {
  entry(environmentId: EnvironmentId): Entry {
    let entry = entries.get(environmentId);
    if (!entry) {
      entry = { snapshot: null, error: null, listeners: new Set(), timer: null, view: EMPTY_VIEW };
      entries.set(environmentId, entry);
    }
    return entry;
  },
  publish(entry: Entry) {
    entry.view = { snapshot: entry.snapshot, error: entry.error };
    for (const listener of entry.listeners) listener();
  },
  set(environmentId: EnvironmentId, snapshot: HandoffModeSnapshot) {
    const entry = store.entry(environmentId);
    entry.snapshot = snapshot;
    entry.error = null;
    store.publish(entry);
  },
};

/** Fetches a machine's handoff state now; rows and dialogs re-render with it. */
export async function refreshHandoffMode(environmentId: EnvironmentId): Promise<void> {
  const result = await runAtomCommand(
    appAtomRegistry,
    handoffMode.snapshot,
    { environmentId, input: {} },
    { label: handoffMode.snapshot.label, reportFailure: false, reportDefect: false },
  );
  const entry = store.entry(environmentId);
  if (result._tag === "Success") {
    entry.snapshot = result.value;
    entry.error = null;
  } else {
    entry.error = handoffModeFailureText(result);
  }
  store.publish(entry);
}

function subscribe(environmentId: EnvironmentId, listener: () => void) {
  const entry = store.entry(environmentId);
  entry.listeners.add(listener);
  if (entry.timer === null) {
    void refreshHandoffMode(environmentId);
    entry.timer = setInterval(
      () => void refreshHandoffMode(environmentId),
      HANDOFF_MODE_REFRESH_MS,
    );
  }
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0 && entry.timer !== null) {
      clearInterval(entry.timer);
      entry.timer = null;
    }
  };
}

/**
 * The cached snapshot for a menu that opens now. A machine nothing has polled yet
 * starts a fetch for next time; its menu hides the handoff items until then.
 */
export function readHandoffModeSnapshot(environmentId: EnvironmentId): HandoffModeSnapshot | null {
  const entry = store.entry(environmentId);
  if (entry.snapshot === null && entry.timer === null) void refreshHandoffMode(environmentId);
  return entry.snapshot;
}

/** Sets a thread's handoff mode and reports a failure as a toast-ready string. */
export function setThreadHandoffMode(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  mode: "inherit" | "on" | "off",
) {
  return runHandoffMode(handoffMode.setThreadMode, { environmentId, input: { threadId, mode } });
}

/**
 * The menu's view of a thread's handoff mode, or undefined when the server has none.
 * A thread with no record yet inherits like the server's effectiveHandoffMode:
 * its project's setting, else the machine default.
 */
export function threadHandoffMenuState(
  snapshot: HandoffModeSnapshot | null,
  threadId: ThreadId,
  projectId: ProjectId,
): { mode: "inherit" | "on" | "off"; effective: "on" | "off"; continued: boolean } | undefined {
  if (!snapshot) return undefined;
  const state = threadHandoffState(snapshot, threadId);
  if (!state)
    return {
      mode: "inherit",
      effective: snapshot.projectModes[projectId] ?? snapshot.config.defaultMode,
      continued: false,
    };
  return {
    mode: state.mode,
    effective: state.effectiveMode,
    continued: state.continuedOn !== null,
  };
}

const noop = () => () => {};

/** A machine's handoff snapshot, refreshed every 15 seconds and after each action. */
export function useHandoffModeSnapshot(environmentId: EnvironmentId | null): HandoffModeView {
  // A stable subscribe: a new one each render made React resubscribe on every
  // snapshot, and the last listener leaving restarted the fetch at once.
  const subscribeTo = useCallback(
    (listener: () => void) => (environmentId ? subscribe(environmentId, listener) : noop()),
    [environmentId],
  );
  return useSyncExternalStore(
    subscribeTo,
    () => (environmentId ? store.entry(environmentId).view : EMPTY_VIEW),
    () => EMPTY_VIEW,
  );
}

/** Test hook: seeds or clears a machine's snapshot without a server. */
export function seedHandoffModeSnapshot(
  environmentId: EnvironmentId,
  snapshot: HandoffModeSnapshot | null,
) {
  const entry = store.entry(environmentId);
  entry.snapshot = snapshot;
  entry.error = null;
  store.publish(entry);
}

// Badge view model.

export type HandoffBadgeView =
  | { readonly kind: "ready"; readonly label: string }
  | { readonly kind: "behind"; readonly label: string; readonly detail: string | null }
  | { readonly kind: "handing-off"; readonly label: string }
  | {
      readonly kind: "continued";
      readonly label: string;
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }
  | {
      readonly kind: "source-unreachable";
      readonly label: string;
      readonly replica: HandoffIncomingReplica;
    }
  | { readonly kind: "paused"; readonly label: string };

type Name = (environmentId: string, fallback?: string | null) => string;

export function threadHandoffState(
  snapshot: HandoffModeSnapshot | null,
  threadId: ThreadId,
): HandoffThreadState | null {
  return snapshot?.threads.find((thread) => thread.threadId === threadId) ?? null;
}

/**
 * The badge a local thread shows. A paused machine (it woke after another
 * machine took over and can't reach its peers) wins over the thread's own state.
 */
export function handoffBadgeFor(
  snapshot: HandoffModeSnapshot | null,
  threadId: ThreadId,
  name: Name,
): HandoffBadgeView | null {
  const state = threadHandoffState(snapshot, threadId);
  if (!snapshot || !state) return null;
  if (state.continuedOn) {
    const machine = name(state.continuedOn.environmentId, state.continuedOn.machineLabel);
    return {
      kind: "continued",
      label: `Continued on ${machine}`,
      environmentId: state.continuedOn.environmentId,
      threadId: state.continuedOn.threadId,
    };
  }
  if (snapshot.pausedSince !== null && (state.effectiveMode === "on" || state.badge === "paused"))
    return { kind: "paused", label: "Paused" };
  switch (state.badge) {
    case "ready":
      return { kind: "ready", label: "Handoff ready" };
    case "behind":
      return {
        kind: "behind",
        label: "Checkpoint behind",
        detail:
          state.replicas
            .filter((replica) => replica.state !== "current")
            .map((replica) => {
              const machine = name(replica.environmentId, replica.machineLabel);
              return replica.detail
                ? `${machine}: ${replica.detail}`
                : `${machine}: ${replica.state}`;
            })
            .join("; ") || null,
      };
    case "handing-off":
      return { kind: "handing-off", label: "Handing off…" };
    case "paused":
      return { kind: "paused", label: "Paused" };
    default:
      return null;
  }
}

/** The incoming checkpoint for a thread that lives on another machine, if this machine holds one. */
export function incomingReplicaFor(
  snapshot: HandoffModeSnapshot | null,
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
): HandoffIncomingReplica | null {
  return (
    snapshot?.incoming.find(
      (replica) =>
        replica.sourceEnvironmentId === sourceEnvironmentId &&
        replica.sourceThreadId === sourceThreadId &&
        replica.continuedThreadId === null,
    ) ?? null
  );
}

/** "Handoff ready · M4 unreachable" for a checkpoint whose source stopped answering. */
export function unreachableBadgeFor(
  replica: HandoffIncomingReplica | null,
  name: Name,
): HandoffBadgeView | null {
  if (!replica || !replica.sourceUnreachable) return null;
  const machine = name(replica.sourceEnvironmentId, replica.sourceLabel);
  return { kind: "source-unreachable", label: `Handoff ready · ${machine} unreachable`, replica };
}

/** Whether the thread's composer must stay read-only: another machine continues it. */
export function isHandoffReadOnly(snapshot: HandoffModeSnapshot | null, threadId: ThreadId) {
  return threadHandoffState(snapshot, threadId)?.continuedOn != null;
}

/** Running threads in handoff mode, the ones "Hand off this machine…" can move. */
export function handoffMachineCandidates(
  snapshot: HandoffModeSnapshot | null,
  isRunning: (threadId: ThreadId) => boolean = () => false,
) {
  return (snapshot?.threads ?? []).filter(
    (thread) =>
      thread.effectiveMode === "on" &&
      thread.continuedOn === null &&
      thread.lease?.state !== "fenced" &&
      (isRunning(thread.threadId) || thread.checkpoint?.runEnding === "active"),
  );
}
