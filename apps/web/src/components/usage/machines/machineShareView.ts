/** The shared Machines view model, with days in the viewer's own time zone. */
import { zonedDay, zonedDayStart } from "@specweave-studio/shared/usageMachineShareView";

export * from "@specweave-studio/shared/usageMachineShareView";

export const VIEWER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** The viewer's own calendar day an instant falls on, `YYYY-MM-DD`. */
export function localDay(atMs: number): string {
  return zonedDay(atMs, VIEWER_TIME_ZONE);
}

/** Midnight that starts a calendar day where the viewer is. */
export function localDayStart(day: string): number {
  return zonedDayStart(day, VIEWER_TIME_ZONE);
}
