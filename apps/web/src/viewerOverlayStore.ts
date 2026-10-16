import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { useEffect, useId, useRef } from "react";
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

interface ViewerOverlayState {
  readonly active: ViewerOverlayEntry | null;
  /** Where the active viewer renders its content. */
  readonly slot: HTMLElement | null;
  /** Where the active viewer renders its actions, in the overlay's header. */
  readonly actionsSlot: HTMLElement | null;
  /** The source thread is folded away, so the viewer takes the whole overlay. */
  readonly threadCollapsed: boolean;
  readonly open: (entry: ViewerOverlayEntry) => void;
  readonly update: (key: string, details: ViewerOverlayDetails) => void;
  readonly close: (key: string) => void;
  readonly setSlot: (slot: HTMLElement | null) => void;
  readonly setActionsSlot: (slot: HTMLElement | null) => void;
  readonly setThreadCollapsed: (collapsed: boolean) => void;
}

export const useViewerOverlayStore = create<ViewerOverlayState>()((set) => ({
  active: null,
  slot: null,
  actionsSlot: null,
  threadCollapsed: false,
  open: (entry) => set({ active: entry }),
  update: (key, details) =>
    set((state) =>
      state.active?.key === key ? { active: { ...state.active, ...details } } : state,
    ),
  close: (key) => set((state) => (state.active?.key === key ? { active: null } : state)),
  setSlot: (slot) => set({ slot }),
  setActionsSlot: (actionsSlot) => set({ actionsSlot }),
  setThreadCollapsed: (threadCollapsed) => set({ threadCollapsed }),
}));

/** Where a viewer renders: its content, and its actions in the overlay's header. */
export interface ViewerOverlaySlots {
  readonly content: HTMLElement;
  /** Null until the header has mounted. */
  readonly actions: HTMLElement | null;
}

const NO_TRAIL: ReadonlyArray<ViewerCrumb> = [];

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
