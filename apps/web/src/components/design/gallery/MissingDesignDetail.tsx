/**
 * Why a design link opens nothing. When its project's folder is gone it names the
 * project and the folder and opens the project, where the folder is fixed.
 */
import { useNavigate } from "@tanstack/react-router";

import { useClientSettings } from "~/hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import type { useProjects } from "~/state/entities";

import { missingFolderOf, missingFolderText } from "./boardOwner";

type Project = ReturnType<typeof useProjects>[number];

export function MissingDesignDetail({
  detail,
  project,
}: {
  detail: string | null;
  project: Project | null;
}) {
  const navigate = useNavigate();
  const grouping = useClientSettings(selectProjectGroupingSettings);
  const path = detail === null ? null : missingFolderOf(detail);
  if (path === null || project === null) return <>{detail ?? "It may have been deleted or moved."}</>;
  const projectKey = deriveLogicalProjectKeyFromSettings(project, grouping);
  return (
    <>
      {project.title}: {missingFolderText(path || project.workspaceRoot)}{" "}
      <button
        type="button"
        data-testid="design-missing-folder-open"
        className="rounded-sm font-medium text-foreground underline underline-offset-2 outline-none hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => void navigate({ to: "/projects/$projectKey", params: { projectKey } })}
      >
        Open {project.title}
      </button>
    </>
  );
}
