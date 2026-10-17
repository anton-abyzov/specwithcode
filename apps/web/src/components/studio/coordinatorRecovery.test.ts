// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import {
  coordinatorFolderCompatibility,
  coordinatorRequiresFolderGrants,
  coordinatorRetryMessage,
  coordinatorRetryPrompt,
  restageCoordinatorAttachments,
} from "./coordinatorRecovery";
import type { ChatAttachment, EnvironmentId } from "@specweave-studio/contracts";

const host = "selected-host" as EnvironmentId;
const screenshot: ChatAttachment = {
  type: "image",
  id: "captured-user-message-shot",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 3,
};
const documentAttachment: ChatAttachment = {
  type: "file",
  id: "captured-user-message-notes",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 3,
};
function queueFixture() {
  return {
    startAttachmentUpload: vi.fn(
      (_input: {
        environmentId: EnvironmentId;
        image: import("./shell/CoordinatorAttachments").CoordinatorAttachment;
      }) => {},
    ),
    awaitAttachmentUploads: vi.fn(async () => {}),
    getUploadedAttachments: vi.fn(
      ({
        images,
      }: {
        images: ReadonlyArray<import("./shell/CoordinatorAttachments").CoordinatorAttachment>;
      }): ChatAttachment[] | null =>
        images.map((image, i) => ({
          type: image.type,
          id: `pending-fresh-${i}`,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
        })),
    ),
    releaseDraftAttachment: vi.fn(
      (_attachment: import("./shell/CoordinatorAttachments").CoordinatorAttachment) => {},
    ),
  };
}

