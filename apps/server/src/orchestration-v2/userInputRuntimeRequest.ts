import type {
  OrchestrationV2InternalCommand,
  OrchestrationV2RuntimeRequest,
  ProviderTurnId,
} from "@specweave-studio/contracts";
import type * as DateTime from "effect/DateTime";

import { isReopenCardRequestId, wasClosed } from "../serviceUpdate/ServiceUpdateClosedQuestions.ts";

/** Preserve request creation time separately from the original ask restored after an update. */
export function userInputRuntimeRequest(
  command: Extract<OrchestrationV2InternalCommand, { readonly type: "user_input_request.record" }>,
  providerTurnId: ProviderTurnId | null,
  now: DateTime.Utc,
): OrchestrationV2RuntimeRequest {
  return {
    id: command.requestId,
    nodeId: command.requestNodeId,
    providerTurnId,
    nativeRequestRef: null,
    kind: "user_input",
    status: "pending",
    responseCapability: { type: "message" },
    createdAt: now,
    resolvedAt: null,
    ...(command.reopenedFromAskedAt === undefined
      ? {}
      : { reopenedFromAskedAt: command.reopenedFromAskedAt }),
  };
}

/**
 * Whether recording `command` puts `existing` back: a card that asks a closed
 * request again (one id however often updates close it) that a later update
 * closed in turn. Any other card already recorded, answered or still open,
 * stays as it is.
 */
export function reopensClosedCard(
  command: Extract<OrchestrationV2InternalCommand, { readonly type: "user_input_request.record" }>,
  existing: Pick<OrchestrationV2RuntimeRequest, "kind" | "status" | "decision" | "answers">,
): boolean {
  return (
    command.reopenedFromAskedAt !== undefined &&
    isReopenCardRequestId(command.requestId) &&
    existing.kind === "user_input" &&
    wasClosed(existing)
  );
}
