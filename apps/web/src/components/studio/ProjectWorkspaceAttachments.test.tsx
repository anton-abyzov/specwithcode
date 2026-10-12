// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type ChatAttachment } from "@specweave-studio/contracts";
const draftState = vi.hoisted(() => ({
  draft: null as import("../../composerDraftStore").ComposerThreadDraftState | null,
  clear: vi.fn(),
  upload: vi.fn(),
  release: vi.fn(),
}));
vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getComposerDraft: () => draftState.draft,
      clearComposerContent: draftState.clear,
    }),
  },
}));
vi.mock("../../lib/attachmentUploadQueue", () => ({
  startAttachmentUpload: vi.fn(),
  awaitAttachmentUploads: async () => {},
  getUploadedAttachments: draftState.upload,
  releaseDraftAttachments: draftState.release,
}));
const asset = vi.hoisted(() => ({
  state: { _tag: "Success", url: "/signed/attachment", expiresAt: 1 },
  /** Attachments whose signed URL has not arrived yet. */
  loading: new Set<string>(),
}));
vi.mock("../../assets/assetUrls", () => ({
  useAssetUrlState: (_: unknown, resource: { attachmentId: string } | null) =>
    resource && asset.loading.has(resource.attachmentId)
      ? { _tag: "Initial" }
      : asset.state._tag === "Success" && resource
        ? { ...asset.state, url: `/signed/${resource.attachmentId}` }
        : asset.state,
}));
vi.mock("../files/AttachmentFilePreview", () => ({
  AttachmentFilePreview: (props: {
    name: string;
    asset: { attachmentId: string };
    onClose: () => void;
  }) => (
    <div data-preview-id={props.asset.attachmentId}>
      Captured {props.name}
      <button type="button" onClick={props.onClose}>
        Close
      </button>
    </div>
  ),
}));
vi.mock("../chat/ExpandedImageDialog", () => ({
  ExpandedImageDialog: ({
    preview,
    onClose,
  }: {
    preview: { images: Array<{ name: string; src: string | null }>; index: number };
    onClose: () => void;
  }) => (
    <div data-lightbox data-index={preview.index}>
      {preview.images.map((image) => `${image.name}=${image.src}`).join(",")}
      <button type="button" onClick={onClose}>
        Close preview
      </button>
    </div>
  ),
}));
import { sendProjectComposerDraft } from "../../studio/projectMessageRouting";
import { ProjectWorkspaceAttachments } from "./ProjectWorkspaceAttachments";
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it("renders signed image bytes and opens the captured file preview by attachment ID", async () => {
  const attachments: ChatAttachment[] = [
    {
      type: "image",
      id: "coordinator-image",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 3,
    },
    {
      type: "file",
      id: "coordinator-file",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
    },
  ];
  await act(async () =>
    root.render(
      <ProjectWorkspaceAttachments
        environmentId={EnvironmentId.make("host")}
        attachments={attachments}
      />,
    ),
  );
  expect(container.querySelector("img")?.getAttribute("src")).toBe("/signed/coordinator-image");
  expect(container.querySelector("img")?.alt).toBe("diagram.png");
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Preview notes.txt"]',
  )!;
  expect(button.textContent).toContain("notes.txt");
  await act(async () => button.click());
  expect(document.querySelector("[data-preview-id]")?.getAttribute("data-preview-id")).toBe(
    "coordinator-file",
  );
  // The preview is a dialog that closes from its own button, or with Escape.
  const close = [...document.querySelectorAll<HTMLButtonElement>("[data-preview-id] button")];
  await act(async () => close[0]!.click());
  expect(document.querySelector("[data-preview-id]")).toBeNull();
  await act(async () => button.click());
  expect(document.querySelector("[data-preview-id]")).not.toBeNull();
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  await vi.waitFor(() => expect(document.querySelector("[data-preview-id]")).toBeNull());
});

it("opens a sent image full screen over every image of its message", async () => {
  const image = (id: string): ChatAttachment => ({
    type: "image",
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 3,
  });
  await act(async () =>
    root.render(
      <ProjectWorkspaceAttachments
        environmentId={EnvironmentId.make("host")}
        attachments={[
          image("first"),
          {
            type: "file",
            id: "between",
            name: "log.txt",
            mimeType: "text/plain",
            sizeBytes: 3,
          },
          image("second"),
          image("third"),
        ]}
      />,
    ),
  );
  const thumbnails = container.querySelectorAll<HTMLButtonElement>(".project-captured-image");
  expect(thumbnails).toHaveLength(3);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Preview third.png"]')!.click(),
  );
  const lightbox = document.querySelector("[data-lightbox]")!;
  expect(lightbox.getAttribute("data-index")).toBe("2");
  expect(lightbox.textContent).toContain(
    "first.png=/signed/first,second.png=/signed/second,third.png=/signed/third",
  );
  expect(document.querySelector("[data-preview-id]")).toBeNull();
  await act(async () =>
    document.querySelector<HTMLButtonElement>("[data-lightbox] button")!.click(),
  );
  expect(document.querySelector("[data-lightbox]")).toBeNull();
});

