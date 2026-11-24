// The attention members each sidebar row reads, as the machines would report
// them: live for a reachable seat, offline for Tower. Root selection and the
// counts built from them are the real ones.
import { useMemo } from "react";
import {
  expandAttentionProjects,
  type AttentionProjectMember,
} from "../../src/studio/useProjectAttention";

export * from "../../src/studio/useProjectAttention";

export function useAttentionMembers(projects: readonly AttentionProjectMember[]) {
  return useMemo(
    () =>
      expandAttentionProjects(projects).map((project) => ({
        environmentId: project.environmentId,
        projectId: project.id,
        coordinatorThreadId:
          project.workspaceSettings?.coordinatorThreadId ?? `project-coordinator:${project.id}`,
        includeUserRoots: Boolean(project.workspaceSettings?.logicalProject),
        freshness: project.environmentId === "tower" ? ("offline" as const) : ("live" as const),
        remoteWorkers: [],
        remoteWorkersComplete: true,
      })),
    [projects],
  );
}
