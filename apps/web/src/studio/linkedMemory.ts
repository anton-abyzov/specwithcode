import { createEnvironmentRpcCommand } from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { type EnvironmentId, WS_METHODS } from "@specweave-studio/contracts";
import type { LinkedMemoryMember } from "@specweave-studio/shared/linkedMemorySync";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import { connectionAtomRuntime } from "../connection/runtime";

export {
  type LinkedMemoryDriver,
  type LinkedMemoryExportOptions,
  type LinkedMemoryMember,
  syncLinkedMemory,
} from "@specweave-studio/shared/linkedMemorySync";

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

/**
 * Copies of each linked project that can exchange memory now, one list per
 * logical project. The coordinator's server also syncs them while no window is
 * open, but only toward machines it holds a grant for, so the window keeps going:
 * equal digests make its pass two cheap exports. A personal assistant is
 * never in a group: its memory moves only between the owner's servers, under
 * the share rules, and the servers refuse it from a window (1448 D-13).
 */
export function linkedMemoryGroups(
  projects: ReadonlyArray<EnvironmentProject>,
  ready: (environmentId: EnvironmentId) => boolean,
  label: (environmentId: EnvironmentId) => string,
): LinkedMemoryMember[][] {
  const groups = new Map<string, LinkedMemoryMember[]>();
  // A copy takes part once another copy of the project lists it. A link's last step
  // is the kept copy listing the one that joined, after writing the notes its review
  // chose: syncing the joined copy before that would merge notes the review settles.
  const listed = new Set(
    projects.flatMap((project) => {
      const identity = project.workspaceSettings?.logicalProject;
      return (identity?.members ?? [])
        .filter(
          (member) =>
            member.environmentId !== project.environmentId || member.projectId !== project.id,
        )
        .map((member) => `${identity!.id}\n${member.environmentId}\n${member.projectId}`);
    }),
  );
  for (const project of projects) {
    const id = project.workspaceSettings?.logicalProject?.id;
    if (!id || !ready(project.environmentId)) continue;
    if (isPersonalAssistantProject(project)) continue;
    if (!listed.has(`${id}\n${project.environmentId}\n${project.id}`)) continue;
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
