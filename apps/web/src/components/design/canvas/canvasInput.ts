import type { DesignNode } from "@specweave-studio/contracts";
import type { NodeIndex, Point } from "./geometry";

/** The design editor: canvas shortcuts work from anywhere inside it once the canvas is not focused. */
export const CANVAS_KEY_SCOPE = '[data-testid="design-editor"]';

/** Fields that take typing: canvas shortcuts never fire from them. */
const EDITABLE = [
  "input",
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="spinbutton"]',
  '[role="slider"]',
].join(",");

/** Open menus, dialogs, popovers and pickers own their keys, as does the design's thread pane. */
const KEY_OWNERS = [
  '[role="menu"]',
  '[role="menubar"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="listbox"]',
  '[role="combobox"]',
  '[data-slot="menu-popup"]',
  '[data-slot="dialog-popup"]',
  '[data-slot="alert-dialog-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="sheet-popup"]',
  '[data-testid="design-thread"]',
].join(",");

/** With focus on the page body, an open overlay still owns the keyboard (the app's own check). */
const OPEN_OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/** Widgets whose arrow keys move within them. */
const ARROW_OWNERS = '[role="radiogroup"], [role="tablist"], [role="tree"], [role="grid"]';
const ARROW_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

/** A picker's trigger while its list is closed: it has no use for undo and redo. */
const CLOSED_PICKER = '[role="combobox"]:not([aria-expanded="true"])';

interface PressTracker {
  users: number;
  /** The last pointerdown's composed path, read at dispatch so later DOM removal does not matter. */
  path: readonly EventTarget[] | null;
  readonly listener: (event: Event) => void;
}

const pressTrackers = new WeakMap<Document, PressTracker>();

/**
 * Records where the last pointer press in `document` landed (a capture listener, so
 * handlers that stop propagation cannot hide it). Focus on the page body only counts as
 * the canvas when that press was in the editor. Returns the release; the listener goes
 * away with the last user.
 */
export function trackCanvasPresses(document: Document): () => void {
  let tracker = pressTrackers.get(document);
  if (tracker === undefined) {
    const created: PressTracker = {
      users: 0,
      path: null,
      listener: (event) => {
        created.path = event.composedPath();
      },
    };
    tracker = created;
    pressTrackers.set(document, created);
    document.addEventListener("pointerdown", created.listener, true);
  }
  const active = tracker;
  active.users += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active.users -= 1;
    if (active.users > 0) return;
    document.removeEventListener("pointerdown", active.listener, true);
    pressTrackers.delete(document);
  };
}

/** Whether the last press was inside `scope` and outside the thread pane, menus and dialogs. */
function lastPressInEditor(document: Document, scope: Element | null): boolean {
  const path = pressTrackers.get(document)?.path ?? null;
  if (scope === null || path === null || !path.includes(scope)) return false;
  return !path.some((node) => node instanceof Element && node.matches(KEY_OWNERS));
}

export interface CanvasKeyTarget {
  readonly target: EventTarget | null;
  readonly key: string;
  readonly defaultPrevented: boolean;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
}

const isUndoKey = (event: CanvasKeyTarget) =>
  (event.metaKey === true || event.ctrlKey === true) &&
  event.altKey !== true &&
  /^[yz]$/i.test(event.key);

/**
 * Whether a keydown belongs to the canvas. Keys pressed on the canvas always do. After a
 * toolbar or panel click focus sits on a button there, or on the page body, and shortcuts
 * keep working. The page body counts only when the last press (see `trackCanvasPresses`)
 * was in the editor, so a click on plain text in the thread or the app shell never lets
 * Delete reach the canvas. Typing fields, open menus and dialogs, keys another component
 * already handled, and targets outside `scope` (the editor) are left alone, except undo
 * and redo on a closed picker's trigger, so Cmd+Z right after a pick undoes it. A focused
 * control keeps Enter and Space for activation, and Tab always moves focus.
 */
export function shouldCanvasHandleKey(
  event: CanvasKeyTarget,
  canvas: Element | null,
  scope: Element | null,
): boolean {
  const target = event.target;
  if (event.defaultPrevented || !(target instanceof Element)) return false;
  if (canvas !== null && target === canvas) return true;
  if (event.key === "Tab") return false;
  const document = target.ownerDocument;
  if (target === document.body || target === document.documentElement)
    return document.querySelector(OPEN_OVERLAY) === null && lastPressInEditor(document, scope);
  if (scope === null || !scope.contains(target)) return false;
  if ((target as HTMLElement).isContentEditable === true || target.closest(EDITABLE) !== null)
    return false;
  const owner = target.closest(KEY_OWNERS);
  if (owner !== null && !(owner === target && target.matches(CLOSED_PICKER) && isUndoKey(event)))
    return false;
  if (ARROW_KEYS.has(event.key) && target.closest(ARROW_OWNERS) !== null) return false;
  return event.key !== "Enter" && event.key !== " ";
}

/**
 * The unlocked text or note the pointer pressed on: a double-click there edits it in
 * place, inside a slide or frame too. Only the node itself counts, not its ancestors.
 */
export function textNodeAt(
  target: EventTarget | null,
  index: NodeIndex,
): Extract<DesignNode, { type: "text" | "note" }> | null {
  const element = target instanceof Element ? target.closest<HTMLElement>("[data-node]") : null;
  const node = element === null ? undefined : index.get(element.dataset.node ?? "");
  if (node === undefined || node.locked === true) return null;
  return node.type === "text" || node.type === "note" ? node : null;
}

/**
 * Pen points for a path finished by double-click. Both presses of the double-click added
 * a point; the second one is dropped wherever the pointer jittered to, so the path ends
 * on the first press with no stray segment.
 */
export function withoutDoubleClickPoint(points: readonly Point[]): Point[] {
  return points.slice(0, -1);
}
