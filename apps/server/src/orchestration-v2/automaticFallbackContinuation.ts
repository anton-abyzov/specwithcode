import type { ModelSelection } from "@specweave-studio/contracts";

const MARKER = "\n\n[Automatic fallback continuation]\n";

/** Only for a server-selected, eligible usage-limit fallback, never a manual send. */
export function automaticFallbackContinuation(target: ModelSelection, request: string): string {
  // A later hop may replay a request that already carries an earlier hop's note.
  const at = request.lastIndexOf(MARKER);
  const base = at === -1 ? request : request.slice(0, at);
  return `${base}${MARKER}The configured automatic fallback policy selected ${target.instanceId} / ${target.model} after the previous provider reached a usage or credit limit. Continue the same assignment in this thread and worktree on this selected model. Do not ask for provider-substitution confirmation solely because an older assignment named a different provider/model or said to stop rather than switch implementers; the configured automatic fallback authorizes this substitution. Preserve the task scope, ownership, billing restrictions, grants, actual Stop holds and all other approval requirements. This does not authorize spending beyond the existing billing policy, new access, answering pending approval cards, or switching to another provider yourself.`;
}
