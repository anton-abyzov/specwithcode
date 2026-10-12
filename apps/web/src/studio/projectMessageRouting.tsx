import { createContext, useContext } from "react";
import {
  ChatAttachment as ChatAttachmentSchema,
  type ChatAttachment,
  type EnvironmentId,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

/** Where in the opened thread to land, such as a quoted passage. */
export interface ProjectThreadOpenOptions {
  readonly hash?: string;
  /** A fresh activation lets the same link reveal its passage again. */
  readonly state?: { readonly assistantCitationActivation?: string };
}

export interface ProjectMessageRouting {
  readonly coordinatorThreadId: ThreadId | null;
  readonly send: (prompt: string, attachments?: ReadonlyArray<ChatAttachment>) => Promise<void>;
  readonly openCoordinator: () => void;
  /**
   * Opens a thread in the project's right panel. Returns false when the thread
   * belongs elsewhere, so the caller opens it full page instead.
   */
  readonly openThread: (
    threadId: ThreadId,
    environmentId?: EnvironmentId,
    options?: ProjectThreadOpenOptions,
  ) => boolean;
}
export const ProjectMessageRoutingContext = createContext<ProjectMessageRouting | null>(null);
export const useProjectMessageRouting = () => useContext(ProjectMessageRoutingContext);

/** Keep native approval/question submission in its own runtime. Ordinary messages route once. */
export async function routeProjectComposerSend(
  routing: ProjectMessageRouting | null,
  input: {
    prompt: string;
    hasOtherContent: boolean;
    nativeInput: boolean;
    prepareAttachments?: () => Promise<ReadonlyArray<ChatAttachment>>;
    clear: () => void;
    reportError: (message: string) => void;
  },
): Promise<boolean> {
  if (!routing || input.nativeInput) return false;
  if (input.hasOtherContent) {
    input.reportError(
      "This reply has annotations or context cards. Keep this draft and send those from the full thread view.",
    );
    return true;
  }
  try {
    const attachments = await input.prepareAttachments?.();
    if (!input.prompt.trim() && !attachments?.length) return true;
    if (attachments?.length) await routing.send(input.prompt, attachments);
    else await routing.send(input.prompt);
    input.clear();
  } catch (error) {
    input.reportError(
      error instanceof Error
        ? error.message
        : "Message was not confirmed. Your draft is preserved; retry sends the same request.",
    );
  }
  return true;
}

type UploadReceipt = { key: string; attachments: ReadonlyArray<ChatAttachment> };
const inMemoryUploadReceipts = new Map<string, UploadReceipt[]>();
const isAttachment = Schema.is(ChatAttachmentSchema);

/** Reuse staged references after reload even when native verification would remint them. */
function draftUploadReceipt(scope: string, key: string) {
  const storageKey = `studio.project-draft-upload.v1:${scope}`;
  let receipts = inMemoryUploadReceipts.get(scope) ?? [];
  try {
    const raw = inMemoryUploadReceipts.has(scope)
      ? null
      : window.sessionStorage.getItem(storageKey);
    if (raw && raw.length <= 2_000_000) {
      const decoded: unknown = JSON.parse(raw);
      if (Array.isArray(decoded))
        receipts = decoded
          .filter(
            (entry): entry is UploadReceipt =>
              typeof entry?.key === "string" &&
              Array.isArray(entry.attachments) &&
              entry.attachments.every(
                (attachment: unknown) =>
                  isAttachment(attachment) && attachment.id.startsWith("pending-"),
              ),
          )
          .slice(-32);
    }
  } catch {
    /* The in-memory receipt still protects retries when browser storage is unavailable. */
  }
  function persist() {
    // Keep an empty in-memory tombstone after acknowledgement: a failed storage
    // removal must not resurrect the old staged refs on the next send.
    inMemoryUploadReceipts.set(scope, receipts);
    try {
      if (receipts.length) window.sessionStorage.setItem(storageKey, JSON.stringify(receipts));
      else window.sessionStorage.removeItem(storageKey);
    } catch {
      /* Preserve the in-memory request. */
    }
  }
  return {
    attachments: receipts.find((entry) => entry.key === key)?.attachments,
    remember(attachments: ReadonlyArray<ChatAttachment>) {
      receipts = [...receipts.filter((entry) => entry.key !== key), { key, attachments }].slice(
        -32,
      );
      persist();
    },
    acknowledge() {
      receipts = receipts.filter((entry) => entry.key !== key);
      persist();
    },
  };
}

/** Native upload preparation stays outside the large ChatView and clears only the captured draft. */
export async function sendProjectComposerDraft(input: {
  routing: ProjectMessageRouting;
  environmentId: EnvironmentId;
  draftTarget: import("../composerDraftStore").ComposerThreadTarget;
  promptRef: { current: string };
  supportsAttachmentUploads: boolean;
  hasDirectAnnotation: boolean;
  resetCursor: () => void;
  reportError: (message: string) => void;
}): Promise<void> {
  const prompt = input.promptRef.current;
  const { useComposerDraftStore } = await import("../composerDraftStore");
  const {
    startAttachmentUpload,
    awaitAttachmentUploads,
    getUploadedAttachments,
    releaseDraftAttachments,
  } = await import("../lib/attachmentUploadQueue");
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(input.draftTarget);
  const attachments = draft ? [...draft.images, ...draft.files] : [];
  const receipt = draftUploadReceipt(
    JSON.stringify([input.environmentId, input.draftTarget]),
    JSON.stringify([prompt, attachments.map((attachment) => attachment.id)]),
  );
  const hasContext = (value: typeof draft) =>
    Boolean(
      value &&
      (value.terminalContexts.length ||
        value.previewAnnotations.length ||
        value.reviewComments.length ||
        value.threadContexts.length),
    );
  await routeProjectComposerSend(input.routing, {
    prompt,
    nativeInput: false,
    hasOtherContent: input.hasDirectAnnotation || hasContext(draft),
    prepareAttachments: async () => {
      if (!attachments.length) return [];
      if (receipt.attachments) return receipt.attachments;
      if (!input.supportsAttachmentUploads)
        throw new Error("This host does not support attachment uploads.");
      for (const image of attachments)
        startAttachmentUpload({
          environmentId: input.environmentId,
          image,
          draftTarget: input.draftTarget,
        });
      await awaitAttachmentUploads(attachments.map((a) => a.id));
      const uploaded = getUploadedAttachments({
        environmentId: input.environmentId,
        images: attachments,
      });
      if (!uploaded) throw new Error("Retry or remove failed uploads before sending.");
      receipt.remember(uploaded);
      return uploaded;
    },
    clear: () => {
      receipt.acknowledge();
      const current = useComposerDraftStore.getState().getComposerDraft(input.draftTarget);
      const currentIds = current ? [...current.images, ...current.files].map((a) => a.id) : [];
      if (
        input.promptRef.current !== prompt ||
        hasContext(current) ||
        JSON.stringify(currentIds) !== JSON.stringify(attachments.map((a) => a.id))
      )
        return;
      input.promptRef.current = "";
      useComposerDraftStore.getState().clearComposerContent(input.draftTarget);
      releaseDraftAttachments(attachments);
      input.resetCursor();
    },
    reportError: input.reportError,
  });
}