describe("coordinator recovery", () => {
  it("restages screenshots and files in the selected host without reusing captured IDs", async () => {
    const read = vi.fn(async (_attachment: ChatAttachment) => new Blob(["abc"]));
    const queue = queueFixture();
    const result = await restageCoordinatorAttachments({
      environmentId: host,
      attachments: [screenshot, documentAttachment],
      read,
      queue,
    });
    expect(read.mock.calls.map(([attachment]) => attachment.id)).toEqual([
      screenshot.id,
      documentAttachment.id,
    ]);
    expect(queue.startAttachmentUpload).toHaveBeenCalledTimes(2);
    for (const [input] of queue.startAttachmentUpload.mock.calls) {
      expect(input.environmentId).toBe(host);
      expect(input.image.id).not.toBe(screenshot.id);
      expect(input.image.id).not.toBe(documentAttachment.id);
      expect(input.image.file!.size).toBe(3);
      expect(input.image).not.toHaveProperty("uploadedAttachmentId");
    }
    expect(result.attachments.map((attachment) => attachment.id)).toEqual([
      "pending-fresh-0",
      "pending-fresh-1",
    ]);
    expect(result.attachments.map((attachment) => attachment.type)).toEqual(["image", "file"]);
    expect(queue.releaseDraftAttachment).not.toHaveBeenCalled();
    result.release();
    expect(queue.releaseDraftAttachment).toHaveBeenCalledTimes(2);
    expect([screenshot.id, documentAttachment.id]).toEqual([
      "captured-user-message-shot",
      "captured-user-message-notes",
    ]);
  });

  it("rejects the entire retry when one saved asset cannot be read, leaving originals intact", async () => {
    const queue = queueFixture();
    const read = vi
      .fn()
      .mockResolvedValueOnce(new Blob(["abc"]))
      .mockRejectedValueOnce(new Error("authorization denied"));
    await expect(
      restageCoordinatorAttachments({
        environmentId: host,
        attachments: [screenshot, documentAttachment],
        read,
        queue,
      }),
    ).rejects.toThrow("Could not restore notes.txt");
    expect(queue.getUploadedAttachments).not.toHaveBeenCalled();
    expect(queue.releaseDraftAttachment).toHaveBeenCalledTimes(1);
    expect(queue.releaseDraftAttachment.mock.calls[0]![0].id).not.toBe(screenshot.id);
  });

  it.each(["upload-failure", "invalid-reference", "missing-upload"])(
    "rejects incomplete staging: %s",
    async (kind) => {
      const queue = queueFixture();
      queue.getUploadedAttachments.mockReturnValueOnce(
        kind === "upload-failure" ? null : kind === "missing-upload" ? [] : [screenshot],
      );
      await expect(
        restageCoordinatorAttachments({
          environmentId: host,
          attachments: [screenshot],
          read: async () => new Blob(["abc"]),
          queue,
        }),
      ).rejects.toThrow("Could not restore all message attachments");
      expect(queue.releaseDraftAttachment).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects mismatched saved bytes before uploading", async () => {
    const queue = queueFixture();
    await expect(
      restageCoordinatorAttachments({
        environmentId: host,
        attachments: [screenshot],
        read: async () => new Blob(["truncated"]),
        queue,
      }),
    ).rejects.toThrow("saved bytes did not match");
    expect(queue.startAttachmentUpload).not.toHaveBeenCalled();
  });

  it("allows a text-only retry without asset operations", async () => {
    const read = vi.fn();
    const result = await restageCoordinatorAttachments({
      environmentId: host,
      attachments: [],
      read,
    });
    expect(result.attachments).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it("selects only the person's message, preserving empty text and all attachments", () => {
    const original = {
      role: "user",
      createdBy: "user",
      text: "",
      attachments: [screenshot, documentAttachment],
    };
    expect(
      coordinatorRetryMessage([
        original,
        { ...original, createdBy: "agent", text: "quoted reply" },
      ]),
    ).toBe(original);
    expect(coordinatorRetryMessage([{ ...original, createdBy: "agent" }])).toBeNull();
  });

  it("explains only the Studio folder grant limitation, including custom provider instances", () => {
    expect(coordinatorFolderCompatibility(true, "acpRegistry")).toContain(
      "current restricted policy",
    );
    expect(coordinatorFolderCompatibility(true, "codex")).toBeNull();
    expect(coordinatorFolderCompatibility(true, "claudeAgent")).toBeNull();
    expect(coordinatorFolderCompatibility(false, "acpRegistry")).toBeNull();
    expect(coordinatorFolderCompatibility(true, undefined)).toBeNull();
  });

  it("recognizes configured folders and external repositories without flagging a child checkout", () => {
    expect(
      coordinatorRequiresFolderGrants(
        { additionalFolders: ["/other"], repositories: [] },
        "/project",
      ),
    ).toBe(true);
    const repository = {
      id: "one",
      url: "https://github.com/example/one",
      localPath: "/project/src",
    };
    expect(
      coordinatorRequiresFolderGrants(
        { additionalFolders: [], repositories: [repository] },
        "/project",
      ),
    ).toBe(false);
    expect(
      coordinatorRequiresFolderGrants(
        { additionalFolders: [], repositories: [{ ...repository, localPath: "/project-sibling" }] },
        "/project",
      ),
    ).toBe(true);
  });
});

const retryQueue = vi.hoisted(() => ({
  startAttachmentUpload: vi.fn(),
  awaitAttachmentUploads: vi.fn(async () => {}),
  getUploadedAttachments: vi.fn(),
  releaseDraftAttachment: vi.fn(),
  releasePersistedAttachmentUpload: vi.fn(),
}));
vi.mock("../../lib/attachmentUploadQueue", () => retryQueue);
import { act, createElement, StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useCoordinatorMessageRecovery } from "./coordinatorRecovery";

let harnessOrdinal = 0;
function recoveryHarness(
  overrides: Partial<Parameters<typeof useCoordinatorMessageRecovery>[0]> = {},
  recoveryHook = useCoordinatorMessageRecovery,
  strictRetryOnMount = false,
) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  retryQueue.startAttachmentUpload.mockReset();
  retryQueue.awaitAttachmentUploads.mockReset().mockResolvedValue(undefined);
  retryQueue.getUploadedAttachments
    .mockReset()
    .mockImplementation(
      ({
        images,
      }: {
        images: ReadonlyArray<import("./shell/CoordinatorAttachments").CoordinatorAttachment>;
      }) => images.map((image) => ({ ...screenshot, id: `pending-${image.id}` })),
    );
  retryQueue.releaseDraftAttachment.mockReset();
  retryQueue.releasePersistedAttachmentUpload.mockReset();
  const input: Parameters<typeof useCoordinatorMessageRecovery>[0] = {
    environmentId: host,
    projectId: `retry-project-${++harnessOrdinal}`,
    coordinatorId: "coord" as never,
    failureRunId: "failed",
    message: {
      id: "saved",
      text: "Original text",
      attachments: [screenshot],
      senderThreadId: "worker" as never,
    },
    uploadsSupported: true,
    canRetry: true,
    flight: { current: false },
    composer: { setSubmitting: vi.fn() },
    revision: () => 7,
    send: vi.fn(async () => {}),
    read: vi.fn(async () => new Blob(["abc"])),
    reportError: vi.fn(),
    setRetrying: vi.fn(),
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let retry!: () => void;
  function Fixture() {
    retry = recoveryHook(input);
    useEffect(() => {
      if (strictRetryOnMount) retry();
    }, []);
    return null;
  }
  return {
    input,
    mount: async () => {
      // Resolve the mocked lazy dependency before React's StrictMode effect replay.
      // Module loading is setup, not part of the pending asset-read assertion.
      await import("../../lib/attachmentUploadQueue");
      await act(async () =>
        root.render(
          strictRetryOnMount
            ? createElement(StrictMode, null, createElement(Fixture))
            : createElement(Fixture),
        ),
      );
    },
    retry: async () => {
      await act(async () => retry());
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("worker follow-up retry text", () => {
  const wrapper = (source: string, text: string) =>
    `User follow-up from selected worker ${source}. Review that thread and decide whether to reuse it or route elsewhere.\n\n${text}`;

  it("removes only the matching generated envelope and preserves the person's identical prefix", () => {
    const original = wrapper("worker", "Please inspect this exact wording.");
    const envelope = {
      id: "coordinator-send:project:command",
      text: wrapper("worker", original),
      senderThreadId: "worker",
    };
    expect(coordinatorRetryPrompt(envelope, "project", "worker")).toBe(original);
    expect(coordinatorRetryPrompt(envelope, "other-project", "worker")).toBe(envelope.text);
    expect(
      coordinatorRetryPrompt({ ...envelope, id: "ordinary-user-message" }, "project", "worker"),
    ).toBe(envelope.text);
    expect(
      coordinatorRetryPrompt({ ...envelope, senderThreadId: "other-worker" }, "project", "worker"),
    ).toBe(envelope.text);
    const mismatchedPrefix = { ...envelope, text: wrapper("other-worker", original) };
    expect(coordinatorRetryPrompt(mismatchedPrefix, "project", "worker")).toBe(
      mismatchedPrefix.text,
    );
    expect(coordinatorRetryPrompt(envelope, "project", undefined)).toBe(envelope.text);
    expect(
      coordinatorRetryPrompt(
        { ...envelope, text: "Keep the original unwrapped request" },
        "project",
        "worker",
      ),
    ).toBe("Keep the original unwrapped request");
  });

  it("keeps original prompt and sender provenance through repeated saved worker retries", async () => {
    const original = wrapper(
      "worker",
      "  Verify the screenshot.\nKeep these exact newlines and my authored prefix.  ",
    );
    const send = vi.fn(async (text: string, source: string | undefined) => {
      expect(source).toBe("worker");
      fixture.input.message!.text = wrapper(source!, text);
    });
    const fixture = recoveryHarness({
      send,
      projectId: "project",
      message: {
        id: "coordinator-send:project:saved-worker",
        text: wrapper("worker", original),
        attachments: [],
        senderThreadId: "worker" as never,
      },
    });
    await fixture.mount();
    await fixture.retry();
    fixture.input.failureRunId = "saved-worker-failed-again";
    await fixture.mount();
    await fixture.retry();
    fixture.input.failureRunId = "saved-worker-failed-third-time";
    await fixture.mount();
    await fixture.retry();
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map(([text, source]) => [text, source])).toEqual([
      [original, "worker"],
      [original, "worker"],
      [original, "worker"],
    ]);
    expect(fixture.input.message!.text).toBe(wrapper("worker", original));
    await fixture.unmount();
  });
});

describe("coordinator retry ownership", () => {
  it("retains confirmed F1 through a lagged F0 cache mount, stale F1 return and module reload", async () => {
    const projectId = "lagged-confirmed-projection";
    const send = vi.fn(async () => {});
    const first = recoveryHarness({ projectId, failureRunId: "F1", send });
    await first.mount();
    await first.retry();
    expect(send).toHaveBeenCalledTimes(1);
    await first.unmount();
    const lagged = recoveryHarness({ projectId, failureRunId: "F0", canRetry: false });
    await lagged.mount();
    await lagged.unmount();
    const stale = recoveryHarness({ projectId, failureRunId: "F1", send });
    await stale.mount();
    await stale.retry();
    expect(send).toHaveBeenCalledTimes(1);
    expect(stale.input.read).not.toHaveBeenCalled();
    await stale.unmount();
    vi.resetModules();
    const reloaded = await import("./coordinatorRecovery");
    const freshPage = recoveryHarness(
      { projectId, failureRunId: "F1", send },
      reloaded.useCoordinatorMessageRecovery,
    );
    await freshPage.mount();
    await freshPage.retry();
    expect(send).toHaveBeenCalledTimes(1);
    expect(freshPage.input.read).not.toHaveBeenCalled();
    freshPage.input.failureRunId = "F2";
    await freshPage.mount();
    await freshPage.retry();
    expect(send).toHaveBeenCalledTimes(2);
    freshPage.input.failureRunId = "F1";
    await freshPage.mount();
    await freshPage.retry();
    expect(send).toHaveBeenCalledTimes(2);
    await freshPage.unmount();
  });

  it("keeps a confirmed retry tombstone while the same failed projection remains visible", async () => {
    const projectId = "confirmed-stale-projection";
    const receipt = createScopedProjectSendReceipt(host, projectId);
    const allocate = vi.fn(() => `confirmed-command-${allocate.mock.calls.length}`);
    const send = vi.fn(async (text, source, attachments) => {
      const id = receipt.forPrompt(
        JSON.stringify([projectId, text, source, attachments]),
        allocate,
      );
      receipt.acknowledge(id);
    });
    const fixture = recoveryHarness({ projectId, send });
    await fixture.mount();
    await fixture.retry();
    expect(retryQueue.releaseDraftAttachment).toHaveBeenCalledTimes(1);
    await fixture.retry();
    expect(send).toHaveBeenCalledTimes(1);
    expect(allocate).toHaveBeenCalledTimes(1);
    expect(retryQueue.startAttachmentUpload).toHaveBeenCalledTimes(1);
    await fixture.unmount();
    const remounted = recoveryHarness({ projectId, send });
    await remounted.mount();
    await remounted.retry();
    expect(send).toHaveBeenCalledTimes(1);
    expect(remounted.input.read).not.toHaveBeenCalled();
    remounted.input.failureRunId = "distinct-failed-run";
    await remounted.mount();
    await remounted.retry();
    expect(send).toHaveBeenCalledTimes(2);
    expect(allocate).toHaveBeenCalledTimes(2);
    await remounted.unmount();
  });

  it("releases a canceled pre-dispatch lock immediately without clearing a newer owner", async () => {
    let resolveOld!: (blob: Blob) => void;
    let resolveNew!: (blob: Blob) => void;
    let submitting = false;
    const flight = { current: false };
    const composer = {
      setSubmitting: vi.fn((value: boolean) => {
        submitting = value;
      }),
    };
    const old = recoveryHarness({
      flight,
      composer,
      read: () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    });
    await old.mount();
    await old.retry();
    expect(submitting).toBe(true);
    await old.unmount();
    expect(submitting).toBe(false);
    expect(flight.current).toBe(false);
    const next = recoveryHarness({
      projectId: old.input.projectId,
      flight,
      composer,
      read: () =>
        new Promise((resolve) => {
          resolveNew = resolve;
        }),
    });
    await next.mount();
    await next.retry();
    expect(submitting).toBe(true);
    await act(async () => resolveOld(new Blob(["abc"])));
    expect(submitting).toBe(true);
    expect(flight.current).toBe(true);
    expect(old.input.send).not.toHaveBeenCalled();
    await act(async () => resolveNew(new Blob(["abc"])));
    expect(next.input.send).toHaveBeenCalledTimes(1);
    expect(submitting).toBe(false);
    await next.unmount();
  });

  it("keeps uncertain post-dispatch identity through navigation and a later lost acknowledgement", async () => {
    let rejectAck!: (error: Error) => void;
    const send = vi.fn(
      (_text, _source, _attachments) =>
        new Promise<void>((_resolve, reject) => {
          rejectAck = reject;
        }),
    );
    const first = recoveryHarness({ send });
    await first.mount();
    await first.retry();
    expect(send).toHaveBeenCalledTimes(1);
    const attachments = send.mock.calls[0]![2];
    await first.unmount();
    expect(first.input.composer.setSubmitting).not.toHaveBeenCalledWith(false);
    expect(retryQueue.releaseDraftAttachment).not.toHaveBeenCalled();
    const next = recoveryHarness({
      projectId: first.input.projectId,
      composer: first.input.composer,
      send,
    });
    await next.mount();
    await next.retry();
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => rejectAck(new Error("Acknowledgement lost")));
    expect(first.input.composer.setSubmitting).toHaveBeenCalledWith(false);
    send.mockResolvedValueOnce(undefined);
    await next.retry();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![2]).toBe(attachments);
    expect(next.input.read).not.toHaveBeenCalled();
    expect(retryQueue.releaseDraftAttachment).toHaveBeenCalledTimes(1);
    await next.unmount();
  });

  it("owns only the surviving StrictMode staging flight and cancels its pending read on navigation", async () => {
    let resolveRead!: (blob: Blob) => void;
    const fixture = recoveryHarness(
      {
        read: vi.fn(
          () =>
            new Promise<Blob>((resolve) => {
              resolveRead = resolve;
            }),
        ),
      },
      useCoordinatorMessageRecovery,
      true,
    );
    await fixture.mount();
    await act(async () => {
      // The surviving flight first loads the upload queue on demand. Each dynamic import goes
      // back through vitest's module runner, which a loaded release host delays well past 10s.
      await vi.waitFor(() => expect(fixture.input.read).toHaveBeenCalledTimes(1), {
        timeout: 45_000,
      });
    });
    expect((fixture.input.composer.setSubmitting as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [true],
      [false],
      [true],
    ]);
    expect(fixture.input.reportError).toHaveBeenLastCalledWith(null);
    expect(fixture.input.read).toHaveBeenCalledTimes(1);
    expect(fixture.input.flight.current).toBe(true);
    await fixture.unmount();
    expect(fixture.input.flight.current).toBe(false);
    expect(fixture.input.composer.setSubmitting).toHaveBeenLastCalledWith(false);
    await act(async () => resolveRead(new Blob(["abc"])));
    expect(fixture.input.send).not.toHaveBeenCalled();
    expect(retryQueue.startAttachmentUpload).not.toHaveBeenCalled();
  }, 60_000);

  it("holds the shared send flight during staging, ignores double clicks, and preserves worker provenance", async () => {
    let resolveRead!: (value: Blob) => void;
    const fixture = recoveryHarness({
      read: () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    });
    await fixture.mount();
    await fixture.retry();
    expect(fixture.input.flight.current).toBe(true);
    expect(fixture.input.composer.setSubmitting).toHaveBeenCalledWith(true);
    await fixture.retry();
    await act(async () => resolveRead(new Blob(["abc"])));
    expect(fixture.input.send).toHaveBeenCalledExactlyOnceWith(
      "Original text",
      "worker",
      [expect.objectContaining({ ...screenshot, id: expect.stringMatching(/^pending-/) })],
      expect.any(Function),
    );
    expect(fixture.input.flight.current).toBe(false);
    expect(retryQueue.startAttachmentUpload).toHaveBeenCalledTimes(1);
    await fixture.unmount();
  });

  it("keeps staged references after an uncertain send and releases only after confirmation", async () => {
    const send = vi.fn().mockRejectedValue(new Error("Delivery not confirmed"));
    const fixture = recoveryHarness({ send });
    await fixture.mount();
    await fixture.retry();
    await fixture.retry();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![2]).toBe(send.mock.calls[1]![2]);
    expect(retryQueue.startAttachmentUpload).toHaveBeenCalledTimes(1);
    expect(retryQueue.releaseDraftAttachment).not.toHaveBeenCalled();
    await fixture.unmount();
    expect(retryQueue.releaseDraftAttachment).not.toHaveBeenCalled();
    send.mockResolvedValueOnce(undefined);
    const remounted = recoveryHarness({ projectId: fixture.input.projectId, send });
    await remounted.mount();
    await remounted.retry();
    expect(retryQueue.startAttachmentUpload).not.toHaveBeenCalled();
    expect(retryQueue.releaseDraftAttachment).toHaveBeenCalledTimes(1);
    await remounted.unmount();
  });

  it("cancels an unmounted retry before it can upload or dispatch into another project", async () => {
    let resolveRead!: (value: Blob) => void;
    const fixture = recoveryHarness({
      read: () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    });
    await fixture.mount();
    await fixture.retry();
    await fixture.unmount();
    await act(async () => resolveRead(new Blob(["abc"])));
    expect(retryQueue.startAttachmentUpload).not.toHaveBeenCalled();
    expect(fixture.input.send).not.toHaveBeenCalled();
    expect(fixture.input.flight.current).toBe(false);
  });

  it("refuses dispatch if project settings changed during restoration", async () => {
    let resolveRead!: (value: Blob) => void;
    let revision = 7;
    const fixture = recoveryHarness({
      revision: () => revision,
      read: () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    });
    await fixture.mount();
    await fixture.retry();
    revision = 8;
    await act(async () => resolveRead(new Blob(["abc"])));
    expect(fixture.input.send).not.toHaveBeenCalled();
    expect(fixture.input.reportError).toHaveBeenCalledWith(
      expect.stringContaining("Project settings changed"),
    );
    expect(retryQueue.releaseDraftAttachment).toHaveBeenCalledTimes(1);
    await fixture.unmount();
  });
});

import { createScopedProjectSendReceipt } from "../../studio/projectWorkspaceModel";

describe("coordinator retry replay across project remounts", () => {
  it("reuses pending ids and command identity after the host accepted a send but its acknowledgement was lost", async () => {
    const projectId = "lost-ack-project";
    const accepted = new Map<string, string>();
    const commandIds: string[] = [];
    const attachmentIds: string[][] = [];
    const allocate = vi.fn(() => `test-command-${commandIds.length + 1}`);
    const deliver =
      (receipt: ReturnType<typeof createScopedProjectSendReceipt>, loseAck: boolean) =>
      async (
        text: string,
        source: string | undefined,
        attachments: ReadonlyArray<ChatAttachment> | undefined,
      ) => {
        const fingerprint = JSON.stringify([projectId, text, source ?? null, attachments ?? []]);
        const commandId = receipt.forPrompt(fingerprint, allocate);
        commandIds.push(commandId);
        attachmentIds.push((attachments ?? []).map((attachment) => attachment.id));
        accepted.set(commandId, fingerprint);
        if (loseAck) throw new Error("Host accepted the request; acknowledgement was lost");
        receipt.acknowledge(commandId);
      };
    const first = recoveryHarness({
      projectId,
      send: deliver(createScopedProjectSendReceipt(host, projectId), true),
    });
    await first.mount();
    await first.retry();
    expect(retryQueue.startAttachmentUpload).toHaveBeenCalledTimes(1);
    await first.unmount();
    expect(retryQueue.releaseDraftAttachment).not.toHaveBeenCalled();
    const second = recoveryHarness({
      projectId,
      send: deliver(createScopedProjectSendReceipt(host, projectId), false),
    });
    await second.mount();
    await second.retry();
    expect(second.input.read).not.toHaveBeenCalled();
    expect(retryQueue.startAttachmentUpload).not.toHaveBeenCalled();
    expect(commandIds).toEqual(["test-command-1", "test-command-1"]);
    expect(attachmentIds[1]).toEqual(attachmentIds[0]);
    expect(allocate).toHaveBeenCalledTimes(1);
    expect(accepted.size).toBe(1);
    expect(retryQueue.releaseDraftAttachment).toHaveBeenCalledTimes(1);
    expect(retryQueue.releaseDraftAttachment.mock.calls[0]![0].file).toBeNull();
    await second.unmount();
  });

  it("keeps uncertain staging isolated by both host and project", async () => {
    const scopes = [
      { environmentId: "isolated-host-a" as EnvironmentId, projectId: "same-project" },
      { environmentId: "isolated-host-b" as EnvironmentId, projectId: "same-project" },
      { environmentId: "isolated-host-a" as EnvironmentId, projectId: "other-project" },
    ];
    const ids: string[] = [];
    for (const scope of scopes) {
      const send = vi.fn().mockRejectedValue(new Error("Unknown delivery"));
      const fixture = recoveryHarness({ ...scope, send });
      await fixture.mount();
      await fixture.retry();
      expect(retryQueue.startAttachmentUpload).toHaveBeenCalledTimes(1);
      expect(fixture.input.read).toHaveBeenCalledTimes(1);
      ids.push(send.mock.calls[0]![2][0].id);
      await fixture.unmount();
      expect(retryQueue.releaseDraftAttachment).not.toHaveBeenCalled();
    }
    expect(new Set(ids).size).toBe(3);
    for (const scope of scopes) {
      const confirmed = recoveryHarness(scope);
      await confirmed.mount();
      await confirmed.retry();
      expect(retryQueue.startAttachmentUpload).not.toHaveBeenCalled();
      expect(retryQueue.releaseDraftAttachment).toHaveBeenCalledTimes(1);
      await confirmed.unmount();
    }
  });

  it("releases uploads canceled on unmount before dispatch, without retaining a replay receipt", async () => {
    let finishUploads!: () => void;
    const fixture = recoveryHarness({ projectId: "canceled-stage" });
    retryQueue.awaitAttachmentUploads.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishUploads = resolve;
        }),
    );
    await fixture.mount();
    await fixture.retry();
    expect(retryQueue.startAttachmentUpload).toHaveBeenCalledTimes(1);
    await fixture.unmount();
    expect(retryQueue.releaseDraftAttachment).toHaveBeenCalledTimes(1);
    await act(async () => finishUploads());
    expect(fixture.input.send).not.toHaveBeenCalled();
    const remounted = recoveryHarness({ projectId: "canceled-stage" });
    await remounted.mount();
    await remounted.retry();
    expect(retryQueue.startAttachmentUpload).toHaveBeenCalledTimes(1);
    expect(remounted.input.read).toHaveBeenCalledTimes(1);
    await remounted.unmount();
  });
});

