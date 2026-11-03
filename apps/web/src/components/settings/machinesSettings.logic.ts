import {
  logicalProjectTitle,
  type EnvironmentId,
  type LogicalProject,
  type ProjectCoordinatorBinding,
  type TeamRulesPeerRules,
  type TeamRulesSummary,
} from "@specweave-studio/contracts";
import { isScratchProject } from "@specweave-studio/client-runtime/state/projects";
import { isAutomatedProject } from "@specweave-studio/shared/projectOrigin";
import type {
  StudioFleetMachine,
  StudioFleetSnapshot,
  StudioWorkGrant,
  StudioWorkGrantsSnapshot,
} from "@specweave-studio/contracts/studioFleet";

import { fleetMachineSaved } from "../../studio/fleetAutoConnect";
import { fleetWorkersView } from "../../studio/fleetWorkers";
import type { HostLimitBlock } from "../../studio/hostLimitsModel";
import {
  teamRulesMachineLinkLock,
  teamRulesMachineLock,
  teamRulesOwnMachineView,
  teamRulesPeerFromSummary,
  teamRulesPeerMachineView,
  type TeamRulesLock,
  type TeamRulesMachineView,
} from "../../teamRules/teamRulesView";
import { workGrantProjectsSummary, workGrantStatus } from "./machineWorkGrants.logic";
import { isShareablePairingUrl } from "./pairingUrls";

/**
 * Settings > Machines: one row per machine this app knows of, from its own
 * app connections and the primary server's private machines. Each row keeps
 * apart the three switches people mix up: whether this app can see the
 * machine, whether this server may run workers there, and which shared
 * projects have a copy on it.
 */

/** An environment this app has an app connection to, as the page reads it. */
export interface MachineEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly phase: string;
  /** The connection line the rest of the app shows, such as "Connecting…". */
  readonly statusText: string;
  /** That machine's rules, once its config has arrived. */
  readonly teamRules?: TeamRulesSummary | undefined;
  readonly configKnown?: boolean | undefined;
}

/** The project fields the page reads, so tests need not build a full shell. */
export interface MachineProjectInput {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly workspaceSettings?:
    | {
        readonly kind?: string | undefined;
        readonly archived?: boolean | undefined;
        readonly origin?: string | undefined;
        readonly temporarySessionId?: string | undefined;
        readonly logicalProject?: LogicalProject | undefined;
        readonly coordinatorBinding?: ProjectCoordinatorBinding | undefined;
      }
    | null
    | undefined;
}

export type MachineSeenState = "this-machine" | "connected" | "elsewhere" | "not-connected";

export type SharedProjectRole = "coordinator" | "runs-workers" | "handoff-pending";

export interface MachineProject {
  readonly key: string;
  readonly title: string;
  /** Null when this app cannot see that copy, so its role is unknown here. */
  readonly role: SharedProjectRole | "only-here" | null;
  readonly roleLabel: string;
  /** The role in a sentence, for the label's tooltip. */
  readonly roleHelp: string;
  /** The other machines that hold a copy. */
  readonly alsoOn: readonly string[];
  /** Those copies in full: each machine, how this app sees it, its folder and role. */
  readonly elsewhere: readonly MachineProjectCopy[];
  readonly folder: string | null;
}

/** A copy of a project on another machine. */
export interface MachineProjectCopy {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly seen: MachineSeen;
  /** Null when this app cannot see that copy, so its folder is unknown here. */
  readonly folder: string | null;
  /** Null when this app cannot see that copy. */
  readonly roleLabel: string | null;
}

export interface MachineSeen {
  readonly state: MachineSeenState;
  readonly text: string;
}

/** A machine's projects, split as the sidebar splits them. */
export interface MachineProjects {
  readonly own: readonly MachineProject[];
  readonly automated: readonly MachineProject[];
  readonly archived: readonly MachineProject[];
}

export interface MachineAccount {
  readonly key: string;
  readonly provider: string;
  readonly identity: string;
  /** Other machines signed in to the same account, sharing its limits. */
  readonly alsoOn: readonly string[];
}

export interface MachineWorkerGrant {
  readonly status: "allowed" | "expiring" | "not-allowed";
  readonly label: string;
  readonly detail: string;
}

/** What a machine may run on this one, from this machine's own grant to it. */
export interface MachineWorkHere {
  readonly status: StudioWorkGrant["status"];
  readonly label: string;
  readonly detail: string;
}

