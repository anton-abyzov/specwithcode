import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { useEffect, useId, useRef } from "react";
import { create } from "zustand";

/** What the overlay shows: one viewer at a time, and the thread it came from. */
export interface ViewerOverlayEntry {
  /** The viewer that owns the overlay; opening another replaces it. */
  readonly key: string;
  readonly title: string;
  /** Shown beside the viewer, so the conversation stays in reach. */
  readonly threadRef: ScopedThreadRef | null;
}

interface ViewerOverlayState {
  readonly active: ViewerOverlayEntry | null;
  /** Where the active viewer renders its content. */
  readonly slot: HTMLElement | null;
  /** The source thread is folded away, so the viewer takes the whole overlay. */
  readonly threadCollapsed: boolean;
  readonly open: (entry: ViewerOverlayEntry) => void;
  readonly close: (key: string) => void;
  readonly setSlot: (slot: HTMLElement | null) => void;
  readonly setThreadCollapsed: (collapsed: boolean) => void;
}

export const useViewerOverlayStore = create<ViewerOverlayState>()((set) => ({
  active: null,
  slot: null,
  threadCollapsed: false,
  open: (entry) => set({ active: entry }),
  close: (key) => set((state) => (state.active?.key === key ? { active: null } : state)),
  setSlot: (slot) => set({ slot }),
  setThreadCollapsed: (threadCollapsed) => set({ threadCollapsed }),
}));

/**
 * Shows a viewer in the app's one overlay while `open` is true and returns
 * the element to portal its content into (null until the overlay has it).
 * The viewer keeps its own state and props; the overlay only frames it.
 * When the overlay closes, or another viewer takes it, `onClose` runs.
 */
export function useViewerOverlay(options: {
  readonly open: boolean;
  readonly title: string;
  readonly threadRef?: ScopedThreadRef | null | undefined;
  readonly onClose: () => void;
}): HTMLElement | null {
  const key = useId();
  const onCloseRef = useRef(options.onClose);
  onCloseRef.current = options.onClose;
  const { open, title } = options;
  const threadRef = options.threadRef ?? null;
  const environmentId = threadRef?.environmentId;
  const threadId = threadRef?.threadId;

  useEffect(() => {
    if (!open) return;
    const store = useViewerOverlayStore.getState();
    store.open({
      key,
      title,
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
  }, [environmentId, key, open, threadId, title]);

  const active = useViewerOverlayStore((state) => state.active?.key === key);
  const slot = useViewerOverlayStore((state) => state.slot);
  return open && active ? slot : null;
}
