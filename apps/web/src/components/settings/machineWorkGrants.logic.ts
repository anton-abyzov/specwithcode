import type {
  StudioWorkGrant,
  StudioWorkGrantAccounts,
  StudioWorkGrantsSnapshot,
} from "@specweave-studio/contracts/studioFleet";

/** Words for "Who can run work here", shared by its section and the machine rows. */

export function formatTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * A coordinator's name for this screen: a name this app knows for that
 * machine (its nickname above all), else the server's label, else a short
 * id. The server sends the bare environment id when it knows no name.
 */
export function workGrantMachineLabel(
  grant: Pick<StudioWorkGrant, "coordinatorEnvironmentId" | "machineLabel">,
  knownName?: (environmentId: string) => string | null | undefined,
): string {
  const id = grant.coordinatorEnvironmentId;
  const known = knownName?.(id)?.trim();
  if (known && known !== id) return known;
  const label = grant.machineLabel.trim();
  if (label !== "" && label !== id) return label;
  return `Machine ${id.slice(0, 8)}`;
}

/** The snapshot with every coordinator named by {@link workGrantMachineLabel}. */
export function withReadableGrantLabels(
  snapshot: StudioWorkGrantsSnapshot | null,
  knownName?: (environmentId: string) => string | null | undefined,
): StudioWorkGrantsSnapshot | null {
  if (snapshot === null) return null;
  return {
    ...snapshot,
    grants: snapshot.grants.map((grant) => {
      const machineLabel = workGrantMachineLabel(grant, knownName);
      return machineLabel === grant.machineLabel ? grant : { ...grant, machineLabel };
    }),
  };
}

type WorkGrantProjectUnavailable = NonNullable<
  StudioWorkGrantsSnapshot["projects"][number]["unavailable"]
>;

const UNAVAILABLE_NOTES: Record<WorkGrantProjectUnavailable, string> = {
  scratch: "folder for chats, uncheck to remove",
  archived: "archived, uncheck to remove",
  automated: "automated, uncheck to remove",
};

/** What a "Chosen projects" row says beside a project it keeps but no longer offers. */
export function workGrantUnavailableNote(reason: WorkGrantProjectUnavailable): string {
  return UNAVAILABLE_NOTES[reason];
}

/** A project's name in a grant summary, with why it is not offered when it is not. */
function summaryTitle(project: StudioWorkGrantsSnapshot["projects"][number]): string {
  if (project.unavailable === "scratch") return "No project folder (chats)";
  return project.unavailable === "archived" || project.unavailable === "automated"
    ? `${project.title} (${project.unavailable})`
    : project.title;
}

