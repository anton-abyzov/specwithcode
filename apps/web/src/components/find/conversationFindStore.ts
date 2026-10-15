import { useSyncExternalStore } from "react";

export interface ConversationFindState {
  readonly query: string;
  readonly scope: HTMLElement | null;
}

const CLOSED: ConversationFindState = { query: "", scope: null };
let state: ConversationFindState = CLOSED;
const listeners = new Set<() => void>();

export function setConversationFindState(next: ConversationFindState): void {
  if (next.query === state.query && next.scope === state.scope) return;
  state = next.scope === null ? CLOSED : next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ConversationFindState {
  return state;
}

/**
 * The open find query when it targets `scope`, so a virtualized list can keep its matching
 * rows mounted for the find bar to highlight; "" otherwise.
 */
export function useConversationFindQuery(scope: HTMLElement | null): string {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return scope !== null && current.scope === scope ? current.query.trim() : "";
}
