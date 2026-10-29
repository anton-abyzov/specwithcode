import type {
  OrchestrationV2InternalCommand,
  OrchestrationV2RuntimeRequest,
  ProviderTurnId,
} from "@specweave-studio/contracts";
import type * as DateTime from "effect/DateTime";

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
