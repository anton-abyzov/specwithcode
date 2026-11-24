/**
 * Whether this app holds a thread's alert back because the thread's owner
 * machine is in use (1436 D-07, AC-11, AC-12). The owner machine shows the
 * alert then, and every other app shows nothing: no toast, no system
 * notification, no sound. Anything short of the owner's server saying a
 * person is there now (an unknown or unreachable owner, a failed or slow read,
 * an older server, "not in use") shows the alert as before, so none is lost.
 *
 * @module notificationOwnerHold
 */
import type { EnvironmentId } from "@specweave-studio/contracts";

import { readNotificationTarget, type NotificationTargetRead } from "./notificationTarget";

/**
 * A held alert is read again once, after the owner's 120 s in-use window has
 * run out, and shown if it still applies and the owner is no longer in use.
 */
export const OWNER_HOLD_RECHECK_MS = 122_000;

export type OwnerHoldWhy =
  /** The alert is this machine's own, so nothing is read. */
  | "own-machine"
  /** This app does not know its own machine yet, so nothing is read. */
  | "own-machine-unknown"
  /** This app cannot reach the owner machine, or does not know it. */
  | "owner-unreachable"
  /** The read failed or timed out. */
  | "read-failed"
  /** The owner's server is too old to say. */
  | "no-field"
  | "owner-idle"
  | "owner-in-use";

export interface OwnerHold {
  readonly hold: boolean;
  readonly why: OwnerHoldWhy;
  /** The owner server's answer; null when it was not read or did not say. */
  readonly ownerInUse: boolean | null;
}

/** The decision for one alert, given the owner machine's read (undefined when not read). */
export function ownerHoldsAlert(input: {
  readonly ownEnvironmentId: string | null;
  readonly ownerMachineId: string;
  readonly ownerReachable: boolean;
  readonly ownerRead: NotificationTargetRead | undefined;
}): OwnerHold {
  if (input.ownEnvironmentId === input.ownerMachineId)
    return { hold: false, why: "own-machine", ownerInUse: null };
  // Before this app knows its own machine it cannot tell whose alert it is.
  if (input.ownEnvironmentId === null)
    return { hold: false, why: "own-machine-unknown", ownerInUse: null };
  if (!input.ownerReachable) return { hold: false, why: "owner-unreachable", ownerInUse: null };
  const ownerInUse = input.ownerRead?.ownerInUse;
  if (ownerInUse === undefined)
    return {
      hold: false,
      // A read that failed comes back "unknown" with nothing else in it.
      why:
        input.ownerRead === undefined ||
        (input.ownerRead.status === "unknown" && !input.ownerRead.ownerAppConnected)
          ? "read-failed"
          : "no-field",
      ownerInUse: null,
    };
  return ownerInUse
    ? { hold: true, why: "owner-in-use", ownerInUse }
    : { hold: false, why: "owner-idle", ownerInUse };
}

/**
 * Reads the owner machine's server when the decision needs it, within the
 * read's own 1.5 s timeout, and decides. Never rejects.
 */
export async function readOwnerHold(input: {
  readonly ownEnvironmentId: string | null;
  readonly ownerMachineId: string;
  readonly ownerReachable: boolean;
}): Promise<OwnerHold & { readonly ownerRead: NotificationTargetRead | undefined }> {
  const needsRead =
    input.ownerReachable &&
    input.ownEnvironmentId !== null &&
    input.ownEnvironmentId !== input.ownerMachineId;
  const ownerRead = needsRead
    ? await readNotificationTarget(input.ownerMachineId as EnvironmentId)
    : undefined;
  return { ...ownerHoldsAlert({ ...input, ownerRead }), ownerRead };
}
