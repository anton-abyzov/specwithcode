import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type * as Cause from "effect/Cause";
import type { useThreadActions } from "../hooks/useThreadActions";

function isSettlementUnsupported(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const { _tag, cause } = result as { _tag?: unknown; cause?: Cause.Cause<unknown> };
  if (_tag !== "Failure" || cause === undefined) return false;
  const error = squashAtomCommandFailure({ cause });
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { _tag?: unknown })._tag === "ThreadSettlementUnsupportedError"
  );
}

/** Legacy archived history and explicit settlement have the same project-level reopen action. */
export async function toggleProjectThreadResolution(
  thread: EnvironmentThreadShell,
  actions: Pick<
    ReturnType<typeof useThreadActions>,
    "unarchiveThread" | "unsettleThread" | "settleThread"
  >,
  refresh: () => void,
) {
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  if (thread.archivedAt !== null) {
    const restored = await actions.unarchiveThread(ref, { navigate: false });
    if (restored?._tag === "Failure") return restored;
    const reopened = await actions.unsettleThread(ref);
    refresh();
    // History a server only archived is back once restored: a server that predates
    // Resolve has no settlement to clear, so its refusal is not a failed reopen.
    if (thread.settledOverride !== "settled" && isSettlementUnsupported(reopened)) return restored;
    return reopened;
  }
  return thread.settledOverride === "settled"
    ? actions.unsettleThread(ref)
    : actions.settleThread(ref);
}
