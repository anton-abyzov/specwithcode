/**
 * "Allow" on a Percy row that says the two machines have no access to each
 * other (1448): the same grant Settings > Machines makes, from the Percy card.
 * It first lets agents here start work on the other machine (this machine
 * then holds a grant there), and when the other machine refuses that, it lets
 * the other machine run work here instead (this machine issues the grant).
 * Either direction is enough for the two to keep Percy in step. An existing
 * grant keeps its access level; a new one gets the default.
 *
 * @module personalShareAllow
 */
import type {
  StudioFleetMachine,
  StudioFleetWorkerAccess,
  StudioFleetWorkers,
} from "@specweave-studio/contracts/studioFleet";

import { DEFAULT_FLEET_WORKER_ACCESS } from "./fleetWorkers";

export interface ShareAllowDeps {
  /** This machine's list of other machines, read fresh. */
  readonly machines: () => Promise<ReadonlyArray<StudioFleetMachine>>;
  /** Agents here may start work on `id` (Settings > Machines > Allow). */
  readonly allowThere: (id: string, access: StudioFleetWorkerAccess) => Promise<StudioFleetWorkers>;
  /** `id` may run work here, asked of it with the token this machine holds there. */
  readonly allowHere: (id: string, access: StudioFleetWorkerAccess) => Promise<StudioFleetWorkers>;
}

export type ShareAllowResult =
  | { readonly ok: true; readonly direction: "there" | "here" }
  | { readonly ok: false; readonly reason: "not_listed" | "refused"; readonly message: string };

const usable = (workers: StudioFleetWorkers | undefined) =>
  workers?.status === "allowed" || workers?.status === "expiring";

const messageOf = (failure: unknown) =>
  failure instanceof Error ? failure.message : "That machine did not answer.";

/** Allows work between this machine and `peerEnvironmentId`, one direction or the other. */
export async function allowShareMachine(
  deps: ShareAllowDeps,
  peerEnvironmentId: string,
  label: string,
): Promise<ShareAllowResult> {
  const machine = (await deps.machines()).find(
    (candidate) => candidate.environmentId === peerEnvironmentId,
  );
  if (machine === undefined)
    return {
      ok: false,
      reason: "not_listed",
      message: `${label} is not in this machine's list of machines. Press Allow on ${label}'s Percy card instead.`,
    };
  const access = machine.workers?.access ?? DEFAULT_FLEET_WORKER_ACCESS;
  let thereFailure: string | null = null;
  try {
    if (usable(await deps.allowThere(machine.id, access))) return { ok: true, direction: "there" };
  } catch (failure) {
    thereFailure = messageOf(failure);
  }
  try {
    if (usable(await deps.allowHere(machine.id, access))) return { ok: true, direction: "here" };
  } catch (failure) {
    return { ok: false, reason: "refused", message: `${label}: ${messageOf(failure)}` };
  }
  return {
    ok: false,
    reason: "refused",
    message: `${label} did not allow work with this machine.${thereFailure ? ` ${thereFailure}` : ""}`,
  };
}
