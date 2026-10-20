import type {
  StudioWorkGrant,
  StudioWorkGrantAccounts,
  StudioWorkGrantsSnapshot,
} from "@specweave-studio/contracts/studioFleet";

/** Words for "Who can run work on this Mac", shared by its section and the machine rows. */

export function formatTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** One line on which projects a coordinator may run work in. */
export function workGrantProjectsSummary(
  grant: Pick<StudioWorkGrant, "projects" | "coordinatorEnvironmentId" | "machineLabel">,
  projects: StudioWorkGrantsSnapshot["projects"],
): string {
  switch (grant.projects.kind) {
    case "all":
      return "All projects";
    case "linked": {
      const linked = projects.filter((project) =>
        project.linkedTo.includes(grant.coordinatorEnvironmentId),
      );
      return linked.length === 0
        ? `Projects linked to ${grant.machineLabel} (none yet)`
        : `Projects linked to ${grant.machineLabel}: ${linked.map((project) => project.title).join(", ")}`;
    }
    case "listed": {
      const titles = grant.projects.projectIds.map(
        (id) => projects.find((project) => project.id === id)?.title ?? id,
      );
      return titles.length === 0 ? "No projects" : titles.join(", ");
    }
  }
}

/** One line on which of this machine's sign-ins its work may use. */
export function workGrantAccountsSummary(
  accounts: StudioWorkGrantAccounts,
  available: StudioWorkGrantsSnapshot["accounts"],
): string {
  switch (accounts.kind) {
    case "all":
      return "All sign-ins on this machine";
    case "none":
      return "No sign-ins: every launch is refused";
    case "listed": {
      const labels = accounts.instanceIds.map((id) => {
        const account = available.find((candidate) => candidate.instanceId === id);
        return account ? accountLabel(account) : id;
      });
      return labels.length === 0 ? "No sign-ins: every launch is refused" : labels.join(", ");
    }
  }
}

export function accountLabel(account: StudioWorkGrantsSnapshot["accounts"][number]): string {
  return account.account ? `${account.label} (${account.account})` : account.label;
}

/** The status line: active until a date, revoked with its grace, or lapsed. */
export function workGrantStatus(grant: StudioWorkGrant): string {
  const running =
    grant.runningThreads === 0
      ? null
      : `${grant.runningThreads} running thread${grant.runningThreads === 1 ? "" : "s"}`;
  if (grant.status === "revoked")
    return [
      `Revoked${grant.revokedAt ? ` ${formatTime(grant.revokedAt)}` : ""}. New work is refused`,
      grant.interruptAt && running ? `${running} stop at ${formatTime(grant.interruptAt)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const parts = [
    grant.status === "expired"
      ? "Expired: that machine must allow workers here again"
      : grant.expiresAt
        ? `Active until ${formatTime(grant.expiresAt)}`
        : "Active",
    running,
  ];
  return parts.filter(Boolean).join(" · ");
}