/** One line on which projects a coordinator may run work in. */
export function workGrantProjectsSummary(
  grant: Pick<StudioWorkGrant, "projects" | "coordinatorEnvironmentId" | "machineLabel">,
  projects: StudioWorkGrantsSnapshot["projects"],
  /** The machine could not read its projects (`projectsUnreadable`). */
  projectsUnreadable = false,
): string {
  switch (grant.projects.kind) {
    case "all":
      return "All projects";
    case "linked": {
      if (projectsUnreadable)
        return `Projects linked to ${grant.machineLabel} (could not read this machine's projects)`;
      // Every project linked to it, archived or automated ones included: the grant still covers them.
      const linked = projects.filter((project) =>
        project.linkedTo.includes(grant.coordinatorEnvironmentId),
      );
      return linked.length === 0
        ? `Projects linked to ${grant.machineLabel} (none yet)`
        : `Projects linked to ${grant.machineLabel}: ${linked.map(summaryTitle).join(", ")}`;
    }
    case "listed": {
      const count = grant.projects.projectIds.length;
      // The grant keeps its choices when the machine could not read its projects.
      if (projectsUnreadable && count > 0)
        return `${count} chosen ${count === 1 ? "project" : "projects"} (could not read this machine's projects)`;
      // An id the snapshot no longer lists (a deleted project, the assistant) covers nothing.
      const titles = grant.projects.projectIds.flatMap((id) => {
        const project = projects.find((candidate) => candidate.id === id);
        return project ? [summaryTitle(project)] : [];
      });
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

/**
 * This machine's sign-ins in the order the picker shows them: signed-in ones
 * first, then the rest, each group in the server's order. A chosen sign-in the
 * machine no longer lists is kept, so it can still be cleared.
 */
export function signInChoices(
  available: StudioWorkGrantsSnapshot["accounts"],
  chosen: ReadonlyArray<string> = [],
): StudioWorkGrantsSnapshot["accounts"] {
  const known = new Set<string>(available.map((account) => account.instanceId));
  const gone = chosen
    .filter((id) => !known.has(id))
    .map((id): StudioWorkGrantsSnapshot["accounts"][number] => ({
      instanceId: id as StudioWorkGrantsSnapshot["accounts"][number]["instanceId"],
      label: id,
      driver: "",
      account: null,
    }));
  return [
    ...available.filter((account) => account.signedIn !== false),
    ...available.filter((account) => account.signedIn === false),
    ...gone,
  ];
}

export interface WorkGrantHopStop {
  readonly label: string;
  /** sender: where the work starts. here: this machine. onward: a further machine. blocked: not allowed. */
  readonly kind: "sender" | "here" | "onward" | "blocked";
}

/**
 * How far work from a machine may travel, as stops and one plain sentence.
 * The hop limit counts machines after the sender: 1 ends here, 2 lets the work
 * it starts here start work on one more machine.
 */
export function workGrantHopPath(grant: Pick<StudioWorkGrant, "machineLabel" | "hopLimit">): {
  readonly stops: ReadonlyArray<WorkGrantHopStop>;
  readonly text: string;
} {
  const further = Math.max(0, grant.hopLimit - 1);
  const sender: WorkGrantHopStop = { label: grant.machineLabel, kind: "sender" };
  const here: WorkGrantHopStop = { label: "This machine", kind: "here" };
  if (further === 0)
    return {
      stops: [sender, here, { label: "Another machine", kind: "blocked" }],
      text: `Work ${grant.machineLabel} starts here stays here: it cannot start work on another machine from this one.`,
    };
  return {
    stops: [
      sender,
      here,
      { label: further === 1 ? "1 more machine" : `${further} more machines`, kind: "onward" },
    ],
    text: `Work ${grant.machineLabel} starts here may itself start work on ${further === 1 ? "one more machine" : `${further} more machines`}, and no further. It can never loop back to ${grant.machineLabel}.`,
  };
}

/**
 * What the Routines switch does in its current position. Starting work and
 * managing schedules are separate permissions: the switch covers only the
 * schedules, and only in the projects the grant already covers.
 */
export function workGrantRoutinesNote(
  grant: Pick<StudioWorkGrant, "machineLabel" | "routines">,
): string {
  return grant.routines
    ? `On: agents on ${grant.machineLabel} may create, change, run and delete scheduled routines on this machine, in the projects chosen above. Turn it off to let them start work here but leave the schedules alone.`
    : `Off: agents on ${grant.machineLabel} can start work here, but cannot create, change, run or delete scheduled routines on this machine. Turn it on if ${grant.machineLabel} should set up recurring work here.`;
}

/**
 * Where the access limit comes from and what it caps. It is read-only here:
 * the sending machine chose it when it allowed workers on this one.
 */
export function workGrantAccessNote(
  grant: Pick<StudioWorkGrant, "machineLabel" | "runtimeCap">,
): string {
  return grant.runtimeCap === null
    ? `${grant.machineLabel} sets it the next time it starts work here. It is the most a thread it starts here may do without asking.`
    : `The most a thread ${grant.machineLabel} starts here may do without asking. A thread can run with less, never more. Chosen on ${grant.machineLabel}, under Allow workers for this machine; change it there.`;
}