export interface MachineConnectAction {
  readonly enabled: boolean;
  readonly label: string;
}

export interface MachineRowModel {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The machine's own name when it differs from the label. */
  readonly machineName: string | null;
  readonly seen: MachineSeen;
  readonly fleetMachine: StudioFleetMachine | null;
  /** Connect, for a private machine this app cannot see yet. */
  readonly connect: MachineConnectAction | null;
  /** Workers this server may start there; null when it is not one of its private machines. */
  readonly workers: MachineWorkerGrant | null;
  /** Work that machine may start here; null when it holds no grant from this machine. */
  readonly workHere: MachineWorkHere | null;
  readonly projects: MachineProjects;
  /** Null when this app cannot see the machine, so its sign-ins are unknown. */
  readonly accounts: readonly MachineAccount[] | null;
  /** A private machine this app sees, whose own app may not see this one yet. */
  readonly connectBothWays: boolean;
  /** Rule fingerprint and drift; null when no machine here has rules, so the row stays as it was. */
  readonly teamRules: TeamRulesMachineView | null;
  /** Set when this machine's rules refuse connecting to that one. */
  readonly connectLock: TeamRulesLock | null;
  /** This app sees the machine, but this server does not list it, so agents here cannot use it. */
  readonly canAddForAgents: boolean;
}

const ROLE_LABELS: Readonly<Record<SharedProjectRole | "only-here", string>> = {
  coordinator: "Main copy",
  "runs-workers": "Runs workers only",
  "handoff-pending": "Moving main copy",
  "only-here": "This machine only",
};

const ROLE_HELP: Readonly<Record<SharedProjectRole | "only-here", string>> = {
  coordinator:
    "This copy runs the project's coordinator, whether or not it is working right now. Copies on other machines take work from it.",
  "runs-workers": "The coordinator moved to another machine. This copy only takes work from it.",
  "handoff-pending": "The project's coordinator is moving between machines.",
  "only-here": "No other machine has a copy of this project.",
};

/** A copy coordinates unless it handed the coordinator on or is handing it on now. */
export function sharedProjectRole(
  binding: Pick<ProjectCoordinatorBinding, "state"> | null | undefined,
): SharedProjectRole {
  if (binding?.state === "transferred") return "runs-workers";
  if (binding?.state === "transferring") return "handoff-pending";
  return "coordinator";
}

/** One identity with copies on more than one machine. */
export function isSharedProject(project: MachineProjectInput): boolean {
  return (project.workspaceSettings?.logicalProject?.members.length ?? 0) > 1;
}

function workerGrant(machine: StudioFleetMachine): MachineWorkerGrant | null {
  const workers = machine.workers;
  if (!workers) return null;
  const detail = fleetWorkersView(workers).summary;
  if (workers.status === "allowed") return { status: "allowed", label: "Workers allowed", detail };
  if (workers.status === "expiring")
    return { status: "expiring", label: "Workers expiring", detail };
  return { status: "not-allowed", label: "Workers not allowed", detail };
}

const WORK_HERE_LABELS: Readonly<Record<StudioWorkGrant["status"], string>> = {
  active: "May run work here",
  revoked: "Revoked",
  expired: "Expired",
};

function workHereFor(
  environmentId: EnvironmentId,
  grants: StudioWorkGrantsSnapshot | null | undefined,
): MachineWorkHere | null {
  const grant = grants?.grants.find(
    (candidate) => candidate.coordinatorEnvironmentId === environmentId,
  );
  if (!grant || !grants) return null;
  return {
    status: grant.status,
    label: WORK_HERE_LABELS[grant.status],
    detail: `${workGrantProjectsSummary(grant, grants.projects, grants.projectsUnreadable === true)} · ${workGrantStatus(grant)}`,
  };
}

/** Connect for a private machine, or why it cannot be pressed yet. */
export function fleetConnectAction(
  machine: Pick<StudioFleetMachine, "status" | "pairingConfigured">,
  canPair: boolean,
): MachineConnectAction {
  if (machine.status !== "reachable") return { enabled: false, label: "Unreachable" };
  if (!machine.pairingConfigured) return { enabled: false, label: "Pairing needs setup" };
  if (!canPair) return { enabled: false, label: "Pairing permission required" };
  return { enabled: true, label: "Connect" };
}

