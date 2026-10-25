/**
 * The Design gallery: every design this machine can read, scoped by owner
 * chips (All, Playground, each project with designs), searchable, in grid or
 * list views. In All the designs sit in one section per project unless
 * Recent is chosen. Data and actions come in as props, so the page wires the
 * server and the headless fixture wires synthetic designs into the same
 * component.
 */
import type { DesignSummary } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  LayoutGridIcon,
  ListIcon,
  PaletteIcon,
  PresentationIcon,
  SearchIcon,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";

import { InputGroup, InputGroupAddon, InputGroupInput } from "../../ui/input-group";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../../ui/menu";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { AddFromPlayground } from "./AddFromPlayground";
import { CreationRow } from "./CreationRow";
import {
  DesignActionsMenu,
  projectKeyFor,
  type DesignActionHandlers,
  type GalleryProject,
} from "./DesignActions";
import { OwnerBadge, OwnerIcon, ScopeChips } from "./GalleryOwners";
import {
  creationOffReason,
  missingFolderOf,
  missingFolderText,
  problemIsAbout,
  problemKey,
  problemsInScope,
  type OwnerProblem,
} from "./boardOwner";
import { ProjectSystemsStrip } from "./ProjectSystemsStrip";
import {
  availableCreationKinds,
  editedAgo,
  filterDesigns,
  GALLERY_GROUPINGS,
  groupByOwner,
  inScope,
  kindLabel,
  ownerChips,
  scopeLabel,
  showsSections,
  summaryKey,
  type CreationKind,
  type GalleryGrouping,
  type GalleryScope,
  type GallerySection,
  type GalleryView,
} from "./galleryModel";

const VIEW_STORAGE_KEY = "studio:design-gallery-view:v1";
const ViewSchema = Schema.Literals(["grid", "list"]);
const GROUPING_STORAGE_KEY = "design.gallery.grouping";
const GroupingSchema = Schema.Literals(GALLERY_GROUPINGS);
const GROUPING_LABELS: Record<GalleryGrouping, string> = {
  project: "Group by project",
  recent: "Recent first",
};
/** A section shows this many rows of cards before "Show N more". */
const SECTION_ROWS = 2;
/** Card minimum (15rem) and the grid's column gap (gap-x-5), for the column count. */
const CARD_MIN_PX = 240;
const CARD_GAP_PX = 20;

export interface DesignGalleryViewProps extends DesignActionHandlers {
  /** Null while the first list is loading. */
  readonly designs: readonly DesignSummary[] | null;
  readonly error: string | null;
  /** Owners that could not be read, as the server reported them. */
  readonly problems: readonly OwnerProblem[];
  readonly projects: readonly GalleryProject[];
  readonly now: number;
  readonly canWrite: boolean;
  /** Whether this window may start threads, which "Design from code" needs. */
  readonly canOperate: boolean;
  readonly creationKinds?: readonly CreationKind[];
  readonly renderThumbnail: (summary: DesignSummary) => ReactNode;
  readonly onCreate: (kind: CreationKind) => void;
  /** "Import PowerPoint…" next to Slides; absent when the server cannot import decks. */
  readonly onImportSlides?: ((file: File) => void) | null;
  /** Controls the owner scope, as the `/design` URL does; local state when omitted. */
  readonly scope?: GalleryScope;
  readonly onScopeChange?: (scope: GalleryScope) => void;
  /** `?group=` from the URL; it wins over the remembered choice. */
  readonly grouping?: GalleryGrouping;
  readonly onGroupingChange?: (grouping: GalleryGrouping) => void;
  /** Opens a project's page by its workspace key: a board's way back, and where a lost folder is fixed. */
  readonly onOpenProjectPage?: (projectKey: string) => void;
  /** A finished move, said in the page instead of a toast over the search and view controls. */
  readonly notice?: GalleryNotice | null;
}

export interface GalleryNotice {
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly onAction: () => void;
  readonly onDismiss: () => void;
}

function KindGlyph({ kind, className }: { kind: DesignSummary["kind"]; className?: string }) {
  const Icon = kind === "slides" ? PresentationIcon : PaletteIcon;
  return <Icon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
}

