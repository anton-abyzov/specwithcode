import type { EnvironmentId, PullRequestRef, ScopedThreadRef } from "@specweave-studio/contracts";
import { createContext, type ReactNode, useCallback, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";

/** One level of the header's trail: what it is and its name. */
export interface ViewerCrumb {
  readonly kind: string;
  readonly title: string;
}

/**
 * What the overlay shows: one viewer at a time, the thread it came from, and
 * the trail the overlay's one header reads as "where you are".
 */
export interface ViewerOverlayEntry {
  /** The viewer that owns the overlay; opening another replaces it. */
  readonly key: string;
  readonly title: string;
  /** What is open, in a word: "Report", "Video", "File". */
  readonly kind: string;
  /** A short type badge beside the title, such as "MD". */
  readonly badge: string | null;
  /** Quiet facts after the title: a date, a word count. */
  readonly detail: string | null;
  /** Shown beside the viewer, so the conversation stays in reach. */
  readonly threadRef: ScopedThreadRef | null;
  /** Where it was opened from when no thread names it, such as "Library". */
  readonly origin: string | null;
  /** Levels between the origin and the title, for something opened from inside a viewer. */
  readonly trail: ReadonlyArray<ViewerCrumb>;
  /** Steps back one level inside the viewer; null when there is nowhere to go back to. */
  readonly onBack: (() => void) | null;
}

export type ViewerOverlayDetails = Omit<ViewerOverlayEntry, "key" | "threadRef">;

/** A file a link inside the overlay points at, as the link resolved it. */
export interface ViewerFileTarget {
  readonly threadRef: ScopedThreadRef;
  /** The workspace the path is relative to; an absolute host path ignores it. */
  readonly cwd: string;
  readonly path: string;
  readonly line: number | undefined;
  /** Every path that was looked in, when the file was found in none of them. */
  readonly tried?: ReadonlyArray<string>;
  readonly openInEditor?: () => void;
  readonly reveal?: () => void;
  /** "Reveal in Finder" and the like, for `reveal`. */
  readonly revealLabel?: string;
}

/** A pull request a link inside the overlay points at. */
export interface ViewerPullRequestTarget {
  /** The server that reads it. */
  readonly environmentId: EnvironmentId;
  /** The thread it was opened beside, if any. */
  readonly threadRef: ScopedThreadRef | null;
  readonly reference: PullRequestRef;
  readonly url: string;
  /** Where "Open in panel" puts it; null when there is no panel to put it in. */
  readonly panel: {
    readonly ref: ScopedThreadRef;
    readonly target: {
      readonly environmentId?: string;
      readonly projectId: string;
      readonly host?: string;
      readonly repository: string;
      readonly number: number;
      readonly url?: string;
    };
  } | null;
}

/**
 * What a link inside the overlay opened. The overlay is in front of the app,
 * so a file or pull request the app would show in its side panel shows here,
 * in the viewer's place, with Back to the viewer, which stays mounted.
 */
export type ViewerLinkTarget =
  | { readonly kind: "file"; readonly file: ViewerFileTarget }
  | { readonly kind: "pull-request"; readonly pullRequest: ViewerPullRequestTarget };

interface ViewerOverlayState {
  readonly active: ViewerOverlayEntry | null;
  /** Where the active viewer renders its content. */
  readonly slot: HTMLElement | null;
  /** Where the active viewer renders its actions, in the overlay's header. */
  readonly actionsSlot: HTMLElement | null;
  /**
   * Where the thread beside the viewer shows its composer when the page
   * behind owns it (the coordinator's), so steering stays beside the viewer.
   */
  readonly threadComposerSlot: HTMLElement | null;
  /** Threads whose page owns their composer and lends it to the overlay, by `threadOwnerKey`. */
  readonly composerOwners: ReadonlyArray<string>;
  /** The source thread is folded away, so the viewer takes the whole overlay. */
  readonly threadCollapsed: boolean;
  /** A link target shown in the viewer's place; the viewer stays mounted behind it. */
  readonly linked: ViewerLinkTarget | null;
  /** Where focus was when the link opened, so Back can return it there. */
  readonly linkedFrom: HTMLElement | null;
  readonly open: (entry: ViewerOverlayEntry) => void;
  readonly update: (key: string, details: ViewerOverlayDetails) => void;
  readonly close: (key: string) => void;
  readonly setSlot: (slot: HTMLElement | null) => void;
  readonly setActionsSlot: (slot: HTMLElement | null) => void;
  readonly setThreadComposerSlot: (slot: HTMLElement | null) => void;
  readonly ownComposer: (threadKey: string) => () => void;
  readonly setThreadCollapsed: (collapsed: boolean) => void;
  readonly showLinked: (target: ViewerLinkTarget) => void;
  /** Back to the viewer: the link target goes and focus returns to the link. */
  readonly closeLinked: () => void;
}

/** What holds focus now, when there is a page to ask. */
function focusedElement(): HTMLElement | null {
  if (typeof document === "undefined" || typeof HTMLElement === "undefined") return null;
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

/** A thread's key among `composerOwners`. */
export function threadOwnerKey(threadRef: ScopedThreadRef): string {
  return `${threadRef.environmentId}:${threadRef.threadId}`;
}

export const useViewerOverlayStore = create<ViewerOverlayState>()((set) => ({
  active: null,
  slot: null,
  actionsSlot: null,
  threadComposerSlot: null,
  composerOwners: [],
  threadCollapsed: false,
  linked: null,
  linkedFrom: null,
  open: (entry) => set({ active: entry, linked: null, linkedFrom: null }),
  update: (key, details) =>
    set((state) =>
      state.active?.key === key ? { active: { ...state.active, ...details } } : state,
    ),
  close: (key) =>
    set((state) =>
      state.active?.key === key ? { active: null, linked: null, linkedFrom: null } : state,
    ),
  setSlot: (slot) => set({ slot }),
  setActionsSlot: (actionsSlot) => set({ actionsSlot }),
  setThreadComposerSlot: (threadComposerSlot) => set({ threadComposerSlot }),
  ownComposer: (threadKey) => {
    set((state) => ({ composerOwners: [...state.composerOwners, threadKey] }));
    return () =>
      set((state) => {
        const index = state.composerOwners.indexOf(threadKey);
        return index < 0 ? state : { composerOwners: state.composerOwners.toSpliced(index, 1) };
      });
  },
  setThreadCollapsed: (threadCollapsed) => set({ threadCollapsed }),
  showLinked: (linked) =>
    set((state) =>
      state.active === null
        ? state
        : {
            linked,
            // Stepping from one link target to another keeps the original link.
            linkedFrom: state.linked !== null ? state.linkedFrom : focusedElement(),
          },
    ),
  closeLinked: () =>
    set((state) => {
      const from = state.linkedFrom;
      if (from?.isConnected) requestAnimationFrame(() => from.focus({ preventScroll: true }));
      return { linked: null, linkedFrom: null };
    }),
}));

/** Where a viewer renders: its content, and its actions in the overlay's header. */
export interface ViewerOverlaySlots {
  readonly content: HTMLElement;
  /** Null until the header has mounted. */
  readonly actions: HTMLElement | null;
}

const NO_TRAIL: ReadonlyArray<ViewerCrumb> = [];

/** The header's type badge for a file name: its extension, such as "PNG". */
export function viewerExtensionBadge(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1, dot + 5).toUpperCase() : "FILE";
}

/**
 * Shows a viewer in the app's one overlay while `open` is true and returns
 * the elements to portal its content and actions into (null until the
 * overlay has them). The viewer keeps its own state and props; the overlay
 * frames it with one header: where you are, Back, the viewer's actions and
 * Close. When the overlay closes, or another viewer takes it, `onClose` runs.
 */
export function useViewerOverlay(options: {
  readonly open: boolean;
  readonly title: string;
  readonly kind?: string | undefined;
  readonly badge?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly threadRef?: ScopedThreadRef | null | undefined;
  readonly origin?: string | null | undefined;
  readonly trail?: ReadonlyArray<ViewerCrumb> | undefined;
  /** Steps back one level inside the viewer; the header shows Back while it is set. */
  readonly onBack?: (() => void) | null | undefined;
  readonly onClose: () => void;
}): ViewerOverlaySlots | null {
  const key = useId();
  const onCloseRef = useRef(options.onClose);
  onCloseRef.current = options.onClose;
  const onBackRef = useRef(options.onBack);
  onBackRef.current = options.onBack;
  const { open, title } = options;
  const kind = options.kind ?? "File";
  const badge = options.badge ?? null;
  const detail = options.detail ?? null;
  const origin = options.origin ?? null;
  const trail = options.trail ?? NO_TRAIL;
  const trailKey = JSON.stringify(trail);
  const canGoBack = Boolean(options.onBack);
  const threadRef = options.threadRef ?? null;
  const environmentId = threadRef?.environmentId;
  const threadId = threadRef?.threadId;
  const details = (): ViewerOverlayDetails => ({
    title,
    kind,
    badge,
    detail,
    origin,
    trail: trailKey === "[]" ? NO_TRAIL : (JSON.parse(trailKey) as ReadonlyArray<ViewerCrumb>),
    onBack: canGoBack ? () => onBackRef.current?.() : null,
  });
  const detailsRef = useRef(details);
  detailsRef.current = details;

  useEffect(() => {
    if (!open) return;
    const store = useViewerOverlayStore.getState();
    store.open({
      key,
      ...detailsRef.current(),
      threadRef:
        environmentId !== undefined && threadId !== undefined ? { environmentId, threadId } : null,
    });
    // The overlay closing, or another viewer taking it, closes this one.
    const unsubscribe = useViewerOverlayStore.subscribe((state, previous) => {
      if (previous.active?.key === key && state.active?.key !== key) onCloseRef.current();
    });
    return () => {
      unsubscribe();
      useViewerOverlayStore.getState().close(key);
    };
  }, [environmentId, key, open, threadId]);

  // A new title or trail changes the header in place; the overlay stays open.
  useEffect(() => {
    if (open) useViewerOverlayStore.getState().update(key, detailsRef.current());
  }, [badge, canGoBack, detail, key, kind, open, origin, title, trailKey]);

  const active = useViewerOverlayStore((state) => state.active?.key === key);
  const content = useViewerOverlayStore((state) => state.slot);
  const actions = useViewerOverlayStore((state) => state.actionsSlot);
  return open && active && content ? { content, actions } : null;
}

/**
 * Keys pressed while the viewer's content area itself has focus, as it does
 * when the overlay opens. A viewer's frame sits inside that area, so its own
 * key handler never sees them.
 */
export function useViewerContentKeys(
  content: HTMLElement | null,
  onKeyDown: (event: KeyboardEvent) => void,
): void {
  const handlerRef = useRef(onKeyDown);
  useEffect(() => {
    handlerRef.current = onKeyDown;
  });
  useEffect(() => {
    if (content === null) return;
    const listener = (event: KeyboardEvent) => {
      if (event.target === content && !event.defaultPrevented) handlerRef.current(event);
    };
    content.addEventListener("keydown", listener);
    return () => content.removeEventListener("keydown", listener);
  }, [content]);
}

/**
 * Paging remounts what held focus. The returned callback, run before a page
 * step, hands focus back to the content area afterwards so the next arrow
 * still pages instead of landing on the page body.
 */
export function useKeepViewerFocus(content: HTMLElement | null): () => void {
  return useCallback(() => {
    if (content === null || !content.contains(document.activeElement)) return;
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active === null || active === document.body || !active.isConnected)
        content.focus({ preventScroll: true });
    });
  }, [content]);
}

/**
 * True inside the overlay's thread. A thread view outside it stops taking
 * keys and pastes while the overlay is open: what is in front gets them.
 */
export const InViewerOverlay = createContext(false);

/**
 * A composer its page owns, moved beside the viewer while the overlay shows
 * that page's thread, and back when the overlay closes or folds the thread.
 * It stays the same composer, with its draft, attachments and send.
 */
export function ViewerThreadComposerPortal(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly children: ReactNode;
}): ReactNode {
  const environmentId = props.threadRef?.environmentId;
  const threadId = props.threadRef?.threadId;
  useEffect(() => {
    if (environmentId === undefined || threadId === undefined) return;
    return useViewerOverlayStore
      .getState()
      .ownComposer(threadOwnerKey({ environmentId, threadId }));
  }, [environmentId, threadId]);
  const target = useViewerOverlayStore((state) =>
    threadId !== undefined &&
    state.active?.threadRef?.environmentId === environmentId &&
    state.active?.threadRef?.threadId === threadId
      ? state.threadComposerSlot
      : null,
  );
  return target ? createPortal(props.children, target) : props.children;
}