it("keeps an open gallery steady while another image of the message loads", async () => {
  const image = (id: string): ChatAttachment => ({
    type: "image",
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 3,
  });
  // Fresh objects each render stand in for the store announcing the new URL.
  const view = () => (
    <ProjectWorkspaceAttachments
      environmentId={EnvironmentId.make("host")}
      attachments={[image("first"), image("second"), image("third")]}
    />
  );
  asset.loading = new Set(["second"]);
  try {
    await act(async () => root.render(view()));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Preview third.png"]')!.click(),
    );
    const before = document.querySelector("[data-lightbox]")!;
    expect(before.getAttribute("data-index")).toBe("1");
    expect(before.textContent).toContain("first.png=/signed/first,third.png=/signed/third");
    asset.loading = new Set();
    await act(async () => root.render(view()));
    const after = document.querySelector("[data-lightbox]")!;
    expect(after.getAttribute("data-index")).toBe("1");
    expect(after.textContent).not.toContain("second.png");
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Preview second.png"]')!.disabled,
    ).toBe(false);
  } finally {
    asset.loading = new Set();
  }
});

it("waits for an image's bytes before it can open", async () => {
  const previous = asset.state;
  asset.state = { _tag: "Initial" } as never;
  try {
    await act(async () =>
      root.render(
        <ProjectWorkspaceAttachments
          environmentId={EnvironmentId.make("host")}
          attachments={[
            { type: "image", id: "slow", name: "slow.png", mimeType: "image/png", sizeBytes: 3 },
          ]}
        />,
      ),
    );
    const thumbnail = container.querySelector<HTMLButtonElement>(".project-captured-image")!;
    expect(thumbnail.disabled).toBe(true);
    expect(thumbnail.textContent).toBe("slow.png");
  } finally {
    asset.state = previous;
  }
});

it("retains a changing draft and only releases uploads after confirmed unchanged delivery", async () => {
  const image = {
    id: "local-image",
    type: "image",
    name: "diagram.png",
  } as import("../../composerDraftStore").ComposerImageAttachment;
  const base = {
    prompt: "Review",
    images: [image],
    files: [],
    persistedAttachments: [{ id: "local-image" }],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
  } as unknown as import("../../composerDraftStore").ComposerThreadDraftState;
  const attachment = {
    type: "image" as const,
    id: "pending-00000000-0000-4000-8000-000000000001",
    name: "diagram.png",
    mimeType: "image/png",
    sizeBytes: 3,
  };
  const promptRef = { current: "Review" };
  draftState.clear.mockReset();
  draftState.release.mockReset();
  draftState.upload.mockReturnValue([attachment]);
  draftState.draft = base;
  let acknowledge: (() => void) | undefined;
  const send = vi.fn(
    () =>
      new Promise<void>((done) => {
        acknowledge = done;
      }),
  );
  const reportError = vi.fn();
  const input = {
    routing: { coordinatorThreadId: null, send, openCoordinator: vi.fn(), openThread: () => false },
    environmentId: EnvironmentId.make("host"),
    draftTarget: {
      environmentId: EnvironmentId.make("host"),
      threadId: "worker",
    } as import("../../composerDraftStore").ComposerThreadTarget,
    promptRef,
    supportsAttachmentUploads: true,
    hasDirectAnnotation: false,
    resetCursor: vi.fn(),
    reportError,
  };
  const first = sendProjectComposerDraft(input);
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(draftState.clear).not.toHaveBeenCalled();
  expect(draftState.release).not.toHaveBeenCalled();
  promptRef.current = "New user text";
  acknowledge!();
  await first;
  expect(draftState.clear).not.toHaveBeenCalled();
  expect(draftState.release).not.toHaveBeenCalled();
  promptRef.current = "Review";
  const second = sendProjectComposerDraft(input);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  // Persisting upload metadata replaces the draft object without changing user content.
  draftState.draft = { ...base };
  acknowledge!();
  await second;
  expect(draftState.clear).toHaveBeenCalledOnce();
  expect(draftState.release).toHaveBeenCalledWith([image]);
  expect(promptRef.current).toBe("");
  expect(reportError).not.toHaveBeenCalled();
});

