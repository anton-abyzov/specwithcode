import { projectRemoteAttentionAtom } from "./fleet";
import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { EnvironmentId } from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import {
  aggregateProjectAttention,
  type AttentionMember,
} from "@specweave-studio/client-runtime/state/projectAttention";
import { environmentShell } from "../state/shell";
import { projectCoordinatorRole } from "./projectCoordinatorThreads";
import { isAgentOwnedProjectThread } from "./projectPaneThreads";
import { isNestedSubagentThread } from "./threadSubagents";
import { useUnreachableHosts } from "./unreachableHosts";

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
export function useAttentionMembers(projects: readonly AttentionProjectMember[]) {
  const unreachable = useUnreachableHosts();
  const observations = useMemo(
    () =>
      Atom.make((get): AttentionMember[] =>
        expandAttentionProjects(projects).map((project) => {
          const shell = get(
            environmentShell.stateValueAtom(EnvironmentId.make(project.environmentId)),
          );
          const remote = get(
            projectRemoteAttentionAtom(
              JSON.stringify({ environmentId: project.environmentId, projectId: project.id }),
            ),
          );
          return {
            includeUserRoots: Boolean(project.workspaceSettings?.logicalProject),
            remoteWorkers: remote.workers,
            remoteWorkersComplete: remote.complete,
            environmentId: project.environmentId,
            projectId: project.id,
            coordinatorThreadId:
              project.workspaceSettings?.coordinatorThreadId ?? `project-coordinator:${project.id}`,
            freshness: unreachable.has(project.environmentId)
              ? "offline"
              : Option.isNone(shell.snapshot) ||
                  !shell.snapshot.value.projects.some((p) => p.id === project.id)
                ? "empty"
                : shell.status,
          };
        }),
      ),
    [projects, unreachable],
  );
  return useAtomValue(observations);
}
export function useProjectAttention(
  threads: readonly EnvironmentThreadShell[],
  projects: readonly AttentionProjectMember[],
) {
  const members = useAttentionMembers(projects);
  return useMemo(
    () =>
      aggregateProjectAttention({
        members,
        roots: projectAttentionRoots(threads, members),
        threads,
      }),
    [members, threads],
  );
}
