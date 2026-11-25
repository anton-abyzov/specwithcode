import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AssetCreateUrlResult,
  assetResourceReadsHostFiles,
  AttachmentCreateUploadUrlInput,
  AttachmentCreateUploadUrlResult,
} from "./assets.ts";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "./chatAttachment.ts";

const isUploadInput = Schema.is(AttachmentCreateUploadUrlInput);

const uploadInput = {
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 3,
} as const;

describe("AttachmentCreateUploadUrlInput", () => {
  it("accepts supported image attachments", () => {
    expect(isUploadInput(uploadInput)).toBe(true);
  });

  it("rejects image types that providers do not support", () => {
    expect(isUploadInput({ ...uploadInput, mimeType: "image/svg+xml" })).toBe(false);
  });

  it("accepts generic files without treating them as provider images", () => {
    expect(
      isUploadInput({
        type: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
      }),
    ).toBe(true);
    expect(
      isUploadInput({
        type: "file",
        name: "diagram.svg",
        mimeType: "image/svg+xml",
        sizeBytes: 3,
      }),
    ).toBe(true);
  });

  it("rejects empty and oversized uploads", () => {
    expect(isUploadInput({ ...uploadInput, sizeBytes: 0 })).toBe(false);
    expect(
      isUploadInput({ ...uploadInput, sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1 }),
    ).toBe(false);
    expect(
      isUploadInput({
        type: "file",
        name: "archive.zip",
        mimeType: "application/zip",
        sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
      }),
    ).toBe(false);
  });
});

describe("assetResourceReadsHostFiles", () => {
  it("needs a file grant for host files and design images only", () => {
    const threadId = "thread" as never;
    expect(
      [
        { _tag: "workspace-file", threadId, path: "a.png" },
        { _tag: "media-file", threadId, path: "/a.png" },
        { _tag: "draft-workspace-file", cwd: "/repo", path: "a.png" },
        {
          _tag: "design-asset",
          owner: { kind: "playground" },
          designId: "d_abc" as never,
          asset: `${"a".repeat(64)}.png`,
        },
      ].map((resource) => assetResourceReadsHostFiles(resource as never)),
    ).toEqual([true, true, true, true]);
    expect(
      [
        { _tag: "attachment", attachmentId: "upload" },
        { _tag: "project-favicon", cwd: "/repo" },
        { _tag: "github-media", cwd: "/repo", url: "https://github.com/x.png" },
      ].map((resource) => assetResourceReadsHostFiles(resource as never)),
    ).toEqual([false, false, false]);
  });
});

describe("signed asset and upload URLs from a host", () => {
  // A remote host answers these, and the client resolves them against that host's origin, so
  // only a path on the host's own asset and upload routes is accepted.
  const isAssetUrl = (relativeUrl: string) =>
    Schema.is(AssetCreateUrlResult)({ relativeUrl, expiresAt: 1 });
  const isUploadUrl = (relativeUrl: string) =>
    Schema.is(AttachmentCreateUploadUrlResult)({ relativeUrl, expiresAt: 1, attachmentId: "a1" });

  it("accepts the shapes the server issues", () => {
    expect(isAssetUrl("/api/assets/eyJ2IjoxfQ.c2ln-_x/report%20(final).html")).toBe(true);
    expect(isAssetUrl("/api/assets/eyJ2IjoxfQ.c2ln/%E2%9C%93.png")).toBe(true);
    expect(isUploadUrl("/api/attachments/upload/eyJ2IjoxfQ.c2ln-_x")).toBe(true);
  });

  it("refuses anything that leaves the host's own routes", () => {
    for (const relativeUrl of [
      "https://other.example/api/assets/t/a.png",
      "//other.example/api/assets/t/a.png",
      "data:text/html,hi",
      "file:///etc/hosts",
      "/api/assets/t/../../other",
      "/api/assets/../a.png",
      "/api/assets/t/..",
      "/api/assets/t/%2e%2e",
      "/api/assets/t/a.png?x=1",
      "/api/assets/t/sub/a.png",
      "/api/assets/t\\a.png",
      "/api/other/t/a.png",
    ]) {
      expect(isAssetUrl(relativeUrl), relativeUrl).toBe(false);
    }
    for (const relativeUrl of [
      "https://other.example/api/attachments/upload/t",
      "//other.example/api/attachments/upload/t",
      "/api/attachments/upload/..",
      "/api/attachments/upload/t/extra",
      "/api/attachments/upload/t?x=1",
      "/api/assets/t/a.png",
    ]) {
      expect(isUploadUrl(relativeUrl), relativeUrl).toBe(false);
    }
  });
});
