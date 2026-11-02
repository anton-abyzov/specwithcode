/**
 * Library > Artifacts: every artifact of the project, pinned first, then most
 * recently updated, as a list (Name, Thread, Date modified, Size) whose headers
 * sort it or a grid of the shelf's cards, with a Type filter and find.
 */
import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  LayoutGridIcon,
  ListIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import {
  artifactMatchesType,
  artifactTypesPresent,
  ARTIFACT_TYPE_FILTER_LABELS,
  ARTIFACT_TYPE_FILTERS,
  DEFAULT_ARTIFACT_SORT,
  formatArtifactDate,
  nextArtifactSort,
  searchArtifacts,
  sortArtifacts,
  type ArtifactSort,
  type ArtifactSortColumn,
  type ArtifactTypeFilter,
  type ProjectArtifact,
} from "../../../studio/projectArtifacts";
import { formatLibrarySize } from "../../../studio/projectPaneModel";
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
import {
  ArtifactCard,
  ArtifactKindIcon,
  ArtifactMenu,
  ArtifactPinButton,
  canOpenArtifact,
  useArtifactOpener,
} from "./ProjectArtifactShelf";
import { Tip } from "./Tip";

function SortHeader(props: {
  readonly column: ArtifactSortColumn;
  readonly label: string;
  readonly sort: ArtifactSort;
  readonly onSort: (column: ArtifactSortColumn) => void;
}) {
  const active = props.sort.column === props.column;
  const Arrow = props.sort.descending ? ArrowDownIcon : ArrowUpIcon;
  return (
    <span
      role="columnheader"
      aria-sort={active ? (props.sort.descending ? "descending" : "ascending") : "none"}
    >
      <button
        type="button"
        className="sws-artifact-sort"
        data-active={active || undefined}
        onClick={() => props.onSort(props.column)}
      >
        {props.label}
        {active ? <Arrow aria-hidden /> : null}
      </button>
    </span>
  );
}

