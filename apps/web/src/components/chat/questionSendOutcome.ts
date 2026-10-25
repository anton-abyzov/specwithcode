/**
 * What one answer or dismissal of a question comes to, for a thread and for the
 * project coordinator alike: what to announce, what to show beside the
 * composer, and what to settle once the host's projection catches up.
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";

import {
  isRecordedQuestionAnswer,
  isSettledRequestRefusal,
  noteRefusedQuestionAnswer,
  QUESTION_ALREADY_SETTLED,
  QUESTION_ALREADY_SETTLED_ON_CARD,
  QUESTION_SEND_INTERRUPTED,
  type RecordedRuntimeRequest,
  type SentQuestionFiles,
} from "../../studio/coordinatorQuestionAnswers";
import {
  QUESTION_ANSWER_SENT,
  QUESTION_DISMISSED,
  QUESTION_SETTLED_ELSEWHERE,
  type QuestionSettleClaims,
} from "./questionLiveStatus";

export type QuestionSendResult =
  | { readonly kind: "sent" }
  /** The connection dropped: the host may or may not have taken it. */
  | { readonly kind: "interrupted" }
  | { readonly kind: "refused"; readonly message: string };

/** A command's result as a question's send sees it. */
export function questionSendResult(
  result: AtomCommandResult<unknown, unknown>,
  fallback: string,
): QuestionSendResult {
  if (result._tag === "Success") return { kind: "sent" };
  if (isAtomCommandInterrupted(result)) return { kind: "interrupted" };
  const error = squashAtomCommandFailure(result);
  return { kind: "refused", message: error instanceof Error ? error.message : fallback };
}

export interface QuestionSendProblem {
  readonly text: string;
  /** The question is settled, so the reason outlives its card. */
  readonly settled: boolean;
}

/** The host's refusal to dismiss a question that is no longer pending. */
export const DISMISS_ALREADY_SETTLED = "This question has already been answered.";

const requestStatus = (
  requests: ReadonlyArray<RecordedRuntimeRequest> | undefined,
  requestId: string,
) => requests?.find((request) => request.id === requestId)?.status;

/**
 * Settles an answer's send. Null means delivered: the draft that held it can
 * go. A send whose outcome is unknown is decided when the request settles: the
 * host holding these words and files means it landed, and `onLanded` clears
 * what it sent. A question settled without this answer goes to
 * `onSettledElsewhere`, and the returned settled problem is only a sign to keep
 * the draft: its reason is already handled.
 */
export function settleQuestionAnswer(input: {
  readonly result: QuestionSendResult;
  readonly requestId: string;
  readonly answers: Readonly<Record<string, unknown>>;
  readonly files: SentQuestionFiles;
  /** The answer came from the chat box, which still holds it; else from the card. */
  readonly heldInBox: boolean;
  /** The page's latest runtime requests, read when called. */
  readonly runtimeRequests: () => ReadonlyArray<RecordedRuntimeRequest> | undefined;
  readonly settle: QuestionSettleClaims;
  readonly announce: (text: string) => void;
  readonly onLanded: () => void;
  /**
   * Shows why the answer went nowhere; false when a question newer than the
   * send outdates that reason and it was never shown, so nothing told. A reason
   * that shows, or showed, is the news: the live status stays quiet rather than
   * say it twice.
   */
  readonly onSettledElsewhere: (problem: QuestionSendProblem) => boolean;
}): QuestionSendProblem | null {
  const { result, requestId, settle } = input;
  const settledElsewhere: QuestionSendProblem = {
    text: input.heldInBox ? QUESTION_ALREADY_SETTLED : QUESTION_ALREADY_SETTLED_ON_CARD,
    settled: true,
  };
  const landed = () =>
    isRecordedQuestionAnswer(input.runtimeRequests(), requestId, input.answers, input.files);
  if (result.kind === "sent") {
    input.announce(QUESTION_ANSWER_SENT);
    return null;
  }
  const status = requestStatus(input.runtimeRequests(), requestId);
  if (status !== undefined && status !== "pending") {
    // Its settle reached the page first and passed in silence: decide now.
    settle.release(requestId);
    if (landed()) {
      // An earlier send of these words and files landed: that is the answer, delivered.
      input.announce(QUESTION_ANSWER_SENT);
      return null;
    }
    if (!input.onSettledElsewhere(settledElsewhere)) input.announce(QUESTION_SETTLED_ELSEWHERE);
    return settledElsewhere;
  }
  // Still waiting on this page: decide once the request settles.
  settle.expect(requestId, () => {
    if (landed()) {
      input.onLanded();
      return QUESTION_ANSWER_SENT;
    }
    return input.onSettledElsewhere(settledElsewhere) ? null : QUESTION_SETTLED_ELSEWHERE;
  });
  // It may have landed: a resend replays the same command, and the settle tells.
  if (result.kind === "interrupted") return { text: QUESTION_SEND_INTERRUPTED, settled: false };
  if (isSettledRequestRefusal(result.message, requestId)) {
    // The host settled it before this page saw whose answer it was: say why
    // now; the settle, once seen, decides again and says nothing twice.
    input.onSettledElsewhere(settledElsewhere);
    return settledElsewhere;
  }
  // Refused outright; a send that failed in transit can still have landed.
  noteRefusedQuestionAnswer(requestId);
  return { text: result.message, settled: false };
}

