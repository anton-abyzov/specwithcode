// Pure scope rules for project attention. They live apart from the React hooks
// in useProjectAttention so callers and tests can use them without loading the
// fleet and shell atom graph.
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import type { AttentionMember } from "@specweave-studio/client-runtime/state/projectAttention";
import { projectCoordinatorRole } from "./projectCoordinatorThreads";
import { isAgentOwnedProjectThread } from "./projectPaneThreads";
import { isNestedSubagentThread } from "./threadSubagents";

export interface AttentionProjectMember {
  readonly environmentId: string;
  readonly id: string;
  readonly workspaceSettings?:
    | {
        readonly coordinatorThreadId?: string | null | undefined;
        readonly logicalProject?:
          | {
              readonly members: readonly {
                environmentId: string;
                projectId: string;
                coordinatorThreadId: string;
              }[];
            }
          | undefined;
      }
    | null
    | undefined;
}
export function projectAttentionRoots(
  threads: readonly EnvironmentThreadShell[],
  members: readonly AttentionMember[],
) {
  return threads.filter((thread) => {
    const member = members.find(
      (m) => m.environmentId === thread.environmentId && m.projectId === thread.projectId,
    );
    if (!member) return false;
    const coordinator = member.coordinatorThreadId;
    const role = projectCoordinatorRole(thread.id, {
      projectId: member.projectId,
      coordinatorThreadId: coordinator,
    });
    if (role !== null) return role === "current";
    return (
      !isNestedSubagentThread(thread, new Set(coordinator ? [coordinator] : [])) &&
      (member.includeUserRoots ||
        isAgentOwnedProjectThread(thread, coordinator, (id) =>
          threads.find(
            (t) =>
              t.environmentId === thread.environmentId &&
              t.projectId === thread.projectId &&
              t.id === id,
          ),
        ))
    );
  });
}
export function expandAttentionProjects(
  projects: readonly AttentionProjectMember[],
): AttentionProjectMember[] {
  const result = new Map(projects.map((p) => [JSON.stringify([p.environmentId, p.id]), p]));
  for (const project of projects)
    for (const member of project.workspaceSettings?.logicalProject?.members ?? []) {
      const key = JSON.stringify([member.environmentId, member.projectId]);
      if (!result.has(key))
        result.set(key, {
          environmentId: member.environmentId,
          id: member.projectId,
          workspaceSettings: {
            coordinatorThreadId: member.coordinatorThreadId,
            logicalProject: project.workspaceSettings?.logicalProject,
          },
        });
    }
  return [...result.values()];
}
