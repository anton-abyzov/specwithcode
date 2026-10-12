/**
 * Workers a coordinator started on another machine, as its project page shows
 * them: the same dot and words as a local thread card, plus the machine. Pure
 * rules only; the component is components/studio/RemoteWorkerCards.tsx.
 */
import type { StudioFleetRemoteWorker } from "@specweave-studio/contracts/studioFleet";

import type { ThreadCardStatus } from "./projectThreadCards";

const FINISHED: Record<string, ThreadCardStatus> = {
  completed: { tone: "done", label: "Done" },
  failed: { tone: "failed", label: "Failed" },
  rolled_back: { tone: "failed", label: "Rolled back" },
  interrupted: { tone: "idle", label: "Interrupted" },
  cancelled: { tone: "idle", label: "Cancelled" },
};

export function remoteWorkerCardStatus(worker: StudioFleetRemoteWorker): ThreadCardStatus {
  const finished = worker.lastStatus ? FINISHED[worker.lastStatus] : undefined;
  switch (worker.state) {
    case "launching":
      return { tone: "working", label: `Starting on ${worker.machineLabel}` };
    case "following":
      return worker.reachable
        ? { tone: "working", label: "Working" }
        : { tone: "waiting", label: `${worker.machineLabel} unreachable, retrying` };
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
): ReadonlyArray<StudioFleetRemoteWorker> {
  return workers.filter((worker) => worker.state !== "disposed");
}
