/**
 * The project that owns a design, as the editor header and the Share dialog
 * name it: its title, sidebar icon and `/projects/$projectKey` workspace.
 * Null for a Playground design.
 */
import type { DesignOwnerInput, EnvironmentId } from "@specweave-studio/contracts";
import { useMemo } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import { useProjects } from "~/state/entities";

import type { DesignOwnerProject } from "./editor/backend";

export function useOwnerProject(
  owner: DesignOwnerInput,
  environmentId: EnvironmentId | null,
): DesignOwnerProject | null {
  const projects = useProjects();
  const grouping = useClientSettings(selectProjectGroupingSettings);
  const projectId = owner.kind === "project" ? owner.projectId : null;
  return useMemo(() => {
    if (projectId === null) return null;
    const project =
      projects.find(
        (candidate) => candidate.id === projectId && candidate.environmentId === environmentId,
      ) ?? projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) return { projectId, label: "Project", projectKey: null, icon: null };
    return {
      projectId,
      label: project.title,
      projectKey: deriveLogicalProjectKeyFromSettings(project, grouping),
      icon: project,
    };
  }, [environmentId, grouping, projectId, projects]);
}
