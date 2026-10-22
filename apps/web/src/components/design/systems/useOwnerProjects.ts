import type { EnvironmentId } from "@specweave-studio/contracts";
import { useMemo } from "react";

import { useScratchProject } from "~/hooks/useScratchProject";
import { useProjects } from "~/state/entities";

import type { OwnerProject } from "./reviewModel";

/** Projects of one machine that can own design systems, by title; the scratch project is left out. */
export function useOwnerProjects(environmentId: EnvironmentId | null): OwnerProject[] {
  const projects = useProjects();
  const { scratchWorkspaceRootFor } = useScratchProject();
  const scratchRoot = environmentId === null ? null : scratchWorkspaceRootFor(environmentId);
  return useMemo(
    () =>
      projects
        .filter(
          (project) =>
            project.environmentId === environmentId && project.workspaceRoot !== scratchRoot,
        )
        .map((project) => ({ id: project.id, title: project.title }))
        .toSorted((left, right) => left.title.localeCompare(right.title)),
    [environmentId, projects, scratchRoot],
  );
}