function otherCopies(
  environmentId: EnvironmentId,
  project: MachineProjectInput,
  projects: readonly MachineProjectInput[],
  machineOf: (environmentId: EnvironmentId) => { name: string; seen: MachineSeen },
): MachineProjectCopy[] {
  const members = project.workspaceSettings?.logicalProject?.members ?? [];
  const seen = new Set<string>([environmentId]);
  const copies: MachineProjectCopy[] = [];
  for (const member of members) {
    if (seen.has(member.environmentId)) continue;
    seen.add(member.environmentId);
    const copy = projects.find(
      (candidate) =>
        candidate.environmentId === member.environmentId && candidate.id === member.projectId,
    );
    copies.push({
      environmentId: member.environmentId,
      ...machineOf(member.environmentId),
      folder: copy?.workspaceRoot ?? null,
      roleLabel: copy
        ? ROLE_LABELS[sharedProjectRole(copy.workspaceSettings?.coordinatorBinding)]
        : null,
    });
  }
  return copies;
}

/** Shared copies first, then by name, so the same project sits in the same place on each machine. */
function byListOrder(left: MachineProject, right: MachineProject): number {
  return (
    Number(right.role !== "only-here") - Number(left.role !== "only-here") ||
    left.title.localeCompare(right.title)
  );
}

/** Which list a copy belongs in, by the same rules as the sidebar. */
function projectListOf(project: MachineProjectInput): keyof MachineProjects {
  if (project.workspaceSettings?.archived) return "archived";
  return isAutomatedProject(project) ? "automated" : "own";
}

function projectsOn(
  environmentId: EnvironmentId,
  seen: boolean,
  projects: readonly MachineProjectInput[],
  machineOf: (environmentId: EnvironmentId) => { name: string; seen: MachineSeen },
  scratchRootFor: (environmentId: EnvironmentId) => string | null | undefined,
): MachineProjects {
  const lists: Record<keyof MachineProjects, MachineProject[]> = {
    own: [],
    automated: [],
    archived: [],
  };
  if (seen) {
    for (const project of projects) {
      if (
        project.environmentId !== environmentId ||
        isScratchProject(project, scratchRootFor(environmentId))
      )
        continue;
      const shared = isSharedProject(project);
      const role = shared
        ? sharedProjectRole(project.workspaceSettings?.coordinatorBinding)
        : "only-here";
      const elsewhere = shared ? otherCopies(environmentId, project, projects, machineOf) : [];
      lists[projectListOf(project)].push({
        key: project.workspaceSettings?.logicalProject?.id ?? project.id,
        title: logicalProjectTitle(project),
        role,
        roleLabel: ROLE_LABELS[role],
        roleHelp: ROLE_HELP[role],
        alsoOn: elsewhere.map((copy) => copy.name),
        elsewhere,
        folder: project.workspaceRoot,
      });
    }
  } else {
    // A machine this app cannot see still shows up in the member lists of the
    // copies it can see; name those projects without guessing role or folder.
    const seenIdentities = new Set<string>();
    for (const project of projects) {
      const logical = project.workspaceSettings?.logicalProject;
      if (!logical || !isSharedProject(project) || seenIdentities.has(logical.id)) continue;
      if (!logical.members.some((member) => member.environmentId === environmentId)) continue;
      seenIdentities.add(logical.id);
      const elsewhere = otherCopies(environmentId, project, projects, machineOf);
      // That machine's own copy is out of sight, so the copies in sight decide together.
      const copies = projects.filter(
        (copy) => copy.workspaceSettings?.logicalProject?.id === logical.id,
      );
      const list = copies.every((copy) => projectListOf(copy) === "archived")
        ? "archived"
        : copies.every((copy) => projectListOf(copy) !== "own")
          ? "automated"
          : "own";
      lists[list].push({
        key: logical.id,
        title: logicalProjectTitle(project),
        role: null,
        roleLabel: "Connect to see its role",
        roleHelp: "This app cannot see this machine, so it cannot tell what this copy does.",
        alsoOn: elsewhere.map((copy) => copy.name),
        elsewhere,
        folder: null,
      });
    }
  }
  return {
    own: lists.own.toSorted(byListOrder),
    automated: lists.automated.toSorted(byListOrder),
    archived: lists.archived.toSorted(byListOrder),
  };
}

function accountsOn(
  environmentId: EnvironmentId,
  blocks: readonly Pick<HostLimitBlock, "environmentId" | "providers">[],
): MachineAccount[] {
  const block = blocks.find((candidate) => candidate.environmentId === environmentId);
  return (block?.providers ?? []).map((row) => ({
    key: row.key,
    provider: row.label,
    identity: row.identity ?? "Account not reported",
    alsoOn: row.sharedWith,
  }));
}

