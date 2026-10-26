import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { THIS_MACHINE_NOT_SENT } from "../../lib/transientSendRetry";

import {
  QUESTION_ALREADY_SETTLED,
  QUESTION_ALREADY_SETTLED_ON_CARD,
  QUESTION_SEND_INTERRUPTED,
  type RecordedRuntimeRequest,
} from "../../studio/coordinatorQuestionAnswers";
import {
  QUESTION_ANSWER_SENT,
  QUESTION_DISMISSED,
  QUESTION_SETTLED_ELSEWHERE,
  type QuestionSettleClaims,
} from "./questionLiveStatus";
import {
  answerProblemFor,
  DISMISS_ALREADY_SETTLED,
  isAnswerProblemOutdated,
  settledSendReason,
  settleQuestionAnswer,
  settleQuestionDismiss,
  questionSendResult,
  shownAnswerProblem,
  type QuestionSendResult,
} from "./questionSendOutcome";

/** The page's side: what it claimed, released or expects, and what it said. */
function harness(initial: ReadonlyArray<RecordedRuntimeRequest>) {
  let requests = initial;
  const said: string[] = [];
  const expected = new Map<string, () => string | null>();
  const released: string[] = [];
  const landed: string[] = [];
  const elsewhere: string[] = [];
  const settle: QuestionSettleClaims = {
    claim: () => {},
    release: (id) => released.push(id),
    expect: (id, outcome) => expected.set(id, outcome),
  };
  return {
    said,
    released,
    landed,
    elsewhere,
    expected,
    /** Whether the reason beside the box shows when the question settles elsewhere. */
    reasonShows: true,
    settle,
    announce: (text: string) => said.push(text),
    runtimeRequests: () => requests,
    /** The host's projection catches up and the request settles. */
    settleNow(next: ReadonlyArray<RecordedRuntimeRequest>, id: string) {
      requests = next;
      const text = expected.get(id)?.();
      if (text) said.push(text);
    },
  };
}
const pending = [{ id: "ask-1", status: "pending" }];
const resolvedWith = (answers: Record<string, unknown>) => [
  { id: "ask-1", status: "resolved", answers },
];
const answer = (
  page: ReturnType<typeof harness>,
  result: QuestionSendResult,
  files = {},
  heldInBox = true,
) =>
  settleQuestionAnswer({
    result,
    requestId: "ask-1",
    answers: { q1: "Tall" },
    files,
    heldInBox,
    runtimeRequests: page.runtimeRequests,
    settle: page.settle,
    announce: page.announce,
    onLanded: () => page.landed.push("ask-1"),
    onSettledElsewhere: (problem) => showReason(page, problem.text),
  });
/** The page's reason beside the box: shown, unless the harness says a newer question outdates it. */
const showReason = (page: ReturnType<typeof harness>, text: string) => {
  if (page.reasonShows) page.elsewhere.push(text);
  return page.reasonShows;
};

