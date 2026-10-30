import { useAtomValue } from "@effect/atom-react";
import { isScratchProject } from "@specweave-studio/client-runtime/state/projects";
import { ThreadId, type ModelSelection, type ScopedProjectRef } from "@specweave-studio/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { readProjects } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import {
  enqueueProjectCoordinatorDraft,
  projectWorkspaceIntentText,
} from "../studio/projectCoordinatorDraft";
import { projectWorkspaceSearch } from "../studio/projectPaneThreads";
import { useMachineNicknames } from "../studio/machineNickname";
import { coordinatorCheckout } from "../studio/workersOnlyCopy";
import { formatReviewCommentFence, type ReviewCommentContext } from "../reviewCommentContext";
import { toastManager } from "../components/ui/toast";
import { useAtomCommand } from "../state/use-atom-command";
import { projectEnvironment } from "../state/projects";
import { useClientSettings, useLegacySidebarEnabled } from "./useSettings";

export interface ProjectCoordinatorHandoff {
  readonly url?: string | undefined;
  readonly prompt?: string | undefined;
  readonly reviewComments?: ReadonlyArray<ReviewCommentContext> | undefined;
  readonly mode?: "worktree" | "local" | undefined;
  readonly branch?: string | null | undefined;
  readonly worktreePath?: string | null | undefined;
  readonly model?: ModelSelection | undefined;
}

/** A workers-only copy whose request goes to its coordinator on another machine. */
export interface WorkersOnlyCopyTarget {
  readonly machine: string;
  readonly folder: string;
}

/**
 * Keep review evidence and checkout intent in the request the user will send.
 * A request sent on from a workers-only copy names that copy first, so its
 * coordinator works there and not in its own checkout.
 */
export function projectCoordinatorHandoffText(
  task: ProjectCoordinatorHandoff,
  copy?: WorkersOnlyCopyTarget,
): string {
  return [
    copy
      ? `This request is for the copy on ${copy.machine}, in ${copy.folder}. That copy runs workers only. Delegate the work to a worker there.`
      : null,
    task.prompt?.trim(),
    task.url ? `Pull request: ${task.url}` : null,
    projectWorkspaceIntentText(task),
    task.mode === "worktree"
      ? "When I send this request, prepare the pull request in its own worktree and delegate the work to a project worker."
      : task.mode === "local"
        ? `When I send this request, prepare the pull request in ${copy ? "that copy's" : "this"} checkout and delegate the work to a project worker. Preserve existing local work.`
        : null,
    ...(task.reviewComments ?? []).map((comment) =>
      [
        `${comment.sectionTitle}: ${comment.filePath} ${comment.rangeLabel}`,
        comment.text,
        comment.diff
          ? formatReviewCommentFence(comment.fenceLanguage ?? "diff", comment.diff)
          : null,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export type ProjectCoordinatorEntryResult =
  | { readonly kind: "standalone" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "opened"; readonly threadId: ThreadId };

/** A successful coordinator navigation is distinct from a standalone draft and a failure. */
export function useProjectCoordinatorHandoff() {
  const legacy = useLegacySidebarEnabled();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const grouping = useClientSettings(selectProjectGroupingSettings);
  const machineName = useMachineNicknames();
  const router = useRouter();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  return useCallback(
    async (
      projectRef: ScopedProjectRef,
      task: ProjectCoordinatorHandoff = {},
    ): Promise<ProjectCoordinatorEntryResult> => {
      if (legacy) return { kind: "standalone" };
      const projects = readProjects();
      const chosen = projects.find(
        (candidate) =>
          candidate.environmentId === projectRef.environmentId &&
          candidate.id === projectRef.projectId,
      );
      if (!chosen) {
        toastManager.add({
          type: "error",
          title: "Project unavailable",
          description:
            "Your draft is unchanged. Reconnect its machine and choose the project again.",
        });
        return { kind: "unavailable" };
      }
      const scratchRoot = configs.get(projectRef.environmentId)?.scratchWorkspaceRoot;
      if (!scratchRoot) {
        toastManager.add({
          type: "error",
          title: "Machine is still connecting",
          description:
            "Your request is unchanged. Wait for the machine to reconnect, then try again.",
        });
        return { kind: "unavailable" };
      }
      if (isScratchProject(chosen, scratchRoot)) return { kind: "standalone" };
      // A workers-only copy cannot take messages: its coordinator, on another machine, opens.
      // A model picked for the copy's machine is not forced on that coordinator,
      // and the request names the copy the person picked.
      const project = coordinatorCheckout(chosen, projects);
      const model = project === chosen ? task.model : undefined;
      const text = projectCoordinatorHandoffText(
        task,
        project === chosen
          ? undefined
          : { machine: machineName(chosen.environmentId), folder: chosen.workspaceRoot },
      );
      if (text)
        enqueueProjectCoordinatorDraft({
          environmentId: project.environmentId,
          projectId: project.id,
          text,
        });
      try {
        if (model) {
          const saved = await updateProject({
            environmentId: project.environmentId,
            input: {
              projectId: project.id,
              workspaceSettings: {
                expectedRevision: project.workspaceSettings?.revision ?? 0,
                coordinatorModelSelection: model,
              },
            },
          });
          if (saved._tag === "Failure") throw new Error("Coordinator model could not be saved");
        }
        await router.navigate({
          to: "/projects/$projectKey",
          params: { projectKey: deriveLogicalProjectKeyFromSettings(project, grouping) },
          search: projectWorkspaceSearch(null, `${project.environmentId}:${project.id}`),
        });
        if (text)
          toastManager.add({
            type: "success",
            title: "Added to the coordinator composer",
            description: "Review the request, then send. The coordinator will arrange the work.",
          });
        return {
          kind: "opened",
          threadId: ThreadId.make(
            project.workspaceSettings?.coordinatorThreadId ?? `project-coordinator:${project.id}`,
          ),
        };
      } catch {
        toastManager.add({
          type: "error",
          title: "Could not open the coordinator",
          description: "The request is saved for this project. Open it to review and send.",
        });
      }
      return { kind: "unavailable" };
    },
    [legacy, configs, grouping, machineName, router, updateProject],
  );
}
