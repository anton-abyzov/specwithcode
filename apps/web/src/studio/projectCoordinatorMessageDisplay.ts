import type { ThreadId } from "@specweave-studio/contracts";
import { parseRoutedMessage } from "@specweave-studio/shared/routedMessage";
import { resolveStudioMcpToolId } from "@specweave-studio/shared/studioMcpToolPresentation";

type Message = {
  readonly id: string;
  readonly role: string;
  readonly createdBy: string;
  readonly senderThreadId?: string | undefined;
  readonly text: string;
};
type Worker = {
  readonly id: ThreadId;
  readonly title: string;
  readonly projectId: string | null;
  readonly environmentId: string;
  readonly deletedAt: string | null;
};

export type RoutedFrom = {
  readonly assistantTitle: string;
  readonly note: string | null;
};

/** Presentation only: retain the stored routing prompt and its receipt identity. */
export function projectCoordinatorMessageDisplay(
  message: Message,
  project: { readonly id: string; readonly environmentId: string },
  workers: readonly Worker[],
): { text: string; sourceThread: Worker | null; routedFrom: RoutedFrom | null } {
  const unchanged = { text: message.text, sourceThread: null, routedFrom: null };
  const idPrefix = `coordinator-send:${project.id}:`;
  // A request the personal assistant routed here: the user's words, and who routed them.
  const routed =
    message.role === "user" &&
    message.createdBy === "user" &&
    message.senderThreadId &&
    message.id.startsWith(idPrefix)
      ? parseRoutedMessage(message.text)
      : null;
  if (routed && routed.threadId === message.senderThreadId)
    return {
      text: routed.words,
      sourceThread: null,
      routedFrom: { assistantTitle: routed.assistantTitle, note: routed.note ?? null },
    };
  if (
    message.role !== "user" ||
    message.createdBy !== "user" ||
    !message.senderThreadId ||
    !message.id.startsWith(idPrefix) ||
    !message.id.slice(idPrefix.length).trim()
  )
    return unchanged;
  const sourceThread = workers.find(
    (worker) =>
      worker.id === message.senderThreadId &&
      worker.projectId === project.id &&
      worker.environmentId === project.environmentId &&
      worker.deletedAt === null,
  );
  if (!sourceThread) return unchanged;
  const text = stripWorkerFollowUp(message.text, sourceThread.id, message.id);
  return text === null ? unchanged : { text, sourceThread, routedFrom: null };
}

/** The server's one-line wrapper around a worker follow-up, current form or the one before message IDs. */
export function stripWorkerFollowUp(
  text: string,
  sourceThreadId: string,
  messageId: string,
): string | null {
  const tail = ". Review that thread and decide whether to reuse it or route elsewhere.\n\n";
  for (const prefix of [
    `User follow-up from selected worker ${sourceThreadId}, message ${messageId}${tail}`,
    `User follow-up from selected worker ${sourceThreadId}${tail}`,
  ])
    if (text.startsWith(prefix)) return text.slice(prefix.length);
  return null;
}

/** Assistant replies are also created by an agent; only a user-role message from another thread is a worker's. */
export function projectMessageAuthor(message: Pick<Message, "role" | "createdBy">) {
  if (message.role !== "user") return "Coordinator";
  return message.createdBy === "agent" ? "Message from a worker" : "You";
}

/**
 * A delegated-task completion is a server wake addressed to the coordinator's model
 * ("Use task_status with taskId …"). The worker's thread status and a notification
 * tell the person it finished, so the coordinator's conversation does not show it.
 */
export function isWorkerCompletionWake(message: {
  readonly delegatedCompletion?: { readonly taskIds: readonly string[] } | undefined;
  readonly notification?: { readonly summary: string } | undefined;
}): boolean {
  if ((message.delegatedCompletion?.taskIds.length ?? 0) > 0) return true;
  // A remote worker's wake is stored as a notification whose summary is the
  // old "reported back" card. Status and the system notification announce it.
  return /reported back\.?\s*$/.test(message.notification?.summary ?? "");
}

/** A background notification shows its summary in place of the text addressed to the model. */
export function projectSystemNotice(message: {
  readonly notification?: { readonly summary: string } | undefined;
}): string | null {
  return message.notification?.summary ?? null;
}

export type RoutedReply<At = string> = {
  readonly id: string;
  readonly text: string;
  readonly createdAt: At | null;
  /** What the coordinator said next, once it has answered. */
  readonly answer: string | null;
  /** Threads that answer links to, in order: where the coordinator says it sent the message. */
  readonly answerThreadIds: readonly string[];
};

