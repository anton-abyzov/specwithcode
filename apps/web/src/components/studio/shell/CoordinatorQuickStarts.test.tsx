// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  COORDINATOR_QUICK_STARTS,
  CoordinatorQuickStarts,
  greetingLine,
  quickStartDraft,
} from "./CoordinatorQuickStarts";

const promptOf = (id: string) => {
  const quickStart = COORDINATOR_QUICK_STARTS.find((q) => q.id === id);
  if (quickStart?.kind !== "prompt") throw new Error(`${id} is not a prompt chip`);
  return quickStart.prompt;
};

describe("greetingLine", () => {
  it("greets the owner a Mac is named after", () => {
    expect(greetingLine("Alice's MacBook Pro")).toBe("Hi Alice,");
    expect(greetingLine("Sam's Mac mini")).toBe("Hi Sam,");
  });

  it("falls back when the host carries no owner name", () => {
    expect(greetingLine(null)).toBe("Hi there,");
    expect(greetingLine("build-server-01")).toBe("Hi there,");
    expect(greetingLine("Host")).toBe("Hi there,");
    // Only a Mac's default name carries its owner's name.
    expect(greetingLine("Let's Build Box")).toBe("Hi there,");
    expect(greetingLine("team's Mac mini")).toBe("Hi there,");
  });
});

describe("quickStartDraft", () => {
  it("fills an empty composer", () => {
    expect(quickStartDraft("  ", "Make a plan for ")).toBe("Make a plan for ");
  });

  it("swaps one chip's untouched text for another's", () => {
    expect(quickStartDraft(promptOf("make-plan"), promptOf("recent-work"))).toBe(
      promptOf("recent-work"),
    );
  });

  it("keeps a draft the person wrote", () => {
    expect(quickStartDraft("Fix the login bug\n", "Make a plan for ")).toBe(
      "Fix the login bug\nMake a plan for ",
    );
  });
});

describe("CoordinatorQuickStarts", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
  });

  const button = (id: string) =>
    container.querySelector<HTMLButtonElement>(`[data-quick-start="${id}"]`)!;

  it("offers the three ways in, in Claude's order", () => {
    act(() =>
      root.render(
        <CoordinatorQuickStarts disabled={false} onPrompt={() => {}} onConnections={() => {}} />,
      ),
    );
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Set up from recent work",
      "Connect tools",
      "Make a plan",
    ]);
  });

  it("fills prompts and opens connections", () => {
    const onPrompt = vi.fn();
    const onConnections = vi.fn();
    act(() =>
      root.render(
        <CoordinatorQuickStarts
          disabled={false}
          onPrompt={onPrompt}
          onConnections={onConnections}
        />,
      ),
    );
    act(() => button("recent-work").click());
    act(() => button("connect-tools").click());
    expect(onPrompt).toHaveBeenCalledWith(promptOf("recent-work"));
    expect(onConnections).toHaveBeenCalledTimes(1);
  });

  it("reads recent work from this machine, then private machines, never the cloud", () => {
    const prompt = promptOf("recent-work");
    expect(prompt.indexOf("sessions on this machine")).toBeLessThan(
      prompt.indexOf("private machines"),
    );
    expect(prompt).not.toContain("cloud");
  });

  it("keeps Connect tools usable while sending is blocked", () => {
    act(() =>
      root.render(<CoordinatorQuickStarts disabled onPrompt={() => {}} onConnections={() => {}} />),
    );
    expect(button("recent-work").disabled).toBe(true);
    expect(button("make-plan").disabled).toBe(true);
    expect(button("connect-tools").disabled).toBe(false);
  });
});
