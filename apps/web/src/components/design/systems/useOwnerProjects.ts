import type { EnvironmentId } from "@specweave-studio/contracts";
import { useMemo } from "react";

import { useScratchProject } from "~/hooks/useScratchProject";
import { useProjects } from "~/state/entities";
import {
  ineligibleProjectLabel,
  isScratchMember,
  projectChoiceIneligibleReason,
} from "~/studio/projectListVisibility";

import type { OwnerProject } from "./reviewModel";

/**
 * Projects of one machine that can own design systems, by title; the scratch project is
 * left out. Archived and automated projects stay for their names but carry why they are
 * not offered; pickers list {@link offeredProjects} only.
 */
export function useOwnerProjects(environmentId: EnvironmentId | null): OwnerProject[] {
  const projects = useProjects();
  const { scratchWorkspaceRootFor } = useScratchProject();
  return useMemo(
    () =>
      projects
        .filter(
          (project) =>
            project.environmentId === environmentId &&
            !isScratchMember(project, scratchWorkspaceRootFor),
        )
        .map((project) => {
          const reason = projectChoiceIneligibleReason(project, scratchWorkspaceRootFor, "design");
          return {
            id: project.id,
            title: project.title,
            kind:
              project.workspaceSettings?.kind === "personal"
                ? ("personal" as const)
                : ("code" as const),
            ...(reason === null ? {} : { unavailable: ineligibleProjectLabel(reason) }),
          };
        })
        .toSorted((left, right) => left.title.localeCompare(right.title)),
    [environmentId, projects, scratchWorkspaceRootFor],
  );
}