import { ProjectId, ProjectWorkspaceError } from "@specweave-studio/contracts";
import { isDefinitiveCoordinatorRejection } from "./coordinatorRecovery";

describe("definitive coordinator retry rejections", () => {
  const rejection = (code: ProjectWorkspaceError["code"], projectId = "rejected-stage") =>
    new ProjectWorkspaceError({ code, projectId: ProjectId.make(projectId) });

  it.each(["attachment_unavailable"] as const)(
    "re-stages original screenshots and files after the typed %s rejection",
    async (code) => {
      const projectId = `rejected-stage-${code}`;
      const message = {
        id: "saved-with-files",
        text: "Keep the exact original request",
        attachments: [screenshot, documentAttachment],
      };
      const send = vi
        .fn()
        .mockRejectedValueOnce(rejection(code, projectId))
        .mockResolvedValueOnce(undefined);
      const fixture = recoveryHarness({ projectId, message, send });
      retryQueue.getUploadedAttachments.mockImplementation(
        ({
          images,
        }: {
          images: ReadonlyArray<import("./shell/CoordinatorAttachments").CoordinatorAttachment>;
        }) =>
          images.map((image) => ({
            type: image.type,
            id: `pending-${image.id}`,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
          })),
      );
      await fixture.mount();
      await fixture.retry();
      expect(retryQueue.releaseDraftAttachment).toHaveBeenCalledTimes(2);
      await fixture.retry();
      expect(retryQueue.startAttachmentUpload).toHaveBeenCalledTimes(4);
      expect(send).toHaveBeenCalledTimes(2);
      const first = send.mock.calls[0]![2] as ReadonlyArray<ChatAttachment>;
      const second = send.mock.calls[1]![2] as ReadonlyArray<ChatAttachment>;
      expect(second.map((attachment) => attachment.id)).not.toEqual(
        first.map((attachment) => attachment.id),
      );
      expect(second.map((attachment) => [attachment.type, attachment.name])).toEqual([
        ["image", "shot.png"],
        ["file", "notes.txt"],
      ]);
      expect(send.mock.calls.map(([text]) => text)).toEqual([message.text, message.text]);
      expect(message.attachments).toEqual([screenshot, documentAttachment]);
      expect(retryQueue.releaseDraftAttachment).toHaveBeenCalledTimes(4);
      await fixture.unmount();
    },
  );

  it.each([
    "invalid_source_thread",
    "invalid_coordinator",
    "invalid_attachments",
    "attachment_limit",
    "unsupported_provider",
    "paused",
    "archived",
    "model_required",
    "operation_failed",
    "conflict",
  ] as const)("preserves replay references for ambiguous typed %s failures", async (code) => {
    const projectId = `ambiguous-stage-${code}`;
    const send = vi
      .fn()
      .mockRejectedValueOnce(rejection(code, projectId))
      .mockResolvedValueOnce(undefined);
    const fixture = recoveryHarness({ projectId, send });
    await fixture.mount();
    await fixture.retry();
    expect(retryQueue.releaseDraftAttachment).not.toHaveBeenCalled();
    await fixture.retry();
    expect(retryQueue.startAttachmentUpload).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[1]![2]).toBe(send.mock.calls[0]![2]);
    await fixture.unmount();
  });

  it("requires the genuine same-project error type instead of trusting matching error text or foreign scope", () => {
    const error = rejection("attachment_unavailable", "project-a");
    expect(isDefinitiveCoordinatorRejection(error, "project-a")).toBe(true);
    expect(isDefinitiveCoordinatorRejection(error, "project-b")).toBe(false);
    expect(
      isDefinitiveCoordinatorRejection(
        Object.assign(new Error("These attachments cannot be sent."), {
          _tag: "ProjectWorkspaceError",
          code: "attachment_unavailable",
          projectId: "project-a",
        }),
        "project-a",
      ),
    ).toBe(false);
    expect(isDefinitiveCoordinatorRejection(new Error(error.message), "project-a")).toBe(false);
  });
});

