import { normalizeProjectPathForComparison } from "@specweave-studio/shared/path";

import type { ThreadShell } from "./types";

function worktreePathKey(path: string | null): string | null {
  return path?.trim() ? normalizeProjectPathForComparison(path) : null;
}

export function getOrphanedWorktreePathForThread(
  threads: ReadonlyArray<Pick<ThreadShell, "id" | "worktreePath">>,
  threadId: ThreadShell["id"],
): string | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return null;
  }

  const targetKey = worktreePathKey(targetThread.worktreePath);
  if (!targetKey) {
    return null;
  }

  const isShared = threads.some((thread) => {
    if (thread.id === threadId) {
      return false;
    }
    return worktreePathKey(thread.worktreePath) === targetKey;
  });

  return isShared ? null : (targetThread.worktreePath?.trim() ?? null);
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}
