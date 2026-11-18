// @vitest-environment jsdom
import type { ProjectBoardCard } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const { FirstFeatureGuideView } = await import("./FirstFeatureGuide");
const { guideView } = await import("./firstFeature.logic");
type Props = Parameters<typeof FirstFeatureGuideView>[0];
type Input = Parameters<typeof guideView>[0];

const card = (over: Partial<ProjectBoardCard> = {}): ProjectBoardCard => ({
  incrementId: "0001-dark-mode-switch",
  title: "Dark mode switch",
  status: "active",
  column: "active",
  tasks: { total: 2, done: 1 },
  blocked: false,
  updatedAt: null,
  pullRequests: [],
  specPath: null,
  ...over,
});
const input = (over: Partial<Input> = {}): Input => ({
  specweave: "off",
  specweaveWaiting: false,
  cards: null,
  askWaiting: false,
  secondFamily: true,
  seenInReview: false,
  openedReview: false,
  skipped: [],
  ...over,
});

describe("FirstFeatureGuideView", () => {
  let root: Root;
  let container: HTMLDivElement;
  let handlers: Omit<Props, "view" | "projectTitle" | "finishedStored">;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    handlers = {
      onShowMe: vi.fn(),
      onWriteRequest: vi.fn(),
      onOpenThread: vi.fn(),
      onOpenReview: vi.fn(),
      onAddReviewer: vi.fn(),
      onSkip: vi.fn(),
      onLeave: vi.fn(),
      onReviewAll: vi.fn(),
      onRemove: vi.fn(),
      onRemoveConfirm: vi.fn(),
      onRemoveCancel: vi.fn(),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function show(over: Partial<Input>, extra: Partial<Props> = {}) {
    await act(async () =>
      root.render(
        <FirstFeatureGuideView
          view={guideView(input(over))}
          projectTitle="First feature"
          finishedStored={false}
          {...handlers}
          {...extra}
        />,
      ),
    );
  }
  const button = (name: string) =>
    [...container.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === name);
  const text = () => container.textContent ?? "";

  it("is a section, not a dialog: three knots, one sentence, one action, Skip and Leave", async () => {
    await show({});
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelectorAll('[data-slot="setup-knot"]')).toHaveLength(3);
    expect(text()).toContain("This project has no plans or board yet. Turn SpecWeave on.");
    button("Show me")!.click();
    expect(handlers.onShowMe).toHaveBeenCalledOnce();
    button("Skip this step")!.click();
    expect(handlers.onSkip).toHaveBeenCalledWith("specweave");
    button("Leave the guide")!.click();
    expect(handlers.onLeave).toHaveBeenCalledOnce();
  });

  it("step 2 writes the request, then reads the card's place and always opens the thread", async () => {
    await show({ specweave: "on" });
    expect(text()).toContain("Ask for the whole feature in one request.");
    button("Write it for me")!.click();
    expect(handlers.onWriteRequest).toHaveBeenCalledOnce();
    expect(button("Open the thread")).toBeDefined();
    await show({ specweave: "on", cards: [card()] });
    expect(button("Write it for me")).toBeUndefined();
    expect(text()).toContain("Working: 1 of 2 tasks");
    button("Open the thread")!.click();
    expect(handlers.onOpenThread).toHaveBeenCalledOnce();
    await show({ specweave: "on", cards: [card({ column: "review" })] });
    expect(text()).toContain("In review");
    await show({ specweave: "on", cards: [card()], seenInReview: true });
    expect(text()).toContain("Fixing what the review found");
    await show({ specweave: "on", askWaiting: true });
    expect(text()).toContain("Waiting on this step.");
  });

  it("step 3 lists each review with the reviewer's mark, and opens the card", async () => {
    await show({
      specweave: "on",
      cards: [
        card({
          column: "done",
          reviews: [
            {
              model: "muse-wonder-full-1.0",
              family: "meta",
              author: "claude",
              verdict: "ship",
              at: "b",
            },
            {
              model: "gpt-6.1-sol",
              family: "openai",
              author: "claude",
              verdict: "fix first",
              at: "a",
            },
          ],
        }),
      ],
    });
    const rows = [...container.querySelectorAll("[data-first-feature-reviews] li")];
    expect(rows.map((row) => row.textContent)).toEqual([
      "Muse Wonder Full 1.0Ship",
      "GPT 6.1 SolFix first",
    ]);
    expect(
      rows.map((row) =>
        row.querySelector("[data-provider-logo]")?.getAttribute("data-provider-logo"),
      ),
    ).toEqual(["meta", "openai"]);
    button("Open the review")!.click();
    expect(handlers.onOpenReview).toHaveBeenCalledOnce();
  });

  it("names Codex and Muse Code with their marks when no second family is ready", async () => {
    await show({ specweave: "on", secondFamily: false, cards: [card({ column: "done" })] });
    const note = container.querySelector('[data-first-feature-note="no-second-family"]')!;
    expect(note.textContent).toBe(
      "No review ran. A review needs a model from a second family, such as Codex or Muse Code.",
    );
    expect(
      [...note.querySelectorAll("[data-provider-logo]")].map((mark) =>
        mark.getAttribute("data-provider-logo"),
      ),
    ).toEqual(["openai", "meta"]);
    button("Add one")!.click();
    expect(handlers.onAddReviewer).toHaveBeenCalledOnce();
  });

  it("draws a skipped knot hollow, not done", async () => {
    await show({ skipped: ["specweave"] });
    const knots = [...container.querySelectorAll("[data-step]")].filter(
      (node) => node.tagName === "LI",
    );
    expect(knots.map((knot) => knot.getAttribute("data-state"))).toEqual([
      "skipped",
      "now",
      "later",
    ]);
  });

  it("ends with the loop and two actions, neither chosen, Remove only once finished is stored", async () => {
    const end = { specweave: "on", cards: [card({ column: "done" })], openedReview: true };
    await show(end);
    expect(text()).toContain("That is the loop: plan, board, work, review, done.");
    expect(text()).toContain("Each review uses the reviewer's plan.");
    expect(button("Skip this step")).toBeUndefined();
    const all = button("Review finished features in all projects on this Mac")!;
    const remove = button("Remove the sample project")!;
    for (const action of [all, remove]) {
      expect(action.getAttribute("aria-pressed")).toBeNull();
      expect(action.getAttribute("aria-checked")).toBeNull();
    }
    expect(remove.disabled).toBe(true);
    all.click();
    expect(handlers.onReviewAll).toHaveBeenCalledOnce();
    await show(end, { finishedStored: true });
    button("Remove the sample project")!.click();
    expect(handlers.onRemove).toHaveBeenCalledOnce();
    await show(end, { finishedStored: true, removing: "confirm", reviewAll: "done" });
    expect(text()).toContain(
      "Remove First feature from SpecWithCode? Its folder and files stay on disk.",
    );
    expect(text()).toContain("On for all projects on this Mac.");
    button("Remove")!.click();
    expect(handlers.onRemoveConfirm).toHaveBeenCalledOnce();
  });
});
