import type { EnvironmentId } from "@specweave-studio/contracts";
import type { StudioFleetMachine } from "@specweave-studio/contracts/studioFleet";
import { useMemo } from "react";

import { useServerConfigs } from "../../state/entities";
import { useStudioFleet } from "../../studio/fleet";
import { useMachineNicknames } from "../../studio/machineNickname";
import { resolveServerConfigVersionMismatch } from "../../versionSkew";
import type { HandoffDestination } from "./HandoffResults";

/** Why a paired machine can't take work, or what it needs first; null when it is ready. */
export function destinationReason(
  machine: Pick<StudioFleetMachine, "status">,
  needsUpdate: boolean,
): string | null {
  if (machine.status === "unreachable") return "Offline";
  if (machine.status === "identity-mismatch") return "Not connected";
  return needsUpdate ? "Needs an update" : null;
}

/** Paired machines the source server can hand threads to, reachable ones first. */
export function handoffDestinations(
  sourceEnvironmentId: EnvironmentId,
  machines: readonly StudioFleetMachine[],
  name: (environmentId: string, fallback?: string | null) => string,
  includeThisMachine: boolean,
  needsUpdate: (environmentId: EnvironmentId) => boolean = () => false,
): HandoffDestination[] {
  const others = machines
    .filter((machine) => machine.environmentId !== sourceEnvironmentId)
    .map((machine): HandoffDestination => ({
      environmentId: machine.environmentId,
      label: name(machine.environmentId, machine.machineName ?? machine.label),
      state: machine.status === "reachable" ? "reachable" : "offline",
      reason: destinationReason(machine, needsUpdate(machine.environmentId)),
    }))
    .toSorted((left, right) =>
      left.state === right.state
        ? left.label.localeCompare(right.label)
        : left.state === "reachable"
          ? -1
          : 1,
    );
  return includeThisMachine
    ? [
        {
          environmentId: sourceEnvironmentId,
          label: name(sourceEnvironmentId),
          state: "this-machine",
        },
        ...others,
      ]
    : others;
}

export function useHandoffDestinations(
  sourceEnvironmentId: EnvironmentId,
  includeThisMachine: boolean,
) {
  const fleet = useStudioFleet(sourceEnvironmentId);
  const name = useMachineNicknames();
  const configs = useServerConfigs();
  return useMemo(
    () =>
      handoffDestinations(
        sourceEnvironmentId,
        fleet.snapshot?.machines ?? [],
        name,
        includeThisMachine,
        // Known only for machines this window is connected to; the check still catches the rest.
        (environmentId) =>
          resolveServerConfigVersionMismatch(configs.get(environmentId) ?? null) !== null,
      ),
    [configs, fleet.snapshot, includeThisMachine, name, sourceEnvironmentId],
  );
}
