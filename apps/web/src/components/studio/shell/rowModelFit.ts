import { useLayoutEffect } from "react";

import { chooseFit, measureFitParts } from "../../chat/modelChipFit";

/**
 * How much of a thread's model unit shows on a list line (thread rows, overview rows and
 * the thread header). The running model always comes first, and a usage-limit fallback
 * is its amber glyph alone after it (ModelStateTag):
 *
 * - `full`: `[mark] Codex · GPT-6.1-Sol`, then the state glyph
 * - `model`: the provider's word goes (its mark stays)
 *
 * The fit follows the room the line really has after its plan, pull request and machine
 * chips, measured from the parts, so the word gives way before any of them is pushed off
 * the line. The provider stays in the accessible name, and the pick and reason in the
 * tooltip.
 *
 * The thread header's chip (`data-row-line="header"`) shares its line with the title,
 * which outranks it, so once the routing and PR chips after it have wrapped away it has
 * two more fits (`HEADER_MODEL_FITS`), as the composer chip has (modelChipFit.ts):
 *
 * - `name`: a long name shows its first characters, never fewer than 3 em
 * - `mark`: the name is left out whole; the mark and the fallback glyph stay
 */
export const ROW_MODEL_FITS = ["full", "model"] as const;
export const HEADER_MODEL_FITS = ["full", "model", "name", "mark"] as const;
export type RowModelFit = (typeof HEADER_MODEL_FITS)[number];
export type RowModelFitWidths = Readonly<Record<RowModelFit, number>>;

/** Optional parts of the unit, marked with `data-row-part`. */
export type RowModelPart = "provider" | "name";

const PARTS_BY_FIT: Readonly<Record<RowModelFit, ReadonlySet<RowModelPart>>> = {
  full: new Set(["provider", "name"]),
  model: new Set(["name"]),
  name: new Set(["name"]),
  mark: new Set(),
};

/** Whether `fit` shows `part`. */
export function rowModelShows(fit: RowModelFit, part: RowModelPart): boolean {
  return PARTS_BY_FIT[fit].has(part);
}

/**
 * What the line's squeeze hides from one rendering: the running name shrunk below its
 * natural width, and whatever still overflows the unit's clipped box. Without it, the
 * fit that squeezed the unit would always seem to fit. Hidden parts hang from the
 * unit's end edge, so they never add to its overflow.
 */
function squeezedWidth(badge: HTMLElement): number {
  // A name that is a part already counts its natural width.
  const name = badge.querySelector<HTMLElement>(".sws-model-name:not([data-row-part])");
  return (
    Math.max(0, badge.scrollWidth - badge.clientWidth) +
    (name ? Math.max(0, name.scrollWidth - name.clientWidth) : 0)
  );
}

/** The unit's natural width at every fit, read from one rendering; null when it has nothing to fit. */
export function measureRowModelFitWidths(badge: HTMLElement): RowModelFitWidths | null {
  const measured = measureFitParts<RowModelPart>(badge, "rowPart");
  if (!measured) return null;
  const always = measured.always + squeezedWidth(badge);
  // At `name` a long name counts only its first characters, as the composer chip's does.
  const widthAt = (fit: RowModelFit) =>
    always +
    [...measured.costs].reduce(
      (sum, [part, cost]) =>
        sum +
        (!rowModelShows(fit, part)
          ? 0
          : fit === "name" && part === "name"
            ? (measured.least.get(part) ?? cost)
            : cost),
      0,
    );
  return {
    full: widthAt("full"),
    model: widthAt("model"),
    name: widthAt("name"),
    mark: widthAt("mark"),
  };
}

/** The line the unit sits on: its nearest size container (`.sws-thread-meta` and the like). */
export function rowModelHost(badge: HTMLElement): HTMLElement | null {
  for (let node = badge.parentElement; node; node = node.parentElement) {
    const type = getComputedStyle(node).containerType;
    if (type && type !== "normal") return node;
  }
  return null;
}

function outOfFlow(element: Element): boolean {
  const style = getComputedStyle(element);
  return style.display === "none" || style.position === "absolute" || style.position === "fixed";
}

function marginsOf(element: Element): number {
  const style = getComputedStyle(element);
  return (Number.parseFloat(style.marginLeft) || 0) + (Number.parseFloat(style.marginRight) || 0);
}

function textWidth(node: Text): number {
  if (!node.data.trim()) return node.data.length > 0 ? 4 : 0;
  const range = document.createRange();
  range.selectNodeContents(node);
  return range.getBoundingClientRect().width;
}

/** Chips that already give way before the model unit: the machine name and a long error. */
const YIELDS_TO_MODEL = ".sws-thread-machine, .sws-thread-error";

/**
 * The width a following item asks for. A wrapping group (the row's plan, PR and machine
 * chips) asks for every item it holds, even those it has wrapped off the line, except the
 * chips that give way to the model anyway.
 */
