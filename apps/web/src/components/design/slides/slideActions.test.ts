import type { DesignDocument, DesignOperation } from "@specweave-studio/contracts";
import { applyDesignOperations, newDesignDocument } from "@specweave-studio/shared/designOps";
import { describe, expect, it } from "vite-plus/test";
import {
  addSlideAfter,
  deleteSlide,
  duplicateSlide,
  isEmptySlide,
  moveSlide,
  nextSlideName,
  setSlideNotes,
  setSlideSkipped,
} from "./slideActions";

const seeded = (start: number) => {
  let seed = start;
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
};

function apply(document: DesignDocument, operations: readonly DesignOperation[]) {
  const outcome = applyDesignOperations(document, operations);
  if (!outcome.ok) throw new Error(outcome.error.detail);
  return outcome.document;
}

/** A three-slide deck: Slide 1, Slide 2, Slide 3. */
function deck(): DesignDocument {
  let document = newDesignDocument({
    id: "d_deck",
    kind: "slides",
    title: "Deck",
    now: "2026-10-20T00:00:00.000Z",
    createdBy: { kind: "user" },
    random: seeded(5),
  });
  const random = seeded(17);
  for (let step = 0; step < 2; step += 1) {
    const change = addSlideAfter(document, document.pages.at(-1)!.id, null, null, random);
    document = apply(document, change.operations);
  }
  return document;
}

const names = (document: DesignDocument) => document.pages.map((page) => page.name);

describe("slide actions", () => {
  it("adds blank 1920x1080 slides after the current one with unique names", () => {
    const document = deck();
    expect(names(document)).toEqual(["Slide 1", "Slide 2", "Slide 3"]);
    const change = addSlideAfter(document, document.pages[0]!.id, null, null, seeded(23));
    const next = apply(document, change.operations);
    expect(names(next)).toEqual(["Slide 1", "Slide 4", "Slide 2", "Slide 3"]);
    expect(next.pages[1]!.id).toBe(change.pageId);
    expect(next.pages[1]!.nodes[0]).toMatchObject({ type: "frame", width: 1920, height: 1080 });
    expect(isEmptySlide(next.pages[1]!)).toBe(true);
  });

  it("adds a layout slide built from the system", () => {
    const document = deck();
    const change = addSlideAfter(document, document.pages[2]!.id, null, "quote", seeded(29));
    const next = apply(document, change.operations);
    expect(next.pages[3]!.nodes.some((node) => node.name === "Quote")).toBe(true);
    expect(isEmptySlide(next.pages[3]!)).toBe(false);
  });

  it("duplicates a slide with fresh ids, notes and skip included, right after it", () => {
    let document = deck();
    const source = document.pages[0]!;
    document = apply(document, [
      { op: "update_page", pageId: source.id, notes: "Open with the number", skipped: true },
      {
        op: "add_node",
        pageId: source.id,
        node: {
          id: "n_text",
          parentId: source.nodes[0]!.id,
          type: "text",
          text: "Hello",
          x: 10,
          y: 10,
          width: 200,
          height: 40,
        },
      },
    ]);
    const change = duplicateSlide(document, source.id, seeded(31))!;
    const next = apply(document, change.operations);
    const copy = next.pages[1]!;
    expect(copy.id).toBe(change.pageId);
    expect(copy.notes).toBe("Open with the number");
    expect(copy.skipped).toBe(true);
    expect(copy.nodes).toHaveLength(2);
    const [frame, text] = copy.nodes;
    expect(frame!.id).not.toBe(source.nodes[0]!.id);
    expect(text!.parentId).toBe(frame!.id);
    expect(duplicateSlide(document, "p_missing")).toBeNull();
  });

  it("moves slides up and down, clamped, and refuses no-op moves", () => {
    const document = deck();
    const [a, b, c] = document.pages;
    const down = moveSlide(document, a!.id, 1)!;
    expect(apply(document, down.operations).pages.map((page) => page.id)).toEqual([
      b!.id,
      a!.id,
      c!.id,
    ]);
    expect(moveSlide(document, a!.id, -1)).toBeNull();
    expect(moveSlide(document, c!.id, 9)).toBeNull();
    const top = moveSlide(document, c!.id, 0)!;
    expect(apply(document, top.operations).pages[0]!.id).toBe(c!.id);
  });

  it("skips and shows a slide", () => {
    const document = deck();
    const id = document.pages[1]!.id;
    const skipped = apply(document, setSlideSkipped(document, id, true)!.operations);
    expect(skipped.pages[1]!.skipped).toBe(true);
    expect(setSlideSkipped(skipped, id, true)).toBeNull();
    const shown = apply(skipped, setSlideSkipped(skipped, id, false)!.operations);
    expect(shown.pages[1]!.skipped).toBe(false);
  });

  it("deletes a slide and shows its neighbour, but keeps the last one", () => {
    const document = deck();
    const [a, b, c] = document.pages;
    expect(deleteSlide(document, b!.id)!.pageId).toBe(c!.id);
    expect(deleteSlide(document, c!.id)!.pageId).toBe(b!.id);
    let single = document;
    for (const page of [a!, b!]) single = apply(single, deleteSlide(single, page.id)!.operations);
    expect(single.pages).toHaveLength(1);
    expect(deleteSlide(single, c!.id)).toBeNull();
  });

  it("stores speaker notes on the page (AC-04)", () => {
    const document = deck();
    const id = document.pages[2]!.id;
    const next = apply(document, setSlideNotes(document, id, "Pause for questions")!.operations);
    expect(next.pages[2]!.notes).toBe("Pause for questions");
    expect(setSlideNotes(next, id, "Pause for questions")).toBeNull();
  });

  it("names the next slide past the highest Slide N", () => {
    const document = deck();
    const renamed = apply(document, [
      { op: "update_page", pageId: document.pages[0]!.id, name: "Slide 9" },
    ]);
    expect(nextSlideName(renamed)).toBe("Slide 10");
  });
});
