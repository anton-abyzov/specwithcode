import { isScratchProject } from "@specweave-studio/client-runtime/state/projects";
import type { Project } from "~/types";
import type { useProjectCoordinatorHandoff } from "~/hooks/useProjectCoordinatorHandoff";
import { useLegacySidebarEnabled } from "~/hooks/useSettings";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/** Old project drafts remain editable and recoverable, but cannot bypass the coordinator. */
export function useProjectDraftSendGuard(
  isDraft: boolean,
  project: Project | null,
  scratchRoot: string | null | undefined,
  openCoordinator: ReturnType<typeof useProjectCoordinatorHandoff>,
) {
  const legacy = useLegacySidebarEnabled();
  const unresolved = project === null || !scratchRoot;
  const blocked =
    !legacy && isDraft && (!project || !scratchRoot || !isScratchProject(project, scratchRoot));
  const description = unresolved
    ? "Reconnect this machine to check the draft's project. Your saved draft is unchanged."
    : "Project work starts in the coordinator. This draft's text, attachments, context and checkout choices remain saved here. Opening the coordinator does not transfer or send them.";
  return {
    notice: blocked ? (
      <div
        role="status"
        className="mb-2 rounded-lg border border-border bg-muted/70 px-3 py-2 text-sm text-muted-foreground"
      >
        <p>{description}</p>
        {!unresolved && project ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() =>
              void openCoordinator({ environmentId: project.environmentId, projectId: project.id })
            }
          >
            Open project coordinator
          </Button>
        ) : null}
      </div>
    ) : null,
    preventSend: () => {
      if (blocked) toastManager.add({ type: "warning", title: "Draft not sent", description });
      return blocked;
    },
  };
}