it("replays original upload refs after reload instead of reminting an uncertain request", async () => {
  window.sessionStorage.clear();
  const attachment = {
    type: "file" as const,
    id: "pending-00000000-0000-4000-8000-000000000001-txt",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 3,
  };
  draftState.draft = {
    prompt: "Retry expired upload",
    images: [],
    files: [{ id: "local-retry-file", type: "file" }],
    persistedAttachments: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
  } as unknown as import("../../composerDraftStore").ComposerThreadDraftState;
  draftState.upload.mockReset();
  draftState.upload.mockReturnValue([attachment]);
  draftState.clear.mockReset();
  const send = vi
    .fn<(...args: unknown[]) => Promise<void>>()
    .mockRejectedValueOnce(new Error("Acknowledgement unknown"))
    .mockResolvedValueOnce();
  const input = {
    routing: { coordinatorThreadId: null, send, openCoordinator: vi.fn(), openThread: () => false },
    environmentId: EnvironmentId.make("host"),
    draftTarget: {
      environmentId: EnvironmentId.make("host"),
      threadId: "retry-worker",
    } as import("../../composerDraftStore").ComposerThreadTarget,
    promptRef: { current: "Retry expired upload" },
    supportsAttachmentUploads: true,
    hasDirectAnnotation: false,
    resetCursor: vi.fn(),
    reportError: vi.fn(),
  };
  await sendProjectComposerDraft(input);
  expect(draftState.clear).not.toHaveBeenCalled();
  expect(window.sessionStorage.length).toBe(1);
  draftState.upload.mockReturnValue([
    { ...attachment, id: "pending-00000000-0000-4000-8000-000000000002-txt" },
  ]);
  vi.resetModules();
  const reloaded = await import("../../studio/projectMessageRouting");
  await reloaded.sendProjectComposerDraft(input);
  expect(draftState.upload).toHaveBeenCalledOnce();
  expect(send.mock.calls[1]).toEqual(["Retry expired upload", [attachment]]);
  expect(draftState.clear).toHaveBeenCalledOnce();
  expect(window.sessionStorage.length).toBe(0);
});

it("prefers newer memory receipts and acknowledgement tombstones when storage writes fail", async () => {
  window.sessionStorage.clear();
  const original = {
    type: "file" as const,
    id: "pending-00000000-0000-4000-8000-000000000001-txt",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 3,
  };
  const next = { ...original, id: "pending-00000000-0000-4000-8000-000000000002-txt" };
  draftState.draft = {
    prompt: "Storage failure",
    images: [],
    files: [{ id: "storage-file", type: "file" }],
    persistedAttachments: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
  } as unknown as import("../../composerDraftStore").ComposerThreadDraftState;
  draftState.upload.mockReset();
  draftState.upload.mockReturnValueOnce([original]).mockReturnValue([next]);
  const send = vi
    .fn<(...args: unknown[]) => Promise<void>>()
    .mockRejectedValueOnce(new Error("Unknown"))
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error("Unknown again"))
    .mockResolvedValueOnce();
  const input = {
    routing: { coordinatorThreadId: null, send, openCoordinator: vi.fn(), openThread: () => false },
    environmentId: EnvironmentId.make("host"),
    draftTarget: {
      environmentId: EnvironmentId.make("host"),
      threadId: "storage-worker",
    } as import("../../composerDraftStore").ComposerThreadTarget,
    promptRef: { current: "Storage failure" },
    supportsAttachmentUploads: true,
    hasDirectAnnotation: false,
    resetCursor: vi.fn(),
    reportError: vi.fn(),
  };
  await sendProjectComposerDraft(input);
  expect(window.sessionStorage.length).toBe(1);
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Quota full");
  });
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("Unavailable");
  });
  try {
    await sendProjectComposerDraft(input);
    expect(send.mock.calls[1]?.[1]).toEqual([original]);
    input.promptRef.current = "Storage failure";
    await sendProjectComposerDraft(input);
    expect(send.mock.calls[2]?.[1]).toEqual([next]);
    await sendProjectComposerDraft(input);
    expect(send.mock.calls[3]?.[1]).toEqual([next]);
    expect(draftState.upload).toHaveBeenCalledTimes(2);
  } finally {
    write.mockRestore();
    remove.mockRestore();
  }
});
