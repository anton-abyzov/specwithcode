/**
 * The linked Percy's chat list is one list over every joined machine (1448
 * AC-20). A machine this window cannot reach contributes no chats: it gets one
 * quiet line naming it, in place of a warning about an incomplete list.
 *
 * @module LinkedAssistantOfflineSeats
 */
import { isMachineReachDown } from "@specweave-studio/client-runtime/connection";

import { useTx } from "../../i18n";
import { useMachineStillChecking } from "../../studio/machineChecking";
import { useMachineNicknames } from "../../studio/machineNickname";
import type { ProjectExecutionScope } from "../../studio/projectDomain";
import { hostReachOr, useHostReachStates } from "../../studio/unreachableHosts";
import { useNamedEnvironments } from "../settings/useNamedEnvironments";

export const LINKED_SEAT_OFFLINE_PHRASE = "{machine} is offline: its chats appear when it is back";

/** How a seat's machine reads from this window: saved here or not, and whether it answers. */
export interface SeatMachineReach {
  readonly environmentId: string;
  /** Saved in this window's machine list. */
  readonly known: boolean;
  /** `connected`, or any other reach state; undefined for a machine not saved here. */
  readonly state: string | undefined;
  /** The window is still finding out, so nothing is said yet. */
  readonly checking: boolean;
  /** The reach state means the machine does not answer (not just reconnecting). */
  readonly down: boolean;
}

/**
 * The seats' machines to name as offline, once each: one not saved here, and
 * one that does not answer. A machine that is connecting or catching up is not
 * named: its chats are about to arrive.
 */
export function offlineSeatMachines(
  scopes: ReadonlyArray<{ readonly environmentId: string }>,
  reachOf: (environmentId: string) => SeatMachineReach,
): string[] {
  const offline: string[] = [];
  for (const environmentId of new Set(scopes.map((scope) => scope.environmentId))) {
    const reach = reachOf(environmentId);
    if (reach.state === "connected" || reach.checking) continue;
    if (!reach.known || reach.down) offline.push(environmentId);
  }
  return offline;
}

const RAW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

export function LinkedAssistantOfflineSeats({
  scopes,
}: {
  readonly scopes: readonly ProjectExecutionScope[];
}) {
  const tx = useTx();
  const { environments } = useNamedEnvironments();
  const nickname = useMachineNicknames();
  const stillChecking = useMachineStillChecking();
  const reach = useHostReachStates();
  const offline = offlineSeatMachines(scopes, (environmentId) => {
    const environment = environments.find((entry) => entry.environmentId === environmentId);
    const state = environment
      ? hostReachOr(reach.get(environmentId), environment.connection)
      : undefined;
    return {
      environmentId,
      known: environment !== undefined,
      state,
      checking: stillChecking(environmentId),
      down: state !== undefined && isMachineReachDown(state),
    };
  });
  if (offline.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0" data-linked-seats-offline>
      {offline.map((environmentId) => {
        const environment = environments.find((entry) => entry.environmentId === environmentId);
        const known = nickname(environmentId);
        // A machine never saved here has no label: never show its raw id.
        const machine =
          environment?.label ??
          (known === environmentId && RAW_ID.test(known) ? tx("Another machine") : known);
        return (
          <li
            key={environmentId}
            className="px-2 py-1 text-muted-foreground text-xs"
            role="status"
            data-linked-seat-offline={environmentId}
          >
            {tx(LINKED_SEAT_OFFLINE_PHRASE, { machine })}
          </li>
        );
      })}
    </ul>
  );
}
