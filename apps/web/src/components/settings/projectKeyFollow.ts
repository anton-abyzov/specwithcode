import { createContext, useContext, useEffect } from "react";

/**
 * Settings remounts its page whenever the address changes. When a project's key changes
 * under an open dialog (a link gives it a shared identity), the page holds the address
 * update until the dialog closes, so the dialog can show its result.
 */
export const ProjectKeyFollowHold = createContext<(() => () => void) | null>(null);

export function useHoldProjectKeyFollow(active: boolean) {
  const hold = useContext(ProjectKeyFollowHold);
  useEffect(() => (active && hold ? hold() : undefined), [active, hold]);
}
