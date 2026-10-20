import { createEnvironmentRpcCommand } from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  type EnvironmentId,
  type LinkedMemoryExport,
  type ProjectId,
  WS_METHODS,
} from "@specweave-studio/contracts";
import { connectionAtomRuntime } from "../connection/runtime";

export const linkedMemory = {
  export: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "linked-memory:export",
    tag: WS_METHODS.projectLinkMemoryExport,
  }),
  merge: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "linked-memory:merge",
    tag: WS_METHODS.projectLinkMemoryMerge,
  }),
};

export interface LinkedMemoryMember {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly label: string;
}

export interface LinkedMemoryDriver {
  /** The member's memory, or null when it could not be read now. */
  readonly exportMemory: (member: LinkedMemoryMember) => Promise<LinkedMemoryExport | null>;
  /** Merges the peer's memory into the member; false when the member refused or failed. */
  readonly mergeMemory: (
    member: LinkedMemoryMember,
    peer: LinkedMemoryMember,
    memory: LinkedMemoryExport,
  ) => Promise<boolean>;
}

/** Copies of each linked project that can exchange memory now, one list per logical project. */
export function linkedMemoryGroups(
  projects: ReadonlyArray<EnvironmentProject>,
  ready: (environmentId: EnvironmentId) => boolean,
  label: (environmentId: EnvironmentId) => string,
): LinkedMemoryMember[][] {
  const groups = new Map<string, LinkedMemoryMember[]>();
  for (const project of projects) {
    const id = project.workspaceSettings?.logicalProject?.id;
    if (!id || !ready(project.environmentId)) continue;
    groups.set(id, [
      ...(groups.get(id) ?? []),
      {
        environmentId: project.environmentId,
        projectId: project.id,
        label: label(project.environmentId).slice(0, 200),
      },
    ]);
  }
  return [...groups.values()].filter(
    (members) => new Set(members.map((member) => member.environmentId)).size > 1,
  );
}

const fingerprint = (memory: LinkedMemoryExport) =>
  JSON.stringify([
    memory.files.map((file) => [file.name, file.contentSha256]).toSorted(),
    memory.tombstones.map((tombstone) => tombstone.name).toSorted(),
  ]);

/** Both copies hold the same files and deletions, so the pair has nothing to merge. */
const agree = (left: LinkedMemoryExport, right: LinkedMemoryExport) =>
  !left.truncated && !right.truncated && fingerprint(left) === fingerprint(right);

const settle = async <A>(run: () => Promise<A>, fallback: A): Promise<A> => {
  try {
    return await run();
  } catch {
    return fallback;
  }
};

/**
 * One pass of two-way memory replication. Every pair of reachable copies is
 * exported on both sides first, then each side merges the other's export, so a
 * failure on one side never changes what the other side sees. A pair that
 * fails is skipped until the next pass.
 */
export async function syncLinkedMemory(
  groups: ReadonlyArray<ReadonlyArray<LinkedMemoryMember>>,
  driver: LinkedMemoryDriver,
): Promise<void> {
  for (const members of groups) {
    for (const [index, left] of members.entries()) {
      for (const right of members.slice(index + 1)) {
        if (left.environmentId === right.environmentId) continue;
        const fromLeft = await settle(() => driver.exportMemory(left), null);
        if (!fromLeft) continue;
        const fromRight = await settle(() => driver.exportMemory(right), null);
        if (!fromRight || agree(fromLeft, fromRight)) continue;
        await settle(() => driver.mergeMemory(left, right, fromRight), false);
        await settle(() => driver.mergeMemory(right, left, fromLeft), false);
      }
    }
  }
}
