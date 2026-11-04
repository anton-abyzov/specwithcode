/**
 * Whether a thread's approval wait is an access request card, and the words
 * every web surface uses for it. One rule here keeps the thread list, the
 * Overview, the sidebar and notifications in agreement; iOS applies the same
 * rule (PendingRuntimeRequestSummary.isAccessRequest).
 */
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";

const ACCESS_REQUEST_ID_PREFIX = "turn-item:access-request:";

type WithSource = { readonly source?: EnvironmentThreadShell["source"] | undefined };

/** True when the thread's pending request is an access request card. */
export function isAccessWait(thread: WithSource): boolean {
  const request = thread.source?.pendingRuntimeRequest ?? null;
  if (request === null) return false;
  return (
    request.access !== undefined ||
    (request.kind === "permission" && request.id.startsWith(ACCESS_REQUEST_ID_PREFIX))
  );
}

/** "Access requested" for an access request card, else "Approval requested". */
export function approvalWaitLabel(thread: WithSource): string {
  return isAccessWait(thread) ? "Access requested" : "Approval requested";
}
