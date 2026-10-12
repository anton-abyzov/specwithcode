import { EnvironmentId, PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import { isVideoAttachment, videoMimeType } from "../../types";
import {
  attachmentsToReleaseOnUploadCapabilityLoss,
  classifyComposerAttachmentFile,
  composerAttachmentLimitMessage,
  composerAttachmentRejectionMessage,
  composerDraftImageUsage,
  composerImageLimitMessage,
  composerImageTotalLimitMessage,
  formatComposerAttachmentByteLimit,
  composerOtherFilesForPresentation,
  fileAttachmentCapabilityBlockReason,
  fileAttachmentStagingLimit,
  inferImageMimeTypeFromName,
  isPreviewableComposerVideo,
  normalizeComposerImageFileMimeType,
  shouldHandleComposerAttachmentPaste,
} from "./composerAttachmentFiles";

describe("composer attachment files", () => {
  it("keeps inline non-media files out of the legacy attachment row", () => {
    const environmentId = EnvironmentId.make("env-1");
    const files = [
      {
        type: "file" as const,
        id: "inline-file",
        name: "inline.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
        file: new File(["inline"], "inline.txt", { type: "text/plain" }),
      },
      {
        type: "file" as const,
        id: "legacy-file",
        name: "legacy.zip",
        mimeType: "application/zip",
        sizeBytes: 24,
        file: new File(["legacy"], "legacy.zip", { type: "application/zip" }),
      },
    ];

    expect(
      composerOtherFilesForPresentation(files, environmentId, new Set(["inline-file"])),
    ).toEqual([files[1]]);
  });

  it("keeps supported images and HEIC photos on the image path", () => {
    expect(classifyComposerAttachmentFile({ name: "photo.png", type: "image/png" })).toBe("image");
    expect(classifyComposerAttachmentFile({ name: "photo.heic", type: "" })).toBe("image");
  });

  it("attaches image types providers cannot read natively as generic files", () => {
    for (const [name, type] of [
      ["diagram.svg", "image/svg+xml"],
      ["scan.bmp", "image/bmp"],
      ["photo.tiff", "image/tiff"],
      ["photo.avif", "image/avif"],
      ["favicon.ico", "image/x-icon"],
    ] as const) {
      expect(classifyComposerAttachmentFile({ name, type })).toBe("file");
      // Same outcome as the same file arriving with no MIME type.
      expect(classifyComposerAttachmentFile({ name, type: "" })).toBe("file");
    }
    expect(classifyComposerAttachmentFile({ name: "report.pdf", type: "application/pdf" })).toBe(
      "file",
    );
  });

  it("keeps native image sending for GIF, JPEG, PNG and WebP", () => {
    for (const type of ["image/gif", "image/jpeg", "image/png", "image/webp"]) {
      expect(classifyComposerAttachmentFile({ name: "picture", type })).toBe("image");
    }
  });

  it("preserves text paste when an application adds a synthetic generic file", () => {
    const file = new File(["clipboard"], "clipboard.rtf", { type: "application/rtf" });

    expect(
      shouldHandleComposerAttachmentPaste({
        files: [file],
        plainText: "Copied text",
      }),
    ).toBe(false);
  });

  it("claims pastes of image types that attach as files", () => {
    const images = [
      new File(["svg"], "diagram.svg", { type: "image/svg+xml" }),
      new File(["tiff"], "photo.tiff", { type: "image/tiff" }),
    ];

    for (const image of images) {
      expect(
        shouldHandleComposerAttachmentPaste({
          files: [image],
          plainText: "Image caption",
        }),
      ).toBe(true);
    }
  });

  it("claims generic file-only pastes so the composer can report validation errors", () => {
    const file = new File(["report"], "report.pdf", { type: "application/pdf" });

    expect(shouldHandleComposerAttachmentPaste({ files: [file], plainText: "" })).toBe(true);
  });

  it("routes empty and oversized generic files to composer feedback", () => {
    const empty = new File([], "empty.txt", { type: "text/plain" });
    const oversized = new File([new Uint8Array(1024)], "large.zip", {
      type: "application/zip",
    });

    expect(shouldHandleComposerAttachmentPaste({ files: [empty], plainText: "" })).toBe(true);
    expect(shouldHandleComposerAttachmentPaste({ files: [oversized], plainText: "" })).toBe(true);
  });

  it("claims Finder file copies whose text is just the file names", () => {
    const files = [
      new File(["zip"], "archive.zip", { type: "application/zip" }),
      new File(["pdf"], "Q3 report.pdf", { type: "application/pdf" }),
    ];

    expect(
      shouldHandleComposerAttachmentPaste({ files: [files[0]!], plainText: "archive.zip" }),
    ).toBe(true);
    for (const plainText of [
      "archive.zip\nQ3 report.pdf",
      "archive.zip\r\nQ3 report.pdf\n",
      "archive.zip\rQ3 report.pdf",
      "/Users/me/Downloads/archive.zip\n/Users/me/Downloads/Q3 report.pdf",
      "file:///Users/me/Downloads/archive.zip\nfile:///Users/me/Q3%20report.pdf",
      "  \n",
    ]) {
      expect(shouldHandleComposerAttachmentPaste({ files, plainText })).toBe(true);
    }
  });

  it("keeps text paste when the text is more than the file names", () => {
    const files = [new File(["zip"], "archive.zip", { type: "application/zip" })];

    for (const plainText of [
      "archive.zip is attached",
      "archive.zip\nPlease review",
      "other.zip",
    ]) {
      expect(shouldHandleComposerAttachmentPaste({ files, plainText })).toBe(false);
    }
  });

  it("ignores an empty clipboard", () => {
    expect(shouldHandleComposerAttachmentPaste({ files: [], plainText: "" })).toBe(false);
  });

  it("falls back to the extension when an image arrives without a MIME type", () => {
    expect(classifyComposerAttachmentFile({ name: "photo.jpg", type: "" })).toBe("image");
    expect(classifyComposerAttachmentFile({ name: "shot.PNG", type: "" })).toBe("image");
    expect(classifyComposerAttachmentFile({ name: "archive.zip", type: "" })).toBe("file");
    expect(classifyComposerAttachmentFile({ name: "no-extension", type: "" })).toBe("file");
    expect(inferImageMimeTypeFromName("photo.jpg")).toBe("image/jpeg");
    expect(inferImageMimeTypeFromName("archive.zip")).toBeNull();
  });

  it("infers supported image types from octet-stream files", () => {
    const jpeg = new File(["jpeg"], "photo.jpg", { type: "application/octet-stream" });
    const png = new File(["png"], "shot.PNG", { type: "application/octet-stream" });

    expect(classifyComposerAttachmentFile(jpeg)).toBe("image");
    expect(classifyComposerAttachmentFile(png)).toBe("image");
    expect(normalizeComposerImageFileMimeType(jpeg).type).toBe("image/jpeg");
    expect(normalizeComposerImageFileMimeType(png).type).toBe("image/png");
  });

  it("does not infer images for unknown extensions or specific conflicting MIME types", () => {
    const binary = new File(["binary"], "archive.bin", { type: "application/octet-stream" });
    const unknownDocument = new File(["pdf"], "report.pdf", {
      type: "application/octet-stream",
    });
    const document = new File(["pdf"], "photo.jpg", { type: "application/pdf" });
    const explicitImage = new File(["png"], "photo.jpg", { type: "image/png" });

    expect(classifyComposerAttachmentFile(binary)).toBe("file");
    expect(classifyComposerAttachmentFile(unknownDocument)).toBe("file");
    expect(classifyComposerAttachmentFile(document)).toBe("file");
    expect(classifyComposerAttachmentFile(explicitImage)).toBe("image");
    expect(normalizeComposerImageFileMimeType(binary)).toBe(binary);
    expect(normalizeComposerImageFileMimeType(document)).toBe(document);
    expect(normalizeComposerImageFileMimeType(explicitImage)).toBe(explicitImage);
  });

  it("uses the hard local limit while server config is unknown", () => {
    expect(
      fileAttachmentStagingLimit({
        attachmentUploadsCapabilityKnown: false,
        supportsAttachmentUploads: false,
        maxFileAttachmentBytes: null,
      }),
    ).toBe(PROVIDER_SEND_TURN_MAX_FILE_BYTES);
    expect(
      fileAttachmentCapabilityBlockReason({
        files: [{ name: "pending.zip", sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES }],
        attachmentUploadsCapabilityKnown: false,
        supportsAttachmentUploads: false,
        maxFileAttachmentBytes: null,
      }),
    ).toBe("Waiting for the server before file attachments can send");
  });

  it("rejects local staging and send when known config has no file support", () => {
    const unsupportedReason =
      "This server does not accept file attachments right now. Remove the files to send.";
    expect(
      fileAttachmentStagingLimit({
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: true,
        maxFileAttachmentBytes: null,
      }),
    ).toBeNull();
    expect(
      fileAttachmentStagingLimit({
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: false,
        maxFileAttachmentBytes: 50 * 1024 * 1024,
      }),
    ).toBeNull();
    expect(
      fileAttachmentCapabilityBlockReason({
        files: [{ name: "report.pdf", sizeBytes: 1024 }],
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: true,
        maxFileAttachmentBytes: null,
      }),
    ).toBe(unsupportedReason);
    expect(
      fileAttachmentCapabilityBlockReason({
        files: [{ name: "report.pdf", sizeBytes: 1024 }],
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: false,
        maxFileAttachmentBytes: 50 * 1024 * 1024,
      }),
    ).toBe(unsupportedReason);
  });

  it("blocks retained files that exceed a newly lower server limit", () => {
    expect(
      fileAttachmentCapabilityBlockReason({
        files: [{ name: "large.zip", sizeBytes: 2 * 1024 * 1024 }],
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: true,
        maxFileAttachmentBytes: 1024 * 1024,
      }),
    ).toBe("'large.zip' exceeds the 1 MB attachment limit.");
  });

  it("uses the confirmed server limit without exceeding the hard cap", () => {
    expect(
      fileAttachmentStagingLimit({
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: true,
        maxFileAttachmentBytes: 1024 * 1024,
      }),
    ).toBe(1024 * 1024);
    expect(
      fileAttachmentStagingLimit({
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: true,
        maxFileAttachmentBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES * 2,
      }),
    ).toBe(PROVIDER_SEND_TURN_MAX_FILE_BYTES);
    expect(
      fileAttachmentCapabilityBlockReason({
        files: [{ name: "report.pdf", sizeBytes: 1024 }],
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: true,
        maxFileAttachmentBytes: 50 * 1024 * 1024,
      }),
    ).toBeNull();
  });

  it("does not block empty or image-only composers on legacy servers", () => {
    expect(
      fileAttachmentCapabilityBlockReason({
        files: [],
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: false,
        maxFileAttachmentBytes: null,
      }),
    ).toBeNull();
    expect(
      fileAttachmentCapabilityBlockReason({
        files: [],
        attachmentUploadsCapabilityKnown: false,
        supportsAttachmentUploads: false,
        maxFileAttachmentBytes: null,
      }),
    ).toBeNull();
  });

  it("keeps draft-persisted file uploads when the upload capability flips off", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const image: ComposerImageAttachment = {
      type: "image",
      id: "image-1",
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 3,
      previewUrl: "blob:photo",
      file: new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" }),
    };
    const uploadingFile: ComposerFileAttachment = {
      type: "file",
      id: "file-uploading",
      name: "fresh.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
      file: new File([new Uint8Array([1, 2, 3])], "fresh.pdf", { type: "application/pdf" }),
    };
    const hydratedFile: ComposerFileAttachment = {
      type: "file",
      id: "file-hydrated",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
      file: null,
      uploadedAttachmentId: "pending-report-pdf",
      uploadEnvironmentId: environmentId,
    };
    const uploadedLocalFile: ComposerFileAttachment = {
      ...uploadingFile,
      id: "file-uploaded-local",
      uploadedAttachmentId: "pending-fresh-pdf",
      uploadEnvironmentId: environmentId,
    };

    const released = attachmentsToReleaseOnUploadCapabilityLoss([
      image,
      uploadingFile,
      hydratedFile,
      uploadedLocalFile,
    ]);

    expect(released.map((attachment) => attachment.id)).toEqual(["image-1", "file-uploading"]);
  });

  it("keeps restored videos on the preview path in their upload environment", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const video: ComposerFileAttachment = {
      type: "file",
      id: "video-1",
      name: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: 3,
      file: null,
      uploadedAttachmentId: "uploaded-video-1",
      uploadEnvironmentId: environmentId,
    };

    expect(isPreviewableComposerVideo(video, environmentId)).toBe(true);
    expect(isPreviewableComposerVideo(video, EnvironmentId.make("environment-2"))).toBe(false);
  });

  it("recognizes common video extensions when the browser omits the MIME type", () => {
    const formats = [
      ["clip.mp4", "video/mp4"],
      ["clip.mov", "video/quicktime"],
      ["clip.webm", "video/webm"],
      ["clip.m4v", "video/mp4"],
      ["clip.mkv", "video/x-matroska"],
      ["clip.avi", "video/x-msvideo"],
      ["clip.ogv", "video/ogg"],
    ] as const;

    for (const [name, expectedMimeType] of formats) {
      expect(
        isVideoAttachment({
          type: "file",
          id: name,
          name,
          mimeType: "application/octet-stream",
          sizeBytes: 1,
        }),
      ).toBe(true);
      expect(videoMimeType({ name, mimeType: "application/octet-stream" })).toBe(expectedMimeType);
    }
  });

  it("claims image pastes even when clipboard text is present", () => {
    const image = new File(["image"], "photo.heic", { type: "image/heic" });

    expect(
      shouldHandleComposerAttachmentPaste({
        files: [image],
        plainText: "Image caption",
      }),
    ).toBe(true);
  });

  it("reports every rejected file in one message", () => {
    expect(composerAttachmentRejectionMessage({ rejections: [] })).toBeNull();
    expect(
      composerAttachmentRejectionMessage({
        rejections: [{ name: "b.zip", reason: "is larger than the 50 MB attachment limit" }],
      }),
    ).toBe("'b.zip' is larger than the 50 MB attachment limit.");
    expect(
      composerAttachmentRejectionMessage({
        rejections: [
          { name: "a.png", reason: "could not be read as an image" },
          { name: "b.zip", reason: "is larger than the 50 MB attachment limit" },
        ],
      }),
    ).toBe(
      "2 files were not added: 'a.png' could not be read as an image; 'b.zip' is larger than the 50 MB attachment limit.",
    );
  });

  it("puts batch limits first and shortens long rejection lists", () => {
    const rejections = Array.from({ length: 5 }, (_, index) => ({
      name: `empty-${index}.txt`,
      reason: "is empty or could not be read",
    }));

    expect(
      composerAttachmentRejectionMessage({
        limits: [composerImageLimitMessage(3)],
        rejections,
      }),
    ).toBe(
      "You can attach up to 20 images per message. 3 images were not added. 5 files were not added: 'empty-0.txt' is empty or could not be read; 'empty-1.txt' is empty or could not be read; 'empty-2.txt' is empty or could not be read; and 2 more.",
    );
    expect(
      composerAttachmentRejectionMessage({
        limits: [composerAttachmentLimitMessage(1)],
        rejections: [],
      }),
    ).toBe("You can attach up to 100 files per message. 1 file was not added.");
  });

  it("names the image limit with the number left out", () => {
    expect(composerImageLimitMessage(1)).toBe(
      "You can attach up to 20 images per message. 1 image was not added.",
    );
    expect(composerImageLimitMessage(4)).toBe(
      "You can attach up to 20 images per message. 4 images were not added.",
    );
  });

  it("names the image byte total with the number left out", () => {
    expect(composerImageTotalLimitMessage(1)).toBe(
      "Images can total up to 22 MB per message. 1 image was not added.",
    );
    expect(composerImageTotalLimitMessage(3)).toBe(
      "Images can total up to 22 MB per message. 3 images were not added.",
    );
  });

  it("counts draft images and their bytes the way the send check does", () => {
    expect(
      composerDraftImageUsage({
        images: [{ sizeBytes: 1000 }, { sizeBytes: 2000 }],
        files: [
          { mimeType: "image/png", sizeBytes: 300 },
          { mimeType: "image/svg+xml", sizeBytes: 50_000 },
          { mimeType: "application/pdf", sizeBytes: 70_000 },
        ],
      }),
    ).toEqual({ count: 3, bytes: 3300 });
    expect(composerDraftImageUsage({ images: [], files: [] })).toEqual({ count: 0, bytes: 0 });
  });

  it("labels byte limits like the attachment size errors", () => {
    expect(formatComposerAttachmentByteLimit(PROVIDER_SEND_TURN_MAX_FILE_BYTES)).toBe("50 MB");
    expect(formatComposerAttachmentByteLimit(512 * 1024)).toBe("512 KB");
    expect(formatComposerAttachmentByteLimit(1)).toBe("1 byte");
  });
});
