/**
 * The project board's "Add from Playground…": picks a design from this
 * machine's Playground and connects it to the board's project, through the
 * same dialog as the card menu's "Connect to a project…".
 */
import type { DesignSummary } from "@specweave-studio/contracts";
import { PaletteIcon, PresentationIcon, ShapesIcon } from "lucide-react";

import { Button } from "../../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import type { DesignMenuHandlers, GalleryProject } from "./DesignActions";
import { editedAgo, type GalleryScope } from "./galleryModel";

/** The Playground's designs, newest edit first. */
export function playgroundDesigns(designs: readonly DesignSummary[] | null): DesignSummary[] {
  return (designs ?? [])
    .filter((summary) => summary.ref.owner.kind === "playground")
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function AddFromPlayground({
  scope,
  designs,
  projects,
  canWrite,
  now,
  onConnect,
}: {
  readonly scope: GalleryScope;
  readonly designs: readonly DesignSummary[] | null;
  readonly projects: readonly GalleryProject[];
  readonly canWrite: boolean;
  readonly now: number;
  readonly onConnect?: DesignMenuHandlers["onConnect"];
}) {
  if (scope.kind !== "project" || !onConnect || !canWrite) return null;
  const project = projects.find((candidate) => candidate.id === scope.projectId);
  // An archived or automated project keeps its board, but takes no new designs.
  if (project === undefined || project.unavailable !== undefined) return null;
  const choices = playgroundDesigns(designs);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            data-testid="design-add-from-playground"
          />
        }
      >
        <ShapesIcon aria-hidden />
        Add from Playground…
      </MenuTrigger>
      <MenuPopup align="start" side="bottom" className="max-h-80 min-w-64 max-w-96">
        <MenuGroup>
          <MenuGroupLabel>Move into {project.title}</MenuGroupLabel>
          {choices.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              Your Playground has no designs.
            </p>
          ) : (
            choices.map((summary) => {
              const Icon = summary.kind === "slides" ? PresentationIcon : PaletteIcon;
              return (
                <MenuItem
                  key={summary.ref.designId}
                  data-testid="design-add-from-playground-item"
                  onClick={() => onConnect(summary, project.id)}
                >
                  <Icon aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{summary.title || "Untitled"}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {editedAgo(summary.updatedAt, now).replace(/^Edited /, "")}
                  </span>
                </MenuItem>
              );
            })
          )}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
