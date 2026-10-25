// @vitest-environment jsdom
import type { DesignDocument, DesignOperation } from "@specweave-studio/contracts";
import { applyDesignOperations, newDesignDocument } from "@specweave-studio/shared/designOps";
import { act, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { addSlideAfter } from "./slideActions";
import { modifierLabel } from "./SlideMenu";
import { SLIDE_DRAG_TYPE, SlideRail } from "./SlideRail";
import { SpeakerNotes } from "./SpeakerNotes";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

function deck(): DesignDocument {
  let doc = newDesignDocument({
    id: "d_deck",
    kind: "slides",
    title: "Deck",
    now: "2026-10-20T00:00:00.000Z",
    createdBy: { kind: "user" },
    random: () => 0.31,
  });
  let seed = 9;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let step = 0; step < 2; step += 1) {
    const change = addSlideAfter(doc, doc.pages.at(-1)!.id, null, null, random);
    const outcome = applyDesignOperations(doc, change.operations);
    if (!outcome.ok) throw new Error(outcome.error.detail);
    doc = outcome.document;
  }
  return doc;
}

/** The rail over live state, the way the editor wires it. */
let state: { document: DesignDocument; pageId: string; commits: DesignOperation[][] };
function Harness({
  initial,
  readOnly = false,
  compact = false,
}: {
  initial: DesignDocument;
  readOnly?: boolean;
  compact?: boolean;
}) {
  const [document, setDocument] = useState(initial);
  const [pageId, setPageId] = useState(initial.pages[0]!.id);
  useLayoutEffect(() => {
    state.document = document;
    state.pageId = pageId;
  });
  return (
    <SlideRail
      document={document}
      pageId={pageId}
      system={null}
      readOnly={readOnly}
      compact={compact}
      onSelect={setPageId}
      onCommit={(operations) => {
        const outcome = applyDesignOperations(document, operations);
        if (!outcome.ok) return false;
        state.commits.push(operations);
        setDocument(outcome.document);
        return true;
      }}
    />
  );
}

function render(initial = deck(), readOnly = false, compact = false) {
  state = { document: initial, pageId: initial.pages[0]!.id, commits: [] };
  act(() => root.render(<Harness initial={initial} readOnly={readOnly} compact={compact} />));
  return initial;
}

const items = () => [...document.querySelectorAll<HTMLElement>("[data-testid=slide-item]")];
const order = () => state.document.pages.map((page) => page.name);
const press = (target: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
const menuItem = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
    item.textContent?.includes(name),
  );