describe("settleQuestionAnswer", () => {
  it("a sent answer is delivered and announced", () => {
    const page = harness(pending);
    expect(answer(page, { kind: "sent" })).toBeNull();
    expect(page.said).toEqual([QUESTION_ANSWER_SENT]);
  });

  it("an interrupted send is decided when the request settles", () => {
    const page = harness(pending);
    expect(answer(page, { kind: "interrupted" })).toEqual({
      text: QUESTION_SEND_INTERRUPTED,
      settled: false,
    });
    page.settleNow(resolvedWith({ q1: "Tall" }), "ask-1");
    expect(page.said).toEqual([QUESTION_ANSWER_SENT]);
    expect(page.landed).toEqual(["ask-1"]);
  });

  it("a send refused in transit that landed anyway is announced as sent", () => {
    const page = harness(pending);
    expect(answer(page, { kind: "refused", message: "Network error" })).toEqual({
      text: "Network error",
      settled: false,
    });
    page.settleNow(resolvedWith({ q1: "Tall" }), "ask-1");
    expect(page.said).toEqual([QUESTION_ANSWER_SENT]);
  });

  it("a refused answer whose question another answer settles says so, once", () => {
    const page = harness(pending);
    answer(page, { kind: "refused", message: "The coordinator is handing off." });
    page.settleNow(resolvedWith({ q1: "Compact" }), "ask-1");
    expect(page.landed).toEqual([]);
    // The visible reason turns from the refusal to the settled question, and is the news.
    expect(page.elsewhere).toEqual([QUESTION_ALREADY_SETTLED]);
    expect(page.said).toEqual([]);
  });

  it("a settle whose reason does not show is said by the live status", () => {
    const page = harness(pending);
    page.reasonShows = false;
    answer(page, { kind: "interrupted" });
    page.settleNow(resolvedWith({ q1: "Compact" }), "ask-1");
    expect(page.elsewhere).toEqual([]);
    expect(page.said).toEqual([QUESTION_SETTLED_ELSEWHERE]);
  });

  it("an answer given on the card is not said to be in the box", () => {
    const page = harness(pending);
    answer(page, { kind: "interrupted" }, {}, false);
    page.settleNow(resolvedWith({ q1: "Compact" }), "ask-1");
    expect(page.elsewhere).toEqual([QUESTION_ALREADY_SETTLED_ON_CARD]);
    const late = harness(resolvedWith({ q1: "Compact" }));
    expect(answer(late, { kind: "interrupted" }, {}, false)).toEqual({
      text: QUESTION_ALREADY_SETTLED_ON_CARD,
      settled: true,
    });
    const refused = harness(pending);
    expect(
      answer(refused, { kind: "refused", message: "Runtime request ask-1 is resolved." }, {}, false)
        ?.text,
    ).toBe(QUESTION_ALREADY_SETTLED_ON_CARD);
  });

  it("an uncertain result arriving after its request settled is decided at once", () => {
    const landedFirst = harness(resolvedWith({ q1: "Tall" }));
    expect(answer(landedFirst, { kind: "interrupted" })).toBeNull();
    expect(answer(landedFirst, { kind: "refused", message: "Network error" })).toBeNull();
    expect(landedFirst.said).toEqual([QUESTION_ANSWER_SENT, QUESTION_ANSWER_SENT]);
    expect(landedFirst.expected.size).toBe(0);

    const otherFirst = harness(resolvedWith({ q1: "Compact" }));
    expect(answer(otherFirst, { kind: "interrupted" })).toEqual({
      text: QUESTION_ALREADY_SETTLED,
      settled: true,
    });
    // The reason beside the box is the news.
    expect(otherFirst.elsewhere).toEqual([QUESTION_ALREADY_SETTLED]);
    expect(otherFirst.said).toEqual([]);
    expect(otherFirst.released).toEqual(["ask-1"]);
    expect(otherFirst.expected.size).toBe(0);

    // A follow-up newer than the send already waits: no reason, the live status says it.
    const followUpFirst = harness(resolvedWith({ q1: "Compact" }));
    followUpFirst.reasonShows = false;
    expect(answer(followUpFirst, { kind: "refused", message: "Network error" })?.settled).toBe(
      true,
    );
    expect(followUpFirst.elsewhere).toEqual([]);
    expect(followUpFirst.said).toEqual([QUESTION_SETTLED_ELSEWHERE]);
  });

  it("a resolved refusal is delivered when the host holds these words and files", () => {
    const page = harness(
      resolvedWith({ q1: 'Tall\n\nAttached image "shot.png": "/attachments/shot.png"' }),
    );
    const problem = answer(
      page,
      { kind: "refused", message: "Runtime request ask-1 is resolved." },
      { q1: [{ type: "image", name: "shot.png" }] },
    );
    expect(problem).toBeNull();
    expect(page.said).toEqual([QUESTION_ANSWER_SENT]);
  });

  it("a resolved refusal of other words is settled, and outlives the card", () => {
    const page = harness(resolvedWith({ q1: "Compact" }));
    expect(
      answer(page, { kind: "refused", message: "Runtime request ask-1 is resolved." }),
    ).toEqual({ text: QUESTION_ALREADY_SETTLED, settled: true });
    expect(page.elsewhere).toEqual([QUESTION_ALREADY_SETTLED]);
    expect(page.released).toEqual(["ask-1"]);
    expect(page.expected.size).toBe(0);
  });

  it("a resolved refusal the page has not seen settle yet is decided when it does", () => {
    const page = harness(pending);
    answer(page, { kind: "refused", message: "Runtime request ask-1 is resolved." });
    // Why, at once; the settle then finds this page's own answer.
    expect(page.elsewhere).toEqual([QUESTION_ALREADY_SETTLED]);
    page.settleNow(resolvedWith({ q1: "Tall" }), "ask-1");
    expect(page.said).toEqual([QUESTION_ANSWER_SENT]);
    expect(page.landed).toEqual(["ask-1"]);

    // Settled with another answer: the reason stays the news, said once.
    const other = harness(pending);
    answer(other, { kind: "refused", message: "Runtime request ask-1 is resolved." });
    other.settleNow(resolvedWith({ q1: "Compact" }), "ask-1");
    expect(other.elsewhere).toEqual([QUESTION_ALREADY_SETTLED, QUESTION_ALREADY_SETTLED]);
    expect(other.said).toEqual([]);
  });
});

