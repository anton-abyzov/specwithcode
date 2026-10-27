import { useEffect } from "react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useEnvironments } from "../../state/environments";
import { unwatchCopy, useCopyWatches, watchCopy } from "../../studio/folderCopyActivity";
import { HandoffFolderCopyWatcher } from "./HandoffFolderCopyWatcher";
import { readPendingCopy } from "./handoffFolderCopyPending";

const POINTER_PREFIX = "specwithcode:folder-copy:";

/** Copies a previous session of this app left running, from their saved pointers. */
function pendingPointers(): ReadonlyArray<{ environmentId: string; projectId: string }> {
  const found: Array<{ environmentId: string; projectId: string }> = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(POINTER_PREFIX)) continue;
      const rest = key.slice(POINTER_PREFIX.length);
      const split = rest.lastIndexOf(":");
      if (split <= 0) continue;
      const saved = readPendingCopy(key);
      if (!saved || saved.cancelled) continue;
      found.push({ environmentId: rest.slice(0, split), projectId: rest.slice(split + 1) });
    }
  } catch {
    /* Without storage there is nothing to resume. */
  }
  return found;
}

/**
 * Watches every folder copy left running while its dialog is closed, whichever project is
 * open: mounted once with the sidebar, so switching projects never stops a copy's progress
 * or its announcement. On start it picks up copies an earlier session left running.
 */
export function FolderCopyWatchers() {
  const watches = useCopyWatches();
  const { environments } = useEnvironments();
  const label = (environmentId: string) =>
    environments.find((item) => item.environmentId === environmentId)?.label ?? "the other machine";

  useEffect(() => {
    for (const pointer of pendingPointers())
      watchCopy({
        ...pointer,
        machineLabel: (environmentId) => environmentId,
        sourceLabel: "this machine",
        restored: true,
      });
  }, []);

  return (
    <>
      {[...watches].map(([key, watch]) => (
        <HandoffFolderCopyWatcher
          key={`${key}:${watch.restored ? "restored" : "live"}`}
          environmentId={watch.environmentId as EnvironmentId}
          projectId={watch.projectId}
          // A restored watch has no dialog's labels; the machines list names the destination.
          machineLabel={watch.restored ? label : watch.machineLabel}
          sourceLabel={
            watch.restored
              ? label(watch.environmentId) === "the other machine"
                ? "this machine"
                : label(watch.environmentId)
              : watch.sourceLabel
          }
          restored={watch.restored ?? false}
          onDone={() => unwatchCopy(key)}
        />
      ))}
    </>
  );
}
