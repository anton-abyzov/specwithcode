import type { CoordinatorMessageRecord } from "./CoordinatorMessageStore.ts";

export interface CoordinatorMessageRepeat {
  readonly message: Pick<
    CoordinatorMessageRecord,
    "kind" | "subject" | "text" | "refs" | "userStep"
  >;
  readonly clientRequestId: string;
  readonly droppedRefs: CoordinatorMessageRecord["droppedRefs"];
  readonly admittedUnder: CoordinatorMessageRecord["admittedUnder"];
  readonly paused: boolean;
  readonly now: number;
  readonly settleMs: number;
}

/**
 * Folds a repeat send into its unread row. The newest send replaces the content, step
 * included, under its own admission, so the day limit runs from this send; an urgent
 * problem (one with a step for the user) leaves a digest and wakes on its own.
 */
export const mergeRepeat = (
  unread: CoordinatorMessageRecord,
  repeat: CoordinatorMessageRepeat,
): CoordinatorMessageRecord => {
  const { message, now } = repeat;
  const { userStep: _dropped, ...rest } = unread;
  const unfold =
    unread.state === "folded" && message.kind === "problem" && message.userStep !== undefined;
  return {
    ...rest,
    receivedAt: now,
    ...(unfold
      ? {
          state: repeat.paused ? ("held" as const) : ("settling" as const),
          deliverAfter: now + repeat.settleMs,
        }
      : {}),
    clientRequestIds: [...unread.clientRequestIds, repeat.clientRequestId].slice(-32),
    subject: message.subject,
    text: message.text,
    refs: message.refs,
    ...(message.userStep === undefined ? {} : { userStep: message.userStep }),
    droppedRefs: repeat.droppedRefs,
    admittedUnder: repeat.admittedUnder,
    revision: (unread.revision ?? 0) + 1,
    count: unread.count + 1,
    updatedAt: now,
  };
};
