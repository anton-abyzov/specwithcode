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

import { MachineSendTargetContext } from "~/studio/machineIdentity";
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

/** A thread on another machine than this window's: fixture names, no real machine. */
const SEND_TARGET = { name: "Workstation W", color: "teal", short: "WW" } as const;

/** The Send button as a browser holds it, so its text is every span at every width. */
function sendButtonTo(target: typeof SEND_TARGET | null, changes: Record<string, unknown> = {}) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    createElement(
      MachineSendTargetContext,
      { value: target },
      createElement(ComposerPrimaryActions, sendButtonProps(null, changes)),
    ),
  );
  const button = host.querySelector("button");
  if (!button) throw new Error("no Send button rendered");
  return button;
}

function renderSendButton(
  sendDisabledReason: string | null = null,
  changes: Record<string, unknown> = {},
) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, sendButtonProps(sendDisabledReason, changes)),
  );
}

function sendButtonProps(sendDisabledReason: string | null, changes: Record<string, unknown>) {
  return {
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
  };
}

afterEach(() => {
  stageArtworkState.mode = "none";
  stageArtworkState.variant = null;
});

describe("ComposerPrimaryActions", () => {
  // Increment 1390, AC-02: Send can never name a machine the chip does not.
  it.each([
    ["wide", false],
    ["narrow", true],
  ])("never prints the machine on Send to another machine (%s)", (_width, compact) => {
    const button = sendButtonTo(SEND_TARGET, { compact });
    const text = button.textContent ?? "";
    expect(text).not.toContain(SEND_TARGET.name);
    expect(text).not.toContain(SEND_TARGET.short);
    expect(text.trim()).toBe("");
    // The wide and the narrow label were two spans, one hidden by a container query.
    expect(button.querySelector("[data-send-target-short]")).toBeNull();
    expect(button.querySelectorAll("span")).toHaveLength(0);
    // What it shows is what a send to this machine shows: the arrow.
    expect(button.innerHTML).toBe(sendButtonTo(null, { compact }).innerHTML);
    // It keeps the machine's color, and a screen reader hears where the message goes.
    expect(button.classList.contains("machine-send")).toBe(true);
    expect(button.getAttribute("data-machine-color")).toBe(SEND_TARGET.color);
    expect(button.getAttribute("aria-label")).toBe("Send to this thread on Workstation W");
  });

  it("is as wide as a send to this machine", () => {
    const sizes = (button: Element) =>
      [...button.classList].filter((name) => /(^|:)(w|px|gap|text)-/u.test(name)).toSorted();
    expect(sizes(sendButtonTo(SEND_TARGET))).toEqual(sizes(sendButtonTo(null)));
  });

  it("says the typed message waits for an unreachable machine", () => {
    const markup = renderSendButton(null, { isEnvironmentUnavailable: true, waitingFor: "M1" });
    expect(markup).toContain('aria-label="Waiting for M1"');
    expect(markup).toContain("data-composer-waiting-for");
    expect(markup).toContain(">Waiting for M1</span>");
    expect(markup).toContain("disabled");
    // Nothing typed: no note beside the button.
    const empty = renderSendButton(null, {
      isEnvironmentUnavailable: true,
      waitingFor: "M1",
      hasSendableContent: false,
    });
    expect(empty).not.toContain("data-composer-waiting-for");
  });

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
