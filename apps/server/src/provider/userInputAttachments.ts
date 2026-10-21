import type {
  ChatAttachment,
  ProviderUserInputAnswers,
  UserInputAttachments,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { resolveAttachmentPath } from "../attachmentStore.ts";
class UserInputAttachmentError extends Schema.TaggedError<UserInputAttachmentError>()(
  "UserInputAttachmentError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const quoteReference = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const referencePrefix = (attachment: Pick<ChatAttachment, "type" | "name">) =>
  `Attached ${attachment.type} ${quoteReference(attachment.name)}: `;

/**
 * The answer as the user gave it: drops the path lines `appendUserInputAttachmentPaths`
 * added for these attachments, for a reply that carries the files themselves.
 */
export function answerWithoutAttachmentPaths(
  answer: string | ReadonlyArray<string>,
  attachments: ReadonlyArray<Pick<ChatAttachment, "type" | "name">>,
): string | ReadonlyArray<string> {
  if (attachments.length === 0) return answer;
  const isBlock = (text: string) => {
    const lines = text.split("\n");
    return (
      lines.length === attachments.length &&
      lines.every((line, index) => line.startsWith(referencePrefix(attachments[index]!)))
    );
  };
  if (typeof answer !== "string") {
    const last = answer.at(-1);
    return last !== undefined && isBlock(last) ? answer.slice(0, -1) : answer;
  }
  if (isBlock(answer)) return "";
  const lines = answer.split("\n");
  const block = lines.slice(-attachments.length).join("\n");
  const rest = lines.slice(0, -attachments.length).join("\n");
  return rest.endsWith("\n") && isBlock(block) ? rest.slice(0, -1) : answer;
}

/** Every answer without the path lines added for its question's attachments. */
export function answersWithoutAttachmentPaths(
  answers: ProviderUserInputAnswers,
  attachmentsByQuestionId: UserInputAttachments,
): ProviderUserInputAnswers {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, answer]) => {
      const attachments = Object.hasOwn(attachmentsByQuestionId, questionId)
        ? (attachmentsByQuestionId[questionId] ?? [])
        : [];
      const text =
        typeof answer === "string" ||
        (Array.isArray(answer) && answer.every((entry) => typeof entry === "string"))
          ? answerWithoutAttachmentPaths(answer as string | ReadonlyArray<string>, attachments)
          : answer;
      return [questionId, text];
    }),
  );
}

/** Keep provider answer protocols unchanged; paths refer to files on the provider's server. */
export const appendUserInputAttachmentPaths = Effect.fn("appendUserInputAttachmentPaths")(
  function* (input: {
    answers: ProviderUserInputAnswers;
    attachmentsByQuestionId?: UserInputAttachments | undefined;
    attachmentsDir: string;
  }) {
    const answers = new Map(Object.entries(input.answers));
    const fs = yield* FileSystem.FileSystem;
    for (const [questionId, attachments] of Object.entries(input.attachmentsByQuestionId ?? {})) {
      if (attachments.length === 0) continue;
      const references: string[] = [];
      for (const attachment of attachments) {
        const path = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
        if (
          !path ||
          !(yield* fs.exists(path).pipe(
            Effect.mapError(
              (cause) =>
                new UserInputAttachmentError({
                  operation: "respondToUserInput",
                  issue: `Could not access attachment '${attachment.name}'.`,
                  cause,
                }),
            ),
          ))
        ) {
          return yield* new UserInputAttachmentError({
            operation: "respondToUserInput",
            issue: `Attachment '${attachment.name}' is no longer available. Attach it again.`,
          });
        }
        references.push(`${referencePrefix(attachment)}${quoteReference(path)}`);
      }
      const answer = answers.get(questionId);
      const text = references.join("\n");
      answers.set(
        questionId,
        Array.isArray(answer)
          ? [...answer, text]
          : typeof answer === "string" && answer.length > 0
            ? `${answer}\n\n${text}`
            : text,
      );
    }
    return Object.fromEntries(answers);
  },
);
