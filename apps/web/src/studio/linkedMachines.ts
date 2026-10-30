/**
 * The other machines a shared project names, and which of them this device
 * should connect to. A copy handed off to a worker lists the machine it came
 * from, which runs its coordinator. The fleet pairs machines only from the
 * primary over Tailscale, so a worker's app has no route back to that machine
 * until it saves one; with SpecWithCode Connect signed in, the account's
 * machine list offers it.
 *
 * @module linkedMachines
 */
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { RelayClientEnvironmentRecord } from "@specweave-studio/contracts/relay";

import { coordinatorElsewhere } from "./workersOnlyCopy";

/** Every machine a linked project names: its members and the copies its coordinator moved to. */
export function linkedMachineIds(projects: ReadonlyArray<EnvironmentProject>): Set<string> {
  const ids = new Set<string>();
  for (const project of projects) {
    for (const member of project.workspaceSettings?.logicalProject?.members ?? [])
      ids.add(member.environmentId);
    const successor = project.workspaceSettings?.coordinatorBinding?.successor;
    if (successor) ids.add(successor.environmentId);
  }
  return ids;
}

/**
 * Connect machines to save on this device: named by a linked project, listed
 * for this Connect account, and not saved here yet. Machines the user removed
 * (`skip`) stay removed.
 */
export function linkedMachinesToConnect(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly savedEnvironmentIds: ReadonlySet<string>;
  readonly discovered: ReadonlyMap<string, { readonly environment: RelayClientEnvironmentRecord }>;
  readonly skip: ReadonlySet<string>;
}): RelayClientEnvironmentRecord[] {
  return [...linkedMachineIds(input.projects)]
    .filter((id) => !input.savedEnvironmentIds.has(id) && !input.skip.has(id))
    .flatMap((id) => {
      const found = input.discovered.get(id);
      return found ? [found.environment] : [];
    });
}

/** How a project shared across machines reads in the sidebar; null for a single-machine project. */
export interface SharedProjectBadge {
  /** coordinator: this copy runs the coordinator. workers: its coordinator is on another machine. */
  readonly role: "coordinator" | "workers";
  readonly label: string;
}

/**
 * The badge for the copy a project row opens, named by machine so it reads the
 * same from any device. Reads the shared member list, so a machine this device
 * never loaded still counts, and follows the coordinator along later moves.
 */
export function sharedProjectBadge(
  project: EnvironmentProject | undefined,
  members: ReadonlyArray<EnvironmentProject>,
  nameOf: (environmentId: string) => string,
): SharedProjectBadge | null {
  if (!project) return null;
  const others = [
    ...new Set(
      (project.workspaceSettings?.logicalProject?.members ?? [])
        .map((member) => member.environmentId)
        .filter((id) => id !== project.environmentId),
    ),
  ];
  if (others.length === 0) return null;
  const here = nameOf(project.environmentId);
  const coordinator = coordinatorElsewhere(project, members);
  if (coordinator)
    return {
      role: "workers",
      label: `Handed off: coordinator on ${nameOf(coordinator.environmentId)}, ${here} runs workers`,
    };
  return {
    role: "coordinator",
    label: `Shared from ${here} with ${others.map(nameOf).join(", ")}`,
  };
}
