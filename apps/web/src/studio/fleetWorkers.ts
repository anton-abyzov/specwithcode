import {
  type EnvironmentId,
  isLocalWorkerMachine,
  LOCAL_WORKER_MACHINE_ID,
  type ProjectWorkerMachine,
} from "@specweave-studio/contracts";
import type {
  StudioFleetRemoveResult,
  StudioFleetSnapshot,
  StudioFleetWorkerAccess,
  StudioFleetWorkers,
} from "@specweave-studio/contracts/studioFleet";
import { runtimeModeConfig, runtimeModeOptions } from "../components/chat/runtimeModeConfig";

/** The same names the composer's permission picker uses. */
export const FLEET_WORKER_ACCESS_CHOICES: ReadonlyArray<{
  readonly value: StudioFleetWorkerAccess;
  readonly label: string;
  readonly description: string;
}> = runtimeModeOptions.map((mode) => ({
  value: mode,
  label: runtimeModeConfig[mode].label,
  description: runtimeModeConfig[mode].description,
}));

/**
 * Runs on the other machine, whose shell is unknown here. An ID of plain letters,
 * digits and dashes needs no quotes in zsh, bash, PowerShell or cmd, and single
 * quotes would reach the program literally under cmd.
 */
export function fleetInviteCommand(environmentId: string): string {
  const id = /^[A-Za-z0-9-]+$/.test(environmentId) ? environmentId : `"${environmentId}"`;
  return `specwithcode fleet invite --coordinator ${id}`;
}

/** What the Workers row's help says, for someone who has not met the word yet. */
export function fleetWorkersHelp(machineLabel: string): readonly string[] {
  return [
    "A worker is a thread that a coordinator starts to do one job.",
    `Allow workers lets coordinators on this machine start those threads on ${machineLabel}. Moving your threads there needs it too.`,
    "Stop workers takes that permission away. Workers already running there keep running, but this machine stops following them.",
    "What you type in a thread yourself does not need it.",
  ];
}

/**
 * Private machines are the owner's own, so workers there start with full
 * access; the select can still give them less. This server's default mode
 * for its own threads does not apply: a lower ceiling here would silently
 * lower a Full access coordinator's workers.
 */
export const DEFAULT_FLEET_WORKER_ACCESS: StudioFleetWorkerAccess = "full-access";

const accessLabel = (access: StudioFleetWorkerAccess | null) =>
  access === null ? "Auto" : runtimeModeConfig[access].label;

const PROBLEMS: Record<NonNullable<StudioFleetWorkers["problem"]>, string> = {
  unsupported: "That machine's SpecWithCode is too old to run workers for another machine.",
  route_mismatch: "That machine answers on a different address than configured here.",
  pairing_unavailable:
    "This machine's key there cannot make a code. On that machine, open Settings > Machines > Allow another machine to run work here and choose this machine.",
  pairing_code_rejected:
    "That machine did not accept the code. A code from Create link does not work here. On that machine, open Settings > Machines > Allow another machine to run work here and choose this machine.",
  unreachable: "That machine could not be reached.",
  identity_mismatch: "A different SpecWithCode answers at that machine's address.",
};

