/**
 * Pure parts of the Away dialog: which machine to preselect, how the plan's
 * rows group, and how each action and request state reads.
 */
import type {
  AwayAccessRequestResult,
  AwayMissingGrant,
  AwayPlan,
  AwayPlanAction,
  AwayPlanItem,
  AwayPlanItemKind,
  EnvironmentId,
} from "@specweave-studio/contracts";

import type { HandoffDestination } from "../handoff/HandoffResults";

/**
 * The remembered target when it can be chosen, else the first online machine
 * (D-04). This machine and offline machines are never preselected.
 */
export function defaultAwayTarget(
  destinations: readonly HandoffDestination[],
  remembered: EnvironmentId | null,
): EnvironmentId | null {
  const choosable = destinations.filter((destination) => destination.state === "reachable");
  if (remembered !== null && choosable.some((item) => item.environmentId === remembered))
    return remembered;
  return choosable[0]?.environmentId ?? null;
}

export interface AwayPlanGroup {
  readonly kind: AwayPlanItemKind;
  readonly title: string;
  readonly items: readonly AwayPlanItem[];
}

const GROUP_TITLES: Record<AwayPlanItemKind, string> = {
  thread: "Threads",
  routine: "Routines",
  coordinator: "Coordinators",
};

/** Rows grouped Threads, Routines, Coordinators; empty groups are left out. */
export function groupAwayPlan(plan: Pick<AwayPlan, "items">): AwayPlanGroup[] {
  return (["thread", "routine", "coordinator"] as const).flatMap((kind) => {
    const items = plan.items.filter((item) => item.kind === kind);
    return items.length === 0 ? [] : [{ kind, title: GROUP_TITLES[kind], items }];
  });
}

const ACTION_LABELS: Record<AwayPlanAction, string> = {
  move: "Moves",
  "handoff-ready": "Ready to move",
  stay: "Stays",
  pause: "Pauses",
};

export function awayActionLabel(action: AwayPlanAction): string {
  return ACTION_LABELS[action];
}

export type AwayActionTone = "ready" | "attention" | "muted";

export function awayActionTone(action: AwayPlanAction): AwayActionTone {
  return action === "move" ? "ready" : action === "handoff-ready" ? "attention" : "muted";
}

/** "3 move, 1 stays, 1 pauses": a one-line count of the plan. */
export function awayPlanSummary(plan: Pick<AwayPlan, "items">): string {
  const count = (action: AwayPlanAction) =>
    plan.items.filter((item) => item.action === action).length;
  const parts = [
    [count("move"), "move", "moves"],
    [count("handoff-ready"), "need a check", "needs a check"],
    [count("stay"), "stay", "stays"],
    [count("pause"), "pause", "pauses"],
  ] as const;
  const text = parts
    .filter(([n]) => n > 0)
    .map(([n, many, one]) => `${n} ${n === 1 ? one : many}`)
    .join(", ");
  return text === "" ? "Nothing here needs to move." : text;
}

/** Whether a missing item is for the target to grant (a request covers it) or a step here. */
export function missingIsOnTarget(
  item: Pick<AwayMissingGrant, "machineEnvironmentId">,
  targetEnvironmentId: EnvironmentId,
): boolean {
  return item.machineEnvironmentId === targetEnvironmentId;
}

/** "Request access" is offered when the target has something to approve. */
export function canRequestAccess(plan: Pick<AwayPlan, "missingGrants" | "targetEnvironmentId">) {
  return plan.missingGrants.some((item) => missingIsOnTarget(item, plan.targetEnvironmentId));
}

/** The line under the Request access button. */
export function accessRequestText(
  result: AwayAccessRequestResult | null,
  targetLabel: string,
): string | null {
  if (result === null) return null;
  switch (result.status) {
    case "sent":
    case "already-pending":
      return `Waiting for approval on ${targetLabel}. Open Settings > Machines there to approve.`;
    case "approved":
      return `${targetLabel} approved. Checking again.`;
    case "declined":
      return `${targetLabel} declined the request.`;
  }
}

/** How often the dialog asks the target about a pending request. */
export const AWAY_ACCESS_POLL_MS = 10_000;

/** A request still waiting on the target's owner. */
export function isAccessPending(result: AwayAccessRequestResult | null): boolean {
  return result !== null && (result.status === "sent" || result.status === "already-pending");
}
