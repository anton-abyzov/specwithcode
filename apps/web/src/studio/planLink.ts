import { createEnvironmentRpcCommand } from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { type EnvironmentId, WS_METHODS } from "@specweave-studio/contracts";
import type { LinkedPlanMember } from "@specweave-studio/shared/linkedPlanSync";
import { connectionAtomRuntime } from "../connection/runtime";

export const planLink = {
  export: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "plan-link:export",
    tag: WS_METHODS.projectLinkPlanExport,
  }),
  merge: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "plan-link:merge",
    tag: WS_METHODS.projectLinkPlanMerge,
  }),
};

export {
  type LinkedPlanMember,
  type LinkedPlanTransport,
  syncLinkedPlans,
} from "@specweave-studio/shared/linkedPlanSync";

/**
 * The reachable members of each linked project, grouped by logical project;
 * a group needs two machines to have anything to sync.
 */
export function linkedPlanGroups(
  projects: ReadonlyArray<EnvironmentProject>,
  machine: (environmentId: EnvironmentId) => { readonly label: string } | null,
): LinkedPlanMember[][] {
  const groups = new Map<string, LinkedPlanMember[]>();
  for (const project of projects) {
    const id = project.workspaceSettings?.logicalProject?.id;
    const reachable = id ? machine(project.environmentId) : null;
    if (!id || !reachable) continue;
    groups.set(id, [
      ...(groups.get(id) ?? []),
      { environmentId: project.environmentId, projectId: project.id, label: reachable.label },
    ]);
  }
  return [...groups.values()].filter(
    (members) => new Set(members.map((member) => member.environmentId)).size > 1,
  );
}
