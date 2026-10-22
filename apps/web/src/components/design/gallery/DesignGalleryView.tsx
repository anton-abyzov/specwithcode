/**
 * The Design gallery: every design this machine can read, with tabs for
 * All, Playground and Projects, a project filter, search, and grid or list
 * views. Data and actions come in as props, so the page wires the server and
 * the headless fixture wires synthetic designs into the same component.
 */
import type { DesignSummary, ProjectId } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { LayoutGridIcon, ListIcon, PaletteIcon, PresentationIcon, SearchIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";

import { InputGroup, InputGroupAddon, InputGroupInput } from "../../ui/input-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { CreationRow } from "./CreationRow";
import { DesignActionsMenu, type DesignActionHandlers, type GalleryProject } from "./DesignActions";
import {
  availableCreationKinds,
  editedAgo,
  filterDesigns,
  GALLERY_TAB_LABELS,
  GALLERY_TABS,
  kindLabel,
  summaryKey,
  type CreationKind,
  type GalleryTab,
  type GalleryView,
} from "./galleryModel";

const VIEW_STORAGE_KEY = "studio:design-gallery-view:v1";
const ViewSchema = Schema.Literals(["grid", "list"]);
const ALL_PROJECTS = "__all__";

export interface DesignGalleryViewProps extends DesignActionHandlers {
  /** Null while the first list is loading. */
  readonly designs: readonly DesignSummary[] | null;
  readonly error: string | null;
  /** Owners that could not be read, as the server reported them. */
  readonly problems: readonly { readonly ownerLabel: string; readonly detail: string }[];
  readonly projects: readonly GalleryProject[];
  readonly now: number;
  readonly canWrite: boolean;
  /** Whether this window may start threads, which "Design from code" needs. */
  readonly canOperate: boolean;
  readonly creationKinds?: readonly CreationKind[];
  readonly renderThumbnail: (summary: DesignSummary) => ReactNode;
  readonly onCreate: (kind: CreationKind) => void;
  /** Controls the tab and project filter, as the `/design` URL does; local state when omitted. */
  readonly filter?: GalleryOwnerFilter;
  readonly onFilterChange?: (filter: GalleryOwnerFilter) => void;
}

export interface GalleryOwnerFilter {
  readonly tab: GalleryTab;
  readonly projectId: ProjectId | null;
}

function KindGlyph({ kind, className }: { kind: DesignSummary["kind"]; className?: string }) {
  const Icon = kind === "slides" ? PresentationIcon : PaletteIcon;
  return <Icon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
}

export function DesignGalleryView(props: DesignGalleryViewProps) {
  const [local, setLocal] = useState<GalleryOwnerFilter>({ tab: "all", projectId: null });
  const { tab, projectId } = props.filter ?? local;
  const changeFilter = (next: GalleryOwnerFilter) => {
    if (props.filter === undefined) setLocal(next);
    props.onFilterChange?.(next);
  };
  const [query, setQuery] = useState("");
  const [view, setView] = useLocalStorage<GalleryView, GalleryView>(
    VIEW_STORAGE_KEY,
    "grid",
    ViewSchema,
  );
  const kinds = props.creationKinds ?? availableCreationKinds();
  const shown =
    props.designs === null
      ? null
      : filterDesigns(props.designs, {
          tab,
          projectId: tab === "projects" ? projectId : null,
          query,
        });
  const selectedProject = props.projects.find((project) => project.id === projectId) ?? null;
  const searching = query.trim() !== "" || (tab === "projects" && projectId !== null);

  return (
    <div className="flex flex-col gap-8" data-testid="design-gallery">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div role="tablist" aria-label="Designs" className="flex items-center gap-1">
          {GALLERY_TABS.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              data-testid="design-tab"
              data-tab={value}
              onClick={() =>
                changeFilter({ tab: value, projectId: value === "projects" ? projectId : null })
              }
              className="rounded-md px-2.5 py-1 text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-selected:bg-accent aria-selected:font-medium aria-selected:text-foreground"
            >
              {GALLERY_TAB_LABELS[value]}
            </button>
          ))}
        </div>
        {tab === "projects" && props.projects.length > 0 ? (
          <Select
            value={projectId ?? ALL_PROJECTS}
            onValueChange={(value) =>
              changeFilter({
                tab: "projects",
                projectId: value === ALL_PROJECTS || value === null ? null : (value as ProjectId),
              })
            }
          >
            <SelectTrigger size="sm" className="w-auto min-w-40" aria-label="Project">
              <SelectValue>{selectedProject?.title ?? "All projects"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
              {props.projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        <span className="flex-1" />
        <InputGroup className="w-full sm:w-56">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            size="sm"
            type="search"
            aria-label="Search designs"
            placeholder="Search designs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>
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

      {kinds.length > 0 ? (
        <CreationRow
          kinds={kinds}
          disabledReason={(kind) =>
            !props.canWrite
              ? "This window may not change files"
              : kind === "design-from-code" && !props.canOperate
                ? "This window may not start threads"
                : null
          }
          onCreate={props.onCreate}
        />
      ) : null}

      {props.error ? (
        <p role="alert" className="text-destructive-foreground text-sm">
          {props.error}
        </p>
      ) : null}
      {props.problems.length > 0 ? (
        <ul className="flex flex-col gap-1 text-muted-foreground text-sm" role="status">
          {props.problems.map((problem) => (
            <li key={problem.ownerLabel}>
              <span className="font-medium text-foreground">{problem.ownerLabel}</span>:{" "}
              {problem.detail}
            </li>
          ))}
        </ul>
      ) : null}

      <section aria-label="Your designs" className="flex flex-col gap-3">
        {shown === null ? (
          <p className="text-muted-foreground text-sm" role="status">
            Loading designs…
          </p>
        ) : shown.length === 0 ? (
          <EmptyGallery tab={tab} searching={searching} />
        ) : view === "grid" ? (
          <ul
            className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-5 gap-y-7"
            data-testid="design-grid"
          >
            {shown.map((summary) => (
              <li key={summaryKey(summary)}>
                <DesignCard summary={summary} {...props} />
              </li>
            ))}
          </ul>
        ) : (
          <DesignList {...props} rows={shown} />
        )}
      </section>
    </div>
  );
}

function EmptyGallery({ tab, searching }: { tab: GalleryTab; searching: boolean }) {
  return (
    <p className="text-muted-foreground text-sm" role="status" data-testid="design-empty">
      {searching
        ? "No design matches."
        : tab === "playground"
          ? "Nothing in your Playground yet. Start a design above; it stays on this machine until you copy it to a project."
          : tab === "projects"
            ? "No project has a design yet. Start one above, or use Design from code to have an agent design against a project."
            : "No designs yet. Start one above."}
    </p>
  );
}

type CardProps = DesignGalleryViewProps & { summary: DesignSummary };

function DesignCard({ summary, ...props }: CardProps) {
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
        className="block aspect-[4/3] w-full overflow-hidden rounded-lg bg-muted/60 outline-none ring-1 ring-border/60 transition-[background-color,box-shadow] hover:bg-muted hover:ring-border focus-visible:ring-2 focus-visible:ring-ring"
      >
        {props.renderThumbnail(summary)}
      </button>
      <div className="flex items-start gap-2 px-0.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="flex min-w-0 items-center gap-1.5 font-medium text-sm">
            <KindGlyph kind={summary.kind} />
            <span className="sr-only">{kindLabel(summary.kind)}: </span>
            <span className="truncate">{title}</span>
          </h3>
          <p className="flex min-w-0 items-baseline gap-2 text-muted-foreground text-xs">
            <span className="truncate" data-testid="design-owner">
              {summary.ownerLabel}
            </span>
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
  ...props
}: DesignGalleryViewProps & { rows: readonly DesignSummary[] }) {
  return (
    <div
      role="table"
      aria-label="Designs"
      className="flex flex-col text-sm"
      data-testid="design-list"
    >
      <div
        role="row"
        className="grid grid-cols-[minmax(0,1fr)_minmax(0,12rem)_6rem_9rem_2rem] gap-3 border-border/70 border-b px-2 pb-2 text-muted-foreground text-xs"
      >
        <span role="columnheader">Name</span>
        <span role="columnheader">Owner</span>
        <span role="columnheader">Kind</span>
        <span role="columnheader">Edited</span>
        <span role="columnheader" className="sr-only">
          Actions
        </span>
      </div>
      {rows.map((summary) => (
        <div
          role="row"
          key={summaryKey(summary)}
          data-testid="design-row"
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,12rem)_6rem_9rem_2rem] items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent/60"
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
          <span role="cell" className="truncate text-muted-foreground">
            {summary.ownerLabel}
          </span>
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
