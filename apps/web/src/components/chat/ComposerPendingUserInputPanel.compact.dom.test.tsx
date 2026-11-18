// @vitest-environment jsdom

import { RuntimeRequestId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import {
  nextCollapsedThreads,
  QUESTION_CARD_COLLAPSED_LIMIT,
  QUESTION_CARD_COLLAPSED_STORAGE_KEY,
} from "./questionCardCollapse";
import type { PendingUserInput } from "../../session-logic";

const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("request-compact"),
  responseCapability: "live",
  createdAt: "2026-11-18T00:00:00.000Z",
  dismissible: true,
  questions: [
    {
      id: "q1",
      header: "First feature",
      question: "Which first-feature step should a new user see?",
      multiSelect: false,
      options: [
        {
          label: "Guided first feature",
          description: "Open a short guide that writes one small feature in a sample project.",
          recommended: true,
        },
        { label: "Machine list first", description: "Keep today's order." },
        { label: "Skip both", description: "Land in the coordinator." },
      ],
    },
  ],
};

let root: Root;
let container: HTMLDivElement;
let picked: string[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  picked = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (collapseKey?: string) =>
  act(async () =>
    root.render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[prompt]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onToggleOption={(_, value) => picked.push(value)}
        onAdvance={() => {}}
        onDismiss={() => {}}
        collapseKey={collapseKey}
      />,
    ),
  );

const option = (letter: string) =>
  container.querySelector<HTMLElement>(`[data-question-option="${letter}"]`)!;
const toggle = () =>
  container.querySelector<HTMLButtonElement>("[data-pending-user-input-toggle]")!;

describe("compact question options", () => {
  it("shows each option on one line with its label, a clipped description and the badge", async () => {
    await render();
    const a = option("A");
    expect(a.dataset.expanded).toBe("false");
    expect(a.querySelector("[data-question-recommended]")?.textContent).toBe("Recommended");
    const description = a.querySelector<HTMLElement>("[data-question-option-description]")!;
    expect(description.className).toContain("truncate");
    expect(description.textContent).toContain("short guide");
  });

  it("opens one option's full description from its details toggle without picking it", async () => {
    await render();
    const details = option("B").querySelector<HTMLButtonElement>("[data-question-option-details]")!;
    expect(details.getAttribute("aria-expanded")).toBe("false");
    await act(async () => details.click());
    expect(option("B").dataset.expanded).toBe("true");
    expect(
      option("B").querySelector("[data-question-option-description]")!.className,
    ).not.toContain("truncate");
    expect(option("A").dataset.expanded).toBe("false");
    expect(picked).toEqual([]);
    await act(async () => details.click());
    expect(option("B").dataset.expanded).toBe("false");
  });

  it("still picks an option when its row is clicked", async () => {
    await render();
    await act(async () => option("C").click());
    expect(picked).toEqual(["Skip both"]);
  });
});

describe("folding the question card", () => {
  it("folds to a one-line summary naming the question and how many options", async () => {
    await render("env:thread-1");
    await act(async () => toggle().click());
    expect(toggle().dataset.pendingUserInputToggle).toBe("collapsed");
    expect(container.querySelector("[data-question-summary]")?.textContent).toBe(
      "Question: Which first-feature step should a new user see? · 3 options",
    );
  });

  it("remembers the fold for the thread and not for others", async () => {
    await render("env:thread-1");
    await act(async () => toggle().click());
    expect(JSON.parse(localStorage.getItem(QUESTION_CARD_COLLAPSED_STORAGE_KEY)!)).toEqual([
      "env:thread-1",
    ]);

    await act(async () => root.unmount());
    root = createRoot(container);
    await render("env:thread-1");
    expect(toggle().dataset.pendingUserInputToggle).toBe("collapsed");

    await render("env:thread-2");
    expect(toggle().dataset.pendingUserInputToggle).toBe("expanded");

    await render("env:thread-1");
    await act(async () => toggle().click());
    expect(toggle().dataset.pendingUserInputToggle).toBe("expanded");
    expect(JSON.parse(localStorage.getItem(QUESTION_CARD_COLLAPSED_STORAGE_KEY)!)).toEqual([]);
  });

  it("keeps a host without a key on its own per-question fold and stores nothing", async () => {
    await render();
    await act(async () => toggle().click());
    expect(toggle().dataset.pendingUserInputToggle).toBe("collapsed");
    expect(localStorage.getItem(QUESTION_CARD_COLLAPSED_STORAGE_KEY)).toBeNull();
  });
});

describe("nextCollapsedThreads", () => {
  it("adds once, removes, and drops the oldest past the limit", () => {
    expect(nextCollapsedThreads(["a"], "a", true)).toEqual(["a"]);
    expect(nextCollapsedThreads(["a", "b"], "a", false)).toEqual(["b"]);
    const full = Array.from({ length: QUESTION_CARD_COLLAPSED_LIMIT }, (_, index) => `t${index}`);
    const next = nextCollapsedThreads(full, "new", true);
    expect(next).toHaveLength(QUESTION_CARD_COLLAPSED_LIMIT);
    expect(next[0]).toBe("t1");
    expect(next.at(-1)).toBe("new");
  });
});
