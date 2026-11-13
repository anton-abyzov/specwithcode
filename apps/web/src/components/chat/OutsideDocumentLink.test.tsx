// @vitest-environment jsdom
import { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { useComposerDraftStore } from "../../composerDraftStore";
import { providerHostedDocument } from "../../providerHostedDocument";
import { getProjectCoordinatorComposer } from "../../studio/projectCoordinatorComposer";
import { toastManager } from "../ui/toast";
import { draftOutsideDocumentImport } from "./OutsideDocumentLink";

const ORIGINAL = "https://claude.ai/artifact/Xq7Lm2Rt9Vb4Nc8Pd3Kf6H";
const document = providerHostedDocument(ORIGINAL)!;
const request = `Save [Release checklist](${ORIGINAL}) into this project's reports with studio_report_save: read it with your access to Claude, keep its source and original link, and link the saved file here instead of the Claude page.`;

describe("draftOutsideDocumentImport", () => {
  it("adds the save request after what the thread's composer already holds, and sends nothing", () => {
    const threadRef = {
      environmentId: EnvironmentId.make("env-local"),
      threadId: ThreadId.make("thread:finish-claude-sessions"),
    };
    useComposerDraftStore.getState().setPrompt(threadRef, "Also check CI.");
    draftOutsideDocumentImport(threadRef, document, "Release checklist");
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
      `Also check CI.\n\n${request}`,
    );
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Added to the composer" }),
    );
  });

  it("drafts into the project coordinator's own composer", () => {
    const threadRef = {
      environmentId: EnvironmentId.make("env-local"),
      threadId: ThreadId.make("project-coordinator:project-1"),
    };
    draftOutsideDocumentImport(threadRef, document, "Release checklist");
    expect(getProjectCoordinatorComposer("env-local", "project-1").getSnapshot().prompt).toBe(
      request,
    );
  });
});
