/**
 * Where a link opens so the reader sees it. The viewer overlay sits in front of
 * the app, so a file or pull request the app would show in its side panel
 * would land behind it; while the overlay is open those open in the overlay
 * instead, in the viewer's place with Back to it. Otherwise a file link opens
 * beside the conversation when both fit, else in the focused viewer (D-05).
 */
import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { scopedThreadKey } from "@specweave-studio/client-runtime/environment";
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { create } from "zustand";

import { type RightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import {
  useViewerOverlayStore,
  type ViewerFileTarget,
  type ViewerPullRequestTarget,
} from "../viewerOverlayStore";

/** True while the viewer overlay is in front of the app. */
export function viewerOverlayInFront(): boolean {
  return useViewerOverlayStore.getState().active !== null;
}

/** D-05: what the conversation keeps beside a file in the right panel, in CSS px. */
export const CONVERSATION_MIN_WIDTH = 560;
/** D-05: the narrowest a file reader beside the conversation may be, in CSS px. */
export const FILE_READER_MIN_WIDTH = 480;

/** The room a thread's page has, as its conversation view measures it, in CSS px. */
export interface FileReaderLayout {
  /** The row that holds the conversation and the right panel. */
  readonly rowWidth: number;
  /** The width the right panel has, or opens at. */
  readonly panelWidth: number;
  /** The panel is a sheet over the conversation. */
  readonly sheet: boolean;
  /** The panel takes the whole row. */
  readonly maximized: boolean;
}

export type FileReaderPlacement = "beside" | "focused";

/**
 * D-05: a file link opens beside the conversation only when the conversation
 * keeps 560 px and the reader gets 480 px; otherwise in the focused viewer. A
 * page that has not measured itself yet gets the focused viewer.
 */
export function fileReaderPlacement(
  layout: FileReaderLayout | null | undefined,
): FileReaderPlacement {
  if (!layout || layout.sheet || layout.maximized) return "focused";
  return layout.panelWidth >= FILE_READER_MIN_WIDTH &&
    layout.rowWidth - layout.panelWidth >= CONVERSATION_MIN_WIDTH
    ? "beside"
    : "focused";
}

// Each thread's room as its conversation view last reported it. Another view
// of the same thread that reports later takes over, and only the view that
// wrote an entry clears it.
const fileReaderLayouts = new Map<
  string,
  { readonly owner: object; readonly layout: FileReaderLayout }
>();
const fileReaderLayoutListeners = new Set<() => void>();

function notifyFileReaderLayout() {
  for (const listener of fileReaderLayoutListeners) listener();
}

function subscribeFileReaderLayout(listener: () => void): () => void {
  fileReaderLayoutListeners.add(listener);
  return () => {
    fileReaderLayoutListeners.delete(listener);
  };
}

/** Records a thread's room for file links until the returned cleanup runs. */
export function reportFileReaderLayout(
  threadRef: ScopedThreadRef,
  layout: FileReaderLayout,
  owner: object = {},
): () => void {
  const key = scopedThreadKey(threadRef);
  fileReaderLayouts.set(key, { owner, layout });
  notifyFileReaderLayout();
  return () => {
    if (fileReaderLayouts.get(key)?.owner !== owner) return;
    fileReaderLayouts.delete(key);
    notifyFileReaderLayout();
  };
}

export function fileReaderLayoutFor(threadRef: ScopedThreadRef): FileReaderLayout | null {
  return fileReaderLayouts.get(scopedThreadKey(threadRef))?.layout ?? null;
}

/**
 * A conversation view reports the room it has, so a file link in it knows
 * whether the right panel would crowd the conversation or the reader (D-05).
 * Nothing is reported until the row has been measured.
 */
export function useFileReaderLayoutReport(
  threadRef: ScopedThreadRef | null,
  rowWidth: number | null,
  panelWidth: number,
  sheet: boolean,
  maximized: boolean,
): void {
  const [owner] = useState(() => ({}));
  const environmentId = threadRef?.environmentId;
  const threadId = threadRef?.threadId;
  useLayoutEffect(() => {
    if (environmentId === undefined || threadId === undefined || rowWidth === null) return;
    return reportFileReaderLayout(
      { environmentId, threadId },
      { rowWidth, panelWidth, sheet, maximized },
      owner,
    );
  }, [environmentId, maximized, owner, panelWidth, rowWidth, sheet, threadId]);
}

/** Where a file link in the thread opens now, kept current as its page resizes. */
export function useFileReaderPlacement(threadRef: ScopedThreadRef | null): FileReaderPlacement {
  const key = threadRef === null ? null : scopedThreadKey(threadRef);
  return useSyncExternalStore(
    subscribeFileReaderLayout,
    () => fileReaderPlacement(key === null ? null : fileReaderLayouts.get(key)?.layout),
    () => "focused",
  );
}

/**
 * The workspace file a link opened in the focused viewer, because beside the
 * conversation it would crowd one or the other (D-05). It keeps all the link
 * knew: Open in editor, Reveal, the places it was looked for.
 */
export const useFocusedFileStore = create<{
  readonly file: ViewerFileTarget | null;
  /** The link that opened it, for focus to return to. */
  readonly from: HTMLElement | null;
}>()(() => ({ file: null, from: null }));

const ACTIVATABLE = 'a[href], button, [role="button"], [role="link"], [tabindex]';
// An open this soon after a click is that click's, though it waited on a
// lookup first (a bare filename) and focus has moved since.
const CLICK_OPENS_WITHIN_MS = 5_000;

let lastClick: { readonly element: HTMLElement | null; readonly at: number } | null = null;

function activatedBy(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest(ACTIVATABLE);
  return element instanceof HTMLElement ? element : null;
}

function rememberClick(event: MouseEvent) {
  lastClick = { element: activatedBy(event.target), at: Date.now() };
}

// Mounted focused viewers. Without one (a shell with no overlay) a link opens
// its file in the panel as before rather than nowhere.
let focusedFileHosts = 0;

/**
 * Marks a focused viewer as mounted until the returned cleanup runs, so links
 * can open files in front. Meanwhile clicks are noted, so a link Safari
 * leaves unfocused is still known when its file opens after a lookup.
 */
export function hostFocusedFiles(): () => void {
  focusedFileHosts += 1;
  if (focusedFileHosts === 1 && typeof document !== "undefined")
    document.addEventListener("click", rememberClick, true);
  let hosted = true;
  return () => {
    if (!hosted) return;
    hosted = false;
    focusedFileHosts -= 1;
    if (focusedFileHosts > 0 || typeof document === "undefined") return;
    document.removeEventListener("click", rememberClick, true);
    lastClick = null;
  };
}

/** Marks the focused viewer as mounted while the calling component is. */
export function useFocusedFileHost(): void {
  useEffect(hostFocusedFiles, []);
}

function focusedElement(): HTMLElement | null {
  const focused = document.activeElement;
  return focused instanceof HTMLElement && focused !== document.body ? focused : null;
}

/**
 * What opened a file, read as it opens: the link being clicked, which Safari
 * leaves unfocused; what holds focus for a key; the frame whose page asked;
 * the link clicked just before, when the open waited on a lookup; else what
 * holds focus.
 */
function openingElement(): HTMLElement | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  const event = window.event;
  if (event?.type === "click" || event?.type === "auxclick") {
    const clicked = activatedBy(event.target);
    if (clicked !== null) return clicked;
  } else if (event?.type === "keydown") return focusedElement();
  if (event instanceof MessageEvent && event.source !== null) {
    const frame = Array.from(document.querySelectorAll("iframe")).find(
      (candidate) => candidate.contentWindow === event.source,
    );
    if (frame !== undefined) return frame;
  }
  if (lastClick?.element && Date.now() - lastClick.at <= CLICK_OPENS_WITHIN_MS)
    return lastClick.element;
  return focusedElement();
}

