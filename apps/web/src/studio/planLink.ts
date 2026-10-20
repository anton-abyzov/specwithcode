import { createEnvironmentRpcCommand } from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  type EnvironmentId,
  type ProjectId,
  type ProjectPlanLinkExport,
  WS_METHODS,
} from "@specweave-studio/contracts";
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

export interface LinkedPlanMember {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly label: string;
}

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

export interface LinkedPlanTransport {
  /** The member's plan, or null when it cannot be read now. */
  readonly exportPlan: (member: LinkedPlanMember) => Promise<ProjectPlanLinkExport | null>;
  readonly mergePlan: (
    target: LinkedPlanMember,
    peer: LinkedPlanMember,
    exported: ProjectPlanLinkExport,
  ) => Promise<void>;
}

/**
 * One two-way pass over a linked project's reachable members: every plan is
 * read before any is changed, so both sides merge the same pair of copies and
 * converge even when one merge fails; the next pass repeats it.
 */
export async function syncLinkedPlans(
  members: ReadonlyArray<LinkedPlanMember>,
  transport: LinkedPlanTransport,
): Promise<void> {
  const exports: Array<{ member: LinkedPlanMember; exported: ProjectPlanLinkExport }> = [];
  for (const member of members) {
    const exported = await transport.exportPlan(member).catch(() => null);
    if (exported) exports.push({ member, exported });
  }
  if (exports.length < 2) return;
  for (const { member: peer, exported } of exports)
    for (const { member: target } of exports) {
      if (target.environmentId === peer.environmentId) continue;
      await transport.mergePlan(target, peer, exported).catch(() => undefined);
    }
}
