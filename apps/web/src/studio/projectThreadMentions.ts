import { DateTime } from "effect";
import type { ThreadId } from "@specweave-studio/contracts";
import { parseStudioThreadHref } from "@specweave-studio/shared/studioThreadLinks";

const PREPARED_THREAD_LINK = /\]\((studio:\/\/thread\/[^)\s]+)\)/g;

/**
 * The threads a message links to after prepareProjectMarkdown, in order, each
 * once. That rewrites every link to one of the project's threads to the
 * canonical href, whose ID segment decodes once to the thread's ID.
 */
export function linkedThreadIds(prepared: string): string[] {
  const ids: string[] = [];
  for (const match of prepared.matchAll(PREPARED_THREAD_LINK)) {
    const id = parseStudioThreadHref(match[1]!)?.[0];
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Host messages carry Effect DateTimes, thread shells ISO strings; fixtures may carry neither. */
export function epochMillis(value: unknown): number | null {
  if (DateTime.isDateTime(value)) return DateTime.toEpochMillis(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

type MentionMessage = {
  readonly id: string;
  readonly role: string;
  /** Thread IDs this message links to, from linkedThreadIds. */
  readonly linked: readonly string[];
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
};

/** A thread can be created a moment before the message that names it is stamped. */
const CLOCK_SLACK_MS = 2_000;

/**
 * Which coordinator messages announce a thread the coordinator started. A thread
 * created during the turn that a message answers, and named there for the first
 * time, is new: it gets a card under that message. Every other mention is a link
 * to a thread that already existed. Without the turn's opening message (history
 * not loaded yet) nothing is called new.
 */
export function newThreadsByMessage(
  messages: readonly MentionMessage[],
  threads: readonly { readonly id: ThreadId; readonly createdAt?: unknown }[],
): Map<string, ThreadId[]> {
  const cards = new Map<string, ThreadId[]>();
  const named = new Set<string>();
  let turnStart: number | null = null;
  for (const message of messages) {
    if (message.role !== "assistant") {
      turnStart = epochMillis(message.createdAt);
      continue;
    }
    const end = epochMillis(message.updatedAt) ?? epochMillis(message.createdAt);
    const fresh: ThreadId[] = [];
    for (const id of message.linked) {
      if (named.has(id)) continue;
      named.add(id);
      const thread = threads.find((t) => t.id === id);
      const created = thread ? epochMillis(thread.createdAt) : null;
      if (
        thread &&
        created !== null &&
        turnStart !== null &&
        end !== null &&
        created >= turnStart - CLOCK_SLACK_MS &&
        created <= end + CLOCK_SLACK_MS
      )
        fresh.push(thread.id);
    }
    if (fresh.length > 0) cards.set(message.id, fresh);
  }
  return cards;
}
