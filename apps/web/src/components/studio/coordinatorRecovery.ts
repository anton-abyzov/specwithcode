import { useEffect, useRef } from "react";
import * as Schema from "effect/Schema";
import {
  ChatAttachment as ChatAttachmentSchema,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProjectWorkspaceError,
  fullAccessAcpProjectFolders,
} from "@specweave-studio/contracts";
import type {
  ChatAttachment,
  EnvironmentId,
  ProjectEnvironmentSettings,
  RuntimeMode,
  ProviderInteractionMode,
} from "@specweave-studio/contracts";
import type { CoordinatorAttachment } from "./shell/CoordinatorAttachments";
import { isImageAttachment, isFileAttachment } from "../../types";
import { randomUUID } from "../../lib/utils";

/** The host resolves these paths before enforcing grants; the picker conservatively explains them. */
export function coordinatorRequiresFolderGrants(
  environment: ProjectEnvironmentSettings | null | undefined,
  workspaceRoot: string,
): boolean {
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  return Boolean(
    environment?.additionalFolders.length ||
    environment?.repositories.some((repository) => {
      const path = repository.localPath;
      return (
        path !== null &&
        path !== root &&
        !path.startsWith(`${root}/`) &&
        !path.startsWith(`${root}\\`)
      );
    }),
  );
}

export const COORDINATOR_FOLDER_GUIDANCE =
  "This project needs additional folder access. With the current restricted policy, choose Codex or Claude for the coordinator.";
export interface CoordinatorFolderPolicy {
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  approvalPolicy?: unknown;
  sandboxPolicy?: unknown;
}

export function coordinatorFolderCompatibility(
  requiresGrants: boolean,
  driver: string | undefined,
  policy?: CoordinatorFolderPolicy,
  supportedRuntimeModes?: ReadonlyArray<RuntimeMode> | undefined,
): string | null {
  const unrestrictedAcp =
    driver === "acpRegistry" &&
    policy !== undefined &&
    fullAccessAcpProjectFolders(policy) &&
    (!supportedRuntimeModes?.length || supportedRuntimeModes.includes("full-access"));
  return requiresGrants &&
    driver !== undefined &&
    driver !== "codex" &&
    driver !== "claudeAgent" &&
    !unrestrictedAcp
    ? COORDINATOR_FOLDER_GUIDANCE
    : null;
}

/** Only an actual user-authored message is eligible, including an attachment-only message. */
export function coordinatorRetryMessage<
  M extends {
    role: string;
    createdBy: string;
    text: string;
    attachments: ReadonlyArray<ChatAttachment>;
  },
>(messages: ReadonlyArray<M>): M | null {
  return (
    messages.findLast((message) => message.role === "user" && message.createdBy === "user") ?? null
  );
}

/** Remove only the one outer wrapper the server adds when persisting a worker follow-up. */
export function coordinatorRetryPrompt(
  message: { id: string; text: string; senderThreadId?: string | null | undefined },
  projectId: string,
  sourceThreadId: string | undefined,
): string {
  if (
    sourceThreadId === undefined ||
    message.senderThreadId !== sourceThreadId ||
    !message.id.startsWith(`coordinator-send:${projectId}:`)
  )
    return message.text;
  const prefix = `User follow-up from selected worker ${sourceThreadId}. Review that thread and decide whether to reuse it or route elsewhere.\n\n`;
  return message.text.startsWith(prefix) ? message.text.slice(prefix.length) : message.text;
}