describe("durable coordinator retry receipt", () => {
  it("persists confirmation before command acknowledgement and replays safely when that write fails", async () => {
    const projectId = "confirmation-storage-failed";
    const receipt = createScopedProjectSendReceipt(host, projectId);
    const allocate = vi.fn(() => "accepted-before-storage-failure");
    const commands: string[] = [];
    const send = vi.fn(async (text, source, attachments, onConfirmed) => {
      const commandId = receipt.forPrompt(
        JSON.stringify([projectId, text, source, attachments]),
        allocate,
      );
      commands.push(commandId);
      onConfirmed();
      receipt.acknowledge(commandId);
    });
    const save = Storage.prototype.setItem;
    const block = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key.startsWith("studio.coordinator-recovery.v1:") && JSON.parse(value).confirmed)
        throw new Error("Confirmation storage failed");
      save.call(this, key, value);
    });
    const first = recoveryHarness({ projectId, send });
    await first.mount();
    await first.retry();
    expect(first.input.reportError).toHaveBeenCalledWith(
      expect.stringContaining("session storage"),
    );
    expect(retryQueue.releaseDraftAttachment).toHaveBeenCalledTimes(1);
    await first.retry();
    expect(send).toHaveBeenCalledTimes(1);
    await first.unmount();
    block.mockRestore();
    vi.resetModules();
    const reloaded = await import("./coordinatorRecovery");
    const next = recoveryHarness({ projectId, send }, reloaded.useCoordinatorMessageRecovery);
    await next.mount();
    await next.retry();
    expect(commands).toEqual([
      "accepted-before-storage-failure",
      "accepted-before-storage-failure",
    ]);
    expect(allocate).toHaveBeenCalledTimes(1);
    expect(next.input.read).not.toHaveBeenCalled();
    expect(send.mock.calls[1]![2]).toEqual(send.mock.calls[0]![2]);
    await next.unmount();
  });

  it("rehydrates safe metadata after a module reload with exactly the same attachment and command ids", async () => {
    const projectId = "page-reload-receipt";
    const environmentId = "page-reload-host" as EnvironmentId;
    const message = {
      id: "captured-reload",
      text: "Keep the screenshot context",
      attachments: [
        {
          ...screenshot,
          source: {
            kind: "snap-shot" as const,
            capturedAt: "2026-10-13T12:00:00Z",
            appName: "Example",
            windowTitle: "Window",
            accessibleText: "Original capture content",
            appIconDataUrl: "data:image/png;base64,YWJj",
          },
        },
      ],
    };
    const commands: string[] = [];
    const fingerprints: string[] = [];
    const allocate = vi.fn(() => `reload-command-${commands.length + 1}`);
    const deliver =
      (receipt: ReturnType<typeof createScopedProjectSendReceipt>, loseAck: boolean) =>
      async (
        text: string,
        source: string | undefined,
        attachments: ReadonlyArray<ChatAttachment> | undefined,
      ) => {
        const fingerprint = JSON.stringify([projectId, text, source ?? null, attachments ?? []]);
        const id = receipt.forPrompt(fingerprint, allocate);
        commands.push(id);
        fingerprints.push(fingerprint);
        if (loseAck) throw new Error("Acknowledgement lost");
        receipt.acknowledge(id);
      };
    const first = recoveryHarness({
      environmentId,
      projectId,
      message,
      send: deliver(createScopedProjectSendReceipt(environmentId, projectId), true),
    });
    retryQueue.getUploadedAttachments.mockImplementation(
      ({
        images,
      }: {
        images: ReadonlyArray<import("./shell/CoordinatorAttachments").CoordinatorAttachment>;
      }) => images.map((image) => ({ ...message.attachments[0]!, id: `pending-${image.id}` })),
    );
    await first.mount();
    await first.retry();
    await first.unmount();
    const storageKey = Array.from({ length: sessionStorage.length }, (_, i) =>
      sessionStorage.key(i)!,
    ).find((key) => key.startsWith("studio.coordinator-recovery.v1:") && key.includes(projectId))!;
    const saved = sessionStorage.getItem(storageKey)!;
    expect(saved).not.toContain("Original capture content");
    expect(saved).not.toContain("data:image");
    expect(saved).not.toContain("source");
    expect(Object.keys(JSON.parse(saved).attachments[0]).sort()).toEqual([
      "id",
      "mimeType",
      "name",
      "sizeBytes",
      "type",
    ]);
    vi.resetModules();
    const reloaded = await import("./coordinatorRecovery");
    const second = recoveryHarness(
      {
        environmentId,
        projectId,
        message,
        send: deliver(createScopedProjectSendReceipt(environmentId, projectId), false),
      },
      reloaded.useCoordinatorMessageRecovery,
    );
    await second.mount();
    await second.retry();
    expect(second.input.read).not.toHaveBeenCalled();
    expect(retryQueue.startAttachmentUpload).not.toHaveBeenCalled();
    expect(commands).toEqual(["reload-command-1", "reload-command-1"]);
    expect(fingerprints[1]).toBe(fingerprints[0]);
    expect(allocate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual({
      version: 1,
      confirmed: true,
    });
    expect(retryQueue.releasePersistedAttachmentUpload).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ environmentId, attachmentId: JSON.parse(saved).attachments[0].id }),
    );
    await second.unmount();
    vi.resetModules();
    const afterConfirmation = await import("./coordinatorRecovery");
    const third = recoveryHarness(
      { environmentId, projectId, message },
      afterConfirmation.useCoordinatorMessageRecovery,
    );
    await third.mount();
    await third.retry();
    expect(third.input.read).not.toHaveBeenCalled();
    expect(third.input.send).not.toHaveBeenCalled();
    expect(retryQueue.startAttachmentUpload).not.toHaveBeenCalled();
    expect(third.input.reportError).toHaveBeenCalledWith(
      expect.stringContaining("retry was confirmed"),
    );
    await third.unmount();
  });

  it("fails visibly before dispatch when browser storage cannot preserve the retry identity", async () => {
    const fixture = recoveryHarness({ projectId: "blocked-recovery-storage" });
    const block = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    await fixture.mount();
    await fixture.retry();
    expect(fixture.input.send).not.toHaveBeenCalled();
    expect(fixture.input.reportError).toHaveBeenCalledWith(
      expect.stringContaining("session storage"),
    );
    expect(retryQueue.releaseDraftAttachment).toHaveBeenCalledTimes(1);
    block.mockRestore();
    await fixture.retry();
    expect(fixture.input.send).toHaveBeenCalledTimes(1);
    expect(retryQueue.startAttachmentUpload).toHaveBeenCalledTimes(2);
    await fixture.unmount();
  });

  it("rejects an untrusted stored reference instead of silently changing request identity", async () => {
    const fixture = recoveryHarness({ projectId: "invalid-recovery-storage" });
    const key =
      "studio.coordinator-recovery.v1:" +
      encodeURIComponent(
        JSON.stringify([
          fixture.input.environmentId,
          fixture.input.projectId,
          fixture.input.message!.id,
          fixture.input.failureRunId,
        ]),
      );
    sessionStorage.setItem(
      key,
      JSON.stringify({ version: 1, attachments: [{ ...screenshot, id: "foreign-captured-id" }] }),
    );
    await fixture.mount();
    await fixture.retry();
    expect(fixture.input.send).not.toHaveBeenCalled();
    expect(retryQueue.startAttachmentUpload).not.toHaveBeenCalled();
    expect(fixture.input.reportError).toHaveBeenCalledWith(
      expect.stringContaining("cannot be restored safely"),
    );
    await fixture.unmount();
    sessionStorage.removeItem(key);
  });
});