/** Settles a dismissal's send, as `settleQuestionAnswer` does an answer's. */
export function settleQuestionDismiss(input: {
  readonly result: QuestionSendResult;
  readonly requestId: string;
  readonly runtimeRequests: () => ReadonlyArray<RecordedRuntimeRequest> | undefined;
  readonly settle: QuestionSettleClaims;
  readonly announce: (text: string) => void;
  /** As for an answer: shows a settled question's reason, or false when outdated. */
  readonly onSettledElsewhere: (problem: QuestionSendProblem) => boolean;
}): QuestionSendProblem | null {
  const { result, requestId, settle } = input;
  if (result.kind === "sent") {
    input.announce(QUESTION_DISMISSED);
    return null;
  }
  const request = () => input.runtimeRequests()?.find((entry) => entry.id === requestId);
  // The host records a dismissal as a cancel decision.
  const outcome = () =>
    request()?.decision === "cancel" ? QUESTION_DISMISSED : QUESTION_SETTLED_ELSEWHERE;
  if (result.kind === "interrupted") {
    const status = request()?.status;
    if (status === undefined || status === "pending") settle.expect(requestId, outcome);
    else {
      // Its settle reached the page first and passed in silence: say it now.
      settle.release(requestId);
      input.announce(outcome());
    }
    return null;
  }
  const status = requestStatus(input.runtimeRequests(), requestId);
  const pending = status === "pending";
  // A request this page cannot see is unknown, not settled: the host's words stand.
  const problem = {
    text: result.message,
    settled: result.message === DISMISS_ALREADY_SETTLED || (status !== undefined && !pending),
  };
  if (!problem.settled) {
    settle.release(requestId);
    return problem;
  }
  if (pending) {
    // Refused as settled before this page saw it settle: its reason is the
    // news, so the settle, once seen, decides again and says nothing twice.
    input.onSettledElsewhere(problem);
    settle.expect(requestId, () =>
      input.onSettledElsewhere(problem) ? null : QUESTION_SETTLED_ELSEWHERE,
    );
  } else {
    settle.release(requestId);
    if (!input.onSettledElsewhere(problem)) input.announce(QUESTION_SETTLED_ELSEWHERE);
  }
  return problem;
}

/** Why a thread's answer was not sent, as the composer shows it. */
export interface AnswerProblem {
  readonly threadId: string;
  /** Shown while this request waits; null for a question already settled. */
  readonly requestId: string | null;
  readonly text: string;
  /** For a settled question: the requests still waiting when it was refused. */
  readonly waitingThen?: ReadonlyArray<string>;
  /** For a settled question: its own request, which this page may still show waiting. */
  readonly settledRequestId?: string;
}

export function answerProblemFor(input: {
  readonly threadId: string;
  readonly requestId: string;
  readonly problem: QuestionSendProblem;
  readonly pendingRequestIds: ReadonlyArray<string>;
}): AnswerProblem {
  const { threadId, requestId, problem } = input;
  return problem.settled
    ? {
        threadId,
        requestId: null,
        text: problem.text,
        waitingThen: input.pendingRequestIds.filter((id) => id !== requestId),
        settledRequestId: requestId,
      }
    : { threadId, requestId, text: problem.text };
}

/**
 * The reason to show for this thread, if any. One about a waiting request goes
 * once it settles; one about a settled question stays until a new question
 * arrives, or until the next send clears it.
 */
export function shownAnswerProblem(
  problem: AnswerProblem | null,
  threadId: string | null,
  pendingRequestIds: ReadonlyArray<string>,
): string | null {
  if (problem === null || problem.threadId !== threadId) return null;
  const relevant =
    problem.requestId === null
      ? pendingRequestIds.every((id) => problem.waitingThen?.includes(id) === true)
      : pendingRequestIds.includes(problem.requestId);
  return relevant ? problem.text : null;
}

/**
 * A settled question's reason is outdated once a newer question waits: retire
 * it. Its own request is not newer, even while this page has yet to see it settle.
 */
export function isAnswerProblemOutdated(
  problem: AnswerProblem | null,
  threadId: string | null,
  pendingRequestIds: ReadonlyArray<string>,
): boolean {
  return (
    problem !== null &&
    problem.requestId === null &&
    problem.threadId === threadId &&
    pendingRequestIds.some(
      (id) => id !== problem.settledRequestId && problem.waitingThen?.includes(id) !== true,
    )
  );
}

/**
 * The reason to keep for a send, or null when a question of its own thread
 * newer than the send outdates it. Only that thread's questions judge it: one
 * for a thread the page has left waits for its return.
 */
export function settledSendReason(input: {
  readonly threadId: string;
  readonly requestId: string;
  readonly problem: QuestionSendProblem;
  /** The requests waiting when the person sent it. */
  readonly waitingAtSend: ReadonlyArray<string>;
  /** The thread the page shows now, and its waiting requests. */
  readonly activeThreadId: string | null;
  readonly pendingRequestIds: ReadonlyArray<string>;
}): AnswerProblem | null {
  const reason = answerProblemFor({
    threadId: input.threadId,
    requestId: input.requestId,
    problem: input.problem,
    pendingRequestIds: input.waitingAtSend,
  });
  return isAnswerProblemOutdated(reason, input.activeThreadId, input.pendingRequestIds)
    ? null
    : reason;
}
