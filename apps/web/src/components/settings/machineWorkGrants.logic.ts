import type {
  StudioWorkGrant,
  StudioWorkGrantAccounts,
  StudioWorkGrantDuration,
  StudioWorkGrantsSnapshot,
} from "@specweave-studio/contracts/studioFleet";
import { englishPhrase, type TranslatePhrase } from "../../i18n";
import { FLEET_WORKER_ACCESS_CHOICES } from "../../studio/fleetWorkers";

/**
 * Words for "Who can run work here", shared by its section and the machine rows.
 * Each takes the screen's `tx` last; without one it says it in English.
 */

/** The time limits an Allow offers, in the order shown; one week is the default. */
export const WORK_GRANT_DURATION_CHOICES = [
  { value: "1h", label: "1 hour" },
  { value: "1d", label: "1 day" },
  { value: "7d", label: "1 week" },
  { value: "until-stopped", label: "Until I stop it" },
] as const satisfies ReadonlyArray<{
  readonly value: StudioWorkGrantDuration;
  readonly label: string;
}>;

export const DEFAULT_WORK_GRANT_DURATION: StudioWorkGrantDuration = "7d";

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
export function workGrantUnavailableNote(
  reason: WorkGrantProjectUnavailable,
  tx: TranslatePhrase = englishPhrase,
): string {
  return tx(UNAVAILABLE_NOTES[reason]);
}

/** A project's name in a grant summary, with why it is not offered when it is not. */
function summaryTitle(
  project: StudioWorkGrantsSnapshot["projects"][number],
  tx: TranslatePhrase,
): string {
  if (project.unavailable === "scratch") return tx("No project folder (chats)");
  if (project.unavailable === "archived") return tx("{title} (archived)", { title: project.title });
  if (project.unavailable === "automated")
    return tx("{title} (automated)", { title: project.title });
  return project.title;
}

/** One line on which projects a coordinator may run work in. */
export function workGrantProjectsSummary(
  grant: Pick<StudioWorkGrant, "projects" | "coordinatorEnvironmentId" | "machineLabel">,
  projects: StudioWorkGrantsSnapshot["projects"],
  /** The machine could not read its projects (`projectsUnreadable`). */
  projectsUnreadable = false,
  tx: TranslatePhrase = englishPhrase,
): string {
  const machine = grant.machineLabel;
  switch (grant.projects.kind) {
    case "all":
      return tx("All projects");
    case "linked": {
      if (projectsUnreadable)
        return tx("Projects linked to {machine} (could not read this machine's projects)", {
          machine,
        });
      // Every project linked to it, archived or automated ones included: the grant still covers them.
      const linked = projects.filter((project) =>
        project.linkedTo.includes(grant.coordinatorEnvironmentId),
      );
      return linked.length === 0
        ? tx("Projects linked to {machine} (none yet)", { machine })
        : tx("Projects linked to {machine}: {projects}", {
            machine,
            projects: linked.map((project) => summaryTitle(project, tx)).join(", "),
          });
    }
    case "listed": {
      const count = grant.projects.projectIds.length;
      // The grant keeps its choices when the machine could not read its projects.
      if (projectsUnreadable && count > 0)
        return count === 1
          ? tx("1 chosen project (could not read this machine's projects)")
          : tx("{count} chosen projects (could not read this machine's projects)", { count });
      // An id the snapshot no longer lists (a deleted project, the assistant) covers nothing.
      const titles = grant.projects.projectIds.flatMap((id) => {
        const project = projects.find((candidate) => candidate.id === id);
        return project ? [summaryTitle(project, tx)] : [];
      });
      return titles.length === 0 ? tx("No projects") : titles.join(", ");
    }
  }
}

/**
 * True when the grant lets its machine start work in no project here: linked
 * with none linked yet, or chosen with nothing chosen. Unknown when the
 * machine could not read its projects, so false then.
 */