import { coordinatorRetryFingerprint } from "./coordinatorRecovery";

describe("coordinator retry failure identity", () => {
  it("distinguishes a text-only retry from its accepted original and from the next failed run", () => {
    const project = "text-only-failure-identity";
    const originalFingerprint = JSON.stringify([project, "Reply with OK", null, []]);
    const receipt = createScopedProjectSendReceipt(host, project);
    let ordinal = 0;
    const allocate = vi.fn(() => `failure-command-${++ordinal}`);
    const acceptedOriginal = receipt.forPrompt(
      coordinatorRetryFingerprint(originalFingerprint),
      allocate,
    );
    const firstRetry = receipt.forPrompt(
      coordinatorRetryFingerprint(originalFingerprint, ["failed-run-1", "original-message"]),
      allocate,
    );
    expect(firstRetry).not.toBe(acceptedOriginal);
    const remountedReceipt = createScopedProjectSendReceipt(host, project);
    expect(
      remountedReceipt.forPrompt(
        coordinatorRetryFingerprint(originalFingerprint, ["failed-run-1", "original-message"]),
        allocate,
      ),
    ).toBe(firstRetry);
    const nextRetry = remountedReceipt.forPrompt(
      coordinatorRetryFingerprint(originalFingerprint, ["failed-run-2", "original-message"]),
      allocate,
    );
    expect(nextRetry).not.toBe(firstRetry);
    expect(nextRetry).not.toBe(acceptedOriginal);
    const otherMessageRetry = remountedReceipt.forPrompt(
      coordinatorRetryFingerprint(originalFingerprint, ["failed-run-1", "other-message"]),
      allocate,
    );
    expect(otherMessageRetry).not.toBe(firstRetry);
    expect(coordinatorRetryFingerprint(originalFingerprint)).toBe(originalFingerprint);
    expect(allocate).toHaveBeenCalledTimes(4);
    receipt.acknowledge(acceptedOriginal);
    remountedReceipt.acknowledge(firstRetry);
    remountedReceipt.acknowledge(nextRetry);
    remountedReceipt.acknowledge(otherMessageRetry);
  });

  it("keeps original IDs and command identity through lost acknowledgement, source rejection, and restored source", async () => {
    const projectId = "lost-ack-source-state";
    const failureRunId = "failed-source-run";
    const commandIds: string[] = [];
    const fileIds: string[][] = [];
    const accepted = new Set<string>();
    const receipt = createScopedProjectSendReceipt(host, projectId);
    let ordinal = 0;
    const allocate = vi.fn(() => `source-command-${++ordinal}`);
    let sourceAvailable = true;
    let acknowledgementLost = true;
    const send = async (
      text: string,
      source: string | undefined,
      attachments: ReadonlyArray<ChatAttachment> | undefined,
    ) => {
      const fingerprint = coordinatorRetryFingerprint(
        JSON.stringify([projectId, text, source ?? null, attachments ?? []]),
        [failureRunId, "saved"],
      );
      const id = receipt.forPrompt(fingerprint, allocate);
      commandIds.push(id);
      fileIds.push((attachments ?? []).map((attachment) => attachment.id));
      if (!sourceAvailable)
        throw new ProjectWorkspaceError({
          projectId: ProjectId.make(projectId),
          code: "invalid_source_thread",
        });
      accepted.add(id);
      if (acknowledgementLost) throw new Error("Accepted with acknowledgement lost");
      receipt.acknowledge(id);
    };
    const first = recoveryHarness({ projectId, failureRunId, send });
    await first.mount();
    await first.retry();
    await first.unmount();
    sourceAvailable = false;
    const second = recoveryHarness({ projectId, failureRunId, send });
    await second.mount();
    await second.retry();
    expect(retryQueue.startAttachmentUpload).not.toHaveBeenCalled();
    expect(retryQueue.releaseDraftAttachment).not.toHaveBeenCalled();
    sourceAvailable = true;
    acknowledgementLost = false;
    await second.retry();
    expect(commandIds).toEqual(["source-command-1", "source-command-1", "source-command-1"]);
    expect(fileIds[1]).toEqual(fileIds[0]);
    expect(fileIds[2]).toEqual(fileIds[0]);
    expect(accepted.size).toBe(1);
    expect(allocate).toHaveBeenCalledTimes(1);
    await second.unmount();
  });
});