describe("settleQuestionDismiss", () => {
  const dismiss = (page: ReturnType<typeof harness>, result: QuestionSendResult) =>
    settleQuestionDismiss({
      result,
      requestId: "ask-1",
      runtimeRequests: page.runtimeRequests,
      settle: page.settle,
      announce: page.announce,
      onSettledElsewhere: (problem) => showReason(page, problem.text),
    });

  it("a dismissal is announced; an interrupted one once the host records it", () => {
    const page = harness(pending);
    expect(dismiss(page, { kind: "sent" })).toBeNull();
    expect(dismiss(page, { kind: "interrupted" })).toBeNull();
    page.settleNow([{ id: "ask-1", status: "resolved", decision: "cancel" }], "ask-1");
    expect(page.said).toEqual([QUESTION_DISMISSED, QUESTION_DISMISSED]);
  });

  it("an interrupted dismissal that another answer beat says so", () => {
    const page = harness(pending);
    dismiss(page, { kind: "interrupted" });
    page.settleNow(resolvedWith({ q1: "Compact" }), "ask-1");
    expect(page.said).toEqual([QUESTION_SETTLED_ELSEWHERE]);
    // Already settled when the result comes back: said at once.
    const late = harness([{ id: "ask-1", status: "resolved", decision: "cancel" }]);
    expect(dismiss(late, { kind: "interrupted" })).toBeNull();
    expect(late.said).toEqual([QUESTION_DISMISSED]);
    expect(late.expected.size).toBe(0);
  });

  it("a refused dismissal lets a later settle be announced", () => {
    const page = harness(pending);
    dismiss(page, { kind: "refused", message: "No permission." });
    expect(page.released).toEqual(["ask-1"]);
  });

  it("a refused dismissal of a request this page cannot see keeps the host's words", () => {
    // The page moved to another thread before the refusal came back.
    const page = harness([]);
    expect(dismiss(page, { kind: "refused", message: "No permission." })).toEqual({
      text: "No permission.",
      settled: false,
    });
    expect(page.said).toEqual([]);
    expect(page.elsewhere).toEqual([]);
  });

  it("a dismissal refused because the question settled is a settled problem", () => {
    const page = harness(resolvedWith({ q1: "Compact" }));
    expect(dismiss(page, { kind: "refused", message: DISMISS_ALREADY_SETTLED })).toEqual({
      text: DISMISS_ALREADY_SETTLED,
      settled: true,
    });
    expect(page.elsewhere).toEqual([DISMISS_ALREADY_SETTLED]);
    expect(page.said).toEqual([]);
    expect(dismiss(harness(pending), { kind: "refused", message: "No permission." })?.settled).toBe(
      false,
    );
  });

  it("a dismissal refused as settled before this page sees it settle is said once", () => {
    const page = harness(pending);
    expect(dismiss(page, { kind: "refused", message: DISMISS_ALREADY_SETTLED })?.settled).toBe(
      true,
    );
    // Not released: the settle is this page's to decide, not someone else's to announce.
    expect(page.released).toEqual([]);
    page.settleNow(resolvedWith({ q1: "Compact" }), "ask-1");
    expect(page.elsewhere).toEqual([DISMISS_ALREADY_SETTLED, DISMISS_ALREADY_SETTLED]);
    expect(page.said).toEqual([]);

    // Outdated by then: no reason, so the live status says it.
    const outdated = harness(pending);
    dismiss(outdated, { kind: "refused", message: DISMISS_ALREADY_SETTLED });
    outdated.reasonShows = false;
    outdated.settleNow(resolvedWith({ q1: "Compact" }), "ask-1");
    expect(outdated.said).toEqual([QUESTION_SETTLED_ELSEWHERE]);
  });
});

