import type { FolderCopySourceStatus, FolderCopyStatus } from "@specweave-studio/contracts";
import { cloneableRows } from "../../studio/folderCopy";
import { undecidedCloneRows } from "./handoffCopyAuto";
import type { PendingCopy } from "./handoffFolderCopyPending";

export function copyNeedsComparison(
  status: FolderCopySourceStatus | null,
  pending: PendingCopy | null,
  copy: FolderCopyStatus | null,
): boolean {
  return (
    pending?.needsComparison === true ||
    (status?.freshness?.current === false &&
      status.capturedAt === undefined &&
      copy?.capturedAt === undefined)
  );
}

/** Answer clone choices once, preserving the original comparison and later user edits. */
export async function decideCopyClones(
  saved: PendingCopy,
  previewed: FolderCopyStatus,
  method: "copy" | "clone",
  apply: (rows: ReadonlyArray<string>) => Promise<void>,
  poll: () => Promise<FolderCopyStatus>,
  remember: (saved: PendingCopy) => void,
) {
  if ((saved.method ?? method) !== "clone" || saved.cloneDecided || previewed.state !== "previewed")
    return { saved, next: previewed };
  let next = previewed;
  if (undecidedCloneRows(previewed.rows).length > 0) {
    await apply(cloneableRows(previewed.rows));
    next = await poll();
  }
  const decided: PendingCopy = { ...saved, cloneDecided: true };
  remember(decided);
  return { saved: decided, next };
}
