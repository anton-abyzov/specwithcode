/**
 * Who names a thread. A coordinator or agent names the threads it starts
 * (delegated tasks, workers, subagents), so sidebar rows keep those titles
 * read-only and only chats a person starts rename there, as in Claude Code,
 * Codex and Cursor. A thread's own heading renames any thread, and the
 * coordinator still finds it by id; automatic titles never replace that name,
 * though a coordinator may still rename the thread on purpose.
 */
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/models";

import type { ProjectNameCheck } from "./projectRename";

type TitleOwnerFields = Partial<Pick<EnvironmentThreadShell, "createdBy" | "lineage">>;

export function isCoordinatorNamedThread(thread: TitleOwnerFields | null | undefined): boolean {
  if (!thread) return false;
  return thread.createdBy === "agent" || thread.lineage?.relationshipToParent === "subagent";
}

/** Whether a chat renames by hand: the person may operate its machine and no coordinator names it. */
export function canRenameChat(thread: TitleOwnerFields, canOperate: boolean): boolean {
  return canOperate && !isCoordinatorNamedThread(thread);
}

/**
 * Checks a chat title typed in place: the same title saves nothing (an untitled
 * chat opens with an empty field, not an error), and blank is refused.
 */
export function checkChatTitle(draft: string, current: string): ProjectNameCheck {
  const title = draft.trim();
  if (title === current.trim()) return { kind: "unchanged" };
  if (title.length === 0) return { kind: "invalid", error: "Enter a name." };
  return { kind: "valid", name: title };
}
