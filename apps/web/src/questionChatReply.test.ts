import { describe, expect, it } from "vite-plus/test";

import type { ComposerImageAttachment, ComposerThreadDraftState } from "./composerDraftStore";
import { imageContextReference } from "./lib/composerContextRecords";
import { formatInlineContextReference } from "./lib/composerContextReferences";
import { planQuestionChatReply } from "./questionChatReply";

const image: ComposerImageAttachment = {
  type: "image",
  id: "image-1",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 70,
  previewUrl: "blob:screenshot",
  file: new File(["png"], "screenshot.png", { type: "image/png" }),
};

function draft(overrides: Partial<ComposerThreadDraftState>): ComposerThreadDraftState {
  return {
    prompt: "",
    images: [],
    files: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
    ...overrides,
  };
}

const plan = (value: ComposerThreadDraftState | null, allowCustomAnswer?: boolean) =>
  planQuestionChatReply({ draft: value, allowCustomAnswer, supportsQuestionAttachments: true });

describe("planQuestionChatReply", () => {
  it("lets the picked option answer when the composer is empty", () => {
    expect(plan(null)).toEqual({ kind: "none" });
    expect(plan(draft({ prompt: "   " }))).toEqual({ kind: "none" });
  });

  it("answers with the typed text and every attached file", () => {
    const chip = formatInlineContextReference(imageContextReference(image));
    expect(plan(draft({ prompt: `Use this layout ${chip} `, images: [image] }))).toEqual({
      kind: "reply",
      text: "Use this layout",
      images: [image],
      files: [],
    });
  });

  it("answers with files alone", () => {
    expect(plan(draft({ images: [image] }))).toMatchObject({ kind: "reply", text: "" });
  });

  it("explains what stops a reply instead of dropping it", () => {
    expect(plan(draft({ prompt: "Tall" }), false)).toEqual({
      kind: "blocked",
      reason: "Choose an option above to answer this question.",
    });
    expect(
      planQuestionChatReply({
        draft: draft({ images: [image] }),
        allowCustomAnswer: true,
        supportsQuestionAttachments: false,
      }),
    ).toMatchObject({ kind: "blocked", reason: expect.stringContaining("Update this server") });
    expect(
      plan(
        draft({
          prompt: "See the output",
          terminalContexts: [{} as ComposerThreadDraftState["terminalContexts"][number]],
        }),
      ),
    ).toMatchObject({ kind: "blocked", reason: expect.stringContaining("dismiss the question") });
  });
});
