import type { EnvironmentId } from "@specweave-studio/contracts";
import type { StudioFleetMachine } from "@specweave-studio/contracts/studioFleet";
import { useMemo } from "react";

import { useStudioFleet } from "../../studio/fleet";
import { useMachineNicknames } from "../../studio/machineNickname";
import type { HandoffDestination } from "./HandoffResults";

/** Paired machines the source server can hand threads to, reachable ones first. */
export function handoffDestinations(
  sourceEnvironmentId: EnvironmentId,
  machines: readonly StudioFleetMachine[],
  name: (environmentId: string, fallback?: string | null) => string,
  includeThisMachine: boolean,
): HandoffDestination[] {
  const others = machines
    .filter((machine) => machine.environmentId !== sourceEnvironmentId)
    .map((machine): HandoffDestination => ({
      environmentId: machine.environmentId,
      label: name(machine.environmentId, machine.machineName ?? machine.label),
      state: machine.status === "reachable" ? "reachable" : "offline",
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
  return useMemo(
    () =>
      handoffDestinations(
        sourceEnvironmentId,
        fleet.snapshot?.machines ?? [],
        name,
        includeThisMachine,
      ),
    [fleet.snapshot, includeThisMachine, name, sourceEnvironmentId],
  );
}
