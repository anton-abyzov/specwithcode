import type {
  EnvironmentId,
  LogicalProjectMember,
  ProjectLinkSyncMembersInput,
} from "@specweave-studio/contracts";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";

import { linkMemberOf } from "./projectLink";

/**
 * Member lists follow the coordinator: a copy that joined learns machines
 * linked after it. The servers do this themselves where one holds a grant on
 * the other; the app covers the rest with `projectLink.syncMembers` on
 * servers that report `linkedMembersSync`.
 */

const memberRef = (member: LogicalProjectMember) =>
  JSON.stringify([member.environmentId, member.projectId, member.coordinatorThreadId]);

/** Whether two lists name the same copies, whatever their order or folders. */
export function sameMemberSet(
  left: ReadonlyArray<LogicalProjectMember>,
  right: ReadonlyArray<LogicalProjectMember>,
): boolean {
  const refs = (list: ReadonlyArray<LogicalProjectMember>) =>
    JSON.stringify([...new Set(list.map(memberRef))].toSorted());
  return refs(left) === refs(right);
}

/** The coordinator's list, as a member adopts it; null when the copy does not coordinate. */
export function coordinatorMemberList(coordinator: EnvironmentProject): {
  readonly logicalProjectId: string;
  readonly from: LogicalProjectMember;
  readonly fromEpoch: number;
  readonly members: ReadonlyArray<LogicalProjectMember>;
} | null {
  const identity = coordinator.workspaceSettings?.logicalProject;
  const binding = coordinator.workspaceSettings?.coordinatorBinding;
  if (!identity || (binding !== undefined && binding !== null && binding.state !== "active"))
    return null;
  return {
    logicalProjectId: identity.id,
    from: linkMemberOf(coordinator),
    fromEpoch: binding?.epoch ?? 0,
    members: identity.members,
  };
}

/**
 * The `projectLink.syncMembers` calls that bring each capable member copy's
 * list in line with the coordinator's: one per copy whose list differs.
 */
export function membersSyncRequests(
  coordinator: EnvironmentProject,
  members: ReadonlyArray<EnvironmentProject>,
  capable: (environmentId: EnvironmentId) => boolean,
): Array<{ readonly environmentId: EnvironmentId; readonly input: ProjectLinkSyncMembersInput }> {
  const list = coordinatorMemberList(coordinator);
  if (list === null) return [];
  return members
    .filter((member) => {
      const settings = member.workspaceSettings;
      return (
        member.environmentId !== coordinator.environmentId &&
        settings?.coordinatorBinding?.state === "transferred" &&
        settings.logicalProject?.id === list.logicalProjectId &&
        capable(member.environmentId) &&
        !sameMemberSet(settings.logicalProject.members, list.members)
      );
    })
    .map((member) => ({
      environmentId: member.environmentId,
      input: {
        projectId: member.id,
        logicalProjectId: list.logicalProjectId,
        from: list.from,
        fromEpoch: list.fromEpoch,
        members: list.members,
      },
    }));
}
