import { describe, expect, it } from "vite-plus/test";

import { resolveAnnotationSubmission } from "./AnnotationKeyboard.ts";

const keyboardEvent = (
  overrides: Partial<Parameters<typeof resolveAnnotationSubmission>[0]> = {},
) => ({
  isTrusted: true,
  key: "Enter",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  isComposing: false,
  ...overrides,
});

describe("resolveAnnotationSubmission", () => {
  it("attaches on Enter and sends on Cmd/Ctrl+Enter", () => {
    expect(resolveAnnotationSubmission(keyboardEvent(), true)).toBe("attach");
    expect(resolveAnnotationSubmission(keyboardEvent({ metaKey: true }), true)).toBe("send");
    expect(resolveAnnotationSubmission(keyboardEvent({ ctrlKey: true }), true)).toBe("send");
  });

  it("leaves Shift+Enter and composition events available for editing", () => {
    expect(resolveAnnotationSubmission(keyboardEvent({ shiftKey: true }), true)).toBeNull();
    expect(resolveAnnotationSubmission(keyboardEvent({ isComposing: true }), true)).toBeNull();
    expect(resolveAnnotationSubmission(keyboardEvent({ key: " " }), true)).toBeNull();
  });

  it("ignores synthetic key events a page script dispatches", () => {
    const synthetic = { isTrusted: false };
    expect(resolveAnnotationSubmission(keyboardEvent(synthetic), true)).toBeNull();
    expect(
      resolveAnnotationSubmission(keyboardEvent({ ...synthetic, ctrlKey: true }), true),
    ).toBeNull();
    expect(
      resolveAnnotationSubmission(keyboardEvent({ ...synthetic, metaKey: true }), true),
    ).toBeNull();
  });

  it("keeps attach available while the send shortcut follows permission changes", () => {
    const send = keyboardEvent({ ctrlKey: true });
    expect(resolveAnnotationSubmission(send, false)).toBeNull();
    expect(resolveAnnotationSubmission(keyboardEvent(), false)).toBe("attach");
    expect(resolveAnnotationSubmission(send, true)).toBe("send");
    expect(resolveAnnotationSubmission(send, false)).toBeNull();
    expect(resolveAnnotationSubmission(keyboardEvent({ metaKey: true }), false)).toBeNull();
  });
});
