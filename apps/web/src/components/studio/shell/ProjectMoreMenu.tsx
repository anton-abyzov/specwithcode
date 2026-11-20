/**
 * The project header's "More" menu: Plan, Board, Design, Usage, Routines and Open in
 * new window. Design opens the project's design board (`/design?project=<id>`),
 * which works before the project has any design. A machine's "No project"
 * folder has no board, and the board shows this machine's designs only, so
 * neither it nor a project running on another machine has a Design item.
 * The first feature sample's guide, once left or closed, comes back from here (1398).
 */
import type { ProjectId } from "@specweave-studio/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  AppWindowIcon,
  EllipsisVerticalIcon,
  GaugeIcon,
  KanbanIcon,
  ListChecksIcon,
  PaletteIcon,
  RepeatIcon,
  SignpostIcon,
} from "lucide-react";

import { canOpenProjectWindowFor, openProjectWindow } from "../../../lib/projectWindow";
import { useServerConfigs } from "../../../state/entities";
import { isScratchMember, type ProjectListMember } from "../../../studio/projectListVisibility";
import { useTx } from "../../../i18n";
import { searchForScope } from "../../design/gallery/galleryModel";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

export function ProjectMoreMenu({
  project,
  projectKey,
  projectTitle,
  onOpenPlan,
  onOpenBoard,
  onOpenSettingsTab,
  onOpenFirstFeatureGuide,
  designHere = true,
}: {
  readonly project: ProjectListMember & { readonly id: ProjectId };
  readonly projectKey: string;
  readonly projectTitle: string;
  readonly onOpenPlan: () => void;
  /** Opens the panel on its Board tab; absent when the project does not use SpecWeave. */
  readonly onOpenBoard?: (() => void) | undefined;
  readonly onOpenSettingsTab: (tab: "usage" | "routines") => void;
  /** False for a project running on another machine. */
  readonly designHere?: boolean;
  /** Brings back the sample project's first feature guide; absent while it shows or elsewhere. */
  readonly onOpenFirstFeatureGuide?: (() => void) | undefined;
}) {
  const tx = useTx();
  const navigate = useNavigate();
  const configs = useServerConfigs();
  const scratch = isScratchMember(
    project,
    (environmentId) => configs.get(environmentId)?.scratchWorkspaceRoot ?? null,
  );
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  className="sws-icon-button"
                  aria-label="More project actions"
                />
              }
            />
          }
        >
          <EllipsisVerticalIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="bottom">More</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-52">
        <MenuItem onClick={onOpenPlan}>
          <ListChecksIcon aria-hidden />
          Plan
        </MenuItem>
        {onOpenBoard ? (
          <MenuItem data-testid="project-more-board" onClick={onOpenBoard}>
            <KanbanIcon aria-hidden />
            Board
          </MenuItem>
        ) : null}
        {scratch || !designHere ? null : (
          <MenuItem
            data-testid="project-more-design"
            onClick={() =>
              void navigate({
                to: "/design",
                search: searchForScope({ kind: "project", projectId: project.id }),
              })
            }
          >
            <PaletteIcon aria-hidden />
            Design
          </MenuItem>
        )}
        {onOpenFirstFeatureGuide ? (
          <MenuItem data-testid="project-more-first-feature" onClick={onOpenFirstFeatureGuide}>
            <SignpostIcon aria-hidden />
            {tx("First feature guide")}
          </MenuItem>
        ) : null}
        <MenuItem onClick={() => onOpenSettingsTab("usage")}>
          <GaugeIcon aria-hidden />
          Usage
        </MenuItem>
        <MenuItem onClick={() => onOpenSettingsTab("routines")}>
          <RepeatIcon aria-hidden />
          Routines
        </MenuItem>
        {canOpenProjectWindowFor(projectKey) ? (
          <MenuItem onClick={() => void openProjectWindow({ projectKey, title: projectTitle })}>
            <AppWindowIcon aria-hidden />
            Open in new window
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