function wantedWidth(node: Node): number {
  if (node instanceof Text) return textWidth(node);
  if (!(node instanceof Element) || outOfFlow(node)) return 0;
  const style = getComputedStyle(node);
  if (style.display.includes("flex") && style.flexWrap !== "nowrap") {
    const gap = Number.parseFloat(style.columnGap) || 0;
    let width = 0;
    let count = 0;
    for (const child of node.children) {
      if (outOfFlow(child) || child.matches(YIELDS_TO_MODEL)) continue;
      width += child.getBoundingClientRect().width + marginsOf(child);
      count += 1;
    }
    return width + gap * Math.max(0, count - 1);
  }
  return node.getBoundingClientRect().width + marginsOf(node);
}

function wraps(element: Element): boolean {
  const style = getComputedStyle(element);
  return style.display.includes("flex") && style.flexWrap !== "nowrap";
}

/**
 * The room for the unit: from its start edge to the end of the host's content box, less
 * everything that follows it on the line at that content's natural width, or less the
 * room the line keeps clear for its row's hover action (shell.css) when that is more.
 * The same room hovered or not, so hovering never refits the unit; on hover the chips
 * after it may wrap away under the action, as they would be covered anyway.
 *
 * When the unit's own line wraps (the thread header's chips), a chip that would not fit
 * even beside the unit's `leanest` width wraps away, and every chip after it with it, so
 * only the chips that stay are left room for.
 */
export function rowModelRoom(badge: HTMLElement, host: HTMLElement, leanest = 0): number {
  const hostBox = host.getBoundingClientRect();
  const hostStyle = getComputedStyle(host);
  const box = badge.getBoundingClientRect();
  let room =
    hostStyle.direction === "rtl"
      ? box.right - hostBox.left - (Number.parseFloat(hostStyle.paddingLeft) || 0)
      : hostBox.right - (Number.parseFloat(hostStyle.paddingRight) || 0) - box.left;
  room -= Number.parseFloat(getComputedStyle(badge).marginInlineEnd) || 0;
  let following = 0;
  for (let node: Node = badge; node !== host && node.parentNode; node = node.parentNode) {
    const parent = node.parentNode;
    const gap =
      parent instanceof Element && getComputedStyle(parent).display.includes("flex")
        ? Number.parseFloat(getComputedStyle(parent).columnGap) || 0
        : 0;
    const wrapping = node === badge && parent instanceof Element && wraps(parent);
    for (let next = node.nextSibling; next; next = next.nextSibling) {
      const wanted = wantedWidth(next);
      if (wanted <= 0) continue;
      if (wrapping && leanest + following + gap + wanted > room) break;
      following += wanted + gap;
    }
    if (parent === host) break;
  }
  const reserve =
    Number.parseFloat(getComputedStyle(host).getPropertyValue("--sws-row-action-reserve")) || 0;
  return room - Math.max(following, reserve);
}

/** Whether `badge` is the thread header's chip, which ModelBadge marks. */
export function isHeaderModelUnit(badge: HTMLElement): boolean {
  return badge.dataset.rowLine === "header";
}

/** What the header keeps of its title, and of anything else beside the chips that may shrink to nothing. */
export const HEADER_TITLE_MIN_EM = 3;

/**
 * The most the header's chips line may claim as its minimum: its container's content
 * box, less the controls beside it at their width and the title at its first 3 em (or
 * all of a shorter one), so the floor never pushes them past the container's edge.
 */
export function headerFloorRoom(host: HTMLElement): number {
  const parent = host.parentElement;
  if (!parent) return Number.POSITIVE_INFINITY;
  const style = getComputedStyle(parent);
  const gap = Number.parseFloat(style.columnGap) || 0;
  let room =
    parent.clientWidth -
    (Number.parseFloat(style.paddingLeft) || 0) -
    (Number.parseFloat(style.paddingRight) || 0);
  let count = 0;
  for (const child of parent.children) {
    if (outOfFlow(child)) continue;
    count += 1;
    if (child === host) continue;
    const childStyle = getComputedStyle(child);
    const yields =
      (Number.parseFloat(childStyle.flexShrink) || 0) > 0 &&
      (Number.parseFloat(childStyle.minWidth) || 0) === 0;
    room -=
      (yields
        ? Math.min(
            child.scrollWidth,
            HEADER_TITLE_MIN_EM * (Number.parseFloat(childStyle.fontSize) || 13),
          )
        : child.getBoundingClientRect().width) + marginsOf(child);
  }
  return room - gap * Math.max(0, count - 1);
}

