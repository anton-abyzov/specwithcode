import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { useAtomCommand } from "../../state/use-atom-command";
import { machineHandoff } from "../../studio/machineHandoff";
import { setCopyActivity } from "../../studio/folderCopyActivity";
import { toastManager } from "../ui/toast";
import { folderCopyStorageKey, readPendingCopy } from "./handoffFolderCopyPending";

/** "envId:projectId", the key a copy's activity, dialog and pointer share. */
const splitKey = (key: string) => {
  const split = key.lastIndexOf(":");
  return {
    environmentId: key.slice(0, split),
    projectId: key.slice(split + 1),
  };
};

/** Cancel for a copy that waits for the person, from the project's banner. */
export function useCancelWaitingCopy() {
  const sourceCancel = useAtomCommand(machineHandoff.copySourceCancel, { reportFailure: false });
  const cancel = useAtomCommand(machineHandoff.copyCancel, { reportFailure: false });
  const release = useAtomCommand(machineHandoff.copyRelease, { reportFailure: false });
  /**
   * Cancels a copy that has applied nothing, as the dialog's Cancel copy does: the
   * destination drops its compare, the source its snapshot, and a move its fence.
   */
  const cancelCopy = async (key: string, machine: string): Promise<void> => {
    const { environmentId, projectId } = splitKey(key);
    const storageKey = folderCopyStorageKey(environmentId, projectId);
    const pending = readPendingCopy(storageKey);
    if (!pending) {
      setCopyActivity(key, null);
      return;
    }
    const operationId = pending.operationId;
    const reason = "The copy was cancelled before Apply.";
    try {
      await cancel({
        environmentId: pending.environmentId as EnvironmentId,
        input: { operationId, reason },
      }).catch(() => null);
      const source = await sourceCancel({
        environmentId: environmentId as EnvironmentId,
        input: { operationId, reason },
      });
      if (source._tag === "Failure") throw squashAtomCommandFailure(source);
      if (pending.mode === "copy-and-move") {
        const released = await release({
          environmentId: environmentId as EnvironmentId,
          input: { projectId: projectId as ProjectId, operationId, reason },
        });
        if (released._tag === "Failure") throw squashAtomCommandFailure(released);
      }
      try {
        if (readPendingCopy(storageKey)?.operationId === operationId)
          localStorage.removeItem(storageKey);
      } catch {
        /* A kept pointer re-reads the cancelled copy once and drops it. */
      }
      setCopyActivity(key, null);
      toastManager.add({
        type: "success",
        title: `Copy to ${machine} cancelled. Nothing was copied.`,
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Copy to ${machine} could not be cancelled. Review it to try again.`,
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  return cancelCopy;
}
