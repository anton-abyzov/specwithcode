import { ThreadId, type EnvironmentId, type ProjectId } from "@specweave-studio/contracts";
import { useProject, useThreadShell } from "../state/entities";

/**
 * The provider instance a project's coordinator runs with on `environmentId`, read from its
 * coordinator thread there. Null when the project, its coordinator or that thread is not known.
 */
export function useCoordinatorProvider(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): string | null {
  const project = useProject(projectId ? { environmentId, projectId } : null);
  const threadId =
    project?.workspaceSettings?.coordinatorThreadId ??
    (projectId ? ThreadId.make(`project-coordinator:${projectId}`) : null);
  const thread = useThreadShell(threadId ? { environmentId, threadId } : null);
  return thread?.modelSelection?.instanceId ?? thread?.providerInstanceId ?? null;
}