const RIGHT_PANEL = "[data-right-panel-tabbar], [data-right-panel-surface-content]";
// Layers that hand focus back on their own as they close.
const POPUP_LAYERS = [
  '[data-slot="dialog-popup"]',
  '[data-slot="alert-dialog-popup"]',
  '[data-slot="command-dialog-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");
const FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/**
 * An open that asked for the panel itself: from inside it (a file the reader
 * links to), from a menu or a dialog (its Open in panel), or from a field.
 */
function openerKeepsPanel(opener: HTMLElement): boolean {
  return opener.closest(`${RIGHT_PANEL}, ${POPUP_LAYERS}, ${FIELD}`) !== null;
}

/**
 * A link outside the panel hands focus to the file reader it opens, so Escape
 * closes it from there and focus comes back to the link.
 */
function readerTakesFocusFrom(opener: HTMLElement | null): opener is HTMLElement {
  return opener !== null && opener.isConnected && !openerKeepsPanel(opener);
}

/**
 * What held focus when each file tab opened: the link a reader clicked. Every
 * open makes a new surface object, so one entry names one open in one thread.
 */
const fileSurfaceOpenedFrom = new WeakMap<RightPanelSurface, HTMLElement>();

/**
 * The link a file tab was opened from, once. A tab shown again (a thread
 * revisited, the panel toggled back) is not an open and has none.
 */
export function takeFileSurfaceOpener(surface: RightPanelSurface): HTMLElement | undefined {
  const opener = fileSurfaceOpenedFrom.get(surface);
  fileSurfaceOpenedFrom.delete(surface);
  return opener;
}

function openInPanel(
  threadRef: ScopedThreadRef,
  target: ViewerFileTarget,
  opener: HTMLElement | null,
) {
  useRightPanelStore.getState().openFile(threadRef, target.path, target.line);
  if (!readerTakesFocusFrom(opener)) return;
  const thread = useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)];
  const opened = thread?.surfaces.find((surface) => surface.id === thread.activeSurfaceId);
  if (opened?.kind === "file") fileSurfaceOpenedFrom.set(opened, opener);
}

