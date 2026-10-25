/**
 * Who asked a question and which message answered it. An answer to an ask_user
 * card is a user message `async-answer:<requestId>` holding only the person's
 * words; the card it answers names the agent that asked.
 */
import type { OrchestrationV2TurnItem, RuntimeRequestId } from "@specweave-studio/contracts";

import { isOrchestratorThreadId } from "./projectCoordinatorThreads";

type QuestionItem = Extract<OrchestrationV2TurnItem, { type: "user_input_request" }>;
export type AnsweredQuestion = QuestionItem & {
  readonly questionAnswer: NonNullable<QuestionItem["questionAnswer"]>;
};

export const COORDINATOR_ASKER = "Coordinator";

/** The name a question card gives the agent that asked: the coordinator, or the thread. */
export function questionAskerLabel(input: {
  readonly threadId: string;
  readonly title: string | null | undefined;
  /** The project names this thread as its coordinator. */
  readonly isCoordinator?: boolean | undefined;
}): string {
  if (input.isCoordinator === true || isOrchestratorThreadId(input.threadId))
    return COORDINATOR_ASKER;
  return input.title?.trim() || "This thread's agent";
}

export const questionAnswerMessageId = (requestId: string) => `async-answer:${requestId}`;

/**
 * Each answered card by the id of the message that answered it. A card answered
 * with its own controls folds that message; a reply typed in chat stays the
 * person's message beside the card.
 */
export function answeredQuestionsByMessageId(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyMap<string, { readonly item: AnsweredQuestion; readonly folded: boolean }> {
  const answered = new Map<string, { item: AnsweredQuestion; folded: boolean }>();
  for (const item of turnItems) {
    if (item.type !== "user_input_request" || item.questionAnswer === undefined) continue;
    answered.set(questionAnswerMessageId(item.questionAnswer.requestId), {
      item: item as AnsweredQuestion,
      folded: item.questionAnswer.answeredInChat !== true,
    });
  }
  return answered;
}

function fnv1a(value: string, seed: number): number {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

// Answers this page saw the host refuse, by request.
const refusedAnswers = new Map<string, number>();

/**
 * The host refused an answer outright, so nothing was recorded for it. The next
 * send is a new command: a host that keeps refusals would otherwise replay this
 * one even after its cause has cleared.
 */
export function noteRefusedQuestionAnswer(requestId: string): void {
  refusedAnswers.set(requestId, (refusedAnswers.get(requestId) ?? 0) + 1);
}

/**
 * One command id per request and answer: sending the same answer again, after a
 * lost response or a reload, replays the command the host already took instead
 * of being refused as a second answer. A changed answer is a new command.
 */
export function questionAnswerCommandId(input: {
  readonly requestId: RuntimeRequestId;
  readonly answers: Readonly<Record<string, unknown>>;
  readonly attachmentIdsByQuestionId: Readonly<Record<string, ReadonlyArray<string>>>;
}): string {
  const body = stableJson({ answers: input.answers, files: input.attachmentIdsByQuestionId });
  const digest = `${fnv1a(body, 0x811c9dc5).toString(36)}${fnv1a(body, 0x050c5d1f).toString(36)}`;
  const refused = refusedAnswers.get(input.requestId) ?? 0;
  return `answer:${input.requestId}:${digest}${refused > 0 ? `:${refused}` : ""}`;
}

/** The host's refusal of an answer to a request that is no longer pending. */
export function isSettledRequestRefusal(message: string, requestId: string): boolean {
  return (
    message === `Runtime request ${requestId} is resolved.` ||
    message === `Runtime request ${requestId} is cancelled.`
  );
}

/** Said beside the composer when a question was settled before this answer reached it. */
export const QUESTION_ALREADY_SETTLED =
  "This question was already answered or closed, so your reply was not sent. It is still in the box: send it as a message, or clear it.";

/** The same, for an answer given on the card: nothing of it is in the box. */
export const QUESTION_ALREADY_SETTLED_ON_CARD =
  "This question was already answered or closed, so your answer was not sent.";

/** Said beside the composer when the connection dropped while an answer was being sent. */
export const QUESTION_SEND_INTERRUPTED =
  "Sending the answer was interrupted. Send it again: the same answer is delivered once.";

/** The files an answer carried, by question, in the order they were sent. */
export type SentQuestionFiles = Readonly<
  Record<string, ReadonlyArray<{ readonly type: string; readonly name: string }>>
>;

export interface RecordedRuntimeRequest {
  readonly id: string;
  readonly status: string;
  readonly answers?: Readonly<Record<string, unknown>> | undefined;
  readonly decision?: string | undefined;
}

// The host's line for each file of an answer (see appendUserInputAttachmentPaths).
const isFileReferenceBlock = (value: unknown, files: SentQuestionFiles[string]) => {
  if (typeof value !== "string") return false;
  const lines = value.split("\n");
  return (
    lines.length === files.length &&
    lines.every((line, index) =>
      line.startsWith(`Attached ${files[index]!.type} ${JSON.stringify(files[index]!.name)}: `),
    )
  );
};

function isSameRecordedAnswer(
  recorded: unknown,
  sent: unknown,
  files: SentQuestionFiles[string],
): boolean {
  if (files.length === 0) return stableJson(recorded) === stableJson(sent);
  // The host appends the references: an element of their own, else after a blank line.
  if (Array.isArray(sent))
    return (
      Array.isArray(recorded) &&
      recorded.length === sent.length + 1 &&
      stableJson(recorded.slice(0, -1)) === stableJson(sent) &&
      isFileReferenceBlock(recorded.at(-1), files)
    );
  if (typeof sent !== "string" || sent.length === 0) return isFileReferenceBlock(recorded, files);
  return (
    typeof recorded === "string" &&
    recorded.startsWith(`${sent}\n\n`) &&
    isFileReferenceBlock(recorded.slice(sent.length + 2), files)
  );
}

/**
 * The host already holds this answer: the request is resolved with these words
 * and these files. A resend refused as "resolved" then means the first send
 * landed, not that someone else answered.
 */
export function isRecordedQuestionAnswer(
  requests: ReadonlyArray<RecordedRuntimeRequest> | undefined,
  requestId: string,
  answers: Readonly<Record<string, unknown>>,
  files: SentQuestionFiles = {},
): boolean {
  const request = requests?.find((entry) => entry.id === requestId);
  if (request?.status !== "resolved" || request.answers === undefined) return false;
  const recorded = request.answers;
  const ids = new Set([...Object.keys(recorded), ...Object.keys(answers)]);
  return [...ids].every((id) => isSameRecordedAnswer(recorded[id], answers[id], files[id] ?? []));
}