/** The fit `badge` should take now, or null when it has nothing to fit or no line. */
export function decideRowModelFit(
  badge: HTMLElement,
  previous: RowModelFit | null,
): { readonly fit: RowModelFit; readonly floor: number | null } | null {
  const host = rowModelHost(badge);
  if (!host) return null;
  const widths = measureRowModelFitWidths(badge);
  if (!widths) return null;
  const header = isHeaderModelUnit(badge);
  // The chips after the unit stay only beside its whole name, so they wrap away before
  // the name gives way, and `name` and `mark` are for a chip alone on its line.
  const room = rowModelRoom(badge, host, widths.model);
  return {
    fit: chooseFit(header ? HEADER_MODEL_FITS : ROW_MODEL_FITS, widths, room, previous),
    // The header's line is never narrower than the leanest chip, so its clip never cuts
    // the mark or the fallback glyph, unless that would take the title's first 3 em.
    floor: header
      ? Math.max(0, Math.floor(Math.min(Math.ceil(widths.mark), headerFloorRoom(host))))
      : null,
  };
}

/**
 * Marks the chips after `badge` that its wrapping line has moved onto the hidden second
 * line with `data-row-wrapped`, so CSS can take them out of sight, the Tab order and the
 * accessibility tree instead of leaving them focusable but clipped.
 */
function markWrapped(badge: HTMLElement): Array<readonly [Element, boolean]> {
  const parent = badge.parentElement;
  if (!parent || !wraps(parent)) return [];
  const bottom = badge.getBoundingClientRect().bottom;
  const marks: Array<readonly [Element, boolean]> = [];
  for (let next = badge.nextElementSibling; next; next = next.nextElementSibling) {
    if (outOfFlow(next)) continue;
    marks.push([next, next.getBoundingClientRect().top >= bottom - 0.5]);
  }
  return marks;
}

// One batch for every row: read every line, then write every fit, so a list of rows
// lays out once per change instead of once per row.
const pending = new Set<HTMLElement>();
let flushQueued = false;

function flush() {
  flushQueued = false;
  const badges = [...pending];
  pending.clear();
  const decisions = badges.map((badge) => {
    const previous = (badge.dataset.rowFit as RowModelFit | undefined) ?? null;
    return [badge, decideRowModelFit(badge, previous)] as const;
  });
  for (const [badge, decision] of decisions) {
    if (!decision) continue;
    if (badge.dataset.rowFit !== decision.fit) badge.dataset.rowFit = decision.fit;
    const host = decision.floor === null ? null : rowModelHost(badge);
    const floor = `${decision.floor}px`;
    if (host && host.style.getPropertyValue("--sws-model-floor") !== floor)
      host.style.setProperty("--sws-model-floor", floor);
  }
  // The new fits decide which chips still share the line: one more read, then write.
  const wrapped = badges.flatMap((badge) =>
    markWrapped(badge).map(([chip, away]) => [badge, chip, away] as const),
  );
  for (const [badge, chip, away] of wrapped) {
    // A chip that wraps away while focused hands focus to the model chip, when it takes
    // focus, instead of dropping it to the page.
    if (away && chip.contains(document.activeElement) && badge.tabIndex >= 0)
      badge.focus({ preventScroll: true });
    chip.toggleAttribute("data-row-wrapped", away);
  }
}

function schedule(badge: HTMLElement) {
  pending.add(badge);
  if (flushQueued) return;
  flushQueued = true;
  // A microtask still runs before the frame paints, so the first frame already fits.
  queueMicrotask(flush);
}

/**
 * Keeps `badge`'s `data-row-fit` in step with its line. The attribute is written straight
 * to the element, so a resize never re-renders the list. The line's size and its content
 * (a new plan, PR or model name) are watched; the unit's own size is not, since only this
 * fit and that content change it. The header's floor also follows the title's row
 * (headerFloorRoom), so the row and each item in it are watched too.
 */
export function useRowModelFit(badge: HTMLElement | null, enabled: boolean): void {
  useLayoutEffect(() => {
    if (!enabled || !badge) return;
    const host = rowModelHost(badge);
    if (!host) return;
    const measure = () => schedule(badge);
    measure();
    const header = isHeaderModelUnit(badge);
    // A line held at its floor never resizes when the row around it grows, or when a
    // handoff badge or the subagents chip appears or grows beside it; the title does.
    const row = header ? host.parentElement : null;
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const observeRow = () => {
      if (row) for (const item of row.children) resize?.observe(item);
    };
    resize?.observe(host);
    if (row) resize?.observe(row);
    observeRow();
    const mutations =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            observeRow();
            measure();
          });
    mutations?.observe(row ?? host, { childList: true, subtree: true, characterData: true });
    document.fonts?.addEventListener("loadingdone", measure);
    return () => {
      resize?.disconnect();
      mutations?.disconnect();
      document.fonts?.removeEventListener("loadingdone", measure);
      pending.delete(badge);
      if (header) host.style.removeProperty("--sws-model-floor");
    };
  }, [badge, enabled]);
}
