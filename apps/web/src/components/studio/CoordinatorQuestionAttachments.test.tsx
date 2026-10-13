// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@specweave-studio/contracts";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  questionAttachmentDraftId,
  clearQuestionAttachmentDraft,
  useQuestionAttachmentPreparation,
} from "../../questionAttachments";
import { CoordinatorQuestionAttachments } from "./CoordinatorQuestionAttachments";
const io = vi.hoisted(() => ({
  allowed: true,
  upload: vi.fn(),
  release: vi.fn(),
  prepare: vi.fn(async (file: File) => ({ ok: true as const, file })),
}));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => io.allowed }));
vi.mock("../../lib/attachmentUploadQueue", () => ({
  startAttachmentUpload: io.upload,
  retryAttachmentUpload: vi.fn(),
  releaseDraftAttachment: io.release,
  releaseDraftAttachments: vi.fn(),
  useAttachmentUploadStore: () => ({}),
}));
vi.mock("../../lib/imageCompression", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/imageCompression")>()),
  prepareImageForAttachment: io.prepare,
}));
const environmentId = EnvironmentId.make("host"),
  threadId = ThreadId.make("coord");
const target = questionAttachmentDraftId(environmentId, threadId, "request", "one");
const main = scopeThreadRef(environmentId, threadId);
let root: Root, container: HTMLDivElement, disabled: boolean;
beforeEach(() => {
  vi.clearAllMocks();
  io.allowed = true;
  disabled = false;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  useQuestionAttachmentPreparation.setState({ counts: {} });
  useComposerDraftStore.getState().setPrompt(main, "Preserved main message");
  URL.createObjectURL = vi.fn(() => "blob:answer");
  URL.revokeObjectURL = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const render = () =>
  act(async () =>
    root.render(
      <CoordinatorQuestionAttachments
        environmentId={environmentId}
        threadId={threadId}
        requestId="request"
        questionId="one"
        allQuestionIds={["one", "two"]}
        disabled={disabled}
        maxFileBytes={1024 * 1024}
      />,
    ),
  );
const choose = async (file: File) => {
  const input = container.querySelector("input")!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
};
it("stages in the existing question draft and uploads with that owner; remount and removal preserve the main draft", async () => {
  await render();
  const file = new File(["answer"], "answer.txt", { type: "text/plain" });
  await choose(file);
  const held = useComposerDraftStore.getState().getComposerDraft(target)!.files[0]!;
  expect(held.file).toBe(file);
  expect(io.upload).toHaveBeenCalledWith({ environmentId, image: held, draftTarget: target });
  await act(async () => root.render(null));
  await render();
  expect(container.textContent).toContain("answer.txt");
  const remove = container.querySelector<HTMLButtonElement>('[aria-label="Remove answer.txt"]')!;
  expect(remove.dataset.slot).toBe("button");
  await act(async () => remove.click());
  expect(io.release).toHaveBeenCalledExactlyOnceWith(held);
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.files ?? []).toHaveLength(0);
  expect(useComposerDraftStore.getState().getComposerDraft(main)?.prompt).toBe(
    "Preserved main message",
  );
});
it("counts attachments across every question in the native request", async () => {
  const other = questionAttachmentDraftId(environmentId, threadId, "request", "two");
  useComposerDraftStore.getState().addFiles(
    other,
    Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, i) => ({
      type: "file",
      id: `f${i}`,
      name: `f${i}.txt`,
      mimeType: "text/plain",
      sizeBytes: 1,
      file: new File(["x"], `f${i}.txt`, { type: "text/plain" }),
    })),
  );
  await render();
  await choose(new File(["extra"], "extra.txt", { type: "text/plain" }));
  expect(io.upload).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')!.textContent).toContain("limit");
});
it.each(["disabled", "revoked"])("rejects file selection when %s", async (reason) => {
  disabled = reason === "disabled";
  io.allowed = reason !== "revoked";
  await render();
  await choose(new File(["x"], "answer.txt", { type: "text/plain" }));
  expect(io.upload).not.toHaveBeenCalled();
  expect(useComposerDraftStore.getState().getComposerDraft(target)).toBeNull();
});
it("does not attach an image after its question is resolved during preparation", async () => {
  let finish!: (value: { ok: true; file: File }) => void;
  io.prepare.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  const image = new File(["pixels"], "answer.png", { type: "image/png" });
  await choose(image);
  expect(useQuestionAttachmentPreparation.getState().counts[target]).toBe(1);
  await act(async () => {
    clearQuestionAttachmentDraft(target);
    finish({ ok: true, file: image });
  });
  expect(io.upload).not.toHaveBeenCalled();
  expect(useComposerDraftStore.getState().getComposerDraft(target)).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:answer");
});
