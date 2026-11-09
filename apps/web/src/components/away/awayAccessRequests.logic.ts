import type { AwayAccessRequestRecord } from "@specweave-studio/contracts";

/** Requests still waiting for the owner, oldest first. */
export function pendingAccessRequests(
  requests: readonly AwayAccessRequestRecord[],
): AwayAccessRequestRecord[] {
  return requests
    .filter((request) => request.status === "pending")
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** What Approve changes here, in one line, and what it leaves to do by hand. */
export function requestChangeSummary(request: AwayAccessRequestRecord): string {
  const changes: string[] = [];
  if (request.changes.routines === true) changes.push("lets its coordinator manage routines");
  const projects = request.changes.addProjectIds?.length ?? 0;
  if (projects > 0)
    changes.push(`adds ${projects} project${projects === 1 ? "" : "s"} to its grant`);
  const manual = request.missing.filter(
    (item) => item.kind !== "routines" && item.kind !== "work-grant",
  ).length;
  const applied =
    changes.length === 0 ? "Approve changes nothing here." : `Approve ${changes.join(" and ")}.`;
  return manual === 0
    ? applied
    : `${applied} ${manual === 1 ? "1 step still needs" : `${manual} steps still need`} doing by hand.`;
}
