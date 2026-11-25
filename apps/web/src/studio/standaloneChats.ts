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

/** The thread on another machine that started this one. Kept whole: ids may hold ":". */
export function helperParentRef(chat: {
  readonly origin?: HelperOrigin | undefined;
}): { readonly environmentId: string; readonly threadId: string } | undefined {
  const ref = chat.origin?.parentThreadRef;
  const environmentId = ref?.environmentId ?? chat.origin?.environmentId;
  return ref === undefined || environmentId === undefined
    ? undefined
    : { environmentId, threadId: ref.threadId };
}

/** The requester as a project thread, a chat of its own, or not loaded here. */
export type HelperRequester =
  | { readonly kind: "project"; readonly name: string }
  | { readonly kind: "chat" }
  | { readonly kind: "unknown" };

/**
 * Where a helper chat another machine's thread started belongs, for its header
 * and the chats list: the requesting project's name (the loaded requester's
 * first, else the name that machine sent) and the machine the request came
 * from. Undefined for a person's chat and for a chat another chat started.
 */
export function helperChatOrigin(
  chat: { readonly origin?: HelperOrigin | undefined },
  requester: HelperRequester,
):
  | { readonly projectName: string | undefined; readonly fromMachine: string | undefined }
  | undefined {
  if (helperParentRef(chat) === undefined || requester.kind === "chat") return undefined;
  const projectName =
    requester.kind === "project"
      ? requester.name
      : chat.origin?.parentProjectLabel?.trim() || undefined;
  const fromMachine = chat.origin?.machineLabel?.trim() || undefined;
  return projectName === undefined && fromMachine === undefined
    ? undefined
    : { projectName, fromMachine };
}

/** Words for a helper's group and header, so each surface translates them alike. */
export interface HelperWords {
  readonly projectOnMachine: (project: string, machine: string) => string;
  readonly project: (project: string) => string;
  readonly machine: (machine: string) => string;
}

export const ENGLISH_HELPER_WORDS: HelperWords = {
  projectOnMachine: (project, machine) => `From ${project} on ${machine}`,
  project: (project) => `From ${project}`,
  machine: (machine) => `From ${machine}`,
};

/**
 * The chats list's group for a helper chat whose requesting thread is not
 * loaded here: "From specweave on M5", or "From M5" from a machine that sent
 * no project name; never "No project". Undefined for any other chat.
 */
export function helperChatGroupLabel(
  chat: { readonly origin?: HelperOrigin | undefined },
  words: HelperWords = ENGLISH_HELPER_WORDS,
): string | undefined {
  const helper = helperChatOrigin(chat, { kind: "unknown" });
  if (helper === undefined) return undefined;
  if (helper.projectName && helper.fromMachine)
    return words.projectOnMachine(helper.projectName, helper.fromMachine);
  return helper.projectName
    ? words.project(helper.projectName)
    : words.machine(helper.fromMachine!);
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
    /** A thread by environment and id, for the starting thread's root. */
    readonly thread: (
      environmentId: string,
      threadId: string,
    ) => { readonly lineage?: { readonly rootThreadId?: string | null } } | undefined;
    readonly blockerOf: (helper: T) => string | null;
  },
): Array<{ readonly helper: T; readonly blocker: string }> {
  const out: Array<{ helper: T; blocker: string }> = [];
  for (const helper of candidates) {
    if (helper.environmentId === thread.environmentId) continue;
    const parent = helperParentRef(helper);
    if (parent === undefined || parent.environmentId !== thread.environmentId) continue;
    const startedHere =
      parent.threadId === thread.id ||
      input.thread(parent.environmentId, parent.threadId)?.lineage?.rootThreadId === thread.id;
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
 * Undefined for a project's own thread, a person's chat and a chat's chat.
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
    readonly words?: HelperWords;
  },
): { readonly group?: G; readonly label: string } | undefined {
  if (!input.isChat(chat)) return undefined;
  const ref = helperParentRef(chat);
  if (ref === undefined) return undefined;
  const requester = input.thread(`${ref.environmentId}:${ref.threadId}`);
  if (requester !== undefined) {
    if (input.isChat(requester)) return undefined;
    const group = input.project(requester);
    if (group !== undefined) return { group, label: group.displayName };
  }
  const label = helperChatGroupLabel(chat, input.words);
  return label === undefined ? undefined : { label };
}