export function DesignGalleryView(props: DesignGalleryViewProps) {
  const [local, setLocal] = useState<GalleryScope>({ kind: "all" });
  const scope = props.scope ?? local;
  const changeScope = (next: GalleryScope) => {
    if (props.scope === undefined) setLocal(next);
    props.onScopeChange?.(next);
  };
  const [query, setQuery] = useState("");
  const [view, setView] = useLocalStorage<GalleryView, GalleryView>(
    VIEW_STORAGE_KEY,
    "grid",
    ViewSchema,
  );
  const [storedGrouping, setStoredGrouping] = useLocalStorage<GalleryGrouping, GalleryGrouping>(
    GROUPING_STORAGE_KEY,
    "project",
    GroupingSchema,
  );
  const grouping = props.grouping ?? storedGrouping;
  const changeGrouping = (next: GalleryGrouping) => {
    setStoredGrouping(next);
    props.onGroupingChange?.(next);
  };
  const kinds = props.creationKinds ?? availableCreationKinds();
  const all = props.designs ?? [];
  const shown = props.designs === null ? null : filterDesigns(props.designs, { scope, query });
  const owners = ownerChips(all, props.projects);
  // Archived and automated projects are not offered as a filter; their designs stay under All.
  const chips = {
    ...owners,
    projects: owners.projects.filter((chip) => {
      const scope = chip.scope;
      return (
        scope.kind !== "project" ||
        props.projects.find((project) => project.id === scope.projectId)?.unavailable === undefined
      );
    }),
  };
  const label = scopeLabel(scope, props.projects, all);
  const scopeCount = all.filter((summary) => inScope(summary, scope)).length;
  const sections = shown === null ? [] : groupByOwner(shown, props.projects);
  const grouped = showsSections(scope, grouping, sections.length);
  const searching = query.trim() !== "";
  const designLabel = scope.kind === "project" ? `New design in ${label}` : undefined;
  const scopedProject =
    scope.kind === "project"
      ? (props.projects.find((project) => project.id === scope.projectId) ?? null)
      : null;
  // An archived, automated or folder-less project keeps its board but makes nothing new.
  const offReason = creationOffReason(scopedProject);
  const problems = problemsInScope(props.problems, scope, label).filter(
    // The board's own missing folder is said once, in the line that turns creation off.
    (problem) =>
      offReason === null || scopedProject === null || !problemIsAbout(problem, scopedProject),
  );
  const missingFolderIds = new Set(
    props.projects.filter((project) => project.missingFolder !== undefined).map((p) => p.id),
  );
  const openProjectPage = (project: GalleryProject | null | undefined) =>
    project?.projectKey !== undefined && props.onOpenProjectPage
      ? () => props.onOpenProjectPage?.(project.projectKey!)
      : null;
  const backToProject = openProjectPage(scopedProject);

  return (
    <div className="flex flex-col gap-7" data-testid="design-gallery" data-scope={scope.kind}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <ScopeChips
            scope={scope}
            total={all.length}
            playground={chips.playground}
            projectChips={chips.projects}
            projects={props.projects}
            onSelect={changeScope}
          />
          {backToProject !== null ? (
            <button
              type="button"
              data-testid="design-open-project"
              className={LINK_BUTTON}
              onClick={backToProject}
            >
              Open project
              <ArrowUpRightIcon aria-hidden className="size-3.5" />
            </button>
          ) : null}
          <span className="flex-1" />
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none">
            <InputGroup className="min-w-0 flex-1 sm:w-60 sm:flex-none">
              <InputGroupAddon>
                <SearchIcon aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                size="sm"
                type="search"
                aria-label="Search designs"
                placeholder={scope.kind === "all" ? "Search designs" : `Search ${label} designs`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </InputGroup>
            {scope.kind === "all" ? (
              <Menu>
                <MenuTrigger
                  render={
                    <button
                      type="button"
                      data-testid="design-grouping"
                      className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[13px] text-muted-foreground outline-none transition-colors duration-[120ms] ease-out-quint hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                    />
                  }
                >
                  {grouping === "project" ? "By project" : "Recent"}
                  <ChevronDownIcon aria-hidden className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end" className="min-w-48">
                  <MenuGroup>
                    <MenuGroupLabel>Arrange</MenuGroupLabel>
                    <MenuRadioGroup
                      value={grouping}
                      onValueChange={(value) => changeGrouping(value as GalleryGrouping)}
                    >
                      {GALLERY_GROUPINGS.map((value) => (
                        <MenuRadioItem key={value} value={value}>
                          <span className="flex items-center justify-between gap-6">
                            {GROUPING_LABELS[value]}
                            <MenuRadioItemIndicator />
                          </span>
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuGroup>
                </MenuPopup>
              </Menu>
            ) : null}
            <ToggleGroup
              aria-label="View"
              value={[view]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "grid" || value === "list") setView(value);
              }}
            >
              <Toggle value="grid" aria-label="Grid view" size="sm">
                <LayoutGridIcon aria-hidden />
              </Toggle>
              <Toggle value="list" aria-label="List view" size="sm">
                <ListIcon aria-hidden />
              </Toggle>
            </ToggleGroup>
          </div>
        </div>
        {kinds.length > 0 ? (
          <CreationRow
            kinds={kinds}
            compact={props.designs !== null && scopeCount > 0}
            {...(designLabel ? { designLabel } : {})}
            {...(scopedProject !== null
              ? { designDescription: `A blank canvas saved in ${scopedProject.title}` }
              : {})}
            disabledReason={(kind) =>
              offReason !== null
                ? "Not available for this project"
                : !props.canWrite
                  ? "This window may not change files"
                  : kind === "design-from-code" && !props.canOperate
                    ? "This window may not start threads"
                    : null
            }
            onCreate={props.onCreate}
            onImportSlides={props.onImportSlides ?? null}
          />
        ) : null}
        {offReason !== null ? (
          <p
            className="text-sm text-muted-foreground"
            role="status"
            data-testid="design-creation-off"
          >
            {offReason}{" "}
            {backToProject !== null ? (
              <button type="button" className={INLINE_LINK} onClick={backToProject}>
                Open {scopedProject?.title}
              </button>
            ) : null}
          </p>
        ) : null}
        <AddFromPlayground {...props} scope={scope} />
      </div>

      {props.error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {props.error}
        </p>
      ) : null}
      {props.notice ? (
        <div
          role="status"
          data-testid="design-notice"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-muted/60 px-3 py-2 text-sm ring-1 ring-border/60"
        >
          <span className="font-medium">{props.notice.title}</span>
          <span className="min-w-0 flex-1 text-muted-foreground">{props.notice.description}</span>
          <button type="button" className={LINK_BUTTON} onClick={props.notice.onAction}>
            {props.notice.actionLabel}
          </button>
          <button type="button" className={LINK_BUTTON} onClick={props.notice.onDismiss}>
            Dismiss
          </button>
        </div>
      ) : null}
      {problems.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground" role="status">
          {problems.map((problem) => {
            const path = missingFolderOf(problem.detail);
            const project =
              path === null
                ? undefined
                : props.projects.find((candidate) => problemIsAbout(problem, candidate));
            const open = openProjectPage(project);
            return (
              <li key={problemKey(problem)} data-testid="design-problem">
                <span className="font-medium text-foreground/80">{problem.ownerLabel}</span>:{" "}
                {path === null ? problem.detail : missingFolderText(project?.missingFolder ?? path)}
                {open !== null ? (
                  <>
                    {" "}
                    <button type="button" className={INLINE_LINK} onClick={open}>
                      Open {problem.ownerLabel}
                    </button>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {scope.kind === "project" ? (
        <ProjectSystemsStrip
          projectId={scope.projectId}
          canWrite={props.canWrite && offReason === null}
          missingFolders={missingFolderIds}
        />
      ) : null}
      <section aria-label="Your designs" className="flex flex-col gap-3">
        {shown === null ? (
          <p className="text-sm text-muted-foreground" role="status">
            Loading designs…
          </p>
        ) : shown.length === 0 ? (
          <EmptyGallery scope={scope} label={label} searching={searching} />
        ) : grouped ? (
          <div className="flex flex-col gap-9">
            {sections.map((section) => (
              <OwnerSection
                key={section.key}
                section={section}
                view={view}
                onScope={changeScope}
                {...props}
              />
            ))}
          </div>
        ) : view === "grid" ? (
          <ul className={GRID} data-testid="design-grid">
            {shown.map((summary) => (
              <li key={summaryKey(summary)}>
                <DesignCard summary={summary} showOwner onScope={changeScope} {...props} />
              </li>
            ))}
          </ul>
        ) : (
          <DesignList {...props} rows={shown} showOwner onScope={changeScope} />
        )}
      </section>
    </div>
  );
}

const GRID = "grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-5 gap-y-7";
const LINK_BUTTON =
  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none transition-colors duration-[120ms] ease-out-quint hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";
const INLINE_LINK =
  "rounded-sm font-medium text-foreground underline underline-offset-2 outline-none hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring";

function EmptyGallery({
  scope,
  label,
  searching,
}: {
  scope: GalleryScope;
  label: string;
  searching: boolean;
}) {
  return (
    <p className="text-sm text-muted-foreground" role="status" data-testid="design-empty">
      {searching
        ? "No design matches."
        : scope.kind === "playground"
          ? "Nothing in your Playground yet. Start a design above; it stays on this machine until you copy it to a project."
          : scope.kind === "projects"
            ? "No project has a design yet. Start one above, or use Design from code to have an agent design against a project."
            : scope.kind === "project"
              ? `${label} has no designs yet. Start one above; it is saved in the project's .specweave/design folder.`
              : "No designs yet. Start one above."}
    </p>
  );
}

/** How many grid columns fit, so a section can show exactly two rows. */
function useGridColumns() {
  const ref = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(4);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null || typeof ResizeObserver === "undefined") return;
    const measure = () =>
      setColumns(
        Math.max(1, Math.floor((node.clientWidth + CARD_GAP_PX) / (CARD_MIN_PX + CARD_GAP_PX))),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, columns };
}

type ScopeProps = DesignGalleryViewProps & { onScope: (scope: GalleryScope) => void };

function OwnerSection({
  section,
  view,
  ...props
}: ScopeProps & { section: GallerySection; view: GalleryView }) {
  const { ref, columns } = useGridColumns();
  const [open, setOpen] = useState(false);
  const cap = view === "grid" ? columns * SECTION_ROWS : 8;
  const first = section.designs.slice(0, cap);
  const rest = section.designs.slice(cap);
  const projectKey =
    section.scope.kind === "project" && section.designs[0]
      ? projectKeyFor(section.designs[0], props.projects)
      : null;
  const headingId = `design-section-${section.key.replace(/[^\w-]/g, "-")}`;
  const count = `${section.designs.length} ${section.designs.length === 1 ? "design" : "designs"}`;
  const body = (items: readonly DesignSummary[]) =>
    view === "grid" ? (
      <ul className={GRID}>
        {items.map((summary) => (
          <li key={summaryKey(summary)}>
            <DesignCard summary={summary} showOwner={false} {...props} />
          </li>
        ))}
      </ul>
    ) : (
      <DesignList {...props} rows={items} showOwner={false} header={items === first} />
    );
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3"
      data-testid="design-section"
      data-owner={section.scope.kind === "project" ? section.scope.projectId : "playground"}
    >
      <header className="sticky top-0 z-10 -mx-2 flex items-center gap-2 bg-background/92 px-2 py-1.5 backdrop-blur-sm">
        <OwnerIcon scope={section.scope} projects={props.projects} className="size-4" />
        <h2 id={headingId} className="min-w-0 truncate text-sm font-semibold">
          <button
            type="button"
            className="rounded-sm outline-none transition-colors duration-[120ms] hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => props.onScope(section.scope)}
          >
            {section.label}
          </button>
        </h2>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{count}</span>
        <span className="flex-1" />
        {projectKey !== null && props.onOpenProject ? (
          <button
            type="button"
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none transition-colors duration-[120ms] ease-out-quint hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => props.onOpenProject?.(section.designs[0]!, projectKey)}
          >
            Open project
            <ArrowUpRightIcon aria-hidden className="size-3.5" />
          </button>
        ) : null}
      </header>
      <div ref={ref}>{body(first)}</div>
      {rest.length > 0 ? (
        <>
          <div
            className={cn(
              "-mt-3 grid transition-[grid-template-rows] duration-200 ease-out-quint motion-reduce:transition-none",
              open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            )}
            inert={!open}
            data-testid="design-section-more"
          >
            <div className="min-h-0 overflow-hidden">
              <div className="pt-7">{body(rest)}</div>
            </div>
          </div>
          <button
            type="button"
            className="self-start rounded-md px-2 py-1 text-xs font-medium text-muted-foreground outline-none transition-colors duration-[120ms] hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "Show fewer" : `Show ${rest.length} more`}
          </button>
        </>
      ) : null}
    </section>
  );
}

type CardProps = DesignGalleryViewProps & {
  summary: DesignSummary;
  showOwner: boolean;
  onScope?: (scope: GalleryScope) => void;
};

function DesignCard({ summary, showOwner, onScope, ...props }: CardProps) {
  const title = summary.title || "Untitled";
  return (
    <article
      className="group/card flex flex-col gap-2.5"
      data-testid="design-card"
      data-owner={summary.ref.owner.kind}
      data-kind={summary.kind}
    >
      <button
        type="button"
        onClick={() => props.onOpen(summary)}
        aria-label={`Open ${title}`}
        className="block aspect-[4/3] w-full overflow-hidden rounded-lg bg-muted/60 ring-1 ring-border/60 outline-none transition-[background-color,box-shadow] duration-150 ease-out-quint hover:bg-muted hover:ring-border focus-visible:ring-2 focus-visible:ring-ring"
      >
        {props.renderThumbnail(summary)}
      </button>
      <div className="flex items-start gap-2 px-0.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
            <KindGlyph kind={summary.kind} />
            <span className="sr-only">{kindLabel(summary.kind)}: </span>
            <span className="truncate">{title}</span>
          </h3>
          <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {showOwner && onScope ? (
              <OwnerBadge summary={summary} projects={props.projects} onSelect={onScope} />
            ) : null}
            <span className="shrink-0 tabular-nums" data-testid="design-edited">
              {editedAgo(summary.updatedAt, props.now)}
            </span>
          </p>
        </div>
        <DesignActionsMenu
          summary={summary}
          projects={props.projects}
          canWrite={props.canWrite}
          handlers={props}
        />
      </div>
    </article>
  );
}

function DesignList({
  rows,
  showOwner,
  onScope,
  header = true,
  ...props
}: DesignGalleryViewProps & {
  rows: readonly DesignSummary[];
  showOwner: boolean;
  onScope?: (scope: GalleryScope) => void;
  header?: boolean;
}) {
  const columns = showOwner
    ? "grid-cols-[minmax(0,1fr)_minmax(0,12rem)_6rem_9rem_2rem]"
    : "grid-cols-[minmax(0,1fr)_6rem_9rem_2rem]";
  return (
    <div
      role="table"
      aria-label="Designs"
      className="flex flex-col text-sm"
      data-testid="design-list"
    >
      {header ? (
        <div
          role="row"
          className={cn(
            "grid gap-3 border-b border-border/70 px-2 pb-2 text-xs text-muted-foreground",
            columns,
          )}
        >
          <span role="columnheader">Name</span>
          {showOwner ? <span role="columnheader">Owner</span> : null}
          <span role="columnheader">Kind</span>
          <span role="columnheader">Edited</span>
          <span role="columnheader" className="sr-only">
            Actions
          </span>
        </div>
      ) : null}
      {rows.map((summary) => (
        <div
          role="row"
          key={summaryKey(summary)}
          data-testid="design-row"
          className={cn(
            "grid items-center gap-3 rounded-md px-2 py-1.5 transition-colors duration-[120ms] hover:bg-accent/60",
            columns,
          )}
        >
          <span role="cell" className="min-w-0">
            <button
              type="button"
              onClick={() => props.onOpen(summary)}
              className="flex w-full min-w-0 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <KindGlyph kind={summary.kind} />
              <span className="truncate font-medium">{summary.title || "Untitled"}</span>
            </button>
          </span>
          {showOwner && onScope ? (
            <span role="cell" className="min-w-0">
              <OwnerBadge summary={summary} projects={props.projects} onSelect={onScope} />
            </span>
          ) : null}
          <span role="cell" className="text-muted-foreground">
            {kindLabel(summary.kind)}
          </span>
          <span role="cell" className="text-muted-foreground tabular-nums">
            {editedAgo(summary.updatedAt, props.now).replace(/^Edited /, "")}
          </span>
          <span role="cell">
            <DesignActionsMenu
              summary={summary}
              projects={props.projects}
              canWrite={props.canWrite}
              handlers={props}
            />
          </span>
        </div>
      ))}
    </div>
  );
}
