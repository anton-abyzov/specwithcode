/**
 * Workers a coordinator started on another machine, as its project page shows
 * them: the same dot and words as a local thread card, plus the machine. Pure
 * rules only; the component is components/studio/RemoteWorkerCards.tsx.
 */
import type { StudioFleetRemoteWorker } from "@specweave-studio/contracts/studioFleet";

import type { ThreadCardStatus } from "./projectThreadCards";
import { epochMillis } from "./projectThreadMentions";

const FINISHED: Record<string, ThreadCardStatus> = {
  completed: { tone: "done", label: "Done" },
  failed: { tone: "failed", label: "Failed" },
  rolled_back: { tone: "failed", label: "Rolled back" },
  interrupted: { tone: "idle", label: "Interrupted" },
  cancelled: { tone: "idle", label: "Cancelled" },
};

/** The server's lastStatus for a followed run blocked on the person (RemoteWorkerFollower). */
export const REMOTE_WORKER_WAITING_ON_YOU = "waiting_on_you";

export function remoteWorkerCardStatus(worker: StudioFleetRemoteWorker): ThreadCardStatus {
  const finished = worker.lastStatus ? FINISHED[worker.lastStatus] : undefined;
  switch (worker.state) {
    case "launching":
      return { tone: "working", label: `Starting on ${worker.machineLabel}` };
    case "following":
      if (!worker.reachable)
        return { tone: "idle", label: `${worker.machineLabel} unreachable, retrying` };
      // Its run asked the person something on that machine; it is not working meanwhile.
      return worker.lastStatus === REMOTE_WORKER_WAITING_ON_YOU
        ? { tone: "waiting", label: `Last observed: waiting on you on ${worker.machineLabel}` }
        : { tone: "working", label: "Working" };
    case "wake_pending":
      return { ...(finished ?? { tone: "done", label: "Finished" }) };
    case "idle":
      return finished ?? { tone: "idle", label: "Idle" };
    case "paused_auth":
      return {
        tone: "waiting",
        label: `Allow workers on ${worker.machineLabel} again to keep following`,
      };
    case "launch_unknown":
      return { tone: "failed", label: "Start not confirmed; check the other machine" };
    case "stopped":
      return { tone: "failed", label: "No longer followed" };
    case "disposed":
      return { tone: "resolved", label: "Closed" };
  }
}

/**
 * Cards worth showing, most recently active first as the server sends them: a
 * worker whose coordinator thread is gone is not this page's.
 */
export function visibleRemoteWorkers(
  workers: ReadonlyArray<StudioFleetRemoteWorker>,
  representedThreads: readonly { environmentId: string; id: string }[] = [],
): ReadonlyArray<StudioFleetRemoteWorker> {
  return workers.filter(
    (worker) =>
      worker.state !== "disposed" &&
      (worker.state === "paused_auth" ||
        !representedThreads.some(
          (thread) =>
            thread.environmentId === worker.environmentId && thread.id === worker.remoteThreadId,
        )),
  );
}

/** A conversation message as far as placing a worker card goes. */
export interface RemoteWorkerAnchorMessage {
  readonly id: string;
  readonly role: string;
  /** An ISO string or a DateTime, as the conversation keeps it. */
  readonly createdAt: unknown;
}

export interface RemoteWorkerPlacement {
  /** Cards under the reply of the turn that started them, by that reply's id. */
  readonly byMessage: ReadonlyMap<string, ReadonlyArray<StudioFleetRemoteWorker>>;
  /** Still-active workers with no loaded turn to sit in: shown above the live activity. */
  readonly live: ReadonlyArray<StudioFleetRemoteWorker>;
}

const ACTIVE_TONES = new Set<ThreadCardStatus["tone"]>(["working", "waiting"]);

/**
 * Where each card sits in a coordinator conversation: under the last reply of
 * the turn that started the worker, so newer messages land after it instead of
 * under a stack of old cards. A worker started before every loaded message, or
 * reported by an older server without a start time, has no place: while it is
 * active it shows above the live activity, and once settled only the thread
 * list has it. Pass only the mounted messages: a turn above them is not on screen.
 */
export function placeRemoteWorkers(
  workers: ReadonlyArray<StudioFleetRemoteWorker>,
  messages: ReadonlyArray<RemoteWorkerAnchorMessage>,
  /** The conversation's thread: a worker another thread started has no turn here. */
  coordinatorThreadId: string,
): RemoteWorkerPlacement {
  const byMessage = new Map<string, StudioFleetRemoteWorker[]>();
  const live: StudioFleetRemoteWorker[] = [];
  const ordered = workers.toSorted((left, right) =>
    (left.launchedAt ?? left.updatedAt).localeCompare(right.launchedAt ?? right.updatedAt),
  );
  for (const worker of ordered) {
    const anchor =
      worker.launchedAt && worker.callerThreadId === coordinatorThreadId
        ? turnReplyAt(messages, worker.launchedAt)
        : null;
    if (anchor !== null) {
      const list = byMessage.get(anchor);
      if (list) list.push(worker);
      else byMessage.set(anchor, [worker]);
    } else if (ACTIVE_TONES.has(remoteWorkerCardStatus(worker).tone)) live.push(worker);
  }
  return { byMessage, live };
}

/** The last reply of the turn running at `at`, or null when that turn is not loaded or has none. */
function turnReplyAt(
  messages: ReadonlyArray<RemoteWorkerAnchorMessage>,
  at: string,
): string | null {
  const atMs = Date.parse(at);
  if (Number.isNaN(atMs)) return null;
  const opened = messages.findLastIndex(
    (message) => message.role === "user" && (epochMillis(message.createdAt) ?? Infinity) <= atMs,
  );
  if (opened === -1) return null;
  const next = messages.findIndex((message, index) => index > opened && message.role === "user");
  const turn = messages.slice(opened + 1, next === -1 ? undefined : next);
  return turn.findLast((message) => message.role === "assistant")?.id ?? null;
}
