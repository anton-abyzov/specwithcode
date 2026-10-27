/**
 * A chat is a conversation in a machine's "No project" folder. It is not a
 * project's thread: nothing resolves it, and the person only archives it.
 * Archived chats are reached from the Chats filter menu, and a chat joins a
 * project with "Move to project…".
 */
import {
  isScratchMember,
  type ProjectListMember,
  type ScratchRootLookup,
} from "./projectListVisibility";

/** `environmentId:projectId` of each machine's "No project" folder. */
export function standaloneChatKeys(
  members: Iterable<ProjectListMember>,
  scratchRootFor: ScratchRootLookup,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const member of members)
    if (isScratchMember(member, scratchRootFor)) keys.add(`${member.environmentId}:${member.id}`);
  return keys;
}

/**
 * A chat as the lists show it. Servers before chats stopped resolving marked
 * quiet chats resolved on their own; that mark is not the person's and does
 * not hide the chat or make it read as finished.
 */
export function asStandaloneChat<T extends { readonly settledOverride?: string | null }>(
  thread: T,
): T {
  return thread.settledOverride === "settled" ? { ...thread, settledOverride: null } : thread;
}
