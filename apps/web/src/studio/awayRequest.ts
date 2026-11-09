/**
 * Opens the Away dialog from any entry point: `/away` or `/back` in a
 * composer, the command palette, the keyboard shortcut, the desktop menu and
 * the tray. The dialog reads the request; every entry point only asks.
 */
import { DESKTOP_AWAY_BACK_ACTION, DESKTOP_AWAY_START_ACTION } from "@specweave-studio/contracts";
import { create } from "zustand";

export type AwayIntent = "away" | "back";

const useAwayRequestStore = create<{ intent: AwayIntent | null }>(() => ({ intent: null }));

/** Opens the Away dialog to leave this machine (`away`) or bring work back (`back`). */
export function requestAway(intent: AwayIntent) {
  useAwayRequestStore.setState({ intent });
}

const close = () => useAwayRequestStore.setState({ intent: null });

/** Whether the Away dialog is open, for which intent, and how to close it. */
export function useAwayRequest(): {
  readonly open: boolean;
  readonly intent: AwayIntent;
  readonly close: () => void;
} {
  const intent = useAwayRequestStore((state) => state.intent);
  return { open: intent !== null, intent: intent ?? "away", close };
}

/** The current request outside React, for tests and non-component callers. */
export function readAwayRequest(): AwayIntent | null {
  return useAwayRequestStore.getState().intent;
}

/** The Away intent a desktop menu or tray action asks for, or null for any other action. */
export function awayIntentForMenuAction(action: string): AwayIntent | null {
  if (action === DESKTOP_AWAY_START_ACTION) return "away";
  if (action === DESKTOP_AWAY_BACK_ACTION) return "back";
  return null;
}
