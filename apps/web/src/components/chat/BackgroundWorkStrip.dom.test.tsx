// @vitest-environment jsdom

import {
  presentPendingBackgroundWork,
  type PendingBackgroundWorkPresentation,
} from "@specweave-studio/client-runtime/state/thread-execution";
import { ThreadId, type OrchestrationV2PendingBackgroundTask } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BackgroundWorkLabel, BackgroundWorkStopButton } from "./BackgroundWorkStrip";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function present(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
): PendingBackgroundWorkPresentation {
  const presentation = presentPendingBackgroundWork(tasks);
  if (presentation === null) throw new Error("expected background work");
  return presentation;
}

function stopButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>("button[aria-label]");
  if (button === null) throw new Error("expected the stop button");
  return button;
}

describe("BackgroundWorkStopButton", () => {
  it("stops when it can act", async () => {
    const onStop = vi.fn();
    await act(async () =>
      root.render(<BackgroundWorkStopButton stopping={false} disabled={false} onStop={onStop} />),
    );
    await act(async () => stopButton().click());
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the thread cannot be operated", { stopping: false, disabled: true }],
    ["it is already stopping", { stopping: true, disabled: false }],
  ])("ignores clicks while %s", async (_, props) => {
    const onStop = vi.fn();
    await act(async () => root.render(<BackgroundWorkStopButton {...props} onStop={onStop} />));
    expect(stopButton().getAttribute("aria-disabled")).toBe("true");
    await act(async () => stopButton().click());
    expect(onStop).not.toHaveBeenCalled();
  });
});

describe("BackgroundWorkLabel popover", () => {
  it("lets long subagent names wrap inside the list and opens their thread", async () => {
    const onOpenRelatedThread = vi.fn();
    const childThreadId = ThreadId.make("thread:review");
    const longName = `Review ${"very-long-path-segment/".repeat(12)}math.ts`;
    await act(async () =>
      root.render(
        <BackgroundWorkLabel
          presentation={present([
            { taskId: "a", kind: "command" },
            { taskId: "b", kind: "command", description: "vp run dev" },
            { taskId: "c", kind: "subagent", description: longName, childThreadId },
          ])}
          onOpenRelatedThread={onOpenRelatedThread}
        />,
      ),
    );

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Show background work"]',
    );
    expect(trigger?.textContent).toBe("1 subagent · 2 commands");
    await act(async () => trigger?.click());

    const list = document.body.querySelector('ul[aria-label="Background work"]');
    expect(list).not.toBeNull();
    const popup = list?.closest("[class*='max-w-[min(30rem']");
    expect(popup?.className).toContain("[&_[data-slot=inline-button]]:max-w-full");

    const subagent = list?.querySelector<HTMLButtonElement>('[data-slot="inline-button"]');
    expect(subagent?.className).toContain("min-w-0");
    expect(subagent?.className).toContain("shrink");
    await act(async () => subagent?.click());
    expect(onOpenRelatedThread).toHaveBeenCalledWith(childThreadId);

    // Only a named shell command reads as code; the unnamed one is a plain noun.
    const rows = Array.from(list?.querySelectorAll("li > span") ?? []);
    expect(rows.map((row) => [row.textContent, row.className.includes("font-mono")])).toEqual([
      ["command", false],
      ["vp run dev", true],
    ]);
  });
});
