import type { EnvironmentId, ProjectWorkerMachine, RuntimeMode } from "@specweave-studio/contracts";
import type {
  StudioFleetSnapshot,
  StudioFleetWorkerAccess,
  StudioFleetWorkers,
} from "@specweave-studio/contracts/studioFleet";
import { runtimeModeConfig, runtimeModeOptions } from "../components/chat/runtimeModeConfig";

/** The same names the composer's permission picker uses. */
export const FLEET_WORKER_ACCESS_CHOICES: ReadonlyArray<{
  readonly value: StudioFleetWorkerAccess;
  readonly label: string;
}> = runtimeModeOptions.map((mode) => ({ value: mode, label: runtimeModeConfig[mode].label }));

/** Workers get no more by default than this server's own threads start with. */
export const defaultFleetWorkerAccess = (
  defaultRuntimeMode: RuntimeMode,
): StudioFleetWorkerAccess => defaultRuntimeMode;

const accessLabel = (access: StudioFleetWorkerAccess | null) =>
  access === null ? "Auto" : runtimeModeConfig[access].label;

const PROBLEMS: Record<NonNullable<StudioFleetWorkers["problem"]>, string> = {
  unsupported: "That machine's Studio is too old to run workers for another machine.",
  route_mismatch: "That machine answers on a different address than configured here.",
  pairing_unavailable:
    "This server cannot create a pairing code there. Paste a code made on that machine.",
  pairing_code_rejected: "That machine did not accept the pairing code. Make a new one.",
  unreachable: "That machine could not be reached.",
  identity_mismatch: "A different Studio answers at that machine's address.",
};

export interface FleetWorkersView {
  /** One line on whether coordinators here may start workers there. */
  readonly summary: string;
  /** Why the last attempt did not finish, when it did not. */
  readonly problem: string | null;
  readonly action: "allow" | "stop";
  /** Allowing needs a pairing code made on that machine. */
  readonly codeNeeded: boolean;
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** What the Workers row of a fleet machine says and offers. */
export function fleetWorkersView(workers: StudioFleetWorkers): FleetWorkersView {
  const problem = workers.problem ? PROBLEMS[workers.problem] : null;
  const codeNeeded =
    !workers.renewable ||
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
      };
    }
    case "revoked":
      return {
        summary: "That machine revoked this server's access. Allow again to resume workers.",
        problem,
        action: "allow",
        codeNeeded,
      };
    case "expired":
      return {
        summary: "Access expired. Allow again to start workers there.",
        problem,
        action: "allow",
        codeNeeded,
      };
    case "not_allowed":
      return {
        summary: "Coordinators here cannot start workers on this machine.",
        problem,
        action: "allow",
        codeNeeded,
      };
  }
}

export interface WorkerMachineChoice {
  /** "local", or the fleet machine id. */
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly machine: ProjectWorkerMachine | null;
}

/**
 * Where a project's coordinator starts workers: here, or a fleet machine this
 * server may start workers on. A machine already chosen stays listed, so a
 * lapsed grant is visible instead of silently reading as "This machine".
 */
export function workerMachineChoices(
  snapshot: StudioFleetSnapshot | null,
  environmentId: EnvironmentId,
  current: ProjectWorkerMachine | null,
): ReadonlyArray<WorkerMachineChoice> {
  const choices: WorkerMachineChoice[] = [
    { value: "local", label: "This machine", disabled: false, machine: null },
  ];
  for (const machine of snapshot?.machines ?? []) {
    if (machine.environmentId === environmentId) continue;
    const status = machine.workers?.status ?? "not_allowed";
    const allowed = status === "allowed" || status === "expiring";
    const chosen = current?.machineId === machine.id;
    if (!allowed && !chosen && !machine.workers) continue;
    choices.push({
      value: machine.id,
      label: allowed ? machine.label : `${machine.label} (allow workers in Settings > Connections)`,
      disabled: !allowed && !chosen,
      machine: {
        machineId: machine.id,
        environmentId: machine.environmentId,
        projectId: chosen ? current.projectId : null,
      },
    });
  }
  if (current && !choices.some((choice) => choice.value === current.machineId))
    choices.push({
      value: current.machineId,
      // Until the machines are read, a saved one is only not known yet.
      label:
        snapshot === null ? current.machineId : `${current.machineId} (not in this server's fleet)`,
      disabled: false,
      machine: current,
    });
  return choices;
}
