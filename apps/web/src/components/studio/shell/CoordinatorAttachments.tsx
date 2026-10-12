/**
 * Attachments on the coordinator's composer: images and files that are pasted,
 * dropped or picked. They upload as they are added, so sending only has to wait
 * for what is still in flight.
 */
import {
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGES,
  PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  type ChatAttachment,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { formatAttachmentSize } from "@specweave-studio/client-runtime/state/attachments";
import { videoMimeType } from "@specweave-studio/shared/video";
import { FileTextIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../../../composerDraftStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachment,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../../lib/attachmentUploadQueue";
import { formatAttachmentUploadProgress } from "../../../lib/attachmentUploadState";
import { prepareImageForAttachment } from "../../../lib/imageCompression";
import { ExpandedImageDialog } from "../../chat/ExpandedImageDialog";
import { buildExpandedImagePreview } from "../../chat/ExpandedImagePreview";
import {
  classifyComposerAttachmentFile,
  composerAttachmentLimitMessage,
  composerAttachmentRejectionMessage,
  composerImageLimitMessage,
  formatComposerAttachmentByteLimit,
  normalizeComposerImageFileMimeType,
  shouldHandleComposerAttachmentPaste,
  type ComposerAttachmentRejection,
} from "../../chat/composerAttachmentFiles";
import { AttachmentFilePreview } from "../../files/AttachmentFilePreview";
import { Dialog, DialogPopup, DialogTitle } from "../../ui/dialog";
import { Tip } from "./Tip";
import { randomUUID } from "../../../lib/utils";

export type CoordinatorAttachment = ComposerImageAttachment | ComposerFileAttachment;

/** What the picker offers: any file when the host takes files, otherwise images only. */
export function coordinatorAttachAccept(filesAllowed: boolean): string | undefined {
  return filesAllowed
    ? undefined
    : [...PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES, "image/heic", "image/heif"].join(",");
}
/** From here on the strip says how many images are left before the limit. */
export const COORDINATOR_IMAGE_COUNT_FROM = 15;
const MAX_TOTAL_IMAGE_MB = PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES / (1024 * 1024);
const totalImageBytesMessage = (notAdded: number) =>
  `Images can total up to ${MAX_TOTAL_IMAGE_MB} MB per message. ${notAdded} ${
    notAdded === 1 ? "image was" : "images were"
  } not added.`;

/** Every file a paste or drop carries. */
export function filesFrom(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  const files = [...transfer.files];
  // Some sources expose a screenshot only as an item, never in `files`.
  if (files.length === 0)
    for (const item of transfer.items ?? []) {
      const file = item.kind === "file" ? item.getAsFile() : null;
      if (file) files.push(file);
    }
  return files;
}

/**
 * The files a paste should attach, by the thread composer's rule: images always
 * attach; other files attach unless the clipboard also has real text, which the
 * browser inserts as usual.
 */
export function pastedFilesFrom(transfer: DataTransfer | null): File[] {
  const files = filesFrom(transfer);
  if (files.length === 0) return [];
  const plainText = transfer?.getData("text/plain") ?? "";
  return shouldHandleComposerAttachmentPaste({ files, plainText }) ? files : [];
}

const isImage = (attachment: CoordinatorAttachment): attachment is ComposerImageAttachment =>
  attachment.type === "image";

/** An image being converted or shrunk before it can attach. */
export interface PreparingCoordinatorImage {
  readonly id: string;
  readonly name: string;
}

export function useCoordinatorAttachments(input: {
  environmentId: EnvironmentId;
  /** The host takes uploads at all. */
  uploadsSupported: boolean;
  /** This window may send to the host right now. */
  canUpload: boolean;
  /** The largest file the host takes, or null when it takes images only. */
  maxFileBytes: number | null;
}) {
  const { environmentId, uploadsSupported, canUpload, maxFileBytes } = input;
  const [attachments, setAttachments] = useState<ReadonlyArray<CoordinatorAttachment>>([]);
  const [preparing, setPreparing] = useState<ReadonlyArray<PreparingCoordinatorImage>>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const held = useRef(attachments);
  const converting = useRef(preparing);
  const alive = useRef(true);
  /** Attachments a send has handed to the host and not heard back about. */
  const outgoing = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // Leaving the project drops the draft, so its uploads and previews go with it.
      for (const attachment of held.current) {
        // The host may still be claiming these; deleting them now would fail that send.
        if (!outgoing.current.has(attachment.id)) releaseDraftAttachment(attachment);
        if (isImage(attachment)) URL.revokeObjectURL(attachment.previewUrl);
      }
    };
  }, []);
  useEffect(() => {
    // An attachment added while the host was out of reach starts as soon as it is back.
    if (!canUpload) return;
    for (const image of held.current) startAttachmentUpload({ environmentId, image });
  }, [canUpload, environmentId]);

  const attach = useCallback(
    (added: ReadonlyArray<CoordinatorAttachment>) => {
      if (added.length === 0) return;
      for (const image of added) startAttachmentUpload({ environmentId, image });
      held.current = [...held.current, ...added];
      setAttachments(held.current);
    },
    [environmentId],
  );

  /**
   * Every image goes through the thread composer's preparation, one at a time:
   * HEIC photos become JPEG, and anything over Claude Code's size or 2000 px
   * shrinks. What fits already passes through untouched.
   */
  const convert = useCallback(
    async (jobs: ReadonlyArray<{ id: string; name: string; file: File }>) => {
      const rejections: ComposerAttachmentRejection[] = [];
      let overBytes = 0;
      for (const job of jobs) {
        const result = await prepareImageForAttachment(job.file);
        converting.current = converting.current.filter((image) => image.id !== job.id);
        if (!alive.current) continue;
        setPreparing(converting.current);
        if (!result.ok) {
          rejections.push({
            name: job.name,
            reason:
              result.reason === "unreadable"
                ? "could not be read as an image"
                : "is too large to attach, even after shrinking it",
          });
          continue;
        }
        const candidate = {
          type: "image" as const,
          mimeType: result.file.type,
          sizeBytes: result.file.size,
        };
        // Its final size is known only now, so the message total is checked here.
        if (getProviderAttachmentLimitError([...held.current, candidate])) {
          overBytes += 1;
          continue;
        }
        attach([
          {
            ...candidate,
            id: job.id,
            name: result.file.name || job.name,
            previewUrl: URL.createObjectURL(result.file),
            file: result.file,
          },
        ]);
      }
      if (!alive.current) return;
      const note = composerAttachmentRejectionMessage({
        limits: overBytes > 0 ? [totalImageBytesMessage(overBytes)] : [],
        rejections,
      });
      if (note) setProblem((current) => (current ? `${current} ${note}` : note));
    },
    [attach],
  );

  const add = useCallback(
    (files: ReadonlyArray<File>) => {
      if (files.length === 0) return;
      if (!uploadsSupported) {
        setProblem("This host does not accept attachments.");
        return;
      }
      if (!canUpload) {
        setProblem("Reconnect to this host with permission to send before attaching files.");
        return;
      }
      const accepted: CoordinatorAttachment[] = [];
      const jobs: Array<{ id: string; name: string; file: File }> = [];
      const rejections: ComposerAttachmentRejection[] = [];
      let total = held.current.length + converting.current.length;
      let images = held.current.filter(isImage).length + converting.current.length;
      let overImages = 0;
      let overTotal = 0;
      for (const file of files) {
        const kind = classifyComposerAttachmentFile(file);
        if (total >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
          overTotal += 1;
          continue;
        }
        if (kind === "image") {
          if (images >= PROVIDER_SEND_TURN_MAX_IMAGES) {
            overImages += 1;
            continue;
          }
          const image = normalizeComposerImageFileMimeType(file);
          jobs.push({
            id: `coordinator-${randomUUID()}`,
            name: image.name || "Pasted image",
            file: image,
          });
          images += 1;
          total += 1;
          continue;
        }
        // Anything else, including an image type no provider reads, goes as a file
        // the agent opens from disk.
        const name = file.name || "Pasted file";
        if (maxFileBytes === null) {
          rejections.push({ name, reason: "is not an image, and this host takes images only" });
          continue;
        }
        if (file.size <= 0) {
          rejections.push({ name, reason: "is empty or could not be read" });
          continue;
        }
        if (file.size > maxFileBytes) {
          rejections.push({
            name,
            reason: `exceeds the ${formatComposerAttachmentByteLimit(maxFileBytes)} attachment limit`,
          });
          continue;
        }
        accepted.push({
          type: "file",
          id: `coordinator-${randomUUID()}`,
          name,
          mimeType:
            videoMimeType({ name, mimeType: file.type }) ??
            (file.type || "application/octet-stream"),
          sizeBytes: file.size,
          file,
        });
        total += 1;
      }
      const limits: string[] = [];
      if (overImages > 0) limits.push(composerImageLimitMessage(overImages));
      if (overTotal > 0) limits.push(composerAttachmentLimitMessage(overTotal));
      setProblem(composerAttachmentRejectionMessage({ limits, rejections }));
      attach(accepted);
      if (jobs.length === 0) return;
      converting.current = [...converting.current, ...jobs.map(({ id, name }) => ({ id, name }))];
      setPreparing(converting.current);
      void convert(jobs);
    },
    [attach, canUpload, convert, maxFileBytes, uploadsSupported],
  );

  const remove = useCallback((id: string) => {
    const attachment = held.current.find((candidate) => candidate.id === id);
    if (!attachment || outgoing.current.has(id)) return;
    releaseDraftAttachment(attachment);
    if (isImage(attachment)) URL.revokeObjectURL(attachment.previewUrl);
    held.current = held.current.filter((candidate) => candidate.id !== id);
    setAttachments(held.current);
    setProblem(null);
  }, []);

  /** The uploaded references for exactly these attachments, once every upload has settled. */
  const prepare = useCallback(
    async (sending: ReadonlyArray<CoordinatorAttachment>): Promise<ChatAttachment[]> => {
      if (converting.current.length > 0)
        throw new Error("Wait for the images to finish preparing, then send.");
      if (sending.length === 0) return [];
      // Starting is a no-op for an upload that is running, done or failed.
      for (const image of sending) startAttachmentUpload({ environmentId, image });
      await awaitAttachmentUploads(sending.map((image) => image.id));
      const current = sending.filter((image) => held.current.includes(image));
      if (current.length !== sending.length)
        throw new Error("The attachments changed while they uploaded. Send again.");
      const uploaded = getUploadedAttachments({ environmentId, images: sending });
      if (!uploaded)
        throw new Error("An attachment did not upload. Remove it and attach it again.");
      return uploaded;
    },
    [environmentId],
  );

  /** Bracket the host's part of a send, so nothing withdraws what it is claiming. */
  const hold = useCallback((sending: ReadonlyArray<CoordinatorAttachment>) => {
    outgoing.current = new Set(sending.map((image) => image.id));
    return () => {
      outgoing.current = new Set();
    };
  }, []);

  /** After a confirmed send: forget what went out, keep anything added meanwhile. */
  const clearSent = useCallback((sent: ReadonlyArray<CoordinatorAttachment>) => {
    const ids = new Set(sent.map((image) => image.id));
    for (const attachment of sent) {
      releaseDraftAttachment(attachment);
      if (isImage(attachment)) URL.revokeObjectURL(attachment.previewUrl);
    }
    held.current = held.current.filter((image) => !ids.has(image.id));
    setAttachments(held.current);
    setProblem(null);
  }, []);

  const dismissProblem = useCallback(() => setProblem(null), []);

  return {
    attachments,
    preparing,
    problem,
    add,
    remove,
    prepare,
    hold,
    clearSent,
    dismissProblem,
  };
}

