import {
  type EnvironmentId,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGES,
  PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES,
} from "@specweave-studio/contracts";
import {
  clampFileAttachmentUploadBytes,
  fileAttachmentTooLargeMessage,
} from "@specweave-studio/client-runtime/state/attachments";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import { isHeicImageFile } from "../../lib/imageCompression";
import { isVideoAttachment } from "../../types";

type ComposerAttachmentFileKind = "image" | "file";

interface FileAttachmentCapabilityState {
  readonly attachmentUploadsCapabilityKnown: boolean;
  readonly supportsAttachmentUploads: boolean;
  readonly maxFileAttachmentBytes: number | null;
}

const IMAGE_MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * Some sources (drags from other apps, files piped through a shell) hand over
 * a `File` with an empty or generic MIME type. Maps the extension to a
 * provider-supported image type so a plain `photo.jpg` still lands on the
 * image path; anything unrecognized stays a generic file.
 */
export function inferImageMimeTypeFromName(name: string): string | null {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    return null;
  }
  return IMAGE_MIME_TYPE_BY_EXTENSION[name.slice(dotIndex + 1).toLowerCase()] ?? null;
}

function inferImageMimeTypeForUnknownFile(file: Pick<File, "name" | "type">): string | null {
  const mimeType = file.type.toLowerCase();
  if (mimeType !== "" && mimeType !== "application/octet-stream") {
    return null;
  }
  return inferImageMimeTypeFromName(file.name);
}

/** Give extension-recognized images a concrete type before compression. */
export function normalizeComposerImageFileMimeType(file: File): File {
  const inferredMimeType = inferImageMimeTypeForUnknownFile(file);
  if (!inferredMimeType) {
    return file;
  }
  return new File([file], file.name, {
    type: inferredMimeType,
    lastModified: file.lastModified,
  });
}

/**
 * Images providers read natively (GIF, JPEG, PNG, WebP, plus HEIC converted to
 * JPEG) go on the image path. Other image types such as SVG, BMP, TIFF, AVIF
 * and ICO attach as generic files, the same as when they arrive with no MIME
 * type, so the agent still gets them through the saved-path prompt note.
 */
export function classifyComposerAttachmentFile(
  file: Pick<File, "name" | "type">,
): ComposerAttachmentFileKind {
  if (isHeicImageFile(file)) {
    return "image";
  }
  if (inferImageMimeTypeForUnknownFile(file)) {
    return "image";
  }
  return isProviderSendTurnSupportedImageMimeType(file.type) ? "image" : "file";
}

export function isPreviewableComposerVideo(
  file: ComposerFileAttachment,
  environmentId: EnvironmentId,
): boolean {
  return (
    isVideoAttachment(file) &&
    (file.file !== null ||
      (file.uploadedAttachmentId !== undefined && file.uploadEnvironmentId === environmentId))
  );
}

/** Non-media files without an inline reference still need the legacy attachment row. */
export function composerOtherFilesForPresentation(
  files: ReadonlyArray<ComposerFileAttachment>,
  environmentId: EnvironmentId,
  inlineFileIds: ReadonlySet<string>,
): ComposerFileAttachment[] {
  return files.filter(
    (file) => !isPreviewableComposerVideo(file, environmentId) && !inlineFileIds.has(file.id),
  );
}

/** Byte limit for adding a generic file to the local composer draft. */
export function fileAttachmentStagingLimit(input: FileAttachmentCapabilityState): number | null {
  if (!input.attachmentUploadsCapabilityKnown) {
    return PROVIDER_SEND_TURN_MAX_FILE_BYTES;
  }
  if (!input.supportsAttachmentUploads || input.maxFileAttachmentBytes === null) {
    return null;
  }
  return clampFileAttachmentUploadBytes(input.maxFileAttachmentBytes);
}

/** Why retained generic files cannot send with the current server config. */
export function fileAttachmentCapabilityBlockReason(
  input: FileAttachmentCapabilityState & {
    readonly files: ReadonlyArray<{ readonly name: string; readonly sizeBytes: number }>;
  },
): string | null {
  if (input.files.length === 0) {
    return null;
  }
  if (!input.attachmentUploadsCapabilityKnown) {
    return "Waiting for the server before file attachments can send";
  }
  const maxFileAttachmentBytes = fileAttachmentStagingLimit(input);
  if (maxFileAttachmentBytes === null) {
    return "This server does not accept file attachments right now. Remove the files to send.";
  }
  const oversizedFile = input.files.find((file) => file.sizeBytes > maxFileAttachmentBytes);
  if (oversizedFile) {
    return fileAttachmentTooLargeMessage(oversizedFile.name, maxFileAttachmentBytes);
  }
  return null;
}

/**
 * When `capabilities.attachmentUploads` flips off (reconnect, version skew),
 * tear down only uploads that have not been persisted onto a draft file.
 * Once `uploadedAttachmentId` is stamped, the draft references that server
 * copy after reload even if its local `File` is still available in memory.
 * Explicit attachment removal releases persisted uploads through
 * `releaseDraftAttachment`.
 */
