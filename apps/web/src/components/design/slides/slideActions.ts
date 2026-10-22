import type {
  DesignDocument,
  DesignOperation,
  DesignPage,
  DesignSystem,
} from "@specweave-studio/contracts";
import { designId, SLIDE_FRAME } from "@specweave-studio/shared/designOps";
import {
  slideLayoutPage,
  slideTokens,
  type SlideLayoutId,
} from "@specweave-studio/shared/slideLayouts";

/**
 * The slide menu's actions as reducer operations. Each returns the
 * operations and the slide to show afterwards, or null when the action does
 * not apply (moving the first slide up, deleting the last one).
 */
export interface SlideChange {
  readonly operations: DesignOperation[];
  readonly pageId: string;
}

/** The next free "Slide N" name, so new slides never share a name. */
export function nextSlideName(document: DesignDocument) {
  let highest = document.pages.length;
  for (const page of document.pages) {
    const match = /^Slide (\d+)$/.exec(page.name);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return `Slide ${highest + 1}`;
}

/** A copy of the slide with fresh page and node ids, placed right after it. */
export function duplicateSlide(
  document: DesignDocument,
  pageId: string,
  random: () => number = Math.random,
): SlideChange | null {
  const index = document.pages.findIndex((page) => page.id === pageId);
  const source = document.pages[index];
  if (source === undefined) return null;
  const ids = new Map(source.nodes.map((node) => [node.id, designId("n", random)]));
  const copy: DesignPage = {
    ...source,
    id: designId("p", random),
    name: nextSlideName(document),
    nodes: source.nodes.map((node) => ({
      ...node,
      id: ids.get(node.id)!,
      parentId: node.parentId === null ? null : (ids.get(node.parentId) ?? null),
    })),
  };
  return { operations: [{ op: "add_page", page: copy, index: index + 1 }], pageId: copy.id };
}

/** A new slide after `pageId`: a layout, or an empty frame in the system's background. */
export function addSlideAfter(
  document: DesignDocument,
  pageId: string,
  system: DesignSystem | null,
  layout: SlideLayoutId | null = null,
  random: () => number = Math.random,
): SlideChange {
  const index = document.pages.findIndex((page) => page.id === pageId);
  const name = nextSlideName(document);
  const page: DesignPage =
    layout === null
      ? {
          id: designId("p", random),
          name,
          nodes: [
            {
              id: designId("n", random),
              parentId: null,
              type: "frame",
              name,
              x: 0,
              y: 0,
              width: SLIDE_FRAME.width,
              height: SLIDE_FRAME.height,
              fill: slideTokens(system).background.paint,
              clip: true,
            },
          ],
        }
      : slideLayoutPage(layout, { name, system, random });
  return {
    operations: [{ op: "add_page", page, index: index < 0 ? document.pages.length : index + 1 }],
    pageId: page.id,
  };
}

/** Moves a slide to `to` (clamped); null when it would not move. */
export function moveSlide(
  document: DesignDocument,
  pageId: string,
  to: number,
): SlideChange | null {
  const from = document.pages.findIndex((page) => page.id === pageId);
  const target = Math.max(0, Math.min(document.pages.length - 1, to));
  if (from < 0 || from === target) return null;
  return { operations: [{ op: "move_page", pageId, index: target }], pageId };
}

export function setSlideSkipped(
  document: DesignDocument,
  pageId: string,
  skipped: boolean,
): SlideChange | null {
  const page = document.pages.find((candidate) => candidate.id === pageId);
  if (page === undefined || (page.skipped === true) === skipped) return null;
  return { operations: [{ op: "update_page", pageId, skipped }], pageId };
}

/** Deletes a slide and shows its neighbour; null for the only slide. */
export function deleteSlide(document: DesignDocument, pageId: string): SlideChange | null {
  const index = document.pages.findIndex((page) => page.id === pageId);
  if (index < 0 || document.pages.length === 1) return null;
  const next = document.pages[index + 1] ?? document.pages[index - 1]!;
  return { operations: [{ op: "delete_page", pageId }], pageId: next.id };
}

export function setSlideNotes(
  document: DesignDocument,
  pageId: string,
  notes: string,
): SlideChange | null {
  const page = document.pages.find((candidate) => candidate.id === pageId);
  if (page === undefined || (page.notes ?? "") === notes) return null;
  return { operations: [{ op: "update_page", pageId, notes }], pageId };
}

/** A slide is empty when its frame holds nothing yet: the layout prompt shows. */
export function isEmptySlide(page: DesignPage) {
  const frames = page.nodes.filter((node) => node.type === "frame" && node.parentId === null);
  return frames.length === 1 && page.nodes.length === 1;
}
