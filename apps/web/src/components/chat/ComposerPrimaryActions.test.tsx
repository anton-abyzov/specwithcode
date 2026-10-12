// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const stageArtworkState = vi.hoisted(() => ({
  mode: "none" as "artwork" | "none",
  variant: null as "nightly" | "dev" | null,
}));

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => stageArtworkState.mode,
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: ({ variant }: { variant: string }) => `stage-${variant}`,
  useSidebarStageBackdropVariant: (enabled = true) => (enabled ? stageArtworkState.variant : null),
}));

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

function renderPendingActions(isRunning: boolean) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      canOperateThread: true,
      pendingAction: {
        questionIndex: 0,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
      },
      isRunning,
      canInterrupt: isRunning,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

function renderSendButton(
  sendDisabledReason: string | null = null,
  changes: Record<string, unknown> = {},
) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      canOperateThread: true,
      pendingAction: null,
      isRunning: false,
      canInterrupt: false,
      showPlanFollowUpPrompt: false,
      promptHasText: true,
      isSendBusy: false,
      sendDisabledReason,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: true,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
      ...changes,
    }),
  );
}

afterEach(() => {
  stageArtworkState.mode = "none";
  stageArtworkState.variant = null;
});

describe("ComposerPrimaryActions", () => {
  it("renders a visible credit action with space for the text at compact width", () => {
    const markup = renderSendButton(null, { sendWithCredits: true });
    expect(markup).toContain('aria-label="Send with credits"');
    expect(markup).toContain("<span>Send with credits</span>");
    expect(markup).toContain("w-auto gap-1.5 px-3 text-sm sm:w-auto");
  });

  it.each([
    [{ isRunning: true, canInterrupt: true }, "Steer message"],
    [{ isRunning: true, canInterrupt: true, followUpBehavior: "queue" }, "Queue message"],
    [{ isEditingQueuedMessage: true }, "Update queued message"],
    [{ canResume: true, hasSendableContent: false }, "Resume thread"],
  ])("keeps the existing non-start action ordinary: %j", (changes, label) => {
    const markup = renderSendButton(null, { ...changes, sendWithCredits: true });
    expect(markup).toContain(`aria-label="${label}"`);
    expect(markup).not.toContain("Send with credits");
  });

  it("the actual rendered credit button invokes only its human submit callback", async () => {
    const submit = vi.fn(),
      resume = vi.fn(),
      interrupt = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          createElement(ComposerPrimaryActions, {
            compact: true,
            canOperateThread: true,
            pendingAction: null,
            isRunning: false,
            canInterrupt: false,
            showPlanFollowUpPrompt: false,
            promptHasText: true,
            isSendBusy: false,
            sendDisabledReason: null,
            isConnecting: false,
            isEnvironmentUnavailable: false,
            isPreparingWorktree: false,
            hasSendableContent: true,
            sendWithCredits: true,
            onSubmitMessage: submit,
            onResume: resume,
            onInterrupt: interrupt,
            onPreviousPendingQuestion: () => {},
            onImplementPlanInNewThread: () => {},
          }),
        ),
      );
      const button = container.querySelector('button[aria-label="Send with credits"]')!;
      expect(button.textContent).toBe("Send with credits");
      await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(submit).toHaveBeenCalledOnce();
      expect(resume).not.toHaveBeenCalled();
      expect(interrupt).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("disables and labels the send button while feedback is uploading", () => {
    const markup = renderSendButton("Sending feedback");

    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-label="Sending feedback"');
  });

  it("offers Stop generation while a running turn is waiting for user input", () => {
    expect(renderPendingActions(true)).toContain('aria-label="Stop generation"');
  });

  it("does not offer Stop generation for a pending request without a running turn", () => {
    expect(renderPendingActions(false)).not.toContain('aria-label="Stop generation"');
  });

  it("renders stage artwork inside the send button when artwork identification is active", () => {
    stageArtworkState.mode = "artwork";
    stageArtworkState.variant = "nightly";

    const markup = renderSendButton();

    expect(markup).toContain("stage-nightly");
  });

  it("hides stage artwork when artwork identification is inactive", () => {
    stageArtworkState.variant = "nightly";

    const markup = renderSendButton();

    expect(markup).not.toContain("stage-nightly");
  });
});
