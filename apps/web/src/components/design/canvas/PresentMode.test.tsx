// @vitest-environment jsdom
import type { DesignDocument, DesignOperation } from "@specweave-studio/contracts";
import { applyDesignOperations, newDesignDocument } from "@specweave-studio/shared/designOps";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { addSlideAfter } from "../slides/slideActions";
import { PresentMode, presentationFrames, presentKeyAction } from "./PresentMode";
import { formatElapsed } from "./PresenterView";

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
  vi.useRealTimers();
});

function apply(document: DesignDocument, operations: readonly DesignOperation[]) {
  const outcome = applyDesignOperations(document, operations);
  if (!outcome.ok) throw new Error(outcome.error.detail);
  return outcome.document;
}

/** Twelve slides; slide 3 is skipped and every slide's notes name it. */
function deck(): DesignDocument {
  let doc = newDesignDocument({
    id: "d_deck",
    kind: "slides",
    title: "Deck",
    now: "2026-10-20T00:00:00.000Z",
    createdBy: { kind: "user" },
    random: () => 0.42,
  });
  let seed = 13;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let step = 0; step < 11; step += 1)
    doc = apply(doc, addSlideAfter(doc, doc.pages.at(-1)!.id, null, null, random).operations);
  doc = apply(doc, [
    ...doc.pages.map((page) => ({
      op: "update_page" as const,
      pageId: page.id,
      notes: `Notes for ${page.name}`,
    })),
    { op: "update_page", pageId: doc.pages[2]!.id, skipped: true },
  ]);
  return doc;
}

describe("presentKeyAction (AC-05)", () => {
  const at = (index: number, digits = "") => ({ index, count: 11, digits });
  it("moves with arrows, Space, Page Up and Down, Home and End", () => {
    for (const key of ["ArrowRight", "ArrowDown", " ", "PageDown"])
      expect(presentKeyAction(key, at(4))).toEqual({ kind: "go", index: 5 });
    for (const key of ["ArrowLeft", "ArrowUp", "PageUp"])
      expect(presentKeyAction(key, at(4))).toEqual({ kind: "go", index: 3 });
    expect(presentKeyAction("Home", at(4))).toEqual({ kind: "go", index: 0 });
    expect(presentKeyAction("End", at(4))).toEqual({ kind: "go", index: 10 });
    expect(presentKeyAction("ArrowRight", at(10))).toEqual({ kind: "go", index: 10 });
    expect(presentKeyAction("ArrowLeft", at(0))).toEqual({ kind: "go", index: 0 });
  });

  it("jumps with number keys, including two-digit numbers", () => {
    expect(presentKeyAction("4", at(0))).toEqual({ kind: "digits", digits: "4", index: 3 });
    expect(presentKeyAction("1", at(0))).toEqual({ kind: "digits", digits: "1", index: 0 });
    expect(presentKeyAction("1", at(0, "1"))).toEqual({ kind: "digits", digits: "11", index: 10 });
    // 45 is past the end: start over at 5.
    expect(presentKeyAction("5", at(0, "4"))).toEqual({ kind: "digits", digits: "5", index: 4 });
  });

  it("F is full screen, P the presenter view, Esc leaves, other keys pass", () => {
    expect(presentKeyAction("f", at(0))).toEqual({ kind: "fullscreen" });
    expect(presentKeyAction("F", at(0))).toEqual({ kind: "fullscreen" });
    expect(presentKeyAction("p", at(0))).toEqual({ kind: "presenter" });
    expect(presentKeyAction("Escape", at(0))).toEqual({ kind: "close" });
    expect(presentKeyAction("x", at(0))).toBeNull();
  });
});

describe("PresentMode with slides", () => {
  const position = () =>
    document.querySelector("[data-testid=present-position]")?.textContent ?? "";
  const press = (key: string) =>
    act(() => {
      document
        .querySelector("[data-testid=present-mode]")!
        .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });

  it("leaves skipped slides out", () => {
    const doc = deck();
    const frames = presentationFrames(doc);
    expect(frames).toHaveLength(11);
    expect(frames.some((item) => item.page.id === doc.pages[2]!.id)).toBe(false);
  });

  it("drives the deck from the keyboard and closes on Esc", () => {
    const doc = deck();
    const onClose = vi.fn();
    act(() => root.render(<PresentMode document={doc} startFrameId={null} onClose={onClose} />));
    expect(position()).toBe("1 / 11");
    press(" ");
    press("PageDown");
    expect(position()).toBe("3 / 11");
    // Slide 3 is skipped: the third presented slide is Slide 4.
    expect(
      document.querySelector(
        `[data-testid=present-mode] [data-node="${doc.pages[3]!.nodes[0]!.id}"]`,
      ),
    ).not.toBeNull();
    press("End");
    expect(position()).toBe("11 / 11");
    press("Home");
    press("1");
    press("0");
    expect(position()).toBe("10 / 11");
    press("Escape");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("the presenter view shows the current and next slide, the notes and a timer", () => {
    vi.useFakeTimers();
    const doc = deck();
    act(() =>
      root.render(
        <PresentMode document={doc} startFrameId={null} presenter onClose={() => undefined} />,
      ),
    );
    const view = () => document.querySelector("[data-testid=presenter-view]");
    expect(view()).not.toBeNull();
    expect(document.querySelector("[data-testid=presenter-current] [data-node]")).not.toBeNull();
    expect(document.querySelector("[data-testid=presenter-next] [data-node]")).not.toBeNull();
    expect(document.querySelector("[data-testid=presenter-notes]")?.textContent).toBe(
      "Notes for Slide 1",
    );
    press("ArrowRight");
    press("ArrowRight");
    // Skipped Slide 3 never shows, neither as current nor as next.
    expect(document.querySelector("[data-testid=presenter-notes]")?.textContent).toBe(
      "Notes for Slide 4",
    );
    expect(document.querySelector("[data-testid=presenter-timer]")?.textContent).toBe("0:00");
    act(() => vi.advanceTimersByTime(65_000));
    expect(document.querySelector("[data-testid=presenter-timer]")?.textContent).toBe("1:05");
    press("End");
    expect(document.body.textContent).toContain("End of the deck");
    press("p");
    expect(view()).toBeNull();
  });

  it("keeps focus inside while open and returns it to the Present button on leaving", () => {
    const doc = deck();
    // The editor behind the presentation, outside the React root.
    const editor = document.createElement("main");
    const present = document.createElement("button");
    present.textContent = "Present";
    editor.append(present);
    document.body.append(editor);
    present.focus();
    let open = true;
    const view = () =>
      open ? <PresentMode document={doc} startFrameId={null} onClose={() => undefined} /> : null;
    act(() => root.render(view()));
    const dialog = document.querySelector<HTMLElement>("[data-testid=present-mode]")!;
    expect(document.activeElement).toBe(dialog);
    // Everything behind the presentation is inert, so Tab cannot reach the editor.
    expect(editor.hasAttribute("inert")).toBe(true);
    expect(dialog.hasAttribute("inert")).toBe(false);
    open = false;
    act(() => root.render(view()));
    expect(editor.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(present);
  });

  it("formats the timer", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(59_999)).toBe("0:59");
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
  });
});
