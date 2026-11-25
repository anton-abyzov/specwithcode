/**
 * Whether the guided tour is open, which step it shows and the page it
 * started on. Lives only in this window: nothing is saved, and the tour
 * never starts on its own (1486 D-07).
 */
import { useSyncExternalStore } from "react";

import {
  getMainAppHref,
  isSidebarUtilityPage,
  setMainAppHref,
} from "../../sidebar/mainAppLocation";

export interface GuidedTourState {
  readonly open: boolean;
  readonly index: number;
  /** Path, search and hash the tour returns to on Skip or Done. */
  readonly returnTo: string;
  /** Where closing Settings went before the tour visited Overview. */
  readonly mainAppHref: string | null;
}

const CLOSED: GuidedTourState = { open: false, index: 0, returnTo: "/", mainAppHref: null };
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
  set({ open: true, index: 0, returnTo: currentLocation(), mainAppHref: getMainAppHref() });
}

export function showGuidedTourStep(index: number): void {
  if (state.open) set({ ...state, index });
}

/**
 * Closes the tour and hands back where it started, for the host to navigate to. Visiting
 * Overview on the way made it the place Settings closes to, so that is put back too.
 */
export function endGuidedTour(): string {
  const { returnTo, mainAppHref, open } = state;
  if (open) setMainAppHref(mainAppHref);
  set(CLOSED);
  return returnTo;
}

/**
 * The person left the tour with browser Back or Forward: it closes where they are and writes no
 * history. On a main app page the app has already recorded that page as where Settings closes to,
 * so only a utility page (Settings and the like) gets the pre-tour value back.
 */
export function leaveGuidedTour(): void {
  const { mainAppHref, open } = state;
  if (open && typeof window !== "undefined" && isSidebarUtilityPage(window.location.pathname)) {
    setMainAppHref(mainAppHref);
  }
  set(CLOSED);
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
