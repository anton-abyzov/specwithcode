import { useCallback } from "react";
import type { ModelSelection, ScopedProjectRef, ThreadId } from "@specweave-studio/contracts";
import type { DraftId } from "../composerDraftStore";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useProjectCoordinatorHandoff } from "./useProjectCoordinatorHandoff";

export type NewChatDestination =
  | { readonly kind: "coordinator"; readonly threadId: ThreadId }
  | { readonly kind: "draft"; readonly draftId: DraftId; readonly threadId: ThreadId }
  | { readonly kind: "unavailable" };

/** Callers that need an acknowledgement must distinguish a project opening from draft creation. */
export function useNewChatDestination() {
  const openCoordinator = useProjectCoordinatorHandoff();
  const openDraft = useNewThreadHandler();
  return useCallback(
    async (
      projectRef: ScopedProjectRef,
      options: Parameters<typeof openDraft>[1] & {
        readonly model?: ModelSelection | undefined;
      } = {},
    ): Promise<NewChatDestination> => {
      const project = await openCoordinator(projectRef, {
        model: options?.model,
        branch: options?.branch,
        worktreePath: options?.worktreePath,
      });
      if (project.kind === "opened") return { kind: "coordinator", threadId: project.threadId };
      if (project.kind === "unavailable") return project;
      const draft = await openDraft(projectRef, options);
      return draft ? { kind: "draft", ...draft } : { kind: "unavailable" };
    },
    [openCoordinator, openDraft],
  );
}

export async function openBackgroundChatComposer(
  open: ReturnType<typeof useNewChatDestination>,
  projectRef: ScopedProjectRef,
  options: Parameters<ReturnType<typeof useNewChatDestination>>[1],
): Promise<boolean> {
  return (await open(projectRef, options)).kind !== "unavailable";
}
