import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";

import { useProjectFolderHealth } from "../../studio/useProjectFolderHealth";
import { Button } from "../ui/button";

/**
 * Names a project folder that is gone, or replaced by a file, on its machine,
 * with a way to point the project at the right folder. Silent while the folder
 * is there or its state is not known.
 */
export function ProjectFolderHealthNotice({
  project,
  machine,
  onRelink,
}: {
  project: Pick<EnvironmentProject, "environmentId" | "id" | "workspaceRoot">;
  machine: string;
  /** Opens Project settings at the Project folder row. */
  onRelink: () => void;
}) {
  const health = useProjectFolderHealth(project);
  if (health !== "missing" && health !== "file") return null;
  return (
    <p className="project-notice sws-pane-notice" role="status" data-project-folder-health={health}>
      {health === "missing"
        ? `Project folder ${project.workspaceRoot} is missing on ${machine}.`
        : `Project folder ${project.workspaceRoot} on ${machine} is a file, not a folder.`}{" "}
      <Button variant="outline" size="xs" onClick={onRelink}>
        Relink…
      </Button>
    </p>
  );
}