/** Download through authenticated asset URLs, then mint fresh pending uploads in this host. */
export async function restageCoordinatorAttachments(input: {
  environmentId: EnvironmentId;
  attachments: ReadonlyArray<ChatAttachment>;
  read: (attachment: ChatAttachment, signal?: AbortSignal) => Promise<Blob>;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  onReleaseReady?: (release: () => void) => void;
  queue?: Pick<
    typeof import("../../lib/attachmentUploadQueue"),
    | "startAttachmentUpload"
    | "awaitAttachmentUploads"
    | "getUploadedAttachments"
    | "releaseDraftAttachment"
  >;
}): Promise<{ attachments: ReadonlyArray<ChatAttachment>; release: () => void }> {
  if (!input.attachments.length) return { attachments: [], release: () => {} };
  const queue = input.queue ?? (await import("../../lib/attachmentUploadQueue"));
  const drafts: CoordinatorAttachment[] = [];
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const draft of drafts) queue.releaseDraftAttachment(draft);
  };
  input.onReleaseReady?.(release);
  const assertCurrent = () => {
    input.signal?.throwIfAborted();
    if (input.isCurrent && !input.isCurrent())
      throw new Error(
        "The project changed while restoring the message. Your original message is preserved.",
      );
  };
  try {
    assertCurrent();
    for (const attachment of input.attachments) {
      if (!isImageAttachment(attachment) && !isFileAttachment(attachment))
        throw new Error(
          `Could not restore ${attachment.name}: its attachment type is unsupported. Your original message is preserved.`,
        );
      let bytes: Blob;
      try {
        bytes = await whileRestoring(input.read(attachment, input.signal), input.signal);
      } catch {
        throw new Error(
          `Could not restore ${attachment.name}. Your original message and attachments are preserved. Retry when the host is available, or attach the file again.`,
        );
      }
      assertCurrent();
      if (attachment.sizeBytes !== bytes.size)
        throw new Error(
          `Could not restore ${attachment.name}: its saved bytes did not match. Your original message is preserved.`,
        );
      const common = {
        id: randomUUID(),
        file: new File([bytes], attachment.name, { type: attachment.mimeType }),
      };
      // Previews belong to the saved message, so this temporary upload needs no object URL.
      const draft: CoordinatorAttachment = isImageAttachment(attachment)
        ? { ...attachment, ...common, type: "image", previewUrl: "" }
        : { ...attachment, ...common, type: "file" };
      drafts.push(draft);
      queue.startAttachmentUpload({ environmentId: input.environmentId, image: draft });
    }
    await whileRestoring(
      queue.awaitAttachmentUploads(drafts.map((draft) => draft.id)),
      input.signal,
    );
    assertCurrent();
    const attachments = queue.getUploadedAttachments({
      environmentId: input.environmentId,
      images: drafts,
    });
    if (
      !attachments ||
      attachments.length !== drafts.length ||
      attachments.some((attachment) => !attachment.id.startsWith("pending-"))
    )
      throw new Error(
        "Could not restore all message attachments. Your original text and files are preserved; retry or attach them again.",
      );
    // The retained replay receipt needs ids only, never the downloaded File bytes.
    const cleanup = drafts.map((draft) => ({
      type: "file" as const,
      id: draft.id,
      name: draft.name,
      mimeType: draft.mimeType,
      sizeBytes: draft.sizeBytes,
      file: null,
    }));
    return { attachments, release: releaseRestagedIds(queue, cleanup) };
  } catch (error) {
    release();
    throw error;
  }
}

/** Asset RPCs may not support cancellation; detach their result immediately on navigation. */
function whileRestoring<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

function releaseRestagedIds(
  queue: { releaseDraftAttachment: (attachment: CoordinatorAttachment) => void },
  ids: ReadonlyArray<import("../../composerDraftStore").ComposerFileAttachment>,
): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const id of ids) queue.releaseDraftAttachment(id);
  };
}

interface CoordinatorRecoveryReceipt {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly release: () => void;
  sending: boolean;
  confirmed?: boolean;
  rejected?: boolean;
}
/** Session-local replay references, scoped to host/project/message/failure. Never evict an
 * uncertain dispatch: changing its pending ids would also change the send receipt fingerprint.
 * Confirmed acknowledgements keep an exact-key metadata-only tombstone for this browser session.
 * Cached failure switches cannot prove a causal advance and never evict confirmation. Consumed uploads are released; uncertain ones are not.
 * Canceled pre-dispatch uploads never enter this map.
 * Session storage keeps validated pending ids across page reloads. Source metadata comes only
 * from the original scoped message. No file bytes, signed URLs or credentials are stored. */
const coordinatorRecoveryReceipts = new Map<string, CoordinatorRecoveryReceipt>();
const coordinatorSubmissionOwners = new WeakMap<object, symbol>();

