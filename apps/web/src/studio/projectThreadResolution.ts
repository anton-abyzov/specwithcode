import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import type { useThreadActions } from "../hooks/useThreadActions";

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
    return reopened;
  }
  return thread.settledOverride === "settled"
    ? actions.unsettleThread(ref)
    : actions.settleThread(ref);
}