export function attachmentsToReleaseOnUploadCapabilityLoss(
  attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>,
): Array<ComposerImageAttachment | ComposerFileAttachment> {
  return attachments.filter(
    (attachment) => !(attachment.type === "file" && attachment.uploadedAttachmentId !== undefined),
  );
}

/** Last path segment of a clipboard line, which may be a bare name, a path or a file URL. */
function clipboardLineFileName(line: string): string {
  let value = line.trim();
  if (/^file:\/\//i.test(value)) {
    try {
      value = decodeURIComponent(new URL(value).pathname);
    } catch {
      return value;
    }
  }
  return value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1);
}

/**
 * Finder and most file managers put the copied files' names on the clipboard
 * as plain text next to the files themselves. That text is a label for the
 * files, not prose the user meant to paste.
 */
function isClipboardTextOnlyFileNames(plainText: string, files: ReadonlyArray<File>): boolean {
  const lines = plainText
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return true;
  }
  const names = new Set(files.map((file) => file.name));
  return lines.every((line) => names.has(line) || names.has(clipboardLineFileName(line)));
}

/**
 * Whether a paste's files should be claimed as composer attachments instead of
 * falling through to the default text paste. Deliberately no capacity or
 * pending-plan-question gate here: `addComposerAttachments` owns those limits
 * and reports them, while a gate at this layer would swallow the paste with no
 * feedback.
 */
export function shouldHandleComposerAttachmentPaste(input: {
  readonly files: ReadonlyArray<File>;
  readonly plainText: string;
}): boolean {
  if (input.files.length === 0) {
    return false;
  }
  // Any image on the clipboard is the thing being pasted, even when the
  // source app adds a caption or alt text next to it.
  if (
    input.files.some(
      (file) =>
        classifyComposerAttachmentFile(file) === "image" ||
        file.type.toLowerCase().startsWith("image/"),
    )
  ) {
    return true;
  }
  // Apps that copy rich text can add a synthetic file (RTF, HTML) next to the
  // text. Only claim generic files when the text is empty or just their names.
  return isClipboardTextOnlyFileNames(input.plainText, input.files);
}

/** One file from an attachment batch that did not make it into the draft. */
export interface ComposerAttachmentRejection {
  readonly name: string;
  /** Lowercase predicate that reads after the file name, e.g. "is already attached". */
  readonly reason: string;
}

const MAX_LISTED_REJECTIONS = 3;

/**
 * Turns every failure from one attachment batch into a single thread error,
 * so a later failure never hides an earlier one. Batch-wide limits lead,
 * followed by the files that were turned away and why.
 */
export function composerAttachmentRejectionMessage(input: {
  readonly limits?: ReadonlyArray<string>;
  readonly rejections: ReadonlyArray<ComposerAttachmentRejection>;
}): string | null {
  const parts = [...(input.limits ?? [])];
  const { rejections } = input;
  if (rejections.length === 1) {
    const [rejection] = rejections;
    parts.push(`'${rejection!.name}' ${rejection!.reason}.`);
  } else if (rejections.length > 1) {
    const listed = rejections
      .slice(0, MAX_LISTED_REJECTIONS)
      .map((rejection) => `'${rejection.name}' ${rejection.reason}`);
    const more = rejections.length - listed.length;
    parts.push(
      `${rejections.length} files were not added: ${listed.join("; ")}${
        more > 0 ? `; and ${more} more` : ""
      }.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Thread error for images left out because the message already holds the most it can send. */
export function composerImageLimitMessage(notAddedCount: number): string {
  return `You can attach up to ${PROVIDER_SEND_TURN_MAX_IMAGES} images per message. ${notAddedCount} ${
    notAddedCount === 1 ? "image was" : "images were"
  } not added.`;
}

/** Thread error for files left out because the message already holds the most it can send. */
export function composerAttachmentLimitMessage(notAddedCount: number): string {
  return `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message. ${notAddedCount} ${
    notAddedCount === 1 ? "file was" : "files were"
  } not added.`;
}

/** Thread error for images left out because the message's images would pass their byte total. */
export function composerImageTotalLimitMessage(notAddedCount: number): string {
  return `Images can total up to ${formatComposerAttachmentByteLimit(
    PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES,
  )} per message. ${notAddedCount} ${notAddedCount === 1 ? "image was" : "images were"} not added.`;
}

/**
 * Images in a draft and their raw bytes, counted the way the send check
 * counts them: image attachments plus files with a provider image type.
 */
export function composerDraftImageUsage(draft: {
  readonly images: ReadonlyArray<Pick<ComposerImageAttachment, "sizeBytes">>;
  readonly files: ReadonlyArray<Pick<ComposerFileAttachment, "mimeType" | "sizeBytes">>;
}): { count: number; bytes: number } {
  let count = draft.images.length;
  let bytes = draft.images.reduce((total, image) => total + image.sizeBytes, 0);
  for (const file of draft.files) {
    if (!isProviderSendTurnSupportedImageMimeType(file.mimeType)) continue;
    count += 1;
    bytes += file.sizeBytes;
  }
  return { count, bytes };
}

/** "50 MB" style label matching the wording of the attachment size errors. */
export function formatComposerAttachmentByteLimit(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KB`;
  return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
}
