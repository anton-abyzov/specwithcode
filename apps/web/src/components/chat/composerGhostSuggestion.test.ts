import { RunId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  composerGhostSuggestionKeyAction,
  latestRunPromptSuggestion,
  visibleComposerGhostSuggestion,
  type ComposerGhostSuggestionGate,
  type ComposerGhostSuggestionKey,
} from "./composerGhostSuggestion";

const run = (
  ordinal: number,
  status: "completed" | "running" | "failed" | "queued",
  text?: string,
  source: "provider" | "generated" = "provider",
) => ({
  id: RunId.make(`run-${ordinal}`),
  ordinal,
  status,
  ...(text === undefined ? {} : { promptSuggestion: { text, source } }),
});

describe("latestRunPromptSuggestion", () => {
  it("returns the newest completed run's suggestion", () => {
    expect(
      latestRunPromptSuggestion([run(2, "completed", "Run the tests"), run(1, "completed", "Old")]),
    ).toEqual({ runId: "run-2", text: "Run the tests" });
  });

  it("ignores older suggestions once a newer run exists", () => {
    expect(latestRunPromptSuggestion([run(1, "completed", "Old"), run(2, "running")])).toBeNull();
    expect(latestRunPromptSuggestion([run(1, "completed", "Old"), run(2, "completed")])).toBeNull();
    expect(latestRunPromptSuggestion([run(1, "completed", "Old"), run(2, "queued")])).toBeNull();
  });

  it("needs the latest run to have completed", () => {
    expect(latestRunPromptSuggestion([run(1, "failed", "Retry")])).toBeNull();
    expect(latestRunPromptSuggestion([])).toBeNull();
  });

  it("follows the setting", () => {
    const generated = [run(1, "completed", "Commit it", "generated")];
    expect(latestRunPromptSuggestion(generated, "all")?.text).toBe("Commit it");
    expect(latestRunPromptSuggestion(generated, "native")).toBeNull();
    expect(latestRunPromptSuggestion([run(1, "completed", "Commit it")], "native")?.text).toBe(
      "Commit it",
    );
    expect(latestRunPromptSuggestion([run(1, "completed", "Commit it")], "off")).toBeNull();
  });

  it("drops blank text", () => {
    expect(latestRunPromptSuggestion([run(1, "completed", "   ")])).toBeNull();
  });
});

const idle: ComposerGhostSuggestionGate = {
  suggestion: { runId: "run-1", text: "Run the tests" },
  dismissedRunId: null,
  phase: "ready",
  isSendBusy: false,
  isConnecting: false,
  isApprovalState: false,
  hasPendingUserInput: false,
  showPlanFollowUpPrompt: false,
  environmentUnavailable: false,
  projectSelectionRequired: false,
  isEditingQueuedMessage: false,
  draftHasUserContent: false,
  prompt: "",
};

describe("visibleComposerGhostSuggestion", () => {
  it("shows in an idle, empty composer", () => {
    expect(visibleComposerGhostSuggestion(idle)).toEqual(idle.suggestion);
  });

  it.each<[string, Partial<ComposerGhostSuggestionGate>]>([
    ["running", { phase: "running" }],
    ["connecting phase", { phase: "connecting" }],
    ["disconnected", { phase: "disconnected" }],
    ["sending", { isSendBusy: true }],
    ["connecting", { isConnecting: true }],
    ["approval", { isApprovalState: true }],
    ["pending question", { hasPendingUserInput: true }],
    ["plan follow-up", { showPlanFollowUpPrompt: true }],
    ["machine unavailable", { environmentUnavailable: true }],
    ["project picker", { projectSelectionRequired: true }],
    ["queued edit", { isEditingQueuedMessage: true }],
    ["attachments or chips", { draftHasUserContent: true }],
    ["typed text", { prompt: "a" }],
    ["whitespace", { prompt: " " }],
    ["dismissed", { dismissedRunId: "run-1" }],
    ["no suggestion", { suggestion: null }],
  ])("hides while %s", (_label, patch) => {
    expect(visibleComposerGhostSuggestion({ ...idle, ...patch })).toBeNull();
  });

  it("returns for a newer run after an older one was dismissed", () => {
    expect(
      visibleComposerGhostSuggestion({
        ...idle,
        dismissedRunId: "run-0",
      }),
    ).toEqual(idle.suggestion);
  });
});

const key = (k: string, patch: Partial<ComposerGhostSuggestionKey> = {}) => ({
  key: k,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  ...patch,
});
const visible = { ghostVisible: true, menuIsActive: false, hasSubmissionIntent: false };

describe("composerGhostSuggestionKeyAction", () => {
  it("accepts on Tab and dismisses on Escape", () => {
    expect(composerGhostSuggestionKeyAction(key("Tab"), visible)).toBe("accept");
    expect(composerGhostSuggestionKeyAction(key("Escape"), visible)).toBe("dismiss");
  });

  it("leaves Shift+Tab and modified keys alone", () => {
    expect(composerGhostSuggestionKeyAction(key("Tab", { shiftKey: true }), visible)).toBeNull();
    expect(composerGhostSuggestionKeyAction(key("Tab", { altKey: true }), visible)).toBeNull();
    expect(composerGhostSuggestionKeyAction(key("Tab", { ctrlKey: true }), visible)).toBeNull();
    expect(composerGhostSuggestionKeyAction(key("Tab", { metaKey: true }), visible)).toBeNull();
  });

  it("does nothing while composing, with a menu open, or for a send shortcut", () => {
    expect(composerGhostSuggestionKeyAction(key("Tab", { isComposing: true }), visible)).toBeNull();
    expect(composerGhostSuggestionKeyAction(key("Tab", { keyCode: 229 }), visible)).toBeNull();
    expect(
      composerGhostSuggestionKeyAction(key("Tab"), { ...visible, menuIsActive: true }),
    ).toBeNull();
    expect(
      composerGhostSuggestionKeyAction(key("Tab"), { ...visible, hasSubmissionIntent: true }),
    ).toBeNull();
  });

  it("does nothing without a visible ghost", () => {
    expect(
      composerGhostSuggestionKeyAction(key("Tab"), { ...visible, ghostVisible: false }),
    ).toBeNull();
    expect(composerGhostSuggestionKeyAction(key("Enter"), visible)).toBeNull();
  });
});
