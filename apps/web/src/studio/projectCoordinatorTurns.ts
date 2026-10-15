import { formatDuration } from "@specweave-studio/shared/orchestrationTiming";

import { epochMillis } from "./projectThreadMentions";

/** A pause this long between two messages starts a new time separator. */
const SEPARATOR_GAP_MS = 60 * 60_000;

export interface CoordinatorTurnMessage {
  readonly id: string;
  readonly role: string;
  /** An ISO string, a `Date` or an Effect `DateTime`; anything else counts as no time. */
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
  readonly streaming: boolean;
  /** Shown as a system notice (a worker's report): it never starts, joins or ends a turn. */
  readonly notice?: boolean;
}

export interface CoordinatorTurnLayout {
  /** A time separator goes above this message, naming this ISO time. */
  readonly separatorAt: string | null;
  /** "Worked for 14s" above the first reply to a person's message. */
  readonly workedFor: string | null;
  /** The reply that ends its turn carries the copy and time actions. */
  readonly endsTurn: boolean;
  /** When this message last changed, as ISO text, or null when it carries no time. */
  readonly settledAt: string | null;
}

function iso(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}

function sameLocalDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/**
 * Where the coordinator conversation puts its separators, work summaries and
 * action rows: a reply turn is every non-user message after a user message.
 * Pass only the messages the conversation shows, so a reply Concise hides
 * neither carries nor ends a turn.
 */
export function coordinatorTurnLayout(
  messages: readonly CoordinatorTurnMessage[],
): ReadonlyMap<string, CoordinatorTurnLayout> {
  // A notice (a worker's report) takes a separator but stands outside the turns.
  const turnMessages = messages.filter((message) => !message.notice);
  const turnOf = new Map<string, Pick<CoordinatorTurnLayout, "workedFor" | "endsTurn">>();
  turnMessages.forEach((message, index) => {
    const previous = turnMessages[index - 1];
    const next = turnMessages[index + 1];
    const isReply = message.role !== "user";
    let workedFor: string | null = null;
    if (isReply && previous?.role === "user") {
      // The turn lasts until its last reply settles.
      let last = message;
      for (let i = index + 1; i < turnMessages.length && turnMessages[i]!.role !== "user"; i++) {
        last = turnMessages[i]!;
      }
      const start = epochMillis(previous.createdAt);
      const end = epochMillis(last.updatedAt) ?? epochMillis(last.createdAt);
      if (!last.streaming && start !== null && end !== null && end - start >= 1_000) {
        workedFor = `Worked for ${formatDuration(end - start)}`;
      }
    }
    turnOf.set(message.id, {
      workedFor,
      endsTurn: isReply && !message.streaming && (next === undefined || next.role === "user"),
    });
  });

  const layout = new Map<string, CoordinatorTurnLayout>();
  let previousAt: number | null = null;
  for (const message of messages) {
    const at = epochMillis(message.createdAt);
    const separatorAt =
      at !== null &&
      (previousAt === null || at - previousAt >= SEPARATOR_GAP_MS || !sameLocalDay(at, previousAt))
        ? iso(at)
        : null;
    if (at !== null) previousAt = at;
    layout.set(message.id, {
      separatorAt,
      workedFor: turnOf.get(message.id)?.workedFor ?? null,
      endsTurn: turnOf.get(message.id)?.endsTurn ?? false,
      settledAt: iso(epochMillis(message.updatedAt) ?? at),
    });
  }
  return layout;
}

/** "Today 9:53 PM", "Yesterday 9:53 PM", "Monday 9:53 PM", then "Mon, Oct 5 9:53 PM". */
export function formatConversationSeparator(
  isoTime: string,
  formatTime: (iso: string) => string,
  nowMs: number = Date.now(),
): string {
  const at = epochMillis(isoTime);
  if (at === null) return "";
  const date = new Date(at);
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfDay) / 86_400_000);
  const clock = formatTime(isoTime);
  if (dayDiff === 0) return `Today ${clock}`;
  if (dayDiff === 1) return `Yesterday ${clock}`;
  // Within a week the weekday is enough; after that the date, and the year once it differs.
  const day = date.toLocaleDateString(
    undefined,
    dayDiff > 0 && dayDiff < 7
      ? { weekday: "long" }
      : {
          weekday: "short",
          month: "short",
          day: "numeric",
          ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
        },
  );
  return `${day} ${clock}`;
}
