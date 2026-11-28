/**
 * "Allow" on a Percy row that says the two machines have no access to each
 * other (1448): the same grant Settings > Machines makes, from the Percy card.
 * It first lets agents here start work on the other machine (this machine
 * then holds a grant there), and when the other machine refuses that, it lets
 * the other machine run work here instead (this machine issues the grant).
 * Both use the management key this machine saved for the other one. When
 * that key is gone or refused (the other machine answers 401), the line goes
 * over this app's own SpecWithCode Connect sign-in there instead, as Settings
 * > Machines does for a machine of the same account: no saved key is needed.
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
  /**
   * The other machine may run work here, with this machine's line handed over
   * through this app's Connect sign-in there. Absent when this app has no such
   * sign-in or that machine cannot take a line that way.
   */
  readonly throughAccount?:
    | ((access: StudioFleetWorkerAccess) => Promise<StudioFleetWorkers>)
    | undefined;
}

export type ShareAllowResult =
  | { readonly ok: true; readonly direction: "there" | "here" | "account" }
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
  const access = machine?.workers?.access ?? DEFAULT_FLEET_WORKER_ACCESS;
  // What each route said, so a refusal names every reason, not only the last.
  const failures: string[] = [];
  if (machine !== undefined) {
    try {
      if (usable(await deps.allowThere(machine.id, access)))
        return { ok: true, direction: "there" };
    } catch (failure) {
      failures.push(messageOf(failure));
    }
    try {
      if (usable(await deps.allowHere(machine.id, access))) return { ok: true, direction: "here" };
    } catch (failure) {
      failures.push(messageOf(failure));
    }
  }
  if (deps.throughAccount !== undefined) {
    try {
      if (usable(await deps.throughAccount(access))) return { ok: true, direction: "account" };
    } catch (failure) {
      failures.push(messageOf(failure));
    }
  } else if (machine === undefined)
    return {
      ok: false,
      reason: "not_listed",
      message: `${label} is not in this machine's list of machines, and this app is not signed in to it through SpecWithCode Connect. Press Allow on ${label}'s Percy card instead.`,
    };
  const said = [...new Set(failures)].join(" ");
  return {
    ok: false,
    reason: "refused",
    message: `${label} did not allow work with this machine.${said === "" ? "" : ` ${said}`}`,
  };
}
