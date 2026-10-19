import type { ThreadId } from "@specweave-studio/contracts";

import type { ProviderAdapterV2Event } from "./ProviderAdapter.ts";

/**
 * Runtime requests with no provider turn belong to the live session itself.
 * Their node and transcript item are runless too, so they bypass the normal
 * per-run subscriber and are persisted by the session event pump.
 */
export function sessionScopedRuntimeRequestThreadId(
  event: ProviderAdapterV2Event,
): ThreadId | undefined {
  switch (event.type) {
    case "runtime_request.updated":
      return event.runtimeRequest.providerTurnId === null ? event.threadId : undefined;
    case "node.updated":
      return event.node.runId === null && event.node.runtimeRequestId !== null
        ? event.node.threadId
        : undefined;
    case "turn_item.updated":
      return event.turnItem.runId === null &&
        (event.turnItem.type === "approval_request" || event.turnItem.type === "user_input_request")
        ? event.turnItem.threadId
        : undefined;
    default:
      return undefined;
  }
}