const RECOVERY_STORAGE_PREFIX = "studio.coordinator-recovery.v1:";
const validReplayAttachment = Schema.is(ChatAttachmentSchema);
const replayStorageError = () =>
  new Error(
    "Retry needs browser session storage to preserve the same request identity. Your original message and files are preserved.",
  );
const confirmedRetryError = () =>
  new Error("This retry was confirmed. Refresh coordinator history before retrying again.");
function recoveryStorage(): Storage {
  try {
    const storage = window.sessionStorage;
    if (!storage) throw replayStorageError();
    return storage;
  } catch {
    throw replayStorageError();
  }
}
function persistRecoveryReceipt(
  storage: Storage,
  key: string,
  replay: CoordinatorRecoveryReceipt,
): void {
  // Source capture metadata is restored from the original scoped message; it is never stored here.
  const attachments = replay.attachments.map(({ id, type, name, mimeType, sizeBytes }) => ({
    id,
    type,
    name,
    mimeType,
    sizeBytes,
  }));
  try {
    storage.setItem(
      RECOVERY_STORAGE_PREFIX + encodeURIComponent(key),
      JSON.stringify(
        replay.confirmed ? { version: 1, confirmed: true } : { version: 1, attachments },
      ),
    );
  } catch {
    throw replayStorageError();
  }
}
function restoreRecoveryReceipt(
  storage: Storage,
  key: string,
  environmentId: EnvironmentId,
  originals: ReadonlyArray<ChatAttachment>,
): CoordinatorRecoveryReceipt | undefined {
  let raw: string | null;
  try {
    raw = storage.getItem(RECOVERY_STORAGE_PREFIX + encodeURIComponent(key));
  } catch {
    throw replayStorageError();
  }
  if (raw === null) return undefined;
  const invalid = () =>
    new Error(
      "The saved retry receipt cannot be restored safely. Refresh the coordinator history before retrying. Your original message and files are preserved.",
    );
  let decoded: unknown;
  try {
    if (raw.length > 100_000) throw invalid();
    decoded = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (
    decoded &&
    typeof decoded === "object" &&
    "version" in decoded &&
    decoded.version === 1 &&
    "confirmed" in decoded &&
    decoded.confirmed === true &&
    Object.keys(decoded).length === 2
  )
    return { attachments: [], sending: false, confirmed: true, release: () => {} };
  if (
    !decoded ||
    typeof decoded !== "object" ||
    !("version" in decoded) ||
    decoded.version !== 1 ||
    !("attachments" in decoded) ||
    !Array.isArray(decoded.attachments) ||
    Object.keys(decoded).some((key) => !["version", "attachments"].includes(key)) ||
    decoded.attachments.length !== originals.length ||
    decoded.attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS
  )
    throw invalid();
  const attachments: ChatAttachment[] = [];
  for (let index = 0; index < decoded.attachments.length; index++) {
    const value: unknown = decoded.attachments[index];
    const original = originals[index]!;
    if (
      !validReplayAttachment(value) ||
      !(isImageAttachment(value) || isFileAttachment(value)) ||
      !value.id.startsWith("pending-") ||
      Object.keys(value).some(
        (key) => !["id", "type", "name", "mimeType", "sizeBytes"].includes(key),
      ) ||
      value.type !== original.type ||
      value.name !== original.name ||
      value.mimeType !== original.mimeType ||
      value.sizeBytes !== original.sizeBytes
    )
      throw invalid();
    attachments.push(
      isImageAttachment(value) && isImageAttachment(original)
        ? { ...original, id: value.id }
        : isFileAttachment(value) && isFileAttachment(original)
          ? { ...original, id: value.id }
          : value,
    );
  }
  return {
    attachments,
    sending: false,
    release: () => {
      void import("../../lib/attachmentUploadQueue").then((queue) => {
        for (const attachment of attachments)
          queue.releasePersistedAttachmentUpload({
            environmentId,
            attachmentId: attachment.id,
            id: `coordinator-recovery:${attachment.id}`,
          });
      });
    },
  };
}
function clearRecoveryReceipt(storage: Storage, key: string): void {
  try {
    storage.removeItem(RECOVERY_STORAGE_PREFIX + encodeURIComponent(key));
  } catch {
    throw new Error(
      "The retry outcome is known, but browser storage could not clear its receipt. Refresh coordinator history before another retry.",
    );
  }
}

/** Only this server code is emitted after durable command absence, before intake dispatch. */
export function isDefinitiveCoordinatorRejection(error: unknown, projectId: string): boolean {
  return (
    Schema.is(ProjectWorkspaceError)(error) &&
    error.projectId === projectId &&
    error.code === "attachment_unavailable"
  );
}

/** A fresh failed run is a new retry; uncertain delivery of that same retry keeps its identity. */
export function coordinatorRetryFingerprint(
  messageFingerprint: string,
  retryIdentity?: readonly [failureRunId: string | null, messageId: string],
): string {
  return retryIdentity === undefined
    ? messageFingerprint
    : JSON.stringify(["coordinator-retry", retryIdentity, messageFingerprint]);
}

/** Owns the entire retry, including staging, so normal sends cannot race it. */
export function useCoordinatorMessageRecovery(input: {
  message: {
    id: string;
    text: string;
    attachments: ReadonlyArray<ChatAttachment>;
    senderThreadId?: import("@specweave-studio/contracts").ThreadId | null | undefined;
  } | null;
  failureRunId: string | null;
  coordinatorId: import("@specweave-studio/contracts").ThreadId | null;
  environmentId: EnvironmentId;
  projectId: string;
  uploadsSupported: boolean;
  canRetry: boolean;
  nativeBusy?: boolean;
  flight: { current: boolean };
  composer: { setSubmitting: (value: boolean) => void };
  revision: () => number | null;
  send: (
    text: string,
    sourceThreadId: import("@specweave-studio/contracts").ThreadId | undefined,
    attachments: ReadonlyArray<ChatAttachment> | undefined,
    onConfirmed: () => void,
  ) => Promise<void>;
  read: (attachment: ChatAttachment, signal?: AbortSignal) => Promise<Blob>;
  reportError: (message: string | null) => void;
  setRetrying: (value: boolean) => void;
}) {
  const current = useRef(input);
  current.current = input;
  const mounted = useRef(true);
  const retryFlight = useRef(false);
  const releasePreparing = useRef<(() => void) | null>(null);
  const activeRetry = useRef<{ dispatched: boolean; cancel: () => void } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (activeRetry.current && !activeRetry.current.dispatched) activeRetry.current.cancel();
    };
  }, []);
  return () => {
    const start = current.current;
    const message = start.message;
    if (
      !message ||
      !start.canRetry ||
      start.nativeBusy ||
      retryFlight.current ||
      start.flight.current
    )
      return;
    const key = JSON.stringify([
      start.environmentId,
      start.projectId,
      message.id,
      start.failureRunId,
    ]);
    if (coordinatorRecoveryReceipts.get(key)?.confirmed) {
      start.reportError(confirmedRetryError().message);
      return;
    }
    if (coordinatorRecoveryReceipts.get(key)?.sending) {
      start.reportError(
        "The previous retry is still being confirmed. Your original message is preserved.",
      );
      return;
    }
    const expected = {
      environmentId: start.environmentId,
      projectId: start.projectId,
      messageId: message.id,
      failureRunId: start.failureRunId,
      coordinatorId: start.coordinatorId,
    };
    const owner = Symbol("coordinator-retry");
    const cancellation = new AbortController();
    const finishOwnedFlight = () => {
      if (coordinatorSubmissionOwners.get(start.composer) !== owner) return;
      coordinatorSubmissionOwners.delete(start.composer);
      releasePreparing.current = null;
      activeRetry.current = null;
      retryFlight.current = false;
      start.flight.current = false;
      start.composer.setSubmitting(false);
      if (mounted.current) start.setRetrying(false);
    };
    const operation = {
      dispatched: false,
      cancel: () => {
        releasePreparing.current?.();
        cancellation.abort();
        finishOwnedFlight();
      },
    };
    activeRetry.current = operation;
    coordinatorSubmissionOwners.set(start.composer, owner);
    const isSameRetry = () => {
      const latest = current.current;
      return (
        latest.environmentId === expected.environmentId &&
        latest.projectId === expected.projectId &&
        latest.message?.id === expected.messageId &&
        latest.failureRunId === expected.failureRunId &&
        latest.coordinatorId === expected.coordinatorId &&
        !latest.nativeBusy
      );
    };
    retryFlight.current = true;
    start.flight.current = true;
    start.composer.setSubmitting(true);
    start.setRetrying(true);
    start.reportError(null);
    const revision = start.revision();
    void (async () => {
      let replay = coordinatorRecoveryReceipts.get(key);
      let dispatched = false;
      let storage: Storage | undefined;
      try {
        storage = recoveryStorage();
        if (replay?.rejected) {
          clearRecoveryReceipt(storage, key);
          coordinatorRecoveryReceipts.delete(key);
          replay = undefined;
        }
        replay ??= restoreRecoveryReceipt(storage, key, start.environmentId, message.attachments);
        if (replay?.confirmed) {
          coordinatorRecoveryReceipts.set(key, replay);
          throw confirmedRetryError();
        }
        if (!replay) {
          if (message.attachments.length && !start.uploadsSupported)
            throw new Error(
              "This host cannot restore message attachments. Your original message is preserved.",
            );
          const restored = await restageCoordinatorAttachments({
            environmentId: start.environmentId,
            attachments: message.attachments,
            read: start.read,
            signal: cancellation.signal,
            isCurrent: () => mounted.current && !cancellation.signal.aborted,
            onReleaseReady: (release) => {
              if (
                mounted.current &&
                !cancellation.signal.aborted &&
                activeRetry.current === operation
              )
                releasePreparing.current = release;
              else release();
            },
          });
          if (activeRetry.current === operation) releasePreparing.current = null;
          replay = { ...restored, sending: false };
        }
        if (
          cancellation.signal.aborted ||
          !mounted.current ||
          current.current.revision() !== revision
        ) {
          if (!coordinatorRecoveryReceipts.has(key)) replay.release();
          throw new Error(
            "Project settings changed while restoring the message. Review the coordinator model and retry. Your original message is preserved.",
          );
        }
        if (!isSameRetry()) {
          if (!coordinatorRecoveryReceipts.has(key)) replay.release();
          throw new Error(
            "The coordinator conversation changed while restoring the message. Review its latest turn before retrying. Your original message is preserved.",
          );
        }
        const source =
          message.senderThreadId && message.senderThreadId !== start.coordinatorId
            ? message.senderThreadId
            : undefined;
        persistRecoveryReceipt(storage, key, replay);
        replay.sending = true;
        coordinatorRecoveryReceipts.set(key, replay);
        dispatched = true;
        operation.dispatched = true;
        const confirm = () => {
          if (replay!.confirmed) return;
          replay!.confirmed = true;
          try {
            persistRecoveryReceipt(storage!, key, replay!);
          } finally {
            replay!.release();
          }
        };
        await start.send(
          coordinatorRetryPrompt(message, start.projectId, source),
          source,
          replay.attachments.length ? replay.attachments : undefined,
          confirm,
        );
        confirm();
      } catch (error) {
        let reportableError = error;
        if (replay && !dispatched && !coordinatorRecoveryReceipts.has(key)) replay.release();
        if (replay && isDefinitiveCoordinatorRejection(error, start.projectId)) {
          replay.rejected = true;
          replay.release();
          try {
            if (storage) clearRecoveryReceipt(storage, key);
            if (coordinatorRecoveryReceipts.get(key) === replay)
              coordinatorRecoveryReceipts.delete(key);
          } catch (clearError) {
            reportableError = clearError;
          }
        }
        if (mounted.current && activeRetry.current === operation)
          start.reportError(
            reportableError instanceof Error
              ? reportableError.message
              : "The message could not be retried. Your original message is preserved.",
          );
      } finally {
        if (replay && dispatched) replay.sending = false;
        finishOwnedFlight();
      }
    })();
  };
}