export function ProjectArtifactsLibrary(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly artifacts: ReadonlyArray<ProjectArtifact>;
  readonly loaded: boolean;
  readonly query: string;
  readonly type: ArtifactTypeFilter;
  readonly onTypeChange: (type: ArtifactTypeFilter) => void;
  readonly view: "list" | "grid";
  readonly onViewChange: (view: "list" | "grid") => void;
  readonly onPin: (id: string, on: boolean) => void;
  readonly onOpenThread?: ((threadId: ThreadId, environmentId: EnvironmentId) => void) | undefined;
  readonly sectionSwitch: ReactNode;
}) {
  const { open, viewer } = useArtifactOpener(props.environmentId, props.workspaceRoot);
  const present = artifactTypesPresent(props.artifacts);
  const type = present.has(props.type) ? props.type : "all";
  const [sort, setSort] = useState(DEFAULT_ARTIFACT_SORT);
  const onSort = (column: ArtifactSortColumn) =>
    setSort((current) => nextArtifactSort(current, column));
  const visible = sortArtifacts(
    searchArtifacts(
      props.artifacts.filter((artifact) => artifactMatchesType(type, artifact)),
      props.query,
    ),
    sort,
  );
  const now = Date.now();

  return (
    <>
      <div className="sws-library-toolbar">
        {props.sectionSwitch}
        <Menu>
          <MenuTrigger
            render={<button type="button" className="sws-library-filter" />}
            aria-label={`Type: ${ARTIFACT_TYPE_FILTER_LABELS[type]}`}
          >
            {type === "all" ? "Type" : ARTIFACT_TYPE_FILTER_LABELS[type]}
            <ChevronDownIcon aria-hidden />
          </MenuTrigger>
          <MenuPopup align="start" side="bottom" className="min-w-48">
            <MenuGroup>
              <MenuGroupLabel>Type</MenuGroupLabel>
              <MenuRadioGroup
                value={type}
                onValueChange={(value) => props.onTypeChange(value as ArtifactTypeFilter)}
              >
                {ARTIFACT_TYPE_FILTERS.filter((value) => present.has(value)).map((value) => (
                  <MenuRadioItem key={value} value={value}>
                    <span className="flex items-center justify-between gap-6">
                      {ARTIFACT_TYPE_FILTER_LABELS[value]}
                      <MenuRadioItemIndicator />
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </MenuPopup>
        </Menu>
        <span className="sws-library-spacer" />
        <div className="sws-library-views" role="group" aria-label="View">
          <Tip label="List">
            <button
              type="button"
              className="sws-icon-button"
              aria-label="List view"
              aria-pressed={props.view === "list"}
              onClick={() => props.onViewChange("list")}
            >
              <ListIcon aria-hidden />
            </button>
          </Tip>
          <Tip label="Grid">
            <button
              type="button"
              className="sws-icon-button"
              aria-label="Grid view"
              aria-pressed={props.view === "grid"}
              onClick={() => props.onViewChange("grid")}
            >
              <LayoutGridIcon aria-hidden />
            </button>
          </Tip>
        </div>
      </div>
      {visible.length === 0 ? (
        <p className="sws-empty" role="status">
          {!props.loaded
            ? "Loading artifacts…"
            : props.query.trim() !== "" || type !== "all"
              ? "Nothing matches."
              : "No artifacts yet. Reports, screenshots, pages and designs the threads produce show here."}
        </p>
      ) : props.view === "grid" ? (
        <ul className="sws-artifact-grid" aria-label="Artifacts">
          {visible.map((artifact) => (
            <ArtifactCard
              key={artifact.id}
              artifact={artifact}
              environmentId={props.environmentId}
              workspaceRoot={props.workspaceRoot}
              now={now}
              onOpen={() => open(artifact, visible)}
              onPin={(on) => props.onPin(artifact.id, on)}
              onOpenThread={props.onOpenThread}
              windowed
            />
          ))}
        </ul>
      ) : (
        <div className="sws-library-table sws-artifact-table" role="grid" aria-label="Artifacts">
          <div className="sws-library-head" role="row">
            <SortHeader column="name" label="Name" sort={sort} onSort={onSort} />
            <SortHeader column="thread" label="Thread" sort={sort} onSort={onSort} />
            <SortHeader column="modified" label="Date modified" sort={sort} onSort={onSort} />
            <SortHeader column="size" label="Size" sort={sort} onSort={onSort} />
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
          {visible.map((artifact) => (
            <div
              key={artifact.id}
              role="row"
              className="sws-library-row"
              data-pinned={artifact.pinned || undefined}
              data-missing={artifact.missing || undefined}
            >
              <span role="gridcell" className="sws-library-name">
                <button
                  type="button"
                  disabled={!canOpenArtifact(artifact)}
                  onClick={() => open(artifact, visible)}
                  aria-description={artifact.path ?? artifact.url ?? undefined}
                >
                  <span className="sws-library-chevron" aria-hidden />
                  <ArtifactKindIcon artifact={artifact} />
                  <span className="sws-library-label">{artifact.title}</span>
                  {artifact.missing ? (
                    <span className="sws-artifact-missing-tag">Missing</span>
                  ) : null}
                  {artifact.path === null && artifact.url !== null ? (
                    <ExternalLinkIcon aria-hidden className="sws-library-external" />
                  ) : null}
                </button>
              </span>
              <span role="gridcell" className="sws-artifact-thread-cell">
                {artifact.thread ? (
                  props.onOpenThread ? (
                    <button
                      type="button"
                      onClick={() =>
                        props.onOpenThread!(
                          artifact.thread!.threadId,
                          artifact.thread!.environmentId,
                        )
                      }
                    >
                      {artifact.thread.title}
                    </button>
                  ) : (
                    artifact.thread.title
                  )
                ) : artifact.increment ? (
                  artifact.increment
                ) : (
                  "--"
                )}
              </span>
              <span role="gridcell">{formatArtifactDate(artifact.updatedAt)}</span>
              <span role="gridcell">
                {artifact.byteLength === null ? "--" : formatLibrarySize(artifact.byteLength)}
              </span>
              <span role="gridcell" className="sws-artifact-row-actions">
                <ArtifactPinButton
                  artifact={artifact}
                  onPin={(on) => props.onPin(artifact.id, on)}
                />
                <ArtifactMenu
                  artifact={artifact}
                  className="sws-artifact-more"
                  onOpen={() => open(artifact, visible)}
                  onPin={(on) => props.onPin(artifact.id, on)}
                  onOpenThread={props.onOpenThread}
                />
              </span>
            </div>
          ))}
        </div>
      )}
      {viewer}
    </>
  );
}
