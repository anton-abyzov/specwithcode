/**
 * The gallery's owner pieces: the scope chips (All, Playground, then each
 * project with designs, the rest under More), the owner badge on a card, and
 * the icon both use. A project shows its own sidebar icon; the Playground a
 * neutral shapes glyph.
 */
import type { DesignSummary } from "@specweave-studio/contracts";
import { ChevronDownIcon, FolderIcon, ShapesIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { ProjectFavicon } from "../../ProjectFavicon";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import type { GalleryProject } from "./DesignActions";
import { sameScope, type GalleryScope, type OwnerChip } from "./galleryModel";

/** Project chips shown before the rest fold into More. */
export const VISIBLE_PROJECT_CHIPS = 6;

export function scopeOf(summary: DesignSummary): GalleryScope {
  const owner = summary.ref.owner;
  return owner.kind === "playground"
    ? { kind: "playground" }
    : { kind: "project", projectId: owner.projectId };
}

export function OwnerIcon({
  scope,
  projects,
  className,
}: {
  scope: GalleryScope;
  projects: readonly GalleryProject[];
  className?: string;
}) {
  const size = cn("size-3.5 shrink-0", className);
  if (scope.kind === "playground")
    return <ShapesIcon aria-hidden className={cn(size, "text-muted-foreground")} />;
  const project =
    scope.kind === "project" ? projects.find((entry) => entry.id === scope.projectId) : undefined;
  return project?.icon ? (
    <ProjectFavicon project={project.icon} className={size} />
  ) : (
    <FolderIcon aria-hidden className={cn(size, "text-muted-foreground")} />
  );
}

/** The card's owner: a quiet pill that filters the gallery to that owner. */
export function OwnerBadge({
  summary,
  projects,
  onSelect,
}: {
  summary: DesignSummary;
  projects: readonly GalleryProject[];
  onSelect: (scope: GalleryScope) => void;
}) {
  const scope = scopeOf(summary);
  return (
    <button
      type="button"
      data-testid="design-owner"
      aria-label={`Show ${summary.ownerLabel} designs`}
      onClick={() => onSelect(scope)}
      className="inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-full bg-foreground/5 pr-2 pl-1.5 text-xs font-medium text-foreground/80 outline-none transition-colors duration-[120ms] ease-out-quint hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
    >
      <OwnerIcon scope={scope} projects={projects} />
      <span className="truncate">{summary.ownerLabel}</span>
    </button>
  );
}

const CHIP =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] text-muted-foreground outline-none transition-[background-color,color,box-shadow] duration-[120ms] ease-out-quint hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-foreground/8 aria-pressed:font-medium aria-pressed:text-foreground aria-pressed:ring-1 aria-pressed:ring-foreground/10 aria-pressed:ring-inset motion-reduce:transition-none";

function Count({ value }: { value: number }) {
  return <span className="text-xs text-muted-foreground tabular-nums">{value}</span>;
}

/** All, Playground and the projects with designs; picking one is the gallery's scope. */
export function ScopeChips({
  scope,
  total,
  playground,
  projectChips,
  projects,
  onSelect,
}: {
  scope: GalleryScope;
  total: number;
  playground: number;
  projectChips: readonly OwnerChip[];
  projects: readonly GalleryProject[];
  onSelect: (scope: GalleryScope) => void;
}) {
  let visible = projectChips.slice(0, VISIBLE_PROJECT_CHIPS);
  const active = projectChips.find((chip) => sameScope(chip.scope, scope));
  // A project picked from More stays in view as the last chip.
  if (active && !visible.includes(active)) visible = [...visible.slice(0, -1), active];
  const rest = projectChips.filter((chip) => !visible.includes(chip));
  // A project from a link that owns nothing yet, or that is not offered (archived,
  // automated), still shows as the selected chip: the current context.
  const orphan = scope.kind === "project" && active === undefined;
  const orphanProject =
    scope.kind === "project"
      ? projects.find((project) => project.id === scope.projectId)
      : undefined;
  const chip = (
    key: string,
    target: GalleryScope,
    label: string,
    count: number | null,
    note: string | null = null,
  ) => (
    <button
      key={key}
      type="button"
      className={CHIP}
      aria-pressed={sameScope(target, scope)}
      data-testid="design-scope"
      data-scope={target.kind === "project" ? target.projectId : target.kind}
      onClick={() => onSelect(target)}
    >
      {target.kind === "project" || target.kind === "playground" ? (
        <OwnerIcon scope={target} projects={projects} />
      ) : null}
      <span className="max-w-40 truncate">{label}</span>
      {note === null ? null : (
        <span className="truncate text-muted-foreground" data-testid="design-scope-note">
          {note}
        </span>
      )}
      {count === null ? null : <Count value={count} />}
    </button>
  );
  return (
    <div
      role="group"
      aria-label="Show designs from"
      className="flex min-w-0 flex-wrap items-center gap-1"
    >
      {chip("all", { kind: "all" }, "All", total)}
      {chip("playground", { kind: "playground" }, "Playground", playground)}
      {scope.kind === "projects" ? chip("projects", scope, "All projects", null) : null}
      {visible.map((entry) =>
        chip(
          entry.scope.kind === "project" ? entry.scope.projectId : entry.label,
          entry.scope,
          entry.label,
          entry.count,
        ),
      )}
      {orphan
        ? chip(
            scope.projectId,
            scope,
            orphanProject?.title ?? "Project",
            orphanProject?.unavailable === undefined ? 0 : null,
            // "Archived project", not the picker's full sentence, so the chip row stays one line.
            orphanProject?.unavailable?.split(",")[0] ?? null,
          )
        : null}
      {rest.length > 0 ? (
        <Menu>
          <MenuTrigger
            render={<button type="button" className={CHIP} data-testid="design-scope-more" />}
          >
            More
            <Count value={rest.length} />
            <ChevronDownIcon aria-hidden className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="start" className="max-h-80 min-w-56">
            {rest.map((entry) => (
              <MenuItem key={entry.label} onClick={() => onSelect(entry.scope)}>
                <OwnerIcon scope={entry.scope} projects={projects} />
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                <Count value={entry.count} />
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}
