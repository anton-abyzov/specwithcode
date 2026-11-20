/**
 * The chat banner for a machine that is not connected.
 *
 * @module environmentUnavailableBanner
 */
import {
  isMachineReachDown,
  type EnvironmentConnectionPresentation,
  type MachineReachState,
} from "@specweave-studio/client-runtime/connection";

import { englishPhrase } from "../../i18n";
import {
  IDENTITY_MISMATCH_STATUS,
  hostDownNoteShown,
  identityMismatchShown,
  isThisMachineCatchingUp,
  lastSeenLabel,
  machineDetail,
  machineReachDetail,
  machineReachWords,
  machineStatus,
  machineUnavailableTitle,
  reachFromPhase,
  THIS_MACHINE_BUSY_TITLE,
  type HostDownNote,
  type MachineStatus,
} from "../../lib/machineStatus";

/**
 * What the calm banner for the app's own machine says under its title. Sends
 * are refused until it catches up (nothing queues them), so it says that and
 * that the draft is kept.
 */
export const THIS_MACHINE_BUSY_DESCRIPTION =
  "You can send once it catches up; your draft stays in the composer.";

/**
 * The chat banner for a machine that is not connected. Another machine reads
 * by its reach state: one calm line while it reconnects, then why it is down,
 * when it last answered and that the app retries. The app's own machine is only
 * busy while its server catches up, so it gets one calm line and no failure,
 * reason or retry; "Connection failed" is kept for a stopped connection there.
 */
export function environmentUnavailableBanner(input: {
  readonly label: string;
  readonly connection: Pick<EnvironmentConnectionPresentation, "phase" | "error"> &
    Partial<Pick<EnvironmentConnectionPresentation, "connectSignInRequired">>;
  readonly isThisMachine: boolean;
  /** What the machine reads as now (`machineReach`); judged by phase when omitted. */
  readonly reach?: MachineReachState | undefined;
  /** The fleet says its address now answers as a different SpecWithCode. */
  readonly identityMismatch?: boolean | undefined;
  /** Why it is out of reach beyond its reach state ("Needs sign-in"). */
  readonly note?: HostDownNote | null | undefined;
}): {
  /** Nothing is wrong yet: this machine is busy, or another one is reconnecting. */
  readonly calm: boolean;
  readonly variant: "error" | "warning" | "info";
  readonly title: string;
  readonly status: MachineStatus;
  /** The banner waits out the reconnect grace before it shows. */
  readonly waitsForGrace: boolean;
  /** The line under the title, given when the machine last answered. */
  readonly describe: (lastAnsweredAt: number | null, now: number) => string;
} {
  const { label, connection, isThisMachine } = input;
  const status = machineStatus(connection, true, isThisMachine);
  const waitsForGrace = environmentWaitsForReconnectGrace(connection.phase, isThisMachine);
  if (isThisMachine) {
    if (isThisMachineCatchingUp(connection.phase))
      return {
        calm: true,
        variant: "info",
        title: THIS_MACHINE_BUSY_TITLE,
        status,
        waitsForGrace,
        describe: () => THIS_MACHINE_BUSY_DESCRIPTION,
      };
    return {
      calm: false,
      variant: connection.phase === "error" ? "error" : "warning",
      title: machineUnavailableTitle(label, connection, true),
      status,
      waitsForGrace,
      describe: (lastAnsweredAt, now) =>
        machineDetail(lastSeenLabel(lastAnsweredAt, now), status.reason),
    };
  }
  const reach = input.reach ?? reachFromPhase(connection.phase);
  const words = machineReachWords(
    reach,
    connection.phase,
    input.identityMismatch,
    input.note ?? null,
  );
  const title = englishPhrase(words.headline, { machine: label });
  if (!isMachineReachDown(reach))
    return { calm: true, variant: "info", title, status, waitsForGrace, describe: () => "" };
  // Retrying never reaches the right machine: no retry, only the step that fixes it.
  if (identityMismatchShown(reach, input.identityMismatch))
    return {
      calm: false,
      variant: "warning",
      title,
      status: IDENTITY_MISMATCH_STATUS,
      waitsForGrace,
      describe: (lastAnsweredAt, now) => machineReachDetail(words, lastAnsweredAt, now) ?? "",
    };
  // Signing in fixes it: a step to take, not a failure of the machine.
  const signIn = hostDownNoteShown(reach, input.note) && input.note === "needs-sign-in";
  return {
    calm: false,
    variant: connection.phase === "error" && !signIn ? "error" : "warning",
    title,
    status,
    waitsForGrace,
    describe: (lastAnsweredAt, now) =>
      [
        machineReachDetail(words, lastAnsweredAt, now),
        words.hint?.replace(/\.$/, "") ?? null,
        // A stopped connection says why (sign in again, pair again): that is
        // the step the person takes. A machine that is only silent has none.
        reach === "stopped"
          ? machineDetail(lastSeenLabel(lastAnsweredAt, now), status.reason)
          : null,
      ]
        .filter(Boolean)
        .join(". "),
  };
}

/**
 * Whether a machine's unavailable banner waits out the reconnect grace, which
 * is also when the grace timer must run. Another machine waits only while it
 * is connecting or reconnecting. The app's own machine waits in every phase
 * where it is catching up (including "available"), so the calm banner always
 * shows once the grace passes instead of staying hidden.
 */
export function environmentWaitsForReconnectGrace(
  phase: EnvironmentConnectionPresentation["phase"],
  isThisMachine: boolean,
): boolean {
  if (isThisMachine && isThisMachineCatchingUp(phase)) return true;
  return phase === "connecting" || phase === "reconnecting";
}
