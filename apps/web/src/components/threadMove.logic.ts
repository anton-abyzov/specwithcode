import { isProjectCoordinatorThreadId, type ProjectId } from "@specweave-studio/contracts";
import {
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@specweave-studio/client-runtime/state/models";

import {
  projectPickerMembers,
  type ProjectListMember,
  type ScratchRootLookup,
} from "../studio/projectListVisibility";

type MovableThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "projectId" | "movedTo" | "runtime"
>;

/**
 * Why the thread cannot move to another project, or null when it can. The
 * server checks the same rules again when the move runs.
 */
export function threadMoveBlockedReason(
  thread: MovableThread,
  project:
    | {
        readonly id: ProjectId;
        readonly workspaceSettings?:
          | { readonly coordinatorThreadId?: string | null | undefined }
          | null
          | undefined;
      }
    | undefined,
): string | null {
  if (thread.movedTo != null) return `Already moved to "${thread.movedTo.title}".`;
  const coordinatorThreadId = project?.workspaceSettings?.coordinatorThreadId;
  if (
    isProjectCoordinatorThreadId(thread.id, {
      id: project?.id ?? thread.projectId,
      ...(coordinatorThreadId === undefined ? {} : { workspaceSettings: { coordinatorThreadId } }),
    })
  ) {
    return "A project's coordinator stays with its project.";
  }
  return null;
}

/** Projects the thread can move to: the same machine's main project list, minus its own. */
export function threadMoveTargets<M extends ProjectListMember>(
  thread: MovableThread,
  projects: ReadonlyArray<M>,
  scratchRootFor: ScratchRootLookup,
): M[] {
  return projectPickerMembers(
    projects.filter(
      (project) =>
        project.environmentId === thread.environmentId && project.id !== thread.projectId,
    ),
    scratchRootFor,
  );
}

/**
 * Whether the new thread should start working right away. Work that was still
 * running is restarted; a thread the user had stopped or that had finished waits
 * for them, so cancelled work never resumes on its own.
 */
export function threadMoveStartsByDefault(thread: MovableThread): boolean {
  return !threadRuntimeCanArchive(thread.runtime) || thread.runtime?.status === "queued";
}
