import type { EnvironmentId, ModelSelection, ProjectId } from "@specweave-studio/contracts";
import type { useProjectCoordinatorHandoff } from "~/hooks/useProjectCoordinatorHandoff";

/** Modern device continuation stages context on that device; the user sends it to delegate work. */
export async function coordinatorDeviceHandoff(
  open: ReturnType<typeof useProjectCoordinatorHandoff>,
  target: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly selection: ModelSelection;
  },
  text: string,
  branch: string | null,
): Promise<boolean> {
  const result = await open(
    { environmentId: target.environmentId, projectId: target.projectId },
    { prompt: text, model: target.selection, branch },
  );
  if (result.kind === "unavailable")
    throw new Error(
      "The coordinator could not be opened on that machine. Your current thread is unchanged.",
    );
  return result.kind === "opened";
}
