/**
 * The machines this device waits on for a typed code (1327), and which of those
 * the owner closed the floating card over. Closing only hides the card: the
 * join stays pending, Settings > Machines still shows the code, and the
 * sidebar's "Show code" brings the card back. A closed card stays closed when
 * the machine gives a new code, and across reloads and restarts (see
 * closedJoinCodes for what does bring it back).
 */
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useSyncExternalStore } from "react";

import { useEnvironments } from "../../state/environments";
import {
  closeJoinCodes,
  closedJoinCodesVersion,
  joinCodeClosed,
  reopenJoinCodes,
  subscribeClosedJoinCodes,
} from "./closedJoinCodes";

/** One machine this device waits on, and the code to type there. */
export interface WaitingCode {
  readonly id: EnvironmentId;
  readonly machine: string;
  readonly code: string;
}

/** Close the floating card over these machines; the join itself stays pending. */
export function hideWaitingCodes(entries: ReadonlyArray<Pick<WaitingCode, "id">>) {
  closeJoinCodes(entries.map((entry) => entry.id));
}

/** Bring the floating card back for these machines. */
export function showWaitingCodes(entries: ReadonlyArray<Pick<WaitingCode, "id">>) {
  reopenJoinCodes(entries.map((entry) => entry.id));
}

// Takes the version it was read at, so a render after a change asks again.
const closedAt = (_version: number, machine: string) => joinCodeClosed(machine);

/** Whether the owner closed the card over a machine; re-renders when that changes. */
export function useWaitingCodeHidden(): (entry: Pick<WaitingCode, "id">) => boolean {
  const version = useSyncExternalStore(subscribeClosedJoinCodes, closedJoinCodesVersion);
  return (entry) => closedAt(version, entry.id);
}

/** Every machine this device waits on, whether or not its card is hidden. */
export function useWaitingCodes(): ReadonlyArray<WaitingCode> {
  const { environments } = useEnvironments();
  return environments.flatMap((environment) =>
    environment.connection.deviceApprovalCode !== undefined
      ? [
          {
            id: environment.environmentId,
            machine: environment.label,
            code: environment.connection.deviceApprovalCode,
          },
        ]
      : [],
  );
}
