import {
  parseScopedThreadKey,
  scopedThreadKey,
} from "@specweave-studio/client-runtime/environment";
import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { useEffect } from "react";

import { useRightPanelStore } from "../rightPanelStore";

// How many mounted thread views show each thread. A thread can be on screen twice
// for a moment (a remount, or StrictMode's dev double effect), and only the last
// view to leave hides its panel.
const viewersByThreadKey = new Map<string, number>();

function leave(threadKey: string) {
  const remaining = (viewersByThreadKey.get(threadKey) ?? 1) - 1;
  if (remaining > 0) {
    viewersByThreadKey.set(threadKey, remaining);
    return;
  }
  viewersByThreadKey.delete(threadKey);
  // Deferred past the commit, so a view that mounts the same thread in the same
  // commit (or StrictMode's immediate re-run) keeps the panel as it is.
  queueMicrotask(() => {
    const threadRef = parseScopedThreadKey(threadKey);
    if (viewersByThreadKey.has(threadKey) || threadRef === null) return;
    useRightPanelStore.getState().hideOnLeave(threadRef);
  });
}

/**
 * Arriving at a thread never shows its right panel: leaving the thread view, by
 * switching threads or unmounting, hides it again. The panel's tabs stay, so one
 * toggle brings them back. Opening a surface while on the thread still shows it.
 */
export function useHideRightPanelOnLeave(threadRef: ScopedThreadRef | null): void {
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  // Keyed on the thread, not the ref object: a new ref for the same thread is not a visit.
  useEffect(() => {
    if (threadKey === null) return;
    viewersByThreadKey.set(threadKey, (viewersByThreadKey.get(threadKey) ?? 0) + 1);
    return () => leave(threadKey);
  }, [threadKey]);
}