/** A connected machine answers for itself; otherwise the primary server's last read of it. */
function peerRulesOf(
  environment: MachineEnvironmentInput | undefined,
  machine: StudioFleetMachine | null | undefined,
): { readonly peer: TeamRulesPeerRules | undefined; readonly known: boolean } {
  if (environment?.phase === "connected" && environment.configKnown === true) {
    return { peer: teamRulesPeerFromSummary(environment.teamRules), known: true };
  }
  return { peer: machine?.teamRules, known: machine?.status === "reachable" };
}

/**
 * The rows, this machine first, then the machines this app connects to in
 * catalog order, then private machines it cannot see yet in the server's order.
 */
export function buildMachineRows(input: {
  readonly environments: readonly MachineEnvironmentInput[];
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly fleet: StudioFleetSnapshot | null;
  /** Saved route origins by environment id; a machine saved only at an old address reads as not saved. */
  readonly savedOrigins?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly canPair: boolean;
  readonly projects: readonly MachineProjectInput[];
  readonly hostBlocks: readonly Pick<HostLimitBlock, "environmentId" | "providers">[];
  /** This machine's grants to coordinator machines, when its server lists them. */
  readonly workGrants?: StudioWorkGrantsSnapshot | null;
  /** Each machine's scratch folder, whose project ("No project") is never listed. */
  readonly scratchRootFor?: (environmentId: EnvironmentId) => string | null | undefined;
  /** The name the person gave a machine; the rows' own label otherwise. */
  readonly displayName?: (environmentId: EnvironmentId, label: string) => string;
}): MachineRowModel[] {
  const fleetMachines = input.fleet?.machines ?? [];
  const fleetByEnvironment = new Map(
    fleetMachines.map((machine) => [machine.environmentId, machine] as const),
  );
  const saved = new Set<string>(input.environments.map((environment) => environment.environmentId));
  const ownRules = input.environments.find(
    (environment) => environment.environmentId === input.primaryEnvironmentId,
  )?.teamRules;
  const anyRules =
    ownRules !== undefined ||
    input.environments.some((environment) => environment.teamRules !== undefined) ||
    fleetMachines.some((machine) => machine.teamRules !== undefined);
  const peerRulesFields = (
    label: string,
    environment: MachineEnvironmentInput | undefined,
    machine: StudioFleetMachine | null | undefined,
  ) => {
    const { peer, known } = peerRulesOf(environment, machine);
    return {
      teamRules: anyRules ? teamRulesPeerMachineView(ownRules, peer, known) : null,
      // A machine that has not answered is not known to differ, so only a whole-fleet rule names it.
      connectLock: known
        ? teamRulesMachineLock(ownRules, { label, fingerprint: peer?.fingerprint })
        : teamRulesMachineLinkLock(ownRules),
    };
  };
  const labels = new Map<string, string>([
    ...fleetMachines.map((machine) => [machine.environmentId, machine.label] as const),
    ...input.environments.map(
      (environment) => [environment.environmentId, environment.label] as const,
    ),
  ]);
  const nameOf = (environmentId: EnvironmentId) => {
    const label = labels.get(environmentId) ?? "another machine";
    return input.displayName?.(environmentId, label) ?? label;
  };
  const environmentsById = new Map(
    input.environments.map((environment) => [environment.environmentId, environment] as const),
  );
  const seenOf = (environmentId: EnvironmentId): MachineSeen => {
    if (environmentId === input.primaryEnvironmentId)
      return { state: "this-machine", text: "This machine" };
    const environment = environmentsById.get(environmentId);
    if (!environment) return { state: "not-connected", text: "This app cannot see it" };
    return environment.phase === "connected"
      ? { state: "connected", text: "This app can see it" }
      : { state: "elsewhere", text: environment.statusText };
  };
  const machineOf = (environmentId: EnvironmentId) => ({
    name: nameOf(environmentId),
    seen: seenOf(environmentId),
  });
  const scratchRootFor = input.scratchRootFor ?? (() => null);
  const ordered = input.environments.toSorted(
    (left, right) =>
      Number(right.environmentId === input.primaryEnvironmentId) -
      Number(left.environmentId === input.primaryEnvironmentId),
  );

  const rows: MachineRowModel[] = ordered.map((environment) => {
    const isThisMachine = environment.environmentId === input.primaryEnvironmentId;
    const fleetMachine = isThisMachine
      ? null
      : (fleetByEnvironment.get(environment.environmentId) ?? null);
    const connected = environment.phase === "connected";
    const seen = seenOf(environment.environmentId);
    return {
      environmentId: environment.environmentId,
      label: environment.label,
      machineName:
        fleetMachine?.machineName && fleetMachine.machineName !== environment.label
          ? fleetMachine.machineName
          : null,
      seen,
      fleetMachine,
      // Saved only at an address it has left: Connect adds its new one.
      connect:
        fleetMachine && !fleetMachineSaved(fleetMachine, saved, input.savedOrigins)
          ? fleetConnectAction(fleetMachine, input.canPair)
          : null,
      workers: fleetMachine ? workerGrant(fleetMachine) : null,
      workHere: isThisMachine ? null : workHereFor(environment.environmentId, input.workGrants),
      projects: projectsOn(
        environment.environmentId,
        true,
        input.projects,
        machineOf,
        scratchRootFor,
      ),
      accounts: accountsOn(environment.environmentId, input.hostBlocks),
      connectBothWays: fleetMachine !== null && connected,
      ...(isThisMachine
        ? { teamRules: anyRules ? teamRulesOwnMachineView(ownRules) : null, connectLock: null }
        : peerRulesFields(
            environment.label,
            environment,
            fleetByEnvironment.get(environment.environmentId),
          )),
      // Without a fleet answer yet, "not listed" means nothing.
      canAddForAgents:
        !isThisMachine &&
        connected &&
        fleetMachine === null &&
        input.fleet !== null &&
        input.primaryEnvironmentId !== null,
    };
  });

  for (const machine of fleetMachines) {
    if (machine.environmentId === input.primaryEnvironmentId || saved.has(machine.environmentId))
      continue;
    rows.push({
      environmentId: machine.environmentId,
      label: machine.label,
      machineName:
        machine.machineName && machine.machineName !== machine.label ? machine.machineName : null,
      seen: { state: "not-connected", text: "This app cannot see it" },
      fleetMachine: machine,
      connect: fleetConnectAction(machine, input.canPair),
      workers: workerGrant(machine),
      workHere: workHereFor(machine.environmentId, input.workGrants),
      projects: projectsOn(machine.environmentId, false, input.projects, machineOf, scratchRootFor),
      accounts: null,
      connectBothWays: false,
      ...peerRulesFields(machine.label, undefined, machine),
      canAddForAgents: false,
    });
  }
  return rows;
}

