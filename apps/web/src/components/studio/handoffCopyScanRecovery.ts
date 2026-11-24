import type {
  EnvironmentId,
  FolderCopySourceStatus,
  FolderCopySourceSummary,
} from "@specweave-studio/contracts";

import { DEFAULT_COPY_SELECTION } from "../../studio/folderCopy";
import type { PendingCopy } from "./handoffFolderCopyPending";

/** Older destinations report the same refusal without the additive recovery field. */
export function needsNewCopyComparison(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const error = cause as { code?: unknown; recovery?: unknown; detail?: unknown };
  return (
    error.code === "refused" &&
    (error.recovery === "compare_again" ||
      (typeof error.detail === "string" &&
        error.detail.startsWith(
          "The source changed or this saved scan has no freshness evidence.",
        )))
  );
}

/**
 * Refresh reports current inventory without mutating the saved operation or its choices.
 * Secret files the fresh inventory found that the saved scan did not list go to
 * `untickSecrets` before the new list is shown: the person never approved them.
 */
export async function refreshCopyScan(
  read: () => Promise<FolderCopySourceStatus>,
  setStatus: (status: FolderCopySourceStatus) => void,
  setSummary: (summary: FolderCopySourceSummary) => void,
  untickSecrets?: (paths: ReadonlyArray<string>) => void,
): Promise<void> {
  // A disconnected/stalled RPC must not lock the whole dialog indefinitely.
  // Only publish the winning result: a late reply cannot overwrite a later scan.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            "Checking this scan took too long. Your saved copy and choices are unchanged. Try Check for changes again.",
          ),
        ),
      120_000,
    );
  });
  let checked: FolderCopySourceStatus;
  try {
    checked = await Promise.race([read(), deadline]);
  } finally {
    clearTimeout(timer);
  }
  setStatus(checked);
  const fresh = checked.freshness?.summary;
  if (fresh) {
    const saved = new Set(checked.summary?.secretFiles.map((file) => file.path) ?? []);
    const added = fresh.secretFiles.map((file) => file.path).filter((path) => !saved.has(path));
    if (added.length > 0) untickSecrets?.(added);
    setSummary(fresh);
  }
  if (!checked.freshness)
    throw new Error(
      "Update the source to check scan freshness. The saved copy and choices have been kept.",
    );
}

/** A new comparison carries destination/scope choices, never approval for old contents. */
export function newCopyComparison(
  saved: PendingCopy,
  method: "copy" | "clone",
  scope: { copyRoot: string; projectRelativePath: string },
) {
  return {
    machine: saved.environmentId as EnvironmentId,
    folder: saved.targetFolder,
    mode: saved.mode,
    selection: saved.selection ?? DEFAULT_COPY_SELECTION,
    auto: false,
    method: saved.method ?? method,
    copyRoot: saved.copyRoot ?? scope.copyRoot,
    projectRelativePath: saved.projectRelativePath ?? scope.projectRelativePath,
  };
}