export function workGrantAllowsNoProject(
  grant: Pick<StudioWorkGrant, "projects" | "coordinatorEnvironmentId" | "status">,
  snapshot: Pick<StudioWorkGrantsSnapshot, "projects" | "projectsUnreadable">,
): boolean {
  if (grant.status === "revoked" || snapshot.projectsUnreadable === true) return false;
  if (grant.projects.kind === "linked")
    return !snapshot.projects.some((project) =>
      project.linkedTo.includes(grant.coordinatorEnvironmentId),
    );
  if (grant.projects.kind === "listed")
    return !grant.projects.projectIds.some((id) =>
      snapshot.projects.some((project) => project.id === id),
    );
  return false;
}

/** The access ceiling's own name ("Full access"), or null before the sender set one. */
export function workGrantAccessName(
  grant: Pick<StudioWorkGrant, "runtimeCap">,
  tx: TranslatePhrase = englishPhrase,
): string | null {
  if (grant.runtimeCap === null) return null;
  const label = FLEET_WORKER_ACCESS_CHOICES.find(
    (choice) => choice.value === grant.runtimeCap,
  )?.label;
  return label === undefined ? grant.runtimeCap : tx(label);
}

/**
 * The grant card's one line: projects, sign-ins, access and how long it lasts,
 * e.g. "All projects, All sign-ins, up to Full access, renews automatically".
 * A revoked or expired grant says only that, as its status line does.
 */
export function workGrantSummary(
  grant: StudioWorkGrant,
  snapshot: Pick<StudioWorkGrantsSnapshot, "projects" | "accounts" | "projectsUnreadable">,
  tx: TranslatePhrase = englishPhrase,
): string {
  if (grant.status !== "active") return workGrantStatus(grant, tx);
  const projects = workGrantAllowsNoProject(grant, snapshot)
    ? null
    : grant.projects.kind === "linked"
      ? tx("Linked projects")
      : workGrantProjectsSummary(
          grant,
          snapshot.projects,
          snapshot.projectsUnreadable === true,
          tx,
        );
  const accounts =
    grant.accounts.kind === "all"
      ? tx("All sign-ins")
      : grant.accounts.kind === "none" || grant.accounts.instanceIds.length === 0
        ? tx("No sign-ins")
        : grant.accounts.instanceIds
            .map(
              (id) => snapshot.accounts.find((account) => account.instanceId === id)?.label ?? id,
            )
            .join(", ");
  const access = workGrantAccessName(grant, tx);
  const lasts = grant.endsAt
    ? tx("until {date}", { date: formatTime(grant.endsAt) })
    : grant.renews === true
      ? tx("renews automatically")
      : grant.expiresAt
        ? tx("until {date}", { date: formatTime(grant.expiresAt) })
        : null;
  const running =
    grant.runningThreads === 0
      ? null
      : grant.runningThreads === 1
        ? tx("1 running thread")
        : tx("{count} running threads", { count: grant.runningThreads });
  return [projects, accounts, access ? tx("up to {access}", { access }) : null, lasts, running]
    .filter((part): part is string => part !== null)
    .join(", ");
}

/** One line on which of this machine's sign-ins its work may use. */
export function workGrantAccountsSummary(
  accounts: StudioWorkGrantAccounts,
  available: StudioWorkGrantsSnapshot["accounts"],
  tx: TranslatePhrase = englishPhrase,
): string {
  switch (accounts.kind) {
    case "all":
      return tx("All sign-ins on this machine");
    case "none":
      return tx("No sign-ins: every launch is refused");
    case "listed": {
      const labels = accounts.instanceIds.map((id) => {
        const account = available.find((candidate) => candidate.instanceId === id);
        return account ? accountLabel(account) : id;
      });
      return labels.length === 0 ? tx("No sign-ins: every launch is refused") : labels.join(", ");
    }
  }
}

export function accountLabel(account: StudioWorkGrantsSnapshot["accounts"][number]): string {
  return account.account ? `${account.label} (${account.account})` : account.label;
}