function opensFocused(
  threadRef: ScopedThreadRef,
  target: ViewerFileTarget,
  opener: HTMLElement | null,
): boolean {
  if (focusedFileHosts === 0 || target.path === ".") return false;
  if (opener !== null && openerKeepsPanel(opener)) return false;
  return fileReaderPlacement(fileReaderLayoutFor(threadRef)) === "focused";
}

/**
 * Opens a file where the reader sees it: in the overlay when it is in front;
 * else in the focused viewer when the right panel would leave the
 * conversation under 560 px or the reader under 480 px (D-05); else in the
 * thread's side panel. A file no thread owns (a link in a Library document)
 * opens only in the overlay: the panel and the focused viewer belong to a
 * thread. `opener` is the link that asked, when the caller has it; without it
 * the link is read now. Whatever else opens a file in the panel (the Files
 * tree, search, a menu, reopening a closed tab) calls the panel store itself
 * and opens it there.
 */
export function openFileInFront(target: ViewerFileTarget, opener?: HTMLElement | null): void {
  const overlay = useViewerOverlayStore.getState();
  if (overlay.active !== null) {
    overlay.showLinked({ kind: "file", file: target });
    return;
  }
  const { threadRef } = target;
  if (threadRef === null) return;
  const from = opener === undefined ? openingElement() : opener;
  if (opensFocused(threadRef, target, from)) {
    // The panel stays as it was, and nothing counts as the reader's choice there.
    useFocusedFileStore.setState({ file: target, from });
    return;
  }
  openInPanel(threadRef, target, from);
}

/**
 * Moves the focused file into the right panel, beside the conversation or as
 * the sheet, on request. The overlay closes, the reader takes focus, and
 * closing the tab returns focus to the link that first opened the file.
 */
export function moveFocusedFileToPanel(): void {
  const { file, from } = useFocusedFileStore.getState();
  if (file === null || file.threadRef === null) return;
  useFocusedFileStore.setState({ file: null, from: null });
  stepOutOfViewerOverlay();
  openInPanel(file.threadRef, file, from);
}

/**
 * Opens a pull request in the overlay when it is in front. Returns false when
 * the overlay is not open, so the caller opens it where it always has.
 */
export function openPullRequestInFront(target: ViewerPullRequestTarget): boolean {
  const overlay = useViewerOverlayStore.getState();
  if (overlay.active === null) return false;
  overlay.showLinked({ kind: "pull-request", pullRequest: target });
  return true;
}

/**
 * Closes the overlay so what opens next in the app (the in-app browser, a
 * panel the reader asked for) is in front instead of behind it.
 */
export function stepOutOfViewerOverlay(): void {
  const overlay = useViewerOverlayStore.getState();
  if (overlay.active !== null) overlay.close(overlay.active.key);
}

/** Moves a pull request from the overlay to the thread's side panel, which it reveals. */
export function openPullRequestInPanel(panel: NonNullable<ViewerPullRequestTarget["panel"]>): void {
  stepOutOfViewerOverlay();
  useRightPanelStore.getState().openPullRequest(panel.ref as ScopedThreadRef, panel.target);
}
