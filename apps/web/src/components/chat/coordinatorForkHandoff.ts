import type { EnvironmentId, RunId, ThreadId } from "@specweave-studio/contracts";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import type { useProjectCoordinatorHandoff } from "~/hooks/useProjectCoordinatorHandoff";
import { readProjects, readThreadShell } from "~/state/entities";
import { projectCoordinatorRole } from "~/studio/projectCoordinatorThreads";
import { isAgentOwnedProjectThread } from "~/studio/projectPaneThreads";
import { formatStudioThreadLink } from "~/studio/studioThreadLinks";

/** Existing independent chats can fork normally; new project work is requested from its coordinator. */
export async function coordinatorForkHandoff(
  open: ReturnType<typeof useProjectCoordinatorHandoff>,
  environmentId: EnvironmentId,
  input: { readonly sourceThreadId: ThreadId; readonly runId: RunId },
): Promise<boolean> {
  const source = readThreadShell(scopeThreadRef(environmentId, input.sourceThreadId));
  if (!source) return false;
  const projects = readProjects().filter((entry) => entry.environmentId === environmentId);
  // Provider-native subagents can carry a Scratch project ID. Their loaded
  // ancestry, not that storage folder, identifies the project that owns the work.
  const ancestry = [source];
  const seen = new Set<string>([source.id]);
  for (let step = 0; step < 32; step += 1) {
    const current = ancestry[ancestry.length - 1]!;
    const parentId =
      current.lineage.parentThreadId ??
      (current.forkedFrom?.type === "run" ? current.forkedFrom.threadId : null) ??
      (current.lineage.rootThreadId !== current.id ? current.lineage.rootThreadId : null);
    if (!parentId || seen.has(parentId)) break;
    const parent = readThreadShell(scopeThreadRef(environmentId, parentId));
    if (!parent) break;
    seen.add(parentId);
    ancestry.push(parent);
  }
  const project =
    ancestry.toReversed().flatMap((thread) => {
      const entry = projects.find((candidate) => candidate.id === thread.projectId);
      return entry &&
        (entry.workspaceSettings?.coordinatorThreadId ||
          projectCoordinatorRole(thread.id, { projectId: entry.id, coordinatorThreadId: null }) ===
            "current")
        ? [entry]
        : [];
    })[0] ?? projects.find((entry) => entry.id === source.projectId);
  if (!project) return false;
  const coordinator = project.workspaceSettings?.coordinatorThreadId ?? null;
  if (
    projectCoordinatorRole(source.id, {
      projectId: project.id,
      coordinatorThreadId: coordinator,
    }) !== "current" &&
    !isAgentOwnedProjectThread(
      source,
      coordinator,
      (id) => readThreadShell(scopeThreadRef(environmentId, id as ThreadId)) ?? undefined,
    )
  )
    return false;
  const result = await open(
    { environmentId, projectId: project.id },
    {
      prompt: `Fork a new project worker from this response, keeping its conversation context.\n\nSource thread: ${formatStudioThreadLink(source.id, source.title, environmentId)}\nSource run: ${input.runId}\n\nCreate the worker when I send this request.`,
      branch: source.branch,
      worktreePath: source.worktreePath,
    },
  );
  return result.kind !== "standalone";
}