describe("shownAnswerProblem", () => {
  const settled = answerProblemFor({
    threadId: "thread-1",
    requestId: "ask-1",
    problem: { text: QUESTION_ALREADY_SETTLED, settled: true },
    pendingRequestIds: ["ask-1", "ask-2"],
  });
  const waiting = answerProblemFor({
    threadId: "thread-1",
    requestId: "ask-1",
    problem: { text: "Network error", settled: false },
    pendingRequestIds: ["ask-1"],
  });

  it("shows a waiting request's reason only while it waits, in its own thread", () => {
    expect(shownAnswerProblem(waiting, "thread-1", ["ask-1"])).toBe("Network error");
    expect(shownAnswerProblem(waiting, "thread-1", [])).toBeNull();
    expect(shownAnswerProblem(waiting, "thread-2", ["ask-1"])).toBeNull();
  });

  it("keeps a settled question's reason until a new question arrives", () => {
    expect(shownAnswerProblem(settled, "thread-1", [])).toBe(QUESTION_ALREADY_SETTLED);
    expect(shownAnswerProblem(settled, "thread-1", ["ask-2"])).toBe(QUESTION_ALREADY_SETTLED);
    expect(shownAnswerProblem(settled, "thread-1", ["ask-3"])).toBeNull();
    expect(shownAnswerProblem(null, "thread-1", [])).toBeNull();
  });

  it("retires a settled question's reason once a newer question waits", () => {
    expect(isAnswerProblemOutdated(settled, "thread-1", [])).toBe(false);
    expect(isAnswerProblemOutdated(settled, "thread-1", ["ask-2"])).toBe(false);
    expect(isAnswerProblemOutdated(settled, "thread-1", ["ask-3"])).toBe(true);
    expect(isAnswerProblemOutdated(settled, "thread-2", ["ask-3"])).toBe(false);
    expect(isAnswerProblemOutdated(waiting, "thread-1", ["ask-3"])).toBe(false);
  });

  it("judges a settled reason only by its own thread's questions", () => {
    // Thread-1's refusal came back while the page shows thread-2 and its b-1.
    expect(isAnswerProblemOutdated(settled, "thread-2", ["b-1"])).toBe(false);
    expect(isAnswerProblemOutdated(settled, null, ["b-1"])).toBe(false);
  });

  it("keeps a settled reason while this page still shows its own request waiting", () => {
    // Dismiss refused as already answered before the page saw the request settle.
    const early = answerProblemFor({
      threadId: "thread-1",
      requestId: "ask-1",
      problem: { text: DISMISS_ALREADY_SETTLED, settled: true },
      pendingRequestIds: ["ask-1"],
    });
    expect(isAnswerProblemOutdated(early, "thread-1", ["ask-1"])).toBe(false);
    expect(shownAnswerProblem(early, "thread-1", ["ask-1"])).toBeNull();
    expect(shownAnswerProblem(early, "thread-1", [])).toBe(DISMISS_ALREADY_SETTLED);
    expect(isAnswerProblemOutdated(early, "thread-1", ["ask-1", "ask-2"])).toBe(true);
  });
});

describe("settledSendReason", () => {
  const reason = (activeThreadId: string | null, pendingRequestIds: ReadonlyArray<string>) =>
    settledSendReason({
      threadId: "thread-1",
      requestId: "ask-1",
      problem: { text: QUESTION_ALREADY_SETTLED, settled: true },
      waitingAtSend: ["ask-1"],
      activeThreadId,
      pendingRequestIds,
    });

  it("keeps its own thread's reason unless a newer question outdates it", () => {
    expect(reason("thread-1", [])?.text).toBe(QUESTION_ALREADY_SETTLED);
    expect(reason("thread-1", ["ask-1"])?.settledRequestId).toBe("ask-1");
    expect(reason("thread-1", ["ask-2"])).toBeNull();
  });

  it("keeps another thread's reason whatever the shown thread waits on", () => {
    expect(reason("thread-2", ["b-1"])).toMatchObject({
      threadId: "thread-1",
      text: QUESTION_ALREADY_SETTLED,
    });
    expect(reason(null, ["b-1"])?.threadId).toBe("thread-1");
  });

  it("keeps a waiting request's reason as it is", () => {
    const waiting = settledSendReason({
      threadId: "thread-1",
      requestId: "ask-1",
      problem: { text: "Network error", settled: false },
      waitingAtSend: ["ask-1"],
      activeThreadId: "thread-1",
      pendingRequestIds: ["ask-1", "ask-2"],
    });
    expect(waiting).toEqual({ threadId: "thread-1", requestId: "ask-1", text: "Network error" });
  });
});

describe("questionSendResult", () => {
  const notConnected = AsyncResult.failure(
    Cause.fail(
      Object.assign(new Error("Anton's MacBook M4MAX is not connected."), {
        _tag: "EnvironmentRpcUnavailableError",
      }),
    ),
  );

  it("says the app's own machine is busy when it did not take the answer", () => {
    expect(questionSendResult(notConnected, "Failed to submit user input.", true)).toEqual({
      kind: "refused",
      message: THIS_MACHINE_NOT_SENT,
    });
  });

  it("keeps another machine's words", () => {
    expect(questionSendResult(notConnected, "Failed to submit user input.")).toEqual({
      kind: "refused",
      message: "Anton's MacBook M4MAX is not connected.",
    });
  });
});
