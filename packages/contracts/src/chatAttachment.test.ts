import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  ChatAttachment,
  getProviderAttachmentLimitError,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGES,
  PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES,
  SnapShotAccessibility,
} from "./chatAttachment.ts";

const decodeAttachment = Schema.decodeUnknownEffect(ChatAttachment);
const decodeSnapShotAccessibility = Schema.decodeUnknownEffect(SnapShotAccessibility);

// Attachments ride on persisted events and thread streams with no client
// version negotiation. A type this build does not know must decode instead of
// failing the whole message.
it.effect("tolerates attachment types from newer builds", () =>
  Effect.gen(function* () {
    const attachment = yield* decodeAttachment({
      type: "somethingnew",
      id: "thread-1-00000000-0000-4000-8000-000000000003-glb",
      name: "scene.glb",
      mimeType: "model/gltf-binary",
      sizeBytes: 12,
    });
    assert.strictEqual(attachment.type, "somethingnew");
  }),
);

// The tolerant member must not catch malformed known attachments: a file over
// the size cap or an image with a bad mime has to fail its own schema, not
// slide through the open one with those constraints unchecked.
it.effect("rejects malformed known attachment types instead of tolerating them", () =>
  Effect.gen(function* () {
    const base = {
      id: "thread-1-00000000-0000-4000-8000-000000000003-pdf",
      name: "report.pdf",
      mimeType: "application/pdf",
    };
    const oversizedFile = yield* Effect.exit(
      decodeAttachment({ ...base, type: "file", sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1 }),
    );
    assert.strictEqual(Exit.isFailure(oversizedFile), true);
    const badMimeImage = yield* Effect.exit(
      decodeAttachment({ ...base, type: "image", mimeType: "application/pdf", sizeBytes: 12 }),
    );
    assert.strictEqual(Exit.isFailure(badMimeImage), true);
  }),
);

it.effect("rejects accessibility trees above the serialized payload limit", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeSnapShotAccessibility({
        format: "element-tree",
        coordinateSpace: "captured-image",
        imageSize: { width: 800, height: 600 },
        truncated: false,
        root: {
          role: "window",
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          children: Array.from({ length: 10 }, () => ({
            role: "text",
            value: "x".repeat(8_000),
            bounds: null,
            children: [],
          })),
        },
      }),
    );

    assert.strictEqual(Exit.isFailure(result), true);
  }),
);

it("isProviderSendTurnSupportedImageMimeType accepts raster formats and rejects svg", () => {
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/png"), true);
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("IMAGE/JPEG"), true);
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/svg+xml"), false);
});

const image = (sizeBytes = 1) => ({ type: "image", mimeType: "image/png", sizeBytes }) as const;

it("getProviderAttachmentLimitError allows 20 images and rejects the 21st", () => {
  assert.strictEqual(PROVIDER_SEND_TURN_MAX_IMAGES, 20);
  assert.strictEqual(
    getProviderAttachmentLimitError(Array.from({ length: 20 }, () => image())),
    undefined,
  );
  assert.strictEqual(
    getProviderAttachmentLimitError(Array.from({ length: 21 }, () => image())),
    "You can attach up to 20 images per message or question response.",
  );
});

it("getProviderAttachmentLimitError counts generic files with image types as images", () => {
  const typedFile = { type: "file", mimeType: "image/webp", sizeBytes: 1 } as const;
  assert.match(
    getProviderAttachmentLimitError([...Array.from({ length: 20 }, () => image()), typedFile]) ??
      "",
    /up to 20 images/,
  );
});

it("getProviderAttachmentLimitError does not count unsupported image types or other files as images", () => {
  const svg = { type: "file", mimeType: "image/svg+xml", sizeBytes: 1 } as const;
  const pdf = { type: "file", mimeType: "application/pdf", sizeBytes: 1 } as const;
  assert.strictEqual(
    getProviderAttachmentLimitError([...Array.from({ length: 20 }, () => image()), svg, pdf]),
    undefined,
  );
});

it("getProviderAttachmentLimitError caps total image bytes at 22 MiB", () => {
  assert.strictEqual(PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES, 22 * 1024 * 1024);
  const half = PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES / 2;
  assert.strictEqual(getProviderAttachmentLimitError([image(half), image(half)]), undefined);
  assert.match(
    getProviderAttachmentLimitError([image(half), image(half), image(1)]) ?? "",
    /Images can total up to 22 MiB per message/,
  );
});

it("getProviderAttachmentLimitError still caps all attachments at 100", () => {
  const file = { type: "file", mimeType: "text/plain", sizeBytes: 1 } as const;
  assert.strictEqual(
    getProviderAttachmentLimitError(
      Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, () => file),
    ),
    undefined,
  );
  assert.match(
    getProviderAttachmentLimitError(
      Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1 }, () => file),
    ) ?? "",
    /up to 100 files/,
  );
});
