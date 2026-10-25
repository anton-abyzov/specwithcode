// @vitest-environment jsdom
import type { DesignDocument } from "@specweave-studio/contracts";
import { applyDesignOperations, newDesignDocument } from "@specweave-studio/shared/designOps";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { addSlideAfter } from "../slides/slideActions";
import { presentationFrames } from "./PresentMode";
import { PresenterView } from "./PresenterView";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function deck(): DesignDocument {
  const doc = newDesignDocument({
    id: "d_deck",
    kind: "slides",
    title: "Deck",
    now: "2026-10-20T00:00:00.000Z",
    createdBy: { kind: "user" },
    random: () => 0.42,
  });
  const outcome = applyDesignOperations(
    doc,
    addSlideAfter(doc, doc.pages[0]!.id, null, null, () => 0.5).operations,
  );
  if (!outcome.ok) throw new Error(outcome.error.detail);
  return outcome.document;
}

describe("PresenterView narrow windows", () => {
  it("stacks below 640 px with the current slide first and full width", () => {
    const [current, next] = presentationFrames(deck());
    act(() => root.render(<PresenterView current={current!} next={next} noun="slide" />));
    const view = document.querySelector<HTMLElement>("[data-testid=presenter-view]")!;
    const classes = view.className.split(/\s+/);
    // One column by default; the two-column layout only from the sm (640 px) breakpoint.
    expect(classes).toContain("grid-cols-1");
    expect(classes).toContain("sm:grid-cols-[minmax(0,1.75fr)_minmax(16rem,1fr)]");
    expect(classes.filter((name) => name.startsWith("grid-cols-"))).toEqual(["grid-cols-1"]);

    // The stacked current slide takes a 16:9 box at full width, not a squeezed column.
    const box = document.querySelector<HTMLElement>("[data-testid=presenter-current-box]")!;
    expect(box.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["aspect-video", "w-full", "sm:aspect-auto", "sm:flex-1"]),
    );

    const parts = ["presenter-current", "presenter-next", "presenter-notes", "presenter-timer"].map(
      (id) => document.querySelector(`[data-testid=${id}]`)!,
    );
    for (const part of parts) expect(part).not.toBeNull();
    const [currentSlide, ...rest] = parts;
    for (const part of rest)
      expect(
        currentSlide!.compareDocumentPosition(part!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    expect(view.firstElementChild?.getAttribute("aria-label")).toBe("Current slide");
  });
});
