import { useSyncExternalStore } from "react";

/** The text being typed into a cell, kept out of the sheet's own state so typing redraws no grid. */
export interface SheetEditState {
  readonly text: string;
  readonly caret: number;
  /** The reference a click inserted while typing a formula; the next click replaces it. */
  readonly pointed: { readonly start: number; readonly end: number } | null;
}

export interface SheetEditStore {
  readonly get: () => SheetEditState;
  readonly set: (next: SheetEditState) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createSheetEditStore(): SheetEditStore {
  let state: SheetEditState = { text: "", caret: 0, pointed: null };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next) => {
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useSheetEditState(store: SheetEditStore): SheetEditState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
