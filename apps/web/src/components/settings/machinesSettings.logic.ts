import {
  logicalProjectTitle,
  type EnvironmentId,
  type LogicalProject,
  type ProjectCoordinatorBinding,
} from "@specweave-studio/contracts";
import type {
  StudioFleetMachine,
  StudioFleetSnapshot,
} from "@specweave-studio/contracts/studioFleet";

import { fleetMachineSaved } from "../../studio/fleetAutoConnect";
import { fleetWorkersView } from "../../studio/fleetWorkers";
import type { HostLimitBlock } from "../../studio/hostLimitsModel";
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
        readonly logicalProject?: LogicalProject | undefined;
        readonly coordinatorBinding?: ProjectCoordinatorBinding | undefined;
      }
    | null
    | undefined;
}

export type MachineSeenState = "this-machine" | "connected" | "elsewhere" | "not-connected";

export type SharedProjectRole = "coordinator" | "runs-workers" | "handoff-pending";

export interface MachineSharedProject {
  readonly key: string;
  readonly title: string;
  /** Null when this app cannot see that copy, so its role is unknown here. */
  readonly role: SharedProjectRole | null;
  readonly roleLabel: string;
  readonly folder: string | null;
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

export interface MachineConnectAction {
  readonly enabled: boolean;
  readonly label: string;
}

export interface MachineRowModel {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The machine's own name when it differs from the label. */
  readonly machineName: string | null;
  readonly seen: { readonly state: MachineSeenState; readonly text: string };
  readonly fleetMachine: StudioFleetMachine | null;
  /** Connect, for a private machine this app cannot see yet. */
  readonly connect: MachineConnectAction | null;
  /** Workers this server may start there; null when it is not one of its private machines. */
  readonly workers: MachineWorkerGrant | null;
  readonly sharedProjects: readonly MachineSharedProject[];
  /** Null when this app cannot see the machine, so its sign-ins are unknown. */
  readonly accounts: readonly MachineAccount[] | null;
  /** A private machine this app sees, whose own app may not see this one yet. */
  readonly connectBothWays: boolean;
}

const ROLE_LABELS: Readonly<Record<SharedProjectRole, string>> = {
  coordinator: "Coordinator",
  "runs-workers": "Runs workers",
  "handoff-pending": "Handoff pending",
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

function sharedProjectsOn(
  environmentId: EnvironmentId,
  seen: boolean,
  projects: readonly MachineProjectInput[],
): MachineSharedProject[] {
  const live = projects.filter((project) => !project.workspaceSettings?.archived);
  if (seen) {
    return live
      .filter((project) => project.environmentId === environmentId && isSharedProject(project))
      .map((project) => {
        const role = sharedProjectRole(project.workspaceSettings?.coordinatorBinding);
        return {
          key: project.workspaceSettings?.logicalProject?.id ?? project.id,
          title: logicalProjectTitle(project),
          role,
          roleLabel: ROLE_LABELS[role],
          folder: project.workspaceRoot,
        };
      })
      .toSorted((left, right) => left.title.localeCompare(right.title));
  }
  // A machine this app cannot see still shows up in the member lists of the
  // copies it can see; name those projects without guessing role or folder.
  const byIdentity = new Map<string, MachineSharedProject>();
  for (const project of live) {
    const logical = project.workspaceSettings?.logicalProject;
    if (!logical || !isSharedProject(project) || byIdentity.has(logical.id)) continue;
    if (!logical.members.some((member) => member.environmentId === environmentId)) continue;
    byIdentity.set(logical.id, {
      key: logical.id,
      title: logicalProjectTitle(project),
      role: null,
      roleLabel: "Connect to see its role",
      folder: null,
    });
  }
  return [...byIdentity.values()].toSorted((left, right) => left.title.localeCompare(right.title));
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
}): MachineRowModel[] {
  const fleetMachines = input.fleet?.machines ?? [];
  const fleetByEnvironment = new Map(
    fleetMachines.map((machine) => [machine.environmentId, machine] as const),
  );
  const saved = new Set<string>(input.environments.map((environment) => environment.environmentId));
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
    const seen = isThisMachine
      ? { state: "this-machine" as const, text: "This machine" }
      : connected
        ? { state: "connected" as const, text: "This app can see it" }
        : { state: "elsewhere" as const, text: environment.statusText };
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
      sharedProjects: sharedProjectsOn(environment.environmentId, true, input.projects),
      accounts: accountsOn(environment.environmentId, input.hostBlocks),
      connectBothWays: fleetMachine !== null && connected,
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
      sharedProjects: sharedProjectsOn(machine.environmentId, false, input.projects),
      accounts: null,
      connectBothWays: false,
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