describe("SlideRail (AC-02)", () => {
  it("shows one numbered thumbnail per slide and marks the current one", () => {
    render();
    expect(items()).toHaveLength(3);
    expect(items().map((item) => item.getAttribute("aria-label"))).toEqual([
      "Slide 1",
      "Slide 2",
      "Slide 3",
    ]);
    expect(items()[0]!.getAttribute("aria-current")).toBe("true");
    expect(items()[0]!.querySelector("[data-node]")).not.toBeNull();
  });

  it("moves through slides with the arrow keys and reorders with Alt+arrows", async () => {
    render();
    press(items()[0]!, "ArrowDown");
    await flush();
    expect(state.pageId).toBe(state.document.pages[1]!.id);
    expect(document.activeElement).toBe(items()[1]);

    press(items()[1]!, "ArrowDown", { altKey: true });
    await flush();
    expect(order()).toEqual(["Slide 1", "Slide 3", "Slide 2"]);
    // Focus follows the moved slide.
    expect(document.activeElement?.getAttribute("data-slide")).toBe(state.document.pages[2]!.id);

    press(document.activeElement as HTMLElement, "ArrowUp", { altKey: true });
    press(document.activeElement as HTMLElement, "ArrowUp", { altKey: true });
    await flush();
    expect(order()).toEqual(["Slide 2", "Slide 1", "Slide 3"]);
    expect(state.commits.every((ops) => ops.every((op) => op.op === "move_page"))).toBe(true);
  });

  it("duplicates with Cmd+D and deletes with Delete, never the last slide", async () => {
    render();
    press(items()[0]!, "d", { metaKey: true });
    await flush();
    expect(order()).toEqual(["Slide 1", "Slide 4", "Slide 2", "Slide 3"]);
    for (let step = 0; step < 5; step += 1) {
      press(document.activeElement as HTMLElement, "Delete");
      await flush();
    }
    expect(state.document.pages).toHaveLength(1);
  });

  it("reorders by drag and drop", async () => {
    render();
    const [first, , third] = items();
    const types: string[] = [];
    const transfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: (type: string) => void types.push(type),
    };
    const drag = (target: Element, type: string, clientY = 0) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { dataTransfer: transfer, clientY });
      target.dispatchEvent(event);
    };
    // jsdom has no layout: every item sits at 0..0, so any positive Y is past the last one.
    act(() => drag(first!, "dragstart"));
    // Only the rail's own type: dropped on the composer, a slide inserts no text.
    expect(types).toEqual([SLIDE_DRAG_TYPE]);
    act(() => drag(third!, "dragover", 10));
    expect(document.querySelector("[data-testid=slide-drop-line]")).not.toBeNull();
    act(() => drag(third!, "drop", 10));
    await flush();
    expect(order()).toEqual(["Slide 2", "Slide 3", "Slide 1"]);
  });

  it("the slide menu duplicates, adds after, moves, skips and deletes", async () => {
    render();
    const open = async (index: number) => {
      act(() => {
        items()[index]!.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
        );
      });
      await flush();
    };
    await open(1);
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((item) =>
      item.textContent?.replace(/((Cmd|Ctrl)\+D|Alt\+Up|Alt\+Down|Delete)$/, "").trim(),
    );
    expect(labels).toEqual([
      "Duplicate",
      "Add slide after",
      "Move up",
      "Move down",
      "Skip slide",
      "Delete",
    ]);
    act(() => menuItem("Skip slide")!.click());
    await flush();
    expect(state.document.pages[1]!.skipped).toBe(true);
    expect(items()[1]!.getAttribute("aria-label")).toBe("Slide 2, skipped");

    await open(1);
    act(() => menuItem("Move up")!.click());
    await flush();
    expect(order()).toEqual(["Slide 2", "Slide 1", "Slide 3"]);

    await open(0);
    act(() => menuItem("Add slide after")!.click());
    await flush();
    expect(order()).toEqual(["Slide 2", "Slide 4", "Slide 1", "Slide 3"]);

    await open(3);
    act(() => menuItem("Delete")!.click());
    await flush();
    expect(order()).toEqual(["Slide 2", "Slide 4", "Slide 1"]);
  });

  it("Enter and Space show the focused slide", () => {
    render();
    press(items()[2]!, "Enter");
    expect(state.pageId).toBe(state.document.pages[2]!.id);
    press(items()[1]!, " ");
    expect(state.pageId).toBe(state.document.pages[1]!.id);
  });

  it("keeps the More button beside the slide, not inside it", () => {
    render();
    expect(document.querySelectorAll("[data-testid=slide-more]")).toHaveLength(3);
    for (const item of items()) expect(item.querySelector("button, [role=button]")).toBeNull();
  });

  it("Delete typed in an open slide menu does not delete the slide", async () => {
    render();
    act(() => document.querySelectorAll<HTMLElement>("[data-testid=slide-more]")[1]!.click());
    await flush();
    const item = menuItem("Duplicate");
    expect(item).toBeDefined();
    press(item!, "Delete");
    press(item!, "Backspace");
    await flush();
    expect(state.document.pages).toHaveLength(3);
    expect(state.commits).toHaveLength(0);
  });

  it("the compact strip keeps every slide, the menu and New slide", async () => {
    render(deck(), false, true);
    expect(document.querySelector("[data-testid=slide-rail]")?.getAttribute("data-compact")).toBe(
      "true",
    );
    expect(items()).toHaveLength(3);
    expect(document.querySelector("[data-testid=new-slide]")?.getAttribute("aria-label")).toBe(
      "New slide",
    );
    act(() => {
      items()[2]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    await flush();
    act(() => menuItem("Duplicate")!.click());
    await flush();
    expect(state.document.pages).toHaveLength(4);
  });

  it("the compact strip has a More button on each thumbnail that opens the slide menu", async () => {
    render(deck(), false, true);
    const more = [...document.querySelectorAll<HTMLElement>("[data-testid=slide-more]")];
    expect(more.map((button) => button.getAttribute("aria-label"))).toEqual([
      "More for slide 1",
      "More for slide 2",
      "More for slide 3",
    ]);
    for (const item of items()) expect(item.querySelector("button, [role=button]")).toBeNull();
    // Overlaid on the thumbnail corner: shown on hover and focus, always for the
    // current slide and on touch screens.
    const overlay = more[1]!.parentElement!;
    expect(overlay.className).toContain("group-hover:opacity-100");
    expect(overlay.className).toContain("group-focus-within:opacity-100");
    expect(overlay.className).toContain("pointer-coarse:opacity-100");
    expect(overlay.classList.contains("opacity-0")).toBe(true);
    expect(more[0]!.parentElement!.classList.contains("opacity-100")).toBe(true);

    act(() => more[1]!.click());
    await flush();
    expect(state.pageId).toBe(state.document.pages[1]!.id);
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((item) =>
      item.textContent?.replace(/((Cmd|Ctrl)\+D|Alt\+Up|Alt\+Down|Delete)$/, "").trim(),
    );
    expect(labels).toEqual([
      "Duplicate",
      "Add slide after",
      "Move up",
      "Move down",
      "Skip slide",
      "Delete",
    ]);
    act(() => menuItem("Skip slide")!.click());
    await flush();
    expect(state.document.pages[1]!.skipped).toBe(true);
  });

  it("read-only compact strips have no More button", () => {
    render(deck(), true, true);
    expect(document.querySelector("[data-testid=slide-more]")).toBeNull();
  });

  it.each([
    ["MacIntel", "Cmd"],
    ["iPad", "Cmd"],
    ["Win32", "Ctrl"],
    ["Linux x86_64", "Ctrl"],
  ])("labels the duplicate shortcut for %s with %s", (platform, label) => {
    expect(modifierLabel(platform)).toBe(label);
  });

  it("read-only viewers can browse but not change the deck", async () => {
    render(deck(), true);
    expect(items()[0]!.getAttribute("draggable")).toBe("false");
    expect(document.querySelector("[data-testid=new-slide]")).toBeNull();
    press(items()[0]!, "ArrowDown", { altKey: true });
    press(items()[0]!, "Delete");
    await flush();
    expect(state.commits).toHaveLength(0);
  });
});

describe("SpeakerNotes (AC-04)", () => {
  it("saves typed notes for the slide they were typed on", async () => {
    const doc = deck();
    const saved: [string, string][] = [];
    act(() =>
      root.render(
        <SpeakerNotes
          page={doc.pages[1]!}
          readOnly={false}
          onSave={(pageId, notes) => saved.push([pageId, notes])}
        />,
      ),
    );
    const field = document.querySelector<HTMLTextAreaElement>("[data-testid=speaker-notes-field]")!;
    act(() => {
      field.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(field, "Ask who has tried it");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => field.blur());
    expect(saved).toEqual([[doc.pages[1]!.id, "Ask who has tried it"]]);
  });
});
