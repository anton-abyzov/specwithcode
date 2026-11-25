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

/**
 * The project of the thread that asked for this chat from another machine: a
 * reviewer a project's worker started on a machine without that project lands in
 * that machine's "No project" folder, yet it is the project's work. Undefined
 * when the chat was started by a person, by a client, or by another chat.
 */
export function requesterProject<T, G>(
  chat: {
    readonly origin?:
      | {
          readonly environmentId?: string | undefined;
          readonly parentThreadRef?:
            | { readonly environmentId?: string | undefined; readonly threadId: string }
            | undefined;
        }
      | undefined;
  },
  input: {
    /** A thread by `environmentId:threadId`. */
    readonly thread: (key: string) => T | undefined;
    /** That thread's project, undefined for a chat or an unknown project. */
    readonly project: (thread: T) => G | undefined;
  },
): G | undefined {
  const ref = chat.origin?.parentThreadRef;
  const environmentId = ref?.environmentId ?? chat.origin?.environmentId;
  if (ref === undefined || environmentId === undefined) return undefined;
  const requester = input.thread(`${environmentId}:${ref.threadId}`);
  return requester === undefined ? undefined : input.project(requester);
}

type HelperOrigin = {
  readonly kind?: string;
  readonly machineLabel?: string | undefined;
  readonly environmentId?: string | undefined;
  readonly parentProjectLabel?: string | undefined;
  readonly parentThreadRef?:
    | { readonly environmentId?: string | undefined; readonly threadId: string }
    | undefined;
};

/** `environmentId:threadId` of the thread on another machine that started this one. */
export function helperParentKey(chat: {
  readonly origin?: HelperOrigin | undefined;
}): string | undefined {
  const ref = chat.origin?.parentThreadRef;
  const environmentId = ref?.environmentId ?? chat.origin?.environmentId;
  return ref === undefined || environmentId === undefined
    ? undefined
    : `${environmentId}:${ref.threadId}`;
}

/**
 * What a helper chat another machine's thread started says about where it
 * belongs, for its header and the chats list: the requesting project's name
 * (the loaded requester's project first, else the name that machine sent),
 * and the machine the request came from. Undefined for a person's chat.
 */
export function helperChatOrigin(
  chat: { readonly origin?: HelperOrigin | undefined },
  requesterProjectName: string | undefined,
): { readonly projectName: string; readonly fromMachine: string | undefined } | undefined {
  if (helperParentKey(chat) === undefined) return undefined;
  const projectName = requesterProjectName ?? chat.origin?.parentProjectLabel?.trim();
  if (!projectName) return undefined;
  return { projectName, fromMachine: chat.origin?.machineLabel?.trim() || undefined };
}

/**
 * The chats list's group for a helper chat whose requesting thread is not
 * loaded here, so it cannot open from that project's row: "From specweave on
 * M5", never "No project". Undefined when the origin names no project.
 */
export function helperChatGroupLabel(chat: {
  readonly origin?: HelperOrigin | undefined;
}): string | undefined {
  const helper = helperChatOrigin(chat, undefined);
  if (helper === undefined) return undefined;
  return helper.fromMachine
    ? `From ${helper.projectName} on ${helper.fromMachine}`
    : `From ${helper.projectName}`;
}

type HelperCandidate = {
  readonly environmentId: string;
  readonly id: string;
  readonly origin?: HelperOrigin | undefined;
};

/**
 * The helper chats on other machines that a thread started and that are
 * blocked, for a note in that thread. A subagent's helpers also show in its
 * root thread, where the person reads the work. `blockerOf` says what each
 * one waits on, or null.
 */
export function blockedHelpersOf<T extends HelperCandidate>(
  thread: { readonly environmentId: string; readonly id: string },
  candidates: Iterable<T>,
  input: {
    /** A thread by `environmentId:threadId`, for the starting thread's root. */
    readonly thread: (
      key: string,
    ) => { readonly lineage?: { readonly rootThreadId?: string | null } } | undefined;
    readonly blockerOf: (helper: T) => string | null;
  },
): Array<{ readonly helper: T; readonly blocker: string }> {
  const out: Array<{ helper: T; blocker: string }> = [];
  for (const helper of candidates) {
    if (helper.environmentId === thread.environmentId) continue;
    const parentKey = helperParentKey(helper);
    if (parentKey === undefined) continue;
    const ownKey = `${thread.environmentId}:${thread.id}`;
    const parentEnvironment = parentKey.slice(0, parentKey.indexOf(":"));
    const root = input.thread(parentKey)?.lineage?.rootThreadId;
    const startedHere =
      parentKey === ownKey ||
      (parentEnvironment === thread.environmentId && root != null && root === thread.id);
    if (!startedHere) continue;
    const blocker = input.blockerOf(helper);
    if (blocker !== null) out.push({ helper, blocker });
  }
  return out;
}

/**
 * Where the chats list puts a chat a thread on another machine started: with
 * that thread's project (`group`, opened from its project row), or, while that
 * thread is not loaded here, under the helper's "From <project> on <machine>".
 * Undefined for a project's own thread and for a person's chat.
 */
export function chatRequester<
  T extends { readonly origin?: HelperOrigin | undefined },
  G extends { readonly displayName: string },
>(
  chat: T,
  input: {
    readonly isChat: (thread: T) => boolean;
    readonly thread: (key: string) => T | undefined;
    readonly project: (thread: T) => G | undefined;
  },
): { readonly group?: G; readonly label: string } | undefined {
  if (!input.isChat(chat)) return undefined;
  const group = requesterProject(chat, {
    thread: input.thread,
    project: (requester) => (input.isChat(requester) ? undefined : input.project(requester)),
  });
  if (group !== undefined) return { group, label: group.displayName };
  const label = helperChatGroupLabel(chat);
  return label === undefined ? undefined : { label };
}
