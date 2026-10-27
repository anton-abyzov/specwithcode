import type { OrchestrationV2ThreadProjection } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import {
  currentLifecycleRequest,
  evaluateLifecycleEvidence,
  type LifecycleEvidenceDecision,
} from "@specweave-studio/shared/threadLifecycleEvidence";

/**
 * Server composition flag. When true, automatic settlement also requires a
 * current accepted receipt. No environment, settings or RPC switch enables it;
 * receipts are recorded, shown and resolve threads either way.
 */
export class LifecycleEvidenceActivation extends Context.Reference<boolean>(
  "studio/orchestration-v2/LifecycleEvidenceActivation",
  { defaultValue: () => false },
) {}

type AcceptanceProjection = Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages">;

/** Evaluated under the command lock, using current persisted records, not a sweep snapshot. */
export function lifecycleAcceptanceDecision(
  projection: AcceptanceProjection,
  nowMs: number,
): LifecycleEvidenceDecision {
  const receipt = projection.thread.lifecycleReceipt;
  if (receipt == null) return "missing_evidence";
  const request = currentLifecycleRequest(projection);
  return request === null
    ? "superseded_request"
    : evaluateLifecycleEvidence(request, receipt, nowMs);
}

export function hasCurrentLifecycleAcceptance(
  projection: AcceptanceProjection,
  nowMs: number,
): boolean {
  return lifecycleAcceptanceDecision(projection, nowMs) === "accepted";
}

/** The resolved banner shows the verified scope, within the settled-note limit. */
export function settledNoteFromScope(scope: string): string {
  const text = `Delivery verified: ${scope.replace(/\s+/gu, " ").trim()}`;
  return text.length <= 500 ? text : `${text.slice(0, 499).trimEnd()}…`;
}
