import {
  RuntimeRequestId,
  type OrchestrationV2ConversationMessage,
  type UserInputQuestion,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

/**
 * An answer to an ask_user card is a user message under this id. Its text is
 * the person's words only: the agent's question is never written into a
 * message the conversation shows as theirs. The agent still reads each
 * question beside its answer, added when the message reaches the provider.
 */
const ANSWER_MESSAGE_PREFIX = "async-answer:";

export const questionAnswerMessageId = (requestId: RuntimeRequestId) =>
  `${ANSWER_MESSAGE_PREFIX}${requestId}`;

export function questionAnswerRequestId(messageId: string): RuntimeRequestId | null {
  if (!messageId.startsWith(ANSWER_MESSAGE_PREFIX)) return null;
  const id = messageId.slice(ANSWER_MESSAGE_PREFIX.length);
  return id.length === 0 ? null : RuntimeRequestId.make(id);
}

/** One label per question: its header, numbered where two share one. */
export function questionAnswerLabels(
  questions: ReadonlyArray<Pick<UserInputQuestion, "header">>,
): string[] {
  const headers = questions.map((question) => question.header.trim() || "Question");
  return headers.map((header, index) =>
    headers.filter((other) => other === header).length > 1 ? `${header} ${index + 1}` : header,
  );
}

export interface QuestionAnswerReply {
  readonly label: string;
  readonly answer: string;
  readonly files: ReadonlyArray<{ readonly name: string }>;
}

/**
 * What the conversation shows as the person's message. The answer to a card's
 * only question reads as written; on a card with several, each answer is
 * labelled by its question's header, and an answer that is only files names
 * them.
 */
export function questionAnswerMessageText(
  replies: ReadonlyArray<QuestionAnswerReply>,
  questionCount: number,
): string {
  if (questionCount <= 1 && replies.length === 1) return replies[0]!.answer;
  return replies
    .map(({ label, answer, files }) => {
      const words = answer.length > 0 ? answer : files.map((file) => file.name).join(", ");
      return words.includes("\n") ? `${label}:\n${words}` : `${label}: ${words}`;
    })
    .join("\n\n");
}

/** What the agent reads: the questions it asked, then the person's message. */
export function questionAnswerProviderText(
  questions: ReadonlyArray<Pick<UserInputQuestion, "header" | "question">>,
  text: string,
): string {
  const labels = questionAnswerLabels(questions);
  const asked = questions.map((question, index) => `${labels[index]}: ${question.question}`);
  const answer = text.trim().length > 0 ? text : "(The answer is in the attached files.)";
  return questions.length === 1
    ? `The user answered the question you asked with ask_user.\nYou asked: ${asked[0]}\nTheir answer:\n${answer}`
    : `The user answered the questions you asked with ask_user.\nYou asked:\n${asked.join("\n")}\nTheir answers, labelled by question:\n${answer}`;
}

/**
 * The provider text of a message: for an ask_user answer, the questions it
 * answers come first. Any other message, or an answer whose card is gone,
 * is unchanged.
 */
export const withAskedQuestions = (
  projections: Pick<ProjectionStoreV2Shape, "getRuntimeResponseContext">,
  message: Pick<OrchestrationV2ConversationMessage, "id" | "threadId" | "role">,
  text: string,
) =>
  Effect.gen(function* () {
    const requestId = message.role === "user" ? questionAnswerRequestId(message.id) : null;
    if (requestId === null) return text;
    const context = yield* projections
      .getRuntimeResponseContext(message.threadId, requestId)
      .pipe(Effect.orElseSucceed(() => undefined));
    const item = context?.item;
    if (item?.type !== "user_input_request" || item.questions.length === 0) return text;
    return questionAnswerProviderText(item.questions, text);
  });