describe("existing unrestricted ACP folder access", () => {
  it("allows only the already configured full-access/default policy without enlarging access", () => {
    expect(
      coordinatorFolderCompatibility(true, "acpRegistry", {
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    ).toBeNull();
    expect(
      coordinatorFolderCompatibility(true, "acpRegistry", {
        runtimeMode: "full-access",
        interactionMode: "default",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      }),
    ).toBeNull();
    for (const policy of [
      { runtimeMode: "approval-required", interactionMode: "default" },
      { runtimeMode: "auto-accept-edits", interactionMode: "default" },
      { runtimeMode: "full-access", interactionMode: "plan" },
      { runtimeMode: "full-access", interactionMode: "default", approvalPolicy: "on-request" },
      {
        runtimeMode: "full-access",
        interactionMode: "default",
        sandboxPolicy: { type: "workspaceWrite" },
      },
      {
        runtimeMode: "full-access",
        interactionMode: "default",
        sandboxPolicy: { type: "externalSandbox" },
      },
    ] as const)
      expect(coordinatorFolderCompatibility(true, "acpRegistry", policy)).toContain(
        "current restricted policy",
      );
  });
});

describe("coordinator retry freshness before dispatch", () => {
  it.each(["message", "failed-run", "coordinator", "native-busy"] as const)(
    "does not dispatch an old screenshot retry after %s changes during asset reading",
    async (change) => {
      let finishRead!: (bytes: Blob) => void;
      const fixture = recoveryHarness({
        read: () =>
          new Promise((resolve) => {
            finishRead = resolve;
          }),
      });
      await fixture.mount();
      await fixture.retry();
      if (change === "message")
        fixture.input.message = {
          ...fixture.input.message!,
          id: "new-user-message",
          text: "A newer request",
        };
      if (change === "failed-run") fixture.input.failureRunId = "new-failed-run";
      if (change === "coordinator") fixture.input.coordinatorId = "new-coordinator" as never;
      if (change === "native-busy") fixture.input.nativeBusy = true;
      await fixture.mount();
      await act(async () => finishRead(new Blob(["abc"])));
      expect(fixture.input.send).not.toHaveBeenCalled();
      expect(retryQueue.releaseDraftAttachment).toHaveBeenCalledTimes(1);
      expect(fixture.input.reportError).toHaveBeenCalledWith(
        expect.stringContaining("conversation changed"),
      );
      await fixture.unmount();
    },
  );

  it("cancels after uploads if a native turn begins, without retaining a pending replay", async () => {
    let finishUploads!: () => void;
    const fixture = recoveryHarness();
    retryQueue.awaitAttachmentUploads.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishUploads = resolve;
        }),
    );
    await fixture.mount();
    await fixture.retry();
    fixture.input.nativeBusy = true;
    await fixture.mount();
    await act(async () => finishUploads());
    expect(fixture.input.send).not.toHaveBeenCalled();
    expect(retryQueue.releaseDraftAttachment).toHaveBeenCalledTimes(1);
    const key =
      "studio.coordinator-recovery.v1:" +
      encodeURIComponent(
        JSON.stringify([
          fixture.input.environmentId,
          fixture.input.projectId,
          fixture.input.message!.id,
          fixture.input.failureRunId,
        ]),
      );
    expect(sessionStorage.getItem(key)).toBeNull();
    await fixture.unmount();
  });

  it("allows its own composer staging state to change without confusing it with native work", async () => {
    let finishRead!: (bytes: Blob) => void;
    const fixture = recoveryHarness({
      read: () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    });
    await fixture.mount();
    await fixture.retry();
    fixture.input.canRetry = false;
    await fixture.mount();
    await act(async () => finishRead(new Blob(["abc"])));
    expect(fixture.input.send).toHaveBeenCalledTimes(1);
    await fixture.unmount();
  });
});
