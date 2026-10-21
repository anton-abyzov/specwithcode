import type {
  ComposerFileAttachment,
  ComposerImageAttachment,
  ComposerThreadDraftState,
} from "./composerDraftStore";
import { stripInlineContextReferences } from "./lib/composerContextReferences";

export type QuestionChatReply =
  /** Nothing typed or attached: the option picked on the card answers. */
  | { readonly kind: "none" }
  | { readonly kind: "blocked"; readonly reason: string }
  | {
      readonly kind: "reply";
      readonly text: string;
      readonly images: ReadonlyArray<ComposerImageAttachment>;
      readonly files: ReadonlyArray<ComposerFileAttachment>;
    };

/**
 * What a send from the chat composer does while a question card waits: the
 * thread draft, text and files, becomes the answer to the active question.
 */
export function planQuestionChatReply(input: {
  readonly draft: ComposerThreadDraftState | null | undefined;
  readonly allowCustomAnswer: boolean | undefined;
  readonly supportsQuestionAttachments: boolean;
}): QuestionChatReply {
  const draft = input.draft;
  if (!draft) return { kind: "none" };
  const text = stripInlineContextReferences(draft.prompt).trim();
  const hasFiles = draft.images.length > 0 || draft.files.length > 0;
  const hasOtherContext =
    draft.terminalContexts.length > 0 ||
    draft.previewAnnotations.length > 0 ||
    draft.reviewComments.length > 0 ||
    draft.threadContexts.length > 0;
  if (text.length === 0 && !hasFiles && !hasOtherContext) return { kind: "none" };
  if (input.allowCustomAnswer === false) {
    return { kind: "blocked", reason: "Choose an option above to answer this question." };
  }
  if (hasOtherContext) {
    return {
      kind: "blocked",
      reason:
        "An answer carries text, images and files. Remove the other context, or dismiss the question to send it as a message.",
    };
  }
  if (hasFiles && !input.supportsQuestionAttachments) {
    return { kind: "blocked", reason: "Update this server to send files with question answers." };
  }
  return { kind: "reply", text, images: draft.images, files: draft.files };
}