/** The status line: active until a date, revoked with its grace, or lapsed. */
export function workGrantStatus(
  grant: StudioWorkGrant,
  tx: TranslatePhrase = englishPhrase,
): string {
  const count = grant.runningThreads;
  if (grant.status === "revoked")
    return [
      grant.ended === true && grant.endsAt
        ? tx("Time limit ended {time}. New work is refused", { time: formatTime(grant.endsAt) })
        : grant.revokedAt
          ? tx("Stopped {time}. New work is refused", { time: formatTime(grant.revokedAt) })
          : tx("Stopped. New work is refused"),
      grant.interruptAt && count > 0
        ? count === 1
          ? tx("1 running thread stops at {time}", { time: formatTime(grant.interruptAt) })
          : tx("{count} running threads stop at {time}", {
              count,
              time: formatTime(grant.interruptAt),
            })
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const parts = [
    grant.status === "expired"
      ? tx("Expired: that machine must allow workers here again")
      : grant.expiresAt
        ? tx("Active until {time}", { time: formatTime(grant.expiresAt) })
        : tx("Active"),
    count === 0
      ? null
      : count === 1
        ? tx("1 running thread")
        : tx("{count} running threads", { count }),
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
export function workGrantHopPath(
  grant: Pick<StudioWorkGrant, "machineLabel" | "hopLimit">,
  tx: TranslatePhrase = englishPhrase,
): {
  readonly stops: ReadonlyArray<WorkGrantHopStop>;
  readonly text: string;
} {
  const machine = grant.machineLabel;
  const further = Math.max(0, grant.hopLimit - 1);
  const sender: WorkGrantHopStop = { label: machine, kind: "sender" };
  const here: WorkGrantHopStop = { label: tx("This machine"), kind: "here" };
  if (further === 0)
    return {
      stops: [sender, here, { label: tx("Another machine"), kind: "blocked" }],
      text: tx(
        "Work {machine} starts here stays here: it cannot start work on another machine from this one.",
        { machine },
      ),
    };
  return {
    stops: [
      sender,
      here,
      {
        label:
          further === 1 ? tx("1 more machine") : tx("{count} more machines", { count: further }),
        kind: "onward",
      },
    ],
    text:
      further === 1
        ? tx(
            "Work {machine} starts here may itself start work on one more machine, and no further. It can never loop back to {machine}.",
            { machine },
          )
        : tx(
            "Work {machine} starts here may itself start work on {count} more machines, and no further. It can never loop back to {machine}.",
            { machine, count: further },
          ),
  };
}

/**
 * What the Routines switch does in its current position. Starting work and
 * managing schedules are separate permissions: the switch covers only the
 * schedules, and only in the projects the grant already covers.
 */
export function workGrantRoutinesNote(
  grant: Pick<StudioWorkGrant, "machineLabel" | "routines">,
  tx: TranslatePhrase = englishPhrase,
): string {
  const machine = grant.machineLabel;
  return grant.routines
    ? tx(
        "On: agents on {machine} may create, change, run and delete scheduled routines on this machine, in the projects it may use. Turn it off to let them start work here but leave the schedules alone.",
        { machine },
      )
    : tx(
        "Off: agents on {machine} can start work here, but cannot create, change, run or delete scheduled routines on this machine. Turn it on if {machine} should set up recurring work here.",
        { machine },
      );
}

/**
 * Where the access limit comes from and what it caps. It is read-only here:
 * the sending machine chose it when it allowed workers on this one.
 */
export function workGrantAccessNote(
  grant: Pick<StudioWorkGrant, "machineLabel" | "runtimeCap">,
  tx: TranslatePhrase = englishPhrase,
): string {
  const machine = grant.machineLabel;
  return grant.runtimeCap === null
    ? tx(
        "{machine} sets it the next time it starts work here. It is the most a thread it starts here may do without asking.",
        { machine },
      )
    : tx(
        "The most a thread {machine} starts here may do without asking. A thread can run with less, never more. Chosen on {machine}, on this machine's card; change it there.",
        { machine },
      );
}