const THREAD_LINK = /studio:\/\/thread\/([^)\s"'>]+)/g;

function linkedThreadIds(markdown: string): string[] {
  const ids: string[] = [];
  for (const match of markdown.matchAll(THREAD_LINK)) {
    let id = match[1]!;
    try {
      id = decodeURIComponent(id);
    } catch {
      // Keep the encoded form; it still differs from every other thread's ID.
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export type RoutedReplyNote = {
  readonly id: string;
  readonly text: string;
  /** pending: the coordinator has not answered; sent: delivered to another thread; answered: kept in the coordinator. */
  readonly kind: "pending" | "sent" | "answered";
  readonly targetThreadId: string | null;
};

/**
 * What a worker thread shows for the messages the person typed in it. A message
 * the coordinator delivered back to this thread already appears in its timeline
 * as the person's own, so it gets no note; only a message that went elsewhere,
 * or is still on its way, does.
 */
export function routedReplyNotes(
  replies: readonly RoutedReply<unknown>[],
  threadMessages: readonly Pick<Message, "role" | "senderThreadId" | "text">[],
  threadId: string,
  coordinatorThreadId: string,
): RoutedReplyNote[] {
  const notes: RoutedReplyNote[] = [];
  for (const reply of replies) {
    const words = reply.text.trim();
    const deliveredHere = threadMessages.some(
      (message) =>
        message.role === "user" &&
        message.senderThreadId === coordinatorThreadId &&
        words !== "" &&
        message.text.includes(words),
    );
    if (deliveredHere) continue;
    const elsewhere = reply.answerThreadIds.find(
      (id) => id !== threadId && id !== coordinatorThreadId,
    );
    if (elsewhere !== undefined) {
      notes.push({ id: reply.id, text: words, kind: "sent", targetThreadId: elsewhere });
    } else if (reply.answer === null || reply.answerThreadIds.includes(threadId)) {
      // Not answered yet, or answered with a link back here: the delivery is on its way.
      notes.push({ id: reply.id, text: words, kind: "pending", targetThreadId: null });
    } else {
      notes.push({ id: reply.id, text: words, kind: "answered", targetThreadId: null });
    }
  }
  return notes;
}

/**
 * Places messages the person typed in a worker, and that never came back to it,
 * into its timeline at the time they were typed.
 */
export function withRoutedMessages<
  E extends { readonly createdAt: string },
  M extends { readonly id: string; readonly createdAt: string },
>(entries: readonly E[], messages: readonly M[] | undefined): readonly E[] {
  if (!messages?.length) return entries;
  const merged: Array<E> = [...entries];
  for (const message of messages) {
    const entry = {
      id: message.id,
      kind: "message",
      createdAt: message.createdAt,
      message,
    } as unknown as E;
    const at = merged.findIndex((existing) => existing.createdAt > message.createdAt);
    merged.splice(at === -1 ? merged.length : at, 0, entry);
  }
  return merged;
}

/**
 * What the person typed inside one thread. Those messages are stored on the
 * coordinator's conversation, so the thread's own record of them is read from there.
 */
export function routedRepliesForThread<At = string>(
  messages: readonly (Message & {
    readonly createdAt?: At | undefined;
    readonly streaming?: boolean | undefined;
  })[],
  project: { readonly id: string; readonly environmentId: string },
  thread: Worker,
): RoutedReply<At>[] {
  const replies: RoutedReply<At>[] = [];
  messages.forEach((message, index) => {
    const display = projectCoordinatorMessageDisplay(message, project, [thread]);
    if (display.sourceThread === null) return;
    let answer: string | null = null;
    let answerThreadIds: string[] = [];
    for (const next of messages.slice(index + 1)) {
      if (next.role === "user" && next.createdBy === "user") break;
      if (next.role === "assistant" && !next.streaming && next.text.trim() !== "") {
        // One line of plain text: the full answer, links and all, is in the coordinator.
        const plain = next.text
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
          .replace(/`|\*\*/g, "")
          .replace(/\s+/g, " ")
          .trim();
        answer = plain.length > 240 ? `${plain.slice(0, 239)}…` : plain;
        answerThreadIds = linkedThreadIds(next.text);
        break;
      }
    }
    replies.push({
      id: message.id,
      text: display.text,
      createdAt: message.createdAt ?? null,
      answer,
      answerThreadIds,
    });
  });
  return replies;
}

/** A coordinator tool call, as its turn items record it. */
type ToolCall = {
  readonly type: string;
  readonly status?: string | undefined;
  readonly toolName?: string | null | undefined;
  readonly input?: unknown;
  readonly output?: unknown;
};

/**
 * Where the coordinator's studio_thread_send calls delivered each forwarded
 * message, keyed by the message they forwarded. A call that has not finished,
 * failed, or left the message waiting in a held queue delivered nothing yet, so
 * it names no thread: the follow-up stays in view with what the coordinator said.
 */
function forwardTargets(
  turnItems: readonly ToolCall[],
): ReadonlyMap<string, readonly (string | null)[]> {
  const targets = new Map<string, (string | null)[]>();
  for (const item of turnItems) {
    if (item.type !== "dynamic_tool") continue;
    if (resolveStudioMcpToolId(item.toolName) !== "studio_thread_send") continue;
    const input = item.input as { forwardMessageId?: unknown; threadId?: unknown } | null;
    if (typeof input?.forwardMessageId !== "string" || typeof input.threadId !== "string") continue;
    const output = JSON.stringify(item.output ?? null);
    const delivered =
      item.status === "completed" &&
      !/"isError"\s*:\s*true/.test(output) &&
      !/\\?"queueHeld\\?"\s*:\s*true/.test(output);
    targets.set(input.forwardMessageId, [
      ...(targets.get(input.forwardMessageId) ?? []),
      delivered ? input.threadId : null,
    ]);
  }
  return targets;
}

/**
 * Follow-ups typed in a worker that the coordinator only passed back to that
 * same worker, with its replies in that turn. Sending a thread its own message
 * is routine, so the coordinator conversation leaves the exchange out; a
 * follow-up it moved elsewhere, kept, has not answered yet, or failed to pass on
 * still shows.
 *
 * The coordinator's own forward calls decide it: whatever it said around them,
 * a follow-up every forward delivered to its source worker went home. Without a
 * recorded forward, the replies' thread links decide it: some reply links the
 * source worker and none links another thread. Nothing is decided while a reply
 * is still streaming.
 */
export function returnedFollowUpIds(
  messages: readonly (Message & {
    readonly streaming?: boolean | undefined;
    readonly runId?: string | null | undefined;
  })[],
  project: { readonly id: string; readonly environmentId: string },
  workers: readonly Worker[],
  turnItems: readonly ToolCall[] = [],
): ReadonlySet<string> {
  const forwards = forwardTargets(turnItems);
  const ids = new Set<string>();
  messages.forEach((message, index) => {
    const source = projectCoordinatorMessageDisplay(message, project, workers).sourceThread;
    if (source === null) return;
    const replies: string[] = [];
    const linked = new Set<string>();
    let answered = false;
    let streaming = false;
    for (const next of messages.slice(index + 1)) {
      if (next.role === "user") break;
      if (next.role !== "assistant") continue;
      // A follow-up steered into a running turn shares it with an earlier
      // request; only the replies of the follow-up's own turn are its.
      const runId = message.runId ?? null;
      if (runId !== null && (next.runId ?? null) !== runId) continue;
      replies.push(next.id);
      if (next.streaming) streaming = true;
      if (next.streaming || next.text.trim() === "") continue;
      answered = true;
      for (const id of linkedThreadIds(next.text)) linked.add(id);
    }
    if (streaming) return;
    const delivered = forwards.get(message.id);
    const elsewhere = [...linked].some((id) => id !== source.id);
    const home =
      delivered !== undefined
        ? delivered.every((id) => id === source.id) && !elsewhere
        : answered && linked.has(source.id) && !elsewhere;
    if (!home) return;
    ids.add(message.id);
    for (const id of replies) ids.add(id);
  });
  return ids;
}

/**
 * The coordinator conversation's messages that carry a worker's report and fold
 * when long: a message a worker sent, and the coordinator's replies after a worker
 * reports back (a delegated-task completion or a worker's message), which relay
 * that report, until the person writes again.
 */
export function projectReportMessageIds(
  messages: readonly (Pick<Message, "id" | "role" | "createdBy"> & {
    readonly delegatedCompletion?: { readonly taskIds: readonly string[] } | undefined;
  })[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  let relaying = false;
  for (const message of messages) {
    if (message.delegatedCompletion?.taskIds.length) {
      relaying = true;
    } else if (message.role === "user") {
      relaying = message.createdBy === "agent";
      if (relaying) ids.add(message.id);
    } else if (relaying && message.role === "assistant") {
      ids.add(message.id);
    }
  }
  return ids;
}
