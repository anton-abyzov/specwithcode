/**
 * Which machine's orchestrator a person is looking at. A project added on
 * several machines has a checkout per machine; with the copies linked, each
 * machine may run its own coordinator (0969). Viewing one only reads that
 * machine's server: it never moves a thread or a coordinator. The last viewed
 * checkout is saved per project so a reload opens the same view.
 *
 * @module projectCoordinatorMachine
 */
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { LogicalProjectMember } from "@specweave-studio/contracts";
import { COORDINATOR_PENDING_PROBLEM, logicalCoordinators } from "./projectDomain";

export interface CoordinatorMachineMember {
  readonly environmentId: string;
  readonly id: string;
}

/** The saved form of a checkout: `environmentId:projectId`. */
export function coordinatorMachineKey(member: CoordinatorMachineMember): string {
  return `${member.environmentId}:${member.id}`;
}

export const SUPERSEDED_COORDINATOR_PROBLEM =
  "Another machine took over this coordinator. It gives way once its machine is reachable; view the newer coordinator to send messages.";
export const WORKERS_ONLY_PROBLEM =
  "This copy runs workers, so its coordinator conversation is history. Choose Start a coordinator on this machine to send it messages.";
export const UNCONFIRMED_COORDINATOR_PROBLEM =
  "This copy has not confirmed its coordinator yet. Reconnect its machine to send messages.";

export interface CoordinatorView<T extends CoordinatorMachineMember> {
  readonly member: T | undefined;
  /**
   * The route or the last viewed checkout is not listed now. The page says so
   * instead of quietly showing another machine in its place.
   */
  readonly missing: boolean;
  /** Why the viewed copy's coordinator cannot take messages; null when it can. */
  readonly problem: string | null;
}

/**
 * The checkout the project page shows. An explicit route checkout wins and is
 * never replaced. The last viewed checkout comes next, even while its machine
 * is unreachable: the page then shows that machine's last synced state,
 * read-only. Only with neither does a default apply: for a linked project, a
 * coordinator on this computer, then a reachable one; otherwise this
 * computer's checkout, then a reachable one.
 */
export function chooseCoordinatorView<T extends EnvironmentProject>(input: {
  readonly members: readonly T[];
  readonly checkoutKey?: string | null | undefined;
  readonly lastViewed?: string | undefined;
  readonly primaryEnvironmentId: string | null;
  /** Machines known to be unreachable now; a machine still connecting is not one. */
  readonly unreachable?: ReadonlySet<string>;
}): CoordinatorView<T> {
  const { members, checkoutKey, lastViewed, primaryEnvironmentId } = input;
  const unreachable = input.unreachable ?? new Set<string>();
  const roles = logicalCoordinators(members);
  const viewOf = (member: T | undefined, missing = false): CoordinatorView<T> => ({
    member,
    missing,
    problem: member && roles ? coordinatorProblem(member, roles) : null,
  });
  if (checkoutKey) {
    const exact = members.find((member) => coordinatorMachineKey(member) === checkoutKey);
    return exact ? viewOf(exact) : { member: undefined, missing: true, problem: null };
  }
  if (lastViewed) {
    const environmentId = checkoutKeyEnvironmentId(lastViewed);
    const viewed =
      members.find((member) => coordinatorMachineKey(member) === lastViewed) ??
      members.find((member) => member.environmentId === environmentId);
    if (viewed) return viewOf(viewed);
  }
  const reachable = (candidates: readonly T[]) =>
    candidates.filter((member) => !unreachable.has(member.environmentId));
  const preferred = (candidates: readonly T[]) =>
    (primaryEnvironmentId !== null
      ? candidates.find((member) => member.environmentId === primaryEnvironmentId)
      : undefined) ?? candidates[0];
  const fallback =
    (roles
      ? (roles.coordinators.find((member) => member.environmentId === primaryEnvironmentId) ??
        reachable(roles.coordinators)[0] ??
        roles.coordinators[0] ??
        roles.pending[0])
      : undefined) ??
    preferred(reachable(members)) ??
    preferred(members);
  return viewOf(fallback, Boolean(lastViewed) && members.length > 0);
}

/**
 * Why a linked checkout is not listed. host-unknown: this device is not paired
 * with the checkout's machine. host-refused: the connection stopped for good or
 * this build cannot talk to the machine, so it does not come back on its own.
 * host-offline: the machine is paired but cannot be reached now. host-loading:
 * the machine is connecting, or connected and has not sent its projects since.
 * not-registered: the machine sent its projects and has no such project.
 */
export type CheckoutUnavailableReason =
  | "host-unknown"
  | "host-refused"
  | "host-offline"
  | "host-loading"
  | "not-registered";

