/**
 * Design, Slides and Design system in the Artifacts shelf's New menu
 * (ArtifactNewMenu). They open the Design studio's own New flow for this
 * project, so starting from the shelf and from the gallery work the same way.
 * Each entry navigates and returns null, so the shelf opens no file.
 *
 * The Design studio shows this machine's designs only, and a machine's
 * "No project" folder has no board, so a project on another machine or a
 * scratch project gets none of these, as in the project's More menu.
 */
import type { ProjectId } from "@specweave-studio/contracts";
import { useRouter } from "@tanstack/react-router";
import { PaletteIcon, PresentationIcon, SwatchBookIcon } from "lucide-react";

import { useServerConfigs } from "../../../state/entities";
import { isScratchMember, type ProjectListMember } from "../../../studio/projectListVisibility";
import { DESIGN_FEATURES } from "../../design/designFeatures";
import type { ArtifactNewEntry } from "./ArtifactNewMenu";

export type DesignEntryProject = ProjectListMember & { readonly id: ProjectId };

/** The design entries, or none when `project` is absent (another machine) or scratch. */
export function useNewDesignEntries(
  project: DesignEntryProject | undefined,
  features: { readonly slides: boolean; readonly designSystems: boolean } = DESIGN_FEATURES,
): ArtifactNewEntry[] {
  const router = useRouter();
  const configs = useServerConfigs();
  if (project === undefined) return [];
  if (isScratchMember(project, (id) => configs.get(id)?.scratchWorkspaceRoot ?? null)) return [];
  const owner = project.id;
  const open = (kind: "design" | "slides") => async () => {
    await router.navigate({ to: "/design", search: { new: kind, owner } });
    return null;
  };
  return [
    { id: "design", label: "Design", icon: <PaletteIcon aria-hidden />, create: open("design") },
    ...(features.slides
      ? [
          {
            id: "slides",
            label: "Slides",
            icon: <PresentationIcon aria-hidden />,
            create: open("slides"),
          },
        ]
      : []),
    ...(features.designSystems
      ? [
          {
            id: "design-system",
            label: "Design system",
            icon: <SwatchBookIcon aria-hidden />,
            // The gallery's own "Design system" entry goes here too (designSystemsHref).
            create: async () => {
              await router.navigate({ to: "/settings/design-systems", search: { project: owner } });
              return null;
            },
          },
        ]
      : []),
  ];
}
