import { createContext } from "react";

/**
 * Lets a project's move dialog keep its page on screen while it is open; null outside a
 * project page. Called with true when the dialog opens and false when it closes or unmounts.
 */
export const MoveDialogHold = createContext<((open: boolean) => void) | null>(null);