/**
 * Private machines this app cannot see: not this machine and not connected
 * here at the address the server lists. Their projects, an assistant among
 * them, stay invisible until connected.
 */
export function unseenFleetMachines(input: {
  readonly fleet: StudioFleetSnapshot | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironmentIds: ReadonlySet<string>;
  readonly savedOrigins?: ReadonlyMap<string, ReadonlySet<string>>;
}): StudioFleetMachine[] {
  return (input.fleet?.machines ?? []).filter(
    (machine) =>
      machine.environmentId !== input.primaryEnvironmentId &&
      !fleetMachineSaved(machine, input.savedEnvironmentIds, input.savedOrigins),
  );
}

/**
 * The address the other machine should pair with: the one its own server
 * already reaches this machine at, then this page's address, then this
 * server's direct routes and what the desktop app advertises. Loopback and
 * the desktop app's own origin only reach this machine, so they never qualify.
 */
export function pairingLinkBaseUrl(input: {
  readonly addressSeenThere: string | null;
  readonly pageUrl: string | null;
  readonly directEndpoints: ReadonlyArray<{ readonly httpBaseUrl: string }>;
  readonly advertisedEndpoints: ReadonlyArray<{ readonly httpBaseUrl: string }>;
}): string | null {
  const candidates = [
    input.addressSeenThere,
    input.pageUrl,
    ...input.directEndpoints.map((endpoint) => endpoint.httpBaseUrl),
    ...input.advertisedEndpoints.map((endpoint) => endpoint.httpBaseUrl),
  ];
  for (const candidate of candidates) {
    if (!candidate || !isShareablePairingUrl(candidate)) continue;
    return new URL(candidate).origin;
  }
  return null;
}

/** Where to paste the link on the other machine. */
export function connectBothWaysInstruction(machineLabel: string): string {
  return `On ${machineLabel}, open Settings > Connections > Add environment > Remote link and paste this link.`;
}
