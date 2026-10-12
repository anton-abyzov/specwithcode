/** What the voice call needs to see of the coordinator conversation. */
export interface CoordinatorReplySnapshot {
  /** False while the coordinator conversation is still loading into this window. */
  readonly loaded: boolean;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly streaming: boolean;
    readonly runId: string | null;
    // Set on user-role messages the host writes itself, never on what the caller said.
    readonly notification?: unknown;
    readonly delegatedCompletion?: unknown;
    readonly senderThreadId?: unknown;
    readonly scheduledTaskId?: unknown;
  }>;
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly userMessageId: string;
    readonly ordinal: number;
    readonly status: string;
  }>;
  /** Run id and message of the latest failed coordinator turn, if any. */
  readonly failure: { readonly runId: string; readonly message: string } | null;
}

export type CoordinatorReplyOutcome =
  | { readonly kind: "pending" }
  | { readonly kind: "reply"; readonly text: string | null }
  | { readonly kind: "failed"; readonly message: string };

const ACTIVE_RUN = new Set(["queued", "preparing", "starting", "running", "waiting"]);
/** A finished turn whose answer has not reached this window yet gets this long. */
export const REPLY_SETTLE_MS = 4_000;
/** The call stops waiting after this long; a longer answer is still read in the chat. */
export const REPLY_TIMEOUT_MS = 5 * 60_000;
export const REPLY_TIMEOUT_MESSAGE =
  "The coordinator is still working on that. Its answer will be in the chat.";

type SnapshotMessage = CoordinatorReplySnapshot["messages"][number];

function spokenByCaller(message: SnapshotMessage): boolean {
  return (
    message.role === "user" &&
    message.notification === undefined &&
    message.delegatedCompletion === undefined &&
    message.senderThreadId === undefined &&
    message.scheduledTaskId === undefined
  );
}

/**
 * Waits for the coordinator's answer to one spoken message: the turn started
 * by that message ends, and its last finished assistant message is the reply.
 */
export class CoordinatorReplyWaiter {
  private readonly knownIds: ReadonlySet<string>;
  private readonly sent: string;
  private startedAt: number | null = null;
  private endedAt: number | null = null;

  constructor(before: Pick<CoordinatorReplySnapshot, "messages">, sentText: string) {
    this.knownIds = new Set(before.messages.map((message) => message.id));
    this.sent = sentText.trim();
  }

  observe(snapshot: CoordinatorReplySnapshot, now: number): CoordinatorReplyOutcome {
    this.startedAt ??= now;
    const outcome = this.check(snapshot, now);
    if (outcome.kind === "pending" && now - this.startedAt >= REPLY_TIMEOUT_MS) {
      return { kind: "failed", message: REPLY_TIMEOUT_MESSAGE };
    }
    return outcome;
  }

  private check(snapshot: CoordinatorReplySnapshot, now: number): CoordinatorReplyOutcome {
    const fresh = snapshot.messages.filter((message) => !this.knownIds.has(message.id));
    // The caller's own message: same text if the host kept it, else the first one they sent.
    const candidates = fresh.filter(spokenByCaller);
    const asked = candidates.find((message) => message.text.trim() === this.sent) ?? candidates[0];
    if (!asked) return { kind: "pending" };
    const askedAt = fresh.indexOf(asked);
    let run: CoordinatorReplySnapshot["runs"][number] | null = null;
    for (const candidate of snapshot.runs) {
      if (candidate.userMessageId !== asked.id) continue;
      if (run === null || candidate.ordinal > run.ordinal) run = candidate;
    }
    if (run === null || ACTIVE_RUN.has(run.status)) return { kind: "pending" };
    if (run.status === "failed") {
      return {
        kind: "failed",
        message:
          snapshot.failure?.runId === run.id
            ? snapshot.failure.message
            : "The coordinator could not answer.",
      };
    }
    const replies = fresh
      .slice(askedAt + 1)
      .filter((message) => message.role === "assistant" && !message.streaming);
    const own = replies.filter((message) => message.runId === run.id);
    const last = (own.length > 0 ? own : replies).at(-1);
    if (last) return { kind: "reply", text: last.text };
    this.endedAt ??= now;
    // The turn ended without writing anything, or its message is still on the way.
    return now - this.endedAt >= REPLY_SETTLE_MS
      ? { kind: "reply", text: null }
      : { kind: "pending" };
  }
}