/** Why something was not attached. It stays until dismissed or the attachments change. */
export function CoordinatorAttachmentNotice(props: {
  problem: string | null;
  onDismiss: () => void;
}) {
  if (!props.problem) return null;
  return (
    <div className="sws-attachment-notice" role="alert">
      <p>{props.problem}</p>
      <button
        type="button"
        className="sws-attachment-notice-dismiss"
        aria-label="Dismiss"
        onClick={props.onDismiss}
      >
        <XIcon aria-hidden />
      </button>
    </div>
  );
}

export function CoordinatorAttachmentStrip(props: {
  attachments: ReadonlyArray<CoordinatorAttachment>;
  preparing: ReadonlyArray<PreparingCoordinatorImage>;
  /** A send is under way, so what is attached cannot change. */
  locked: boolean;
  onRemove: (id: string) => void;
}) {
  const uploads = useAttachmentUploadStore((state) => state.uploadsByImageId);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const closePreview = useCallback(() => setPreviewId(null), []);
  const { attachments, preparing } = props;
  if (attachments.length === 0 && preparing.length === 0) return null;
  const states = attachments.map((attachment) => {
    const upload = uploads[attachment.id];
    return upload?.status === "failed"
      ? "failed"
      : upload?.status === "ready"
        ? "ready"
        : "uploading";
  });
  const failed = attachments.filter((_, index) => states[index] === "failed");
  const pending = states.filter((state) => state === "uploading").length;
  const count = attachments.length;
  const images = attachments.filter(isImage);
  const imageCount = images.length + preparing.length;
  const showCount = imageCount >= COORDINATOR_IMAGE_COUNT_FROM;
  const previewed = attachments.find((attachment) => attachment.id === previewId);
  const imagePreview =
    previewed && isImage(previewed) ? buildExpandedImagePreview(images, previewed.id) : null;
  const filePreview = previewed?.type === "file" ? previewed : null;
  const noun = (n: number) => (n === 1 ? "attachment" : "attachments");
  return (
    <>
      <ul className="sws-attachments" aria-label="Attachments">
        {attachments.map((attachment, index) => {
          const upload = uploads[attachment.id];
          const state = states[index]!;
          return (
            <li
              key={attachment.id}
              className="sws-attachment"
              data-kind={attachment.type}
              data-state={state}
            >
              <Tip label={isImage(attachment) ? `Preview ${attachment.name}` : attachment.name}>
                <button
                  type="button"
                  className="sws-attachment-open"
                  aria-label={`Preview ${attachment.name}`}
                  onClick={() => setPreviewId(attachment.id)}
                >
                  {isImage(attachment) ? (
                    <img src={attachment.previewUrl} alt="" />
                  ) : (
                    <>
                      <FileTextIcon aria-hidden />
                      <span className="sws-attachment-name">{attachment.name}</span>
                      <span className="sws-attachment-size">
                        {formatAttachmentSize(attachment.sizeBytes)}
                      </span>
                    </>
                  )}
                </button>
              </Tip>
              {state === "ready" ? null : (
                // The summary below speaks for the strip; twenty percentages would not.
                <span className="sws-attachment-state" aria-hidden>
                  {upload?.status === "failed"
                    ? "Failed"
                    : upload?.status === "uploading"
                      ? formatAttachmentUploadProgress(upload.progress)
                      : "Waiting"}
                </span>
              )}
              <Tip label={`Remove ${attachment.name}`}>
                <button
                  type="button"
                  className="sws-attachment-remove"
                  aria-label={`Remove ${attachment.name}${state === "failed" ? ", upload failed" : ""}`}
                  disabled={props.locked}
                  onClick={() => props.onRemove(attachment.id)}
                >
                  <XIcon aria-hidden />
                </button>
              </Tip>
            </li>
          );
        })}
        {preparing.map((image) => (
          <li key={image.id} className="sws-attachment" data-kind="image" data-state="preparing">
            <span className="sws-attachment-state" aria-hidden>
              Preparing
            </span>
          </li>
        ))}
        {showCount && (
          <li className="sws-attachment-count" aria-hidden>
            {imageCount} of {PROVIDER_SEND_TURN_MAX_IMAGES} images
          </li>
        )}
      </ul>
      <span className="sr-only" role="status">
        {failed.length > 0
          ? `${failed.map((attachment) => attachment.name).join(", ")} did not upload.`
          : preparing.length > 0
            ? `Preparing ${preparing.length} ${preparing.length === 1 ? "image" : "images"}.`
            : pending > 0
              ? `Uploading ${pending} of ${count} ${noun(count)}.`
              : `${count} ${noun(count)} attached.`}
        {showCount ? ` ${imageCount} of ${PROVIDER_SEND_TURN_MAX_IMAGES} images.` : ""}
      </span>
      {imagePreview && <ExpandedImageDialog preview={imagePreview} onClose={closePreview} />}
      {filePreview && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) closePreview();
          }}
        >
          <DialogPopup
            className="h-[min(85vh,52rem)] max-w-4xl overflow-hidden"
            showCloseButton={false}
          >
            <DialogTitle className="sr-only">{filePreview.name}</DialogTitle>
            <AttachmentFilePreview
              name={filePreview.name}
              mimeType={filePreview.mimeType}
              sizeBytes={filePreview.sizeBytes}
              file={filePreview.file}
              origin="Draft"
              onClose={closePreview}
            />
          </DialogPopup>
        </Dialog>
      )}
    </>
  );
}