export interface FleetWorkersView {
  /** One line on whether coordinators here may start workers there. */
  readonly summary: string;
  /** Why the last attempt did not finish, when it did not. */
  readonly problem: string | null;
  readonly action: "allow" | "stop";
  /** Allowing needs a pairing code made on that machine. */
  readonly codeNeeded: boolean;
  /**
   * An allowed grant's access can be changed by allowing again; that needs a
   * pairing code when this server cannot mint there on its own.
   */
  readonly changeCodeNeeded: boolean;
  /** Said when workers there run below full access, so a lowered launch is not a surprise. */
  readonly accessHint: string | null;
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * What the Workers row of a fleet machine says and offers. `pairingConfigured`
 * is whether this server holds a key on that machine: with one it makes the
 * code itself, so nothing is pasted unless that already failed.
 */
export function fleetWorkersView(
  workers: StudioFleetWorkers,
  pairingConfigured = false,
): FleetWorkersView {
  const problem = workers.problem ? PROBLEMS[workers.problem] : null;
  const codeNeeded =
    (!workers.renewable && !pairingConfigured) ||
    workers.problem === "pairing_unavailable" ||
    workers.problem === "pairing_code_rejected";
  switch (workers.status) {
    case "allowed":
    case "expiring": {
      const until = workers.expiresAt ? ` until ${formatDate(workers.expiresAt)}` : "";
      const renewal = workers.renewable ? "Renews on its own." : "Allow again before it lapses.";
      return {
        summary: `${workers.status === "expiring" ? "Expiring" : "Allowed"}: ${accessLabel(workers.access)}${until}. ${renewal}`,
        problem,
        action: "stop",
        codeNeeded: false,
        changeCodeNeeded: codeNeeded,
        accessHint:
          workers.access !== null && workers.access !== "full-access"
            ? `Workers there run at most at ${accessLabel(workers.access)}, even when their coordinator has Full access.`
            : null,
      };
    }
    case "revoked":
      return {
        summary: "That machine revoked this server's access. Allow again to resume workers.",
        problem,
        action: "allow",
        codeNeeded,
        changeCodeNeeded: false,
        accessHint: null,
      };
    case "expired":
      return {
        summary: "Access expired. Allow again to start workers there.",
        problem,
        action: "allow",
        codeNeeded,
        changeCodeNeeded: false,
        accessHint: null,
      };
    case "not_allowed":
      return {
        summary: "Not set up yet.",
        problem,
        action: "allow",
        codeNeeded,
        changeCodeNeeded: false,
        accessHint: null,
      };
  }
}

/**
 * The access a machine's Workers row starts from before the user picks one:
 * the grant's current access once allowed, else `fallback`.
 */
export function fleetWorkerDraftAccess(
  workers: StudioFleetWorkers | undefined,
  fallback: StudioFleetWorkerAccess = DEFAULT_FLEET_WORKER_ACCESS,
): StudioFleetWorkerAccess {
  if (workers && (workers.status === "allowed" || workers.status === "expiring") && workers.access)
    return workers.access;
  return fallback;
}

export interface WorkerMachineChoice {
  /** "local", or the fleet machine id. */
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly machine: ProjectWorkerMachine;
}

/**
 * The machines a project's worker list may hold: this machine, and each fleet
 * machine this server may start workers on. A machine already in the list
 * stays listed, so a lapsed grant is visible instead of silently vanishing.
 */
export function workerMachineChoices(
  snapshot: StudioFleetSnapshot | null,
  environmentId: EnvironmentId,
  current: ReadonlyArray<ProjectWorkerMachine>,
  /** The display name for a machine: its nickname when the user set one. */
  machineName?: (environmentId: EnvironmentId, hostLabel: string) => string,
): ReadonlyArray<WorkerMachineChoice> {
  const choices: WorkerMachineChoice[] = [
    {
      value: LOCAL_WORKER_MACHINE_ID,
      label: "This machine",
      disabled: false,
      machine: { machineId: LOCAL_WORKER_MACHINE_ID, environmentId, projectId: null },
    },
  ];
  for (const machine of snapshot?.machines ?? []) {
    if (machine.environmentId === environmentId) continue;
    const status = machine.workers?.status ?? "not_allowed";
    const allowed = status === "allowed" || status === "expiring";
    const chosen = current.find((entry) => entry.machineId === machine.id);
    if (!allowed && !chosen && !machine.workers) continue;
    const name = machineName?.(machine.environmentId, machine.label) ?? machine.label;
    choices.push({
      value: machine.id,
      label: allowed ? name : `${name} (allow workers in Settings > Machines)`,
      disabled: !allowed && !chosen,
      machine: {
        machineId: machine.id,
        environmentId: machine.environmentId,
        projectId: chosen?.projectId ?? null,
      },
    });
  }
  for (const entry of current) {
    if (choices.some((choice) => choice.value === entry.machineId)) continue;
    choices.push({
      value: entry.machineId,
      // Until the machines are read, a saved one is only not known yet.
      label:
        snapshot === null ? entry.machineId : `${entry.machineId} (not in this server's fleet)`,
      disabled: false,
      machine: entry,
    });
  }
  return choices;
}

/** The ordered list as rows to show, and the machines that can still be added. */
export function workerMachineListView(
  choices: ReadonlyArray<WorkerMachineChoice>,
  list: ReadonlyArray<ProjectWorkerMachine>,
): {
  readonly rows: ReadonlyArray<WorkerMachineChoice>;
  readonly addable: ReadonlyArray<WorkerMachineChoice>;
} {
  const rows = list.map(
    (entry) =>
      choices.find((choice) => choice.value === entry.machineId) ?? {
        value: entry.machineId,
        label: entry.machineId,
        disabled: false,
        machine: entry,
      },
  );
  const addable = choices.filter(
    (choice) => !choice.disabled && !list.some((entry) => entry.machineId === choice.value),
  );
  return { rows, addable };
}

/** Moves the entry at `index` by `delta` places, or returns the list unchanged. */
export function moveWorkerMachine<T>(list: ReadonlyArray<T>, index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/**
 * What to save for a worker machine list. Just this machine saves nothing
 * (the default). `workerMachine` keeps the first other machine for hosts that
 * predate lists, which try it and then run here.
 */
export function workerMachinesPatch(list: ReadonlyArray<ProjectWorkerMachine>): {
  readonly workerMachines: ReadonlyArray<ProjectWorkerMachine> | null;
  readonly workerMachine: ProjectWorkerMachine | null;
} {
  if (list.length === 0 || (list.length === 1 && isLocalWorkerMachine(list[0]!)))
    return { workerMachines: null, workerMachine: null };
  return {
    workerMachines: list,
    workerMachine: list.find((entry) => !isLocalWorkerMachine(entry)) ?? null,
  };
}

/** What removing a machine left valid there, for the notice after Remove. */
export function fleetRemoveNotice(removed: StudioFleetRemoveResult): string {
  const kept = [
    removed.workerAccess === "kept" ? "worker access" : null,
    removed.managementToken === "kept" ? "management token" : null,
  ].filter((part) => part !== null);
  if (kept.length === 0)
    return `Removed ${removed.label} and revoked what this machine held there.`;
  return `Removed ${removed.label} here. ${removed.label} could not be reached, so this machine's ${kept.join(" and ")} there stays valid until it expires. On ${removed.label}, revoke it in Settings > Machines${removed.managementSessionId ? ` (session ${removed.managementSessionId})` : ""}.`;
}

/** Secret files a folder copy sent to a machine; names only, never contents. */
export interface SentSecret {
  readonly folder: string;
  readonly path: string;
  readonly sentAt: string;
}

/** Shown before and after removing a machine that received secret files. */
export function sentSecretsWarning(sent: ReadonlyArray<SentSecret>, label: string): string | null {
  if (sent.length === 0) return null;
  const shown = sent.slice(0, 5).map((entry) => `${entry.folder}/${entry.path}`);
  const more = sent.length > shown.length ? ` and ${sent.length - shown.length} more` : "";
  return `A folder copy sent ${sent.length === 1 ? "a secret file" : `${sent.length} secret files`} to ${label}: ${shown.join(", ")}${more}. Rotate ${sent.length === 1 ? "it" : "them"} if ${label} should no longer hold ${sent.length === 1 ? "it" : "them"}.`;
}
