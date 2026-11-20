import type {
  EnvironmentId,
  OrchestrationV2ThreadProjectMoveLink,
  ScopedThreadRef,
  ThreadExecutionRecord,
  ThreadId,
} from "@specweave-studio/contracts";
import { threadAwaitingPerson } from "@specweave-studio/client-runtime/state/models";

import type { HandoffDestination } from "./HandoffResults";

/** The thread this window shows, with what Bring back reads from it. */
export interface BringBackThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly movedTo?: OrchestrationV2ThreadProjectMoveLink | null | undefined;
  readonly movedFrom?: OrchestrationV2ThreadProjectMoveLink | null | undefined;
  readonly execution?: Pick<ThreadExecutionRecord, "sourceRoot"> | null | undefined;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasPendingSignIn?: boolean;
}

/** The continuation on the other machine, as this window reads it; null when it can't. */
export interface BringBackContinuation {
  readonly movedTo?: OrchestrationV2ThreadProjectMoveLink | null | undefined;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasPendingSignIn?: boolean;
}

/**
 * The one-thread hand off that brings the thread back: the thread that runs
 * now, and the machine it came from. `refused` says why it can't go yet.
 */
export interface BringBackOffer {
  readonly threadRef: ScopedThreadRef;
  readonly destinationEnvironmentId: EnvironmentId;
  /** The machine it goes back to, as the button names it. */
  readonly machine: string;
  readonly refused: string | null;
}

export const BRING_BACK_BUSY = "Answer its question, approval or sign-in first.";

const busy = (thread: {
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  hasPendingSignIn?: boolean;
}) => thread.hasPendingApprovals || thread.hasPendingUserInput || thread.hasPendingSignIn === true;

/**
 * Why the thread can't go back now, read from its live state, or null. A
 * question, an approval or a sign-in waiting on the person stops it, and so
 * does a thread this window can't read: it is never moved unseen.
 */
export function bringBackWaitReason(
  thread: Parameters<typeof threadAwaitingPerson>[0] | null,
): string | null {
  if (thread === null) return "The thread can't be read here, so it stays.";
  return threadAwaitingPerson(thread) === null ? null : BRING_BACK_BUSY;
}

/**
 * Bring back's one machine: the source, never another. It is the only choice
 * offered; when it can't take work the dialog has no destination and says why.
 */
export function pinnedDestination(
  destinations: readonly HandoffDestination[],
  pinned: EnvironmentId,
  machineName: (environmentId: EnvironmentId, label?: string | null) => string,
): {
  readonly destinations: readonly HandoffDestination[];
  readonly destination: EnvironmentId | null;
  readonly refused: string | null;
} {
  const found = destinations.find((item) => item.environmentId === pinned);
  const only: HandoffDestination = found ?? {
    environmentId: pinned,
    label: machineName(pinned),
    state: "offline",
    reason: "Not connected",
  };
  if (only.state === "reachable")
    return { destinations: [only], destination: pinned, refused: null };
  const why = only.state === "this-machine" ? "it runs here" : (only.reason ?? "Offline");
  return {
    destinations: [only],
    destination: null,
    refused: `${only.label} can't take the thread back now: ${why.toLowerCase()}.`,
  };
}

/**
 * Bring back for one handed-off thread (1390 AC-23), or null when there is
 * nothing this window can safely offer. It never reverts anything itself: it
 * names the one-thread hand off a move by hand runs, with the same checks.
 *
 * On the continuation it goes back to the machine it came from. On the
 * read-only copy left on the source it is offered only when this window
 * reaches the machine that runs the thread now and that thread is still there,
 * not moved on. A question or approval waiting, or an offline source, refuses.
 */
export function bringBackOffer(input: {
  readonly thread: BringBackThread;
  readonly connected: ReadonlyArray<EnvironmentId>;
  /** The source's copy only: the thread its link names, read from that machine. */
  readonly continuation: BringBackContinuation | null;
  readonly machineName: (environmentId: EnvironmentId, label?: string | null) => string;
}): BringBackOffer | null {
  const { thread, connected, continuation, machineName } = input;
  const movedTo = thread.movedTo ?? null;
  if (movedTo !== null) {
    // The copy left behind: the thread now runs where the link says.
    if (movedTo.kind !== "handoff") return null;
    const runsOn = movedTo.environmentId;
    if (runsOn === undefined || runsOn === thread.environmentId) return null;
    if (!connected.includes(runsOn) || continuation === null) return null;
    if ((continuation.movedTo ?? null) !== null) return null;
    return {
      threadRef: { environmentId: runsOn, threadId: movedTo.threadId },
      destinationEnvironmentId: thread.environmentId,
      machine: machineName(thread.environmentId),
      refused: busy(continuation) ? BRING_BACK_BUSY : null,
    };
  }
  const movedFrom = thread.movedFrom ?? null;
  if (movedFrom !== null && movedFrom.kind !== "handoff") return null;
  const sourceRoot = thread.execution?.sourceRoot ?? null;
  const origin =
    movedFrom !== null
      ? { environmentId: movedFrom.environmentId, label: movedFrom.machineLabel }
      : sourceRoot !== null && sourceRoot.threadId !== thread.id
        ? { environmentId: sourceRoot.environmentId, label: sourceRoot.machineLabel }
        : null;
  if (origin === null || origin.environmentId === undefined) return null;
  if (origin.environmentId === thread.environmentId) return null;
  const machine = machineName(origin.environmentId, origin.label);
  return {
    threadRef: { environmentId: thread.environmentId, threadId: thread.id },
    destinationEnvironmentId: origin.environmentId,
    machine,
    refused: !connected.includes(origin.environmentId)
      ? `${machine} is offline, so the thread can't go back yet.`
      : busy(thread)
        ? BRING_BACK_BUSY
        : null,
  };
}
