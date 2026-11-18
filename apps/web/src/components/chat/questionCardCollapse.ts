import * as Schema from "effect/Schema";
import { useCallback, useSyncExternalStore } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

/**
 * Threads whose question card the person folded to its one-line summary. The
 * choice belongs to the thread: it survives a reload and the next question in
 * that thread, and other threads keep their own.
 */
export const QUESTION_CARD_COLLAPSED_STORAGE_KEY = "studio:question-card-collapsed:v1";

/** Oldest entries fall off so the list cannot grow without bound. */
export const QUESTION_CARD_COLLAPSED_LIMIT = 200;

const CollapsedThreads = Schema.Array(Schema.String);

export function nextCollapsedThreads(
  current: ReadonlyArray<string>,
  key: string,
  collapsed: boolean,
): ReadonlyArray<string> {
  const rest = current.filter((entry) => entry !== key);
  if (!collapsed) return rest;
  return [...rest, key].slice(-QUESTION_CARD_COLLAPSED_LIMIT);
}

function readCollapsedThreads(): ReadonlyArray<string> {
  try {
    return getLocalStorageItem(QUESTION_CARD_COLLAPSED_STORAGE_KEY, CollapsedThreads) ?? [];
  } catch {
    return [];
  }
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another window of the app folding the same thread.
  const onStorage = (event: StorageEvent) => {
    if (event.key === QUESTION_CARD_COLLAPSED_STORAGE_KEY) listener();
  };
  const canListen = typeof window !== "undefined" && typeof window.addEventListener === "function";
  if (canListen) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (canListen) window.removeEventListener("storage", onStorage);
  };
}

export function setQuestionCardCollapsed(key: string, collapsed: boolean): void {
  try {
    setLocalStorageItem(
      QUESTION_CARD_COLLAPSED_STORAGE_KEY,
      nextCollapsedThreads(readCollapsedThreads(), key, collapsed),
      CollapsedThreads,
    );
  } catch (error) {
    console.error("[LOCALSTORAGE] Could not remember the folded question card.", error);
  }
  for (const listener of listeners) listener();
}

const subscribeNowhere = () => () => {};

/**
 * Whether the card for `key` is folded, and a setter. Without a key nothing is
 * stored or watched, and the host keeps its own fold.
 */
export function useQuestionCardCollapsed(
  key: string | undefined,
): readonly [boolean, ((collapsed: boolean) => void) | null] {
  const collapsed = useSyncExternalStore(
    key === undefined ? subscribeNowhere : subscribe,
    () => key !== undefined && readCollapsedThreads().includes(key),
    () => false,
  );
  const setCollapsed = useCallback(
    (next: boolean) => {
      if (key !== undefined) setQuestionCardCollapsed(key, next);
    },
    [key],
  );
  return key === undefined ? [false, null] : [collapsed, setCollapsed];
}
