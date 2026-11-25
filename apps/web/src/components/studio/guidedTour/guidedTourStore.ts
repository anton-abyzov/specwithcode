/**
 * Whether the guided tour is open, which step it shows and the page it
 * started on. Lives only in this window: nothing is saved, and the tour
 * never starts on its own (1486 D-07).
 */
import { useSyncExternalStore } from "react";

export interface GuidedTourState {
  readonly open: boolean;
  readonly index: number;
  /** Path, search and hash the tour returns to on Skip or Done. */
  readonly returnTo: string;
}

const CLOSED: GuidedTourState = { open: false, index: 0, returnTo: "/" };
let state: GuidedTourState = CLOSED;
const listeners = new Set<() => void>();

function set(next: GuidedTourState) {
  state = next;
  for (const listener of listeners) listener();
}

function currentLocation(): string {
  if (typeof window === "undefined") return "/";
  const { pathname, search, hash } = window.location;
  return `${pathname}${search}${hash}`;
}

export function startGuidedTour(): void {
  set({ open: true, index: 0, returnTo: currentLocation() });
}

export function showGuidedTourStep(index: number): void {
  if (state.open) set({ ...state, index });
}

/** Closes the tour and hands back where it started, for the host to navigate to. */
export function endGuidedTour(): string {
  const { returnTo } = state;
  set(CLOSED);
  return returnTo;
}

export function getGuidedTourState(): GuidedTourState {
  return state;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useGuidedTour(): GuidedTourState {
  return useSyncExternalStore(subscribe, getGuidedTourState, getGuidedTourState);
}
