import type { ThreadId } from "@specweave-studio/contracts";
import { formatStudioThreadLink } from "@specweave-studio/shared/studioThreadLinks";

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

/** Presentation only: retain the stored routing prompt and its receipt identity. */
export function projectCoordinatorMessageDisplay(
  message: Message,
  project: { readonly id: string; readonly environmentId: string },
  workers: readonly Worker[],
): { text: string; sourceThread: Worker | null } {
  const unchanged = { text: message.text, sourceThread: null };
  const idPrefix = `coordinator-send:${project.id}:`;
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
  const prefix = `User follow-up from selected worker ${sourceThread.id}. Review that thread and decide whether to reuse it or route elsewhere.\n\n`;
  return message.text.startsWith(prefix)
    ? { text: message.text.slice(prefix.length), sourceThread }
    : unchanged;
}

/** Assistant replies are also created by an agent; only a user-role message from another thread is a worker's. */
export function projectMessageAuthor(message: Pick<Message, "role" | "createdBy">) {
  if (message.role !== "user") return "Coordinator";
  return message.createdBy === "agent" ? "Message from a worker" : "You";
}

/**
 * A delegated-task completion is a server wake addressed to the coordinator's model
 * ("Use task_status with taskId …"); people see which worker reported back instead.
 */
export function projectSystemNotice(
  message: {
    readonly delegatedCompletion?: { readonly taskIds: readonly string[] } | undefined;
    readonly notification?: { readonly summary: string } | undefined;
  },
  workers: readonly Pick<Worker, "id" | "title">[],
): string | null {
  const taskIds = message.delegatedCompletion?.taskIds;
  if (!taskIds?.length) return message.notification?.summary ?? null;
  const names = [
    ...new Set(
      taskIds.flatMap((taskId) => {
        const prefix = "node:delegated-task:";
        const worker = taskId.startsWith(prefix)
          ? workers.find((w) => w.id === `thread:delegated-task:${taskId.slice(prefix.length)}`)
          : undefined;
        const label = worker?.title.replace(/[[\]\n]/g, " ").trim();
        return worker && label ? [formatStudioThreadLink(worker.id, label)] : [];
      }),
    ),
  ];
  if (names.length === 0)
    return taskIds.length === 1 ? "A worker reported back." : "Workers reported back.";
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${list} reported back.`;
}

export type RoutedReply<At = string> = {
  readonly id: string;
  readonly text: string;
  readonly createdAt: At | null;
  /** What the coordinator said next, once it has answered. */
  readonly answer: string | null;
};

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
        break;
      }
    }
    replies.push({
      id: message.id,
      text: display.text,
      createdAt: message.createdAt ?? null,
      answer,
    });
  });
  return replies;
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
