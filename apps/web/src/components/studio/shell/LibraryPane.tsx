/**
 * The project's Library, laid out as the Claude desktop app's Library: a Type
 * filter, list and grid views, an Add button, and a tree with Name, Date
 * modified, Size and Kind columns. It lists the artifacts the SpecWeave
 * project hub registers, then the folders where SpecWeave keeps shared output;
 * a folder without SpecWeave shows its own files. The project's designs
 * (`.specweave/design/`) come first as their own group.
 */
import {
  AuthFilesystemWriteScope,
  type DesignSummary,
  type EnvironmentId,
  type ProjectEntry,
  type ProjectId,
  type ProjectLibrarySnapshot,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  ImageIcon,
  LayoutGridIcon,
  LinkIcon,
  ListIcon,
  PaletteIcon,
  PlusIcon,
  PresentationIcon,
  RotateCwIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";

import { isWebUrl } from "../../../browser/browserLinkTarget";
import { useOpenLink } from "../../../browser/useOpenLink";
import { useEnvironmentScope } from "../../../state/session";
import { useLocalStorage } from "../../../hooks/useLocalStorage";
import { useEnvironmentQuery } from "../../../state/query";
import { useAtomCommand } from "../../../state/use-atom-command";
import { design } from "../../../studio/design";
import { projectWorkspace } from "../../../studio/projectWorkspace";
import {
  formatLibraryDate,
  formatLibrarySize,
  libraryBaseName,
  libraryFileType,
  libraryKindLabel,
  libraryMatchesType,
  LIBRARY_TYPE_FILTER_LABELS,
  LIBRARY_TYPE_FILTERS,
  type LibraryTypeFilter,
} from "../../../studio/projectPaneModel";
import { designRoute } from "../../design/gallery/designLinks";
import { LibraryDesignMenu } from "../../design/gallery/LibraryDesignMenu";
import { useDirectoryEntries } from "../../files/useDirectoryEntries";
import { toastManager } from "../../ui/toast";
import { LibraryFileViewer, type LibraryViewerFile } from "./LibraryFileViewer";
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
import { ProjectPaneBar, type ProjectPaneBarProps } from "./ProjectPaneBar";
import { Tip } from "./Tip";
import { CharacterCount } from "../../ui/character-count";

const VIEW_STORAGE_KEY = "studio:project-library-view:v1";
const ViewSchema = Schema.Literals(["list", "grid"]);
const ARTIFACTS_ROW = "artifacts:";
const DESIGNS_ROW = "designs:";

/** One line of the tree: an artifact, a folder or a file inside one. */
interface LibraryRow {
  readonly id: string;
  readonly name: string;
  readonly kind: "file" | "directory" | "link" | "design";
  readonly depth: number;
  /** Workspace-relative path for files and folders; the URL for a link. */
  readonly location: string | null;
  readonly modifiedAt?: string | undefined;
  readonly byteLength?: number | undefined;
  readonly missing?: boolean;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly note?: string;
  readonly design?: DesignSummary;
}

/** What a row's type is read from: an artifact's file, not its title. */
function typed(row: LibraryRow) {
  return { kind: row.kind, name: row.kind === "file" && row.location ? row.location : row.name };
}

function RowIcon({ row }: { row: LibraryRow }) {
  if (row.id === ARTIFACTS_ROW) return <SparklesIcon aria-hidden />;
  if (row.id === DESIGNS_ROW) return <PaletteIcon aria-hidden />;
  if (row.kind === "design")
    return row.design?.kind === "slides" ? (
      <PresentationIcon aria-hidden />
    ) : (
      <PaletteIcon aria-hidden />
    );
  if (row.kind === "directory") return <FolderIcon aria-hidden />;
  if (row.kind === "link") return <LinkIcon aria-hidden />;
  const type = libraryFileType(typed(row).name);
  if (type === "images") return <ImageIcon aria-hidden />;
  if (type === "documents") return <FileTextIcon aria-hidden />;
  return <FileIcon aria-hidden />;
}

export function LibraryPane({
  environmentId,
  projectId,
  workspaceRoot,
  canChange,
  bar,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  workspaceRoot: string;
  canChange: boolean;
  bar: ProjectPaneBarProps;
}) {
  const library = useEnvironmentQuery(
    projectWorkspace.library({ environmentId, input: { projectId } }),
  );
  const addArtifact = useAtomCommand(projectWorkspace.libraryAddArtifact);
  const designs = useEnvironmentQuery(
    design.list({ environmentId, input: { filter: { kind: "project", projectId } } }),
  );
  const copyDesign = useAtomCommand(design.copy, { reportFailure: false });
  const router = useRouter();
  const directory = useDirectoryEntries(environmentId, workspaceRoot, { details: true });
  const openLink = useOpenLink(null);
  // Adding writes the hub file, so it needs filesystem write, not only operate.
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const [view, setView] = useLocalStorage<"list" | "grid", "list" | "grid">(
    VIEW_STORAGE_KEY,
    "list",
    ViewSchema,
  );
  const [type, setType] = useState<LibraryTypeFilter>("all");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set([ARTIFACTS_ROW, DESIGNS_ROW]),
  );
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const findRef = useRef<HTMLInputElement>(null);
  const [opened, setOpened] = useState<LibraryViewerFile | null>(null);
  const [adding, setAdding] = useState(false);
  const data: ProjectLibrarySnapshot | null = library.data ?? null;
  const now = new Date();

  const toggle = (row: LibraryRow) => {
    if (!row.expandable) return;
    const opening = !expanded.has(row.id);
    if (opening && row.location !== null) void directory.load(row.location);
    setExpanded((current) => {
      const next = new Set(current);
      if (opening) next.add(row.id);
      else next.delete(row.id);
      return next;
    });
  };

  const rows = useMemo(() => {
    const result: LibraryRow[] = [];
    const childrenOf = (path: string, depth: number) => {
      const children = [...(directory.directories.get(path) ?? [])].toSorted(
        (a: ProjectEntry, b: ProjectEntry) =>
          a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "directory" ? -1 : 1,
      );
      for (const entry of children) {
        const open = expanded.has(entry.path);
        result.push({
          id: entry.path,
          name: libraryBaseName(entry.path),
          kind: entry.kind,
          depth,
          location: entry.path,
          modifiedAt: entry.modifiedAt,
          byteLength: entry.byteLength,
          expandable: entry.kind === "directory",
          expanded: open,
        });
        if (entry.kind === "directory" && open) childrenOf(entry.path, depth + 1);
      }
    };
    if (!data) return result;
    const projectDesigns = (designs.data?.designs ?? []).toSorted((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    if (projectDesigns.length > 0) {
      const designsOpen = expanded.has(DESIGNS_ROW);
      result.push({
        id: DESIGNS_ROW,
        name: "Designs",
        kind: "directory",
        depth: 0,
        location: null,
        modifiedAt: projectDesigns[0]?.updatedAt,
        expandable: true,
        expanded: designsOpen,
        note: projectDesigns.length === 1 ? "1 design" : `${projectDesigns.length} designs`,
      });
      if (designsOpen) {
        for (const summary of projectDesigns) {
          result.push({
            id: `design:${summary.ref.designId}`,
            name: summary.title || "Untitled",
            kind: "design",
            depth: 1,
            location: summary.ref.path,
            modifiedAt: summary.updatedAt,
            expandable: false,
            expanded: false,
            design: summary,
          });
        }
      }
    }
    const usesSpecWeave = data.specweave || data.hub !== null || data.folders.length > 0;
    if (!usesSpecWeave) {
      childrenOf("", 0);
      return result;
    }
    const artifactsOpen = expanded.has(ARTIFACTS_ROW);
    result.push({
      id: ARTIFACTS_ROW,
      name: "Artifacts",
      kind: "directory",
      depth: 0,
      location: null,
      modifiedAt: data.hub?.updatedAt ?? undefined,
      expandable: true,
      expanded: artifactsOpen,
      note: `${data.artifacts.length} registered`,
    });
    if (artifactsOpen) {
      for (const artifact of data.artifacts) {
        result.push({
          id: `artifact:${artifact.id}`,
          name: artifact.title,
          kind: artifact.kind === "link" ? "link" : "file",
          depth: 1,
          location: artifact.location,
          modifiedAt: artifact.modifiedAt ?? artifact.createdAt,
          byteLength: artifact.byteLength,
          missing: artifact.missing,
          expandable: false,
          expanded: false,
        });
      }
    }
    for (const folder of data.folders) {
      const open = expanded.has(folder.path);
      result.push({
        id: folder.path,
        name: folder.label,
        kind: "directory",
        depth: 0,
        location: folder.path,
        modifiedAt: folder.modifiedAt,
        expandable: true,
        expanded: open,
        note: folder.path,
      });
      if (open) childrenOf(folder.path, 1);
    }
    return result;
  }, [data, designs.data, directory.directories, expanded]);

  const needle = query.trim().toLowerCase();
  const visible = rows.filter(
    (row) =>
      (type !== "designs" || row.id === DESIGNS_ROW || row.kind === "design") &&
      libraryMatchesType(type, typed(row)) &&
      (needle === "" || row.kind === "directory" || row.name.toLowerCase().includes(needle)),
  );

  const openDesign = (summary: DesignSummary) =>
    void router.navigate(designRoute({ kind: "project", projectId }, summary.ref.designId));
  /** The design's own file, opened in the Library viewer. */
  const showDesignFile = (summary: DesignSummary) => {
    const path = summary.ref.path.endsWith(".json")
      ? summary.ref.path
      : `${summary.ref.path.replace(/\/+$/, "")}/design.json`;
    setOpened({ path, name: libraryBaseName(path), modifiedAt: summary.updatedAt });
  };
  const copyToPlayground = async (summary: DesignSummary) => {
    const result = await copyDesign({
      environmentId,
      input: {
        owner: { kind: "project", projectId },
        designId: summary.ref.designId,
        to: { kind: "playground" },
      },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not copy the design",
        description: error instanceof Error ? error.message : "Nothing was copied.",
      });
      return;
    }
    const copy = result.value;
    toastManager.add({
      type: "success",
      title: "Copied to your Playground",
      actionProps: {
        children: "Open copy",
        onClick: () => void router.navigate(designRoute({ kind: "playground" }, copy.ref.designId)),
      },
    });
  };
  const designMenu = (summary: DesignSummary) => (
    <LibraryDesignMenu
      title={summary.title || "Untitled"}
      canCopy={canWrite}
      onOpen={() => openDesign(summary)}
      onCopyToPlayground={() => void copyToPlayground(summary)}
      onShowFile={() => showDesignFile(summary)}
    />
  );

  const open = (row: LibraryRow) => {
    if (row.design) return openDesign(row.design);
    if (row.kind === "directory") return toggle(row);
    if (row.location === null || row.missing) return;
    if (row.kind === "link") {
      if (isWebUrl(row.location)) void openLink(row.location).catch(() => undefined);
      return;
    }
    setOpened({ path: row.location, name: row.name, modifiedAt: row.modifiedAt });
  };

  const refresh = () => {
    library.refresh();
    designs.refresh();
    directory.refresh();
  };

  const tools = (
    <>
      <Tip label="Find in the Library">
        <button
          type="button"
          className="sws-icon-button"
          aria-label="Find in the Library"
          aria-expanded={findOpen || query !== ""}
          onClick={() => {
            if (findOpen || query !== "") {
              setQuery("");
              setFindOpen(false);
            } else {
              setFindOpen(true);
              requestAnimationFrame(() => findRef.current?.focus());
            }
          }}
        >
          <SearchIcon aria-hidden />
        </button>
      </Tip>
    </>
  );

  // Files open in the app's viewer overlay, the Library's other files a step away.
  const viewerFiles = visible.flatMap((row) =>
    row.kind === "file" && row.location !== null && !row.missing
      ? [{ path: row.location, name: row.name, modifiedAt: row.modifiedAt }]
      : [],
  );
  const viewer = opened ? (
    <LibraryFileViewer
      environmentId={environmentId}
      workspaceRoot={workspaceRoot}
      files={viewerFiles.some((file) => file.path === opened.path) ? viewerFiles : [opened]}
      path={opened.path}
      onPath={(path) =>
        setOpened(viewerFiles.find((file) => file.path === path) ?? { path, name: path })
      }
      onClose={() => setOpened(null)}
    />
  ) : null;

  return (
    <>
      <ProjectPaneBar {...bar} tools={tools} />
      <div
        className="sws-threads-body sws-library"
        id="sws-pane-library"
        role="tabpanel"
        aria-labelledby="sws-pane-tab-library"
      >
        <div className="sws-library-toolbar">
          <Menu>
            <MenuTrigger
              render={<button type="button" className="sws-library-filter" />}
              aria-label={`Type: ${LIBRARY_TYPE_FILTER_LABELS[type]}`}
            >
              {type === "all" ? "Type" : LIBRARY_TYPE_FILTER_LABELS[type]}
              <ChevronDownIcon aria-hidden />
            </MenuTrigger>
            <MenuPopup align="start" side="bottom" className="min-w-44">
              <MenuGroup>
                <MenuGroupLabel>Type</MenuGroupLabel>
                <MenuRadioGroup
                  value={type}
                  onValueChange={(value) => setType(value as LibraryTypeFilter)}
                >
                  {LIBRARY_TYPE_FILTERS.map((value) => (
                    <MenuRadioItem key={value} value={value}>
                      <span className="flex items-center justify-between gap-6">
                        {LIBRARY_TYPE_FILTER_LABELS[value]}
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
                aria-pressed={view === "list"}
                onClick={() => setView("list")}
              >
                <ListIcon aria-hidden />
              </button>
            </Tip>
            <Tip label="Grid">
              <button
                type="button"
                className="sws-icon-button"
                aria-label="Grid view"
                aria-pressed={view === "grid"}
                onClick={() => setView("grid")}
              >
                <LayoutGridIcon aria-hidden />
              </button>
            </Tip>
          </div>
          <Tip label="Reload the Library">
            <button
              type="button"
              className="sws-icon-button"
              aria-label="Reload the Library"
              onClick={refresh}
            >
              <RotateCwIcon aria-hidden />
            </button>
          </Tip>
          <Tip
            label={
              data?.specweave
                ? "Register a file or link as a project artifact"
                : "Artifacts need a SpecWeave project (specweave init)"
            }
          >
            <button
              type="button"
              className="sws-library-add"
              aria-expanded={adding}
              disabled={!canChange || !canWrite || !data?.specweave}
              onClick={() => setAdding((value) => !value)}
            >
              <PlusIcon aria-hidden />
              Add
            </button>
          </Tip>
        </div>
        {findOpen || query !== "" ? (
          <label className="sws-find">
            <SearchIcon aria-hidden />
            <input
              ref={findRef}
              type="search"
              aria-label="Find in the Library"
              placeholder="Find by name"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                setQuery("");
                setFindOpen(false);
              }}
            />
          </label>
        ) : null}
        {adding && data ? (
          <AddArtifactForm
            onCancel={() => setAdding(false)}
            onAdd={async (title, location) => {
              const result = await addArtifact({
                environmentId,
                input: {
                  projectId,
                  title,
                  location,
                  expectedRevision: data.hub?.revision ?? 0,
                },
              });
              if (result._tag === "Failure") {
                const error = squashAtomCommandFailure(result);
                return error instanceof Error ? error.message : "The artifact was not added.";
              }
              setAdding(false);
              setExpanded((current) => new Set(current).add(ARTIFACTS_ROW));
              library.refresh();
              return null;
            }}
          />
        ) : null}
        {library.error ? (
          <p className="project-notice" role="alert">
            {library.error}
          </p>
        ) : null}
        {data?.hubProblem ? (
          <p className="project-notice" role="status">
            {data.hubProblem}
          </p>
        ) : null}
        {directory.error ? (
          <p className="project-notice" role="status">
            {directory.error}
          </p>
        ) : null}
        {!data ? (
          <p className="sws-empty" role="status">
            {library.isPending ? "Loading the Library…" : "The Library is unavailable."}
          </p>
        ) : visible.length === 0 ? (
          <p className="sws-empty" role="status">
            {needle || type !== "all" ? "Nothing matches." : "Nothing in the Library yet."}
          </p>
        ) : view === "grid" ? (
          <ul className="sws-library-grid" aria-label="Library">
            {visible.map((row) => (
              <li key={row.id} className="relative">
                {row.design ? (
                  <span className="absolute top-1 right-1 z-10">{designMenu(row.design)}</span>
                ) : null}
                <button
                  type="button"
                  className="sws-library-tile"
                  data-kind={row.kind}
                  data-missing={row.missing || undefined}
                  aria-expanded={row.expandable ? row.expanded : undefined}
                  onClick={() => open(row)}
                >
                  <span className="sws-library-tile-icon">
                    <RowIcon row={row} />
                  </span>
                  <span className="sws-library-tile-name">{row.name}</span>
                  <span className="sws-library-tile-meta">
                    {row.missing
                      ? row.kind === "link"
                        ? "Unsafe link"
                        : "Missing"
                      : libraryKindLabel(typed(row))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="sws-library-table" role="treegrid" aria-label="Library">
            <div className="sws-library-head" role="row">
              <span role="columnheader">Name</span>
              <span role="columnheader">Date modified</span>
              <span role="columnheader">Size</span>
              <span role="columnheader">Kind</span>
            </div>
            {visible.map((row) => (
              <div
                key={row.id}
                role="row"
                aria-level={row.depth + 1}
                aria-expanded={row.expandable ? row.expanded : undefined}
                className="sws-library-row"
                data-kind={row.kind}
                data-missing={row.missing || undefined}
              >
                <span
                  role="gridcell"
                  className={
                    row.design ? "sws-library-name flex items-center gap-1" : "sws-library-name"
                  }
                >
                  <button
                    type="button"
                    className={row.design ? "w-auto! min-w-0 flex-1" : undefined}
                    style={{ paddingInlineStart: `${row.depth * 16 + 4}px` }}
                    onClick={() => open(row)}
                    aria-description={row.note ?? row.location ?? undefined}
                  >
                    {row.expandable ? (
                      row.expanded ? (
                        <ChevronDownIcon aria-hidden className="sws-library-chevron" />
                      ) : (
                        <ChevronRightIcon aria-hidden className="sws-library-chevron" />
                      )
                    ) : (
                      <span className="sws-library-chevron" aria-hidden />
                    )}
                    <RowIcon row={row} />
                    <span className="sws-library-label">{row.name}</span>
                    {row.kind === "link" ? (
                      <ExternalLinkIcon aria-hidden className="sws-library-external" />
                    ) : null}
                  </button>
                  {row.design ? (
                    <span className="flex-none [&>button]:size-6! [&>button]:w-6!">
                      {designMenu(row.design)}
                    </span>
                  ) : null}
                </span>
                <span role="gridcell">{formatLibraryDate(row.modifiedAt, now)}</span>
                <span role="gridcell">
                  {row.kind === "directory" || row.kind === "design"
                    ? "--"
                    : formatLibrarySize(row.byteLength)}
                </span>
                <span role="gridcell">
                  {row.missing
                    ? row.kind === "link"
                      ? "Unsafe link"
                      : "Missing"
                    : libraryKindLabel(typed(row))}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {viewer}
    </>
  );
}

function AddArtifactForm(props: {
  onCancel: () => void;
  onAdd: (title: string, location: string) => Promise<string | null>;
}) {
  const countId = useId();
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="sws-library-form"
      aria-label="Add an artifact"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(null);
        void props.onAdd(title, location).then((problem) => {
          setBusy(false);
          setError(problem);
        });
      }}
    >
      <label>
        <span>Title</span>
        <input
          required
          maxLength={180}
          aria-describedby={`${countId}-title`}
          value={title}
          placeholder="Release notes"
          onChange={(event) => setTitle(event.target.value)}
        />
        <CharacterCount id={`${countId}-title`} value={title} max={180} />
      </label>
      <label>
        <span>File or link</span>
        <input
          required
          maxLength={2000}
          aria-describedby={`${countId}-location`}
          value={location}
          placeholder=".specweave/reports/notes.md or https://…"
          onChange={(event) => setLocation(event.target.value)}
        />
        <CharacterCount id={`${countId}-location`} value={location} max={2000} />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <div className="sws-library-form-actions">
        <button type="button" className="project-control" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className="project-control project-primary" disabled={busy}>
          {busy ? "Adding…" : "Add artifact"}
        </button>
      </div>
    </form>
  );
}
