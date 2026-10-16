/**
 * Who names a thread. A coordinator or agent names the threads it starts
 * (delegated tasks, workers, subagents) and keeps renaming them as the work
 * moves, so the UI shows those titles read-only: a hand edit would be
 * overwritten and would break the coordinator's references to the thread.
 * Chats a person starts stay renameable, as in Claude Code, Codex and Cursor.
 */
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/models";

type TitleOwnerFields = Partial<Pick<EnvironmentThreadShell, "createdBy" | "lineage">>;

export function isCoordinatorNamedThread(thread: TitleOwnerFields | null | undefined): boolean {
  if (!thread) return false;
  return thread.createdBy === "agent" || thread.lineage?.relationshipToParent === "subagent";
}

/** The hover label of a clipped title: the whole title, plus who controls it. */
export function threadTitleTip(thread: TitleOwnerFields & { readonly title: string }): string {
  const title = thread.title || "Untitled thread";
  return isCoordinatorNamedThread(thread) ? `${title} (named by its coordinator)` : title;
}