/** The machine part of a saved `environmentId:projectId` checkout key. */
export function checkoutKeyEnvironmentId(key: string): string {
  const separator = key.indexOf(":");
  return separator > 0 ? key.slice(0, separator) : key;
}

export function checkoutUnavailableReason(input: {
  readonly environmentId: string;
  readonly environments: ReadonlyArray<{
    readonly environmentId: string;
    readonly connection: { readonly phase: string };
  }>;
  /** Machines known to be unreachable now; a machine still connecting is not one. */
  readonly unreachable: ReadonlySet<string>;
  /** The machine's project list is synchronized since it last connected. */
  readonly projectsLive: boolean;
}): CheckoutUnavailableReason {
  const environment = input.environments.find(
    (candidate) => candidate.environmentId === input.environmentId,
  );
  if (!environment) return "host-unknown";
  const { phase } = environment.connection;
  if (phase === "error" || phase === "unsupported") return "host-refused";
  if (input.unreachable.has(input.environmentId)) return "host-offline";
  if (phase !== "connected" || !input.projectsLive) return "host-loading";
  return "not-registered";
}

function coordinatorProblem<T extends EnvironmentProject>(
  member: T,
  roles: NonNullable<ReturnType<typeof logicalCoordinators<T>>>,
): string | null {
  if (roles.coordinators.includes(member)) return null;
  if (roles.pending.includes(member)) return COORDINATOR_PENDING_PROBLEM;
  if (roles.superseded.includes(member)) return SUPERSEDED_COORDINATOR_PROBLEM;
  if (member.workspaceSettings?.coordinatorBinding?.state === "transferred")
    return WORKERS_ONLY_PROBLEM;
  return UNCONFIRMED_COORDINATOR_PROBLEM;
}

/**
 * A linked machine the key names that this device has never loaded: the shared
 * project lists it, but no synced copy of it is here. Its state is Unknown, and
 * the page says so rather than showing another machine. Null when the key is
 * loaded, absent, or not one of the project's linked machines.
 */
export function unloadedMachineRef(
  members: ReadonlyArray<EnvironmentProject>,
  key: string | null | undefined,
): LogicalProjectMember | null {
  if (!key || members.some((member) => coordinatorMachineKey(member) === key)) return null;
  for (const member of members)
    for (const ref of member.workspaceSettings?.logicalProject?.members ?? [])
      if (`${ref.environmentId}:${ref.projectId}` === key) return ref;
  return null;
}

/** Every linked machine the project lists that this device has never loaded. */
export function unloadedMachineRefs(
  members: ReadonlyArray<EnvironmentProject>,
): LogicalProjectMember[] {
  const loaded = new Set(members.map(coordinatorMachineKey));
  const refs = new Map<string, LogicalProjectMember>();
  for (const member of members)
    for (const ref of member.workspaceSettings?.logicalProject?.members ?? []) {
      const key = `${ref.environmentId}:${ref.projectId}`;
      if (!loaded.has(key)) refs.set(key, ref);
    }
  return [...refs.values()];
}

/** One machine's copy of the project, as the orchestrator switcher lists it. */
export interface OrchestratorCopy {
  readonly key: string;
  readonly machine: string;
  readonly folder: string;
  /**
   * coordinator: runs its own coordinator. workers: a linked copy that only runs
   * workers. pending: a coordinator move to it is not confirmed yet.
   * independent: the same repository, not linked, with its own orchestrator.
   */
  readonly role: "coordinator" | "workers" | "pending" | "independent";
  /** A coordinator can be started on this linked copy now. */
  readonly canStart: boolean;
}

/**
 * The copies the switcher lists. Checkouts of one repository that were never
 * linked are independent projects with their own orchestrators: the switcher
 * views them, and nothing treats them as one project.
 */
export function orchestratorCopies<T extends EnvironmentProject>(
  members: readonly T[],
  machineOf: (member: T) => string,
  startReady: (environmentId: T["environmentId"]) => boolean,
): OrchestratorCopy[] {
  const roles = logicalCoordinators(members);
  return members.map((member) => {
    const linked = Boolean(member.workspaceSettings?.logicalProject);
    const role: OrchestratorCopy["role"] =
      !roles || !linked
        ? members.length > 1
          ? "independent"
          : "coordinator"
        : roles.coordinators.includes(member)
          ? "coordinator"
          : roles.pending.includes(member)
            ? "pending"
            : "workers";
    return {
      key: coordinatorMachineKey(member),
      machine: machineOf(member),
      folder: member.workspaceRoot,
      role,
      canStart:
        role === "workers" &&
        member.workspaceSettings?.coordinatorBinding?.state === "transferred" &&
        startReady(member.environmentId),
    };
  });
}
