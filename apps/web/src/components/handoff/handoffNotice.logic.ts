import type { OrchestrationV2ThreadShell, ThreadId } from "@specweave-studio/contracts";

/** What the notification of an automatic hand off says on one machine. */
export interface HandoffNotice {
  /** One per move on this thread: the side and the thread on the other end. */
  readonly identity: string;
  readonly title: string;
  /** The line the move left in the thread: "Handed off to M5 at 14:02: …". */
  readonly body: string;
}

type NoticeThread = Pick<OrchestrationV2ThreadShell, "id" | "movedTo" | "movedFrom">;

/**
 * The notice an automatic hand off leaves on this thread (1390 AC-28), or null.
 * Only an automatic move writes a note on its link, so a move someone asked
 * for, which they already watched, raises nothing.
 */
export function handoffNoticeOf(thread: NoticeThread): HandoffNotice | null {
  const movedTo = thread.movedTo ?? null;
  if (movedTo !== null) {
    if (movedTo.kind !== "handoff" || !movedTo.note) return null;
    return {
      identity: `moved-to:${movedTo.threadId}`,
      title: movedTo.machineLabel ? `Handed off to ${movedTo.machineLabel}` : "Handed off",
      body: movedTo.note,
    };
  }
  const movedFrom = thread.movedFrom ?? null;
  if (movedFrom === null || movedFrom.kind !== "handoff" || !movedFrom.note) return null;
  return {
    identity: `moved-from:${movedFrom.threadId}`,
    title: movedFrom.machineLabel
      ? `Continued here from ${movedFrom.machineLabel}`
      : "Continued here",
    body: movedFrom.note,
  };
}

/**
 * The notices that are new since the last pass. The first pass, `seen` null,
 * only learns what is there: history is never announced. A thread that first
 * appears after that, such as a continuation arriving with its note, is new.
 */
export function observeHandoffNotices<T extends NoticeThread>(
  seen: ReadonlyMap<ThreadId, string | null> | null,
  threads: ReadonlyArray<T>,
): {
  readonly notices: ReadonlyArray<{ readonly thread: T; readonly notice: HandoffNotice }>;
  readonly seen: ReadonlyMap<ThreadId, string | null>;
} {
  const next = new Map<ThreadId, string | null>();
  const notices: Array<{ thread: T; notice: HandoffNotice }> = [];
  for (const thread of threads) {
    const notice = handoffNoticeOf(thread);
    next.set(thread.id, notice?.identity ?? null);
    if (seen !== null && notice !== null && seen.get(thread.id) !== notice.identity)
      notices.push({ thread, notice });
  }
  return { notices, seen: next };
}
