import * as Context from "effect/Context";
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@specweave-studio/contracts";
import { backgroundWorkHoldsCompletion } from "@specweave-studio/shared/orchestrationV2PendingBackgroundWork";

/**
 * Server composition flag. No environment, settings or RPC switch enables it.
 * 1069 alone may provide true when current delivery evidence gates are wired.
 */
export class DeferredResolutionActivation extends Context.Reference<boolean>(
  "studio/orchestration-v2/DeferredResolutionActivation",
  { defaultValue: () => false },
) {}

type ResolutionProjection = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "runtimeRequests" | "subagents" | "providerThreads" | "turnItems"
>;

/**
 * Run/pending-work readiness only, not affirmative delivery acceptance.
 * Apply current request-bound delivery evidence under the same lock before the
 * existing settle mutation; completed runs and notes are not that evidence.
 */
export function deferredResolutionBlocked(projection: ResolutionProjection, runId: RunId): boolean {
  const { thread, runs, runtimeRequests, subagents, providerThreads, turnItems } = projection;
  const run = runs.find((candidate) => candidate.id === runId);
  return (
    run === undefined ||
    runs.some(
      (candidate) =>
        candidate.ordinal > run.ordinal ||
        (candidate.id !== runId &&
          ["preparing", "queued", "starting", "running", "waiting"].includes(candidate.status)),
    ) ||
    thread.deletedAt !== null ||
    thread.archivedAt !== null ||
    thread.settledOverride !== null ||
    (thread.deferredResolution?.runId === runId && thread.deferredResolution.revoked === true) ||
    thread.pinnedAt != null ||
    thread.autoSettleDisabledAt != null ||
    thread.movedTo != null ||
    runtimeRequests.some((request) => request.status === "pending") ||
    turnItems.some((item) => item.type === "secret_request" && item.secretStatus === "pending") ||
    subagents.some(
      (child) =>
        ["idle", "pending", "running", "waiting"].includes(child.status) ||
        (child.completionDelivery !== undefined &&
          ["pending", "claimed"].includes(child.completionDelivery.state)),
    ) ||
    providerThreads.some((providerThread) =>
      backgroundWorkHoldsCompletion(providerThread.pendingBackgroundTasks ?? []),
    )
  );
}

/** Once intervening work appears, this intent can never resolve a later turn. */
export function invalidatesDeferredResolution(
  event: OrchestrationV2DomainEvent,
  runId?: RunId,
): boolean {
  switch (event.type) {
    case "message.updated":
      return event.payload.role === "user";
    case "run.created":
      return event.payload.id !== runId;
    case "run.updated":
      return (
        (runId === undefined || event.payload.id === runId) &&
        ["failed", "interrupted", "cancelled", "rolled_back"].includes(event.payload.status)
      );
    case "turn-item.updated":
      return (
        event.payload.type === "run_interrupt_request" ||
        (event.payload.type === "secret_request" && event.payload.secretStatus === "pending")
      );
    case "provider-thread.updated":
      return backgroundWorkHoldsCompletion(event.payload.pendingBackgroundTasks ?? []);
    case "runtime-request.updated":
      return event.payload.status === "pending";
    case "subagent.updated":
      return ["idle", "pending", "running", "waiting"].includes(event.payload.status);
    case "thread.unsettled":
    case "thread.pinned":
    case "thread.archived":
    case "thread.deleted":
    case "thread.auto-settle-set":
    case "thread.provider-switched":
      return true;
    default:
      return false;
  }
}
