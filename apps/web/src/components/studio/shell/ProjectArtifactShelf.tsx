/**
 * The project's artifacts above its Threads list, as a row of cards: a
 * thumbnail or kind tile, the title and its age, a pin, a ... menu and View
 * all into the Library's Artifacts view. The pieces here (thumbnail, menu,
 * opener) are shared with that view.
 */
import type { AssetResource, EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeIcon,
  DatabaseIcon,
  FileTextIcon,
  FilmIcon,
  GlobeIcon,
  ImageIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PaletteIcon,
  PinIcon,
  PresentationIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { useAssetUrlState } from "../../../assets/assetUrls";
import { isWebUrl } from "../../../browser/browserLinkTarget";
import { useOpenLink } from "../../../browser/useOpenLink";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { useLocalStorage } from "../../../hooks/useLocalStorage";
import {
  artifactAge,
  artifactKindLabel,
  ARTIFACT_SHELF_LIMIT,
  type ProjectArtifact,
  type ProjectArtifactKind,
} from "../../../studio/projectArtifacts";
import { useProjectFileQuery } from "../../files/projectFilesQueryState";
import { PULL_REQUEST_STATE_PRESENTATION } from "../../pullRequest/pullRequestIcons";
import { designRoute } from "../../design/gallery/designLinks";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../ui/menu";
import { LibraryFileViewer, type LibraryViewerFile } from "./LibraryFileViewer";
import { Tip } from "./Tip";

const KIND_ICON: Record<ProjectArtifactKind, typeof FileTextIcon> = {
  design: PaletteIcon,
  slides: PresentationIcon,
  page: GlobeIcon,
  document: FileTextIcon,
  image: ImageIcon,
  video: FilmIcon,
  data: DatabaseIcon,
  code: CodeIcon,
  pullRequest: PULL_REQUEST_STATE_PRESENTATION.open.Icon,
  link: LinkIcon,
};

function extensionOf(artifact: ProjectArtifact): string | null {
  if (artifact.path === null) return null;
  const name = artifact.path.slice(artifact.path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1, dot + 5).toUpperCase() : null;
}

export function ArtifactKindIcon({ artifact }: { artifact: ProjectArtifact }) {
  if (artifact.kind === "pullRequest" && artifact.pullRequestState !== null) {
    const { Icon, toneClassName } = PULL_REQUEST_STATE_PRESENTATION[artifact.pullRequestState];
    return <Icon aria-hidden className={toneClassName} />;
  }
  const Icon = KIND_ICON[artifact.kind];
  return <Icon aria-hidden />;
}

/** Documents small enough to read for a page preview on their card. */
const PREVIEW_MAX_BYTES = 512 * 1024;
const PREVIEW_CHARS = 1600;
// A preview shows the page's own text and styles, nothing it would fetch.
const PREVIEW_CSP =
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:\">";

function previewFormat(artifact: ProjectArtifact): "markdown" | "html" | null {
  if (artifact.kind !== "document" && artifact.kind !== "page") return null;
  if (artifact.path === null || artifact.missing) return null;
  // Files only the thread's own worktree has are read where they open, not here.
  if (artifact.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(artifact.path)) return null;
  if (artifact.byteLength !== null && artifact.byteLength > PREVIEW_MAX_BYTES) return null;
  if (/\.(md|markdown|mdx|txt)$/i.test(artifact.path)) return "markdown";
  if (/\.html?$/i.test(artifact.path)) return "html";
  return null;
}

/** The first lines of a markdown file as a small page: its heading, then text. */
function MarkdownPage({ text }: { text: string }) {
  const lines = text
    .slice(0, PREVIEW_CHARS)
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^(```|<!--|\|?\s*-{3,})/.test(line))
    .slice(0, 14);
  return (
    <span className="sws-artifact-page" aria-hidden>
      {lines.map((line, index) => {
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        const plain = (heading ? heading[2]! : line)
          .replace(/^[-*+]\s+|^\d+\.\s+|^>\s*/, "")
          .replace(/[*_`]|\[([^\]]*)\]\([^)]*\)/g, (match, label?: string) => label ?? "");
        return (
          <span
            key={index}
            className="sws-artifact-page-line"
            data-heading={heading ? Math.min(heading[1]!.length, 3) : undefined}
          >
            {plain}
          </span>
        );
      })}
    </span>
  );
}

function DocumentPreview(props: {
  readonly artifact: ProjectArtifact;
  readonly format: "markdown" | "html";
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}) {
  const file = useProjectFileQuery(
    props.environmentId,
    props.artifact.root ?? props.workspaceRoot,
    props.artifact.path,
  );
  const text = file.data?.contents;
  if (typeof text !== "string" || text.trim() === "") return null;
  if (props.format === "html") {
    return (
      <span className="sws-artifact-page sws-artifact-page-html" aria-hidden>
        <iframe
          title=""
          tabIndex={-1}
          sandbox=""
          loading="lazy"
          srcDoc={PREVIEW_CSP + text.slice(0, 64 * 1024)}
        />
      </span>
    );
  }
  return <MarkdownPage text={text} />;
}

/** An image shows itself; everything else a tile with its kind and extension. */
export function ArtifactThumbnail(props: {
  readonly artifact: ProjectArtifact;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}) {
  const { artifact } = props;
  const resource = useMemo<AssetResource | null>(
    () =>
      artifact.kind === "image" && artifact.path !== null && !artifact.missing
        ? {
            _tag: "draft-workspace-file",
            cwd: artifact.root ?? props.workspaceRoot,
            path: artifact.path,
          }
        : null,
    [artifact.kind, artifact.missing, artifact.path, artifact.root, props.workspaceRoot],
  );
  const asset = useAssetUrlState(resource === null ? null : props.environmentId, resource);
  const [broken, setBroken] = useState(false);
  if (asset._tag === "Success" && !broken) {
    return (
      <img
        src={asset.url}
        alt=""
        className="sws-artifact-thumb-image"
        loading="lazy"
        onError={() => setBroken(true)}
      />
    );
  }
  const extension = extensionOf(artifact);
  const format = previewFormat(artifact);
  if (format !== null) {
    return (
      <DocumentPreviewOrTile
        artifact={artifact}
        format={format}
        environmentId={props.environmentId}
        workspaceRoot={props.workspaceRoot}
        extension={extension}
      />
    );
  }
  return <KindTile artifact={artifact} extension={extension} />;
}

function KindTile(props: {
  readonly artifact: ProjectArtifact;
  readonly extension: string | null;
}) {
  const { artifact, extension } = props;
  return (
    <span className="sws-artifact-thumb-tile" data-kind={artifact.kind}>
      <ArtifactKindIcon artifact={artifact} />
      {extension ? <span className="sws-artifact-thumb-ext">{extension}</span> : null}
    </span>
  );
}

function DocumentPreviewOrTile(props: {
  readonly artifact: ProjectArtifact;
  readonly format: "markdown" | "html";
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly extension: string | null;
}) {
  // The tile stays underneath until, or unless, the page can be read.
  return (
    <>
      <KindTile artifact={props.artifact} extension={props.extension} />
      <DocumentPreview
        artifact={props.artifact}
        format={props.format}
        environmentId={props.environmentId}
        workspaceRoot={props.workspaceRoot}
      />
    </>
  );
}

/**
 * Opens an artifact where it belongs: a design in its editor, a file in the
 * app's viewer, a link or pull request in the browser. Returns the viewer to
 * render beside the caller.
 */
export function useArtifactOpener(environmentId: EnvironmentId, workspaceRoot: string) {
  const router = useRouter();
  const openLink = useOpenLink(null);
  const [opened, setOpened] = useState<{
    file: LibraryViewerFile;
    files: LibraryViewerFile[];
    /** A thread's worktree for a file not yet in the project. */
    root: string | null;
  } | null>(null);
  const open = (artifact: ProjectArtifact, siblings: ReadonlyArray<ProjectArtifact> = []) => {
    if (artifact.design) {
      const ref = artifact.design.ref;
      if (ref.owner.kind !== "project") return;
      void router.navigate(
        designRoute({ kind: "project", projectId: ref.owner.projectId }, ref.designId),
      );
      return;
    }
    if (artifact.path !== null && !artifact.missing) {
      const asFile = (item: ProjectArtifact): LibraryViewerFile => ({
        path: item.path!,
        name: item.title,
        modifiedAt: item.updatedAt === null ? undefined : new Date(item.updatedAt).toISOString(),
      });
      // The viewer steps through files of one folder: the project's, or this worktree's.
      const files = siblings
        .filter(
          (item) =>
            item.path !== null &&
            !item.missing &&
            item.design === null &&
            item.root === artifact.root,
        )
        .map(asFile);
      const file = asFile(artifact);
      setOpened({
        file,
        files: files.some((item) => item.path === file.path) ? files : [file],
        root: artifact.root,
      });
      return;
    }
    if (artifact.url !== null && !artifact.missing && isWebUrl(artifact.url)) {
      void openLink(artifact.url).catch(() => undefined);
    }
  };
  const viewer = opened ? (
    <LibraryFileViewer
      environmentId={environmentId}
      workspaceRoot={opened.root ?? workspaceRoot}
      files={opened.files}
      path={opened.file.path}
      onPath={(path) =>
        setOpened((current) =>
          current
            ? {
                ...current,
                file: current.files.find((item) => item.path === path) ?? { path, name: path },
              }
            : current,
        )
      }
      onClose={() => setOpened(null)}
    />
  ) : null;
  return { open, viewer };
}

export function canOpenArtifact(artifact: ProjectArtifact): boolean {
  if (artifact.missing) return false;
  if (artifact.design) return artifact.design.ref.owner.kind === "project";
  return artifact.path !== null || (artifact.url !== null && isWebUrl(artifact.url));
}

/** What the ... menu offers for one artifact. */
export function ArtifactMenu(props: {
  readonly artifact: ProjectArtifact;
  readonly onOpen: () => void;
  readonly onPin: (on: boolean) => void;
  readonly onOpenThread?: ((threadId: ThreadId, environmentId: EnvironmentId) => void) | undefined;
  readonly onShowInLibrary?: (() => void) | undefined;
  readonly className?: string | undefined;
}) {
  const { artifact } = props;
  const { copyToClipboard } = useCopyToClipboard();
  const copyValue =
    artifact.url ??
    (artifact.path !== null && artifact.root !== null
      ? `${artifact.root.replace(/[\\/]+$/, "")}/${artifact.path}`
      : artifact.path);
  return (
    <Menu>
      <MenuTrigger
        render={<button type="button" className={props.className ?? "sws-icon-button"} />}
        aria-label={`More for ${artifact.title}`}
      >
        <MoreHorizontalIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="min-w-48">
        <MenuItem disabled={!canOpenArtifact(artifact)} onClick={props.onOpen}>
          Open
        </MenuItem>
        <MenuItem onClick={() => props.onPin(!artifact.pinned)}>
          {artifact.pinned ? "Unpin" : "Pin to the top"}
        </MenuItem>
        {artifact.thread && props.onOpenThread ? (
          <MenuItem
            onClick={() =>
              props.onOpenThread!(artifact.thread!.threadId, artifact.thread!.environmentId)
            }
          >
            Open thread
          </MenuItem>
        ) : null}
        {props.onShowInLibrary ? (
          <MenuItem onClick={props.onShowInLibrary}>Show in Library</MenuItem>
        ) : null}
        {copyValue ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => copyToClipboard(copyValue, undefined)}>
              {artifact.url !== null ? "Copy link" : "Copy path"}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

export function ArtifactPinButton(props: {
  readonly artifact: ProjectArtifact;
  readonly onPin: (on: boolean) => void;
}) {
  const { artifact } = props;
  // aria-pressed carries the state, so the name stays the same.
  const label = `Pin ${artifact.title}`;
  return (
    <Tip label={artifact.pinned ? "Unpin" : "Pin to the top"}>
      <button
        type="button"
        className="sws-artifact-pin"
        aria-label={label}
        aria-pressed={artifact.pinned}
        onClick={() => props.onPin(!artifact.pinned)}
      >
        <PinIcon aria-hidden fill={artifact.pinned ? "currentColor" : "none"} />
      </button>
    </Tip>
  );
}

/** The card's subtitle: age, then where it came from. */
export function artifactCardMeta(artifact: ProjectArtifact, now: number): string {
  return [artifactAge(artifact.updatedAt, now), artifactKindLabel(artifact)]
    .filter(Boolean)
    .join(" · ");
}

const SHELF_OPEN_STORAGE_KEY = "studio:project-artifacts-shelf-open:v1";

export function ProjectArtifactShelf(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly artifacts: ReadonlyArray<ProjectArtifact>;
  readonly now: number;
  readonly onPin: (id: string, on: boolean) => void;
  readonly onViewAll: () => void;
  readonly onOpenThread?: ((threadId: ThreadId, environmentId: EnvironmentId) => void) | undefined;
}) {
  const { artifacts } = props;
  const shown = artifacts.slice(0, ARTIFACT_SHELF_LIMIT);
  const opener = useArtifactOpener(props.environmentId, props.workspaceRoot);
  const rowRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useLocalStorage<boolean, boolean>(
    SHELF_OPEN_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  if (artifacts.length === 0) return null;
  const scroll = (direction: 1 | -1) =>
    rowRef.current?.scrollBy({ left: direction * 360, behavior: "smooth" });
  return (
    <section className="sws-artifact-shelf" aria-label="Artifacts">
      <header className="sws-artifact-shelf-head">
        <h3>
          <button
            type="button"
            className="sws-artifact-shelf-toggle"
            aria-expanded={open}
            aria-controls="sws-artifact-row"
            onClick={() => setOpen(!open)}
          >
            Artifacts
            <span className="sws-artifact-shelf-count">{artifacts.length}</span>
            <ChevronDownIcon aria-hidden className="sws-artifact-shelf-chevron" />
          </button>
        </h3>
        <span className="sws-library-spacer" />
        {open && shown.length >= 2 ? (
          <>
            <button
              type="button"
              className="sws-icon-button"
              aria-label="Scroll artifacts left"
              onClick={() => scroll(-1)}
            >
              <ChevronLeftIcon aria-hidden />
            </button>
            <button
              type="button"
              className="sws-icon-button"
              aria-label="Scroll artifacts right"
              onClick={() => scroll(1)}
            >
              <ChevronRightIcon aria-hidden />
            </button>
          </>
        ) : null}
      </header>
      <ul ref={rowRef} id="sws-artifact-row" className="sws-artifact-row" hidden={!open}>
        {shown.map((artifact) => (
          <ArtifactCard
            key={artifact.id}
            artifact={artifact}
            environmentId={props.environmentId}
            workspaceRoot={props.workspaceRoot}
            meta={artifactCardMeta(artifact, props.now)}
            onOpen={() => opener.open(artifact, shown)}
            onPin={(on) => props.onPin(artifact.id, on)}
            onOpenThread={props.onOpenThread}
            onShowInLibrary={props.onViewAll}
          />
        ))}
        <li className="sws-artifact-card sws-artifact-more-card">
          <button type="button" className="sws-artifact-view-all-card" onClick={props.onViewAll}>
            <span className="sws-artifact-thumb sws-artifact-view-all-thumb">
              <ArrowRightIcon aria-hidden />
            </span>
            <span className="sws-artifact-title">View all</span>
            <span className="sws-artifact-meta">
              {artifacts.length === 1 ? "1 artifact" : `${artifacts.length} artifacts`}
            </span>
          </button>
        </li>
      </ul>
      {opener.viewer}
    </section>
  );
}

export function ArtifactCard(props: {
  readonly artifact: ProjectArtifact;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly meta: string;
  readonly onOpen: () => void;
  readonly onPin: (on: boolean) => void;
  readonly onOpenThread?: ((threadId: ThreadId, environmentId: EnvironmentId) => void) | undefined;
  readonly onShowInLibrary?: (() => void) | undefined;
}) {
  const { artifact } = props;
  const openable = canOpenArtifact(artifact);
  return (
    <li
      className="sws-artifact-card"
      data-kind={artifact.kind}
      data-pinned={artifact.pinned || undefined}
      data-missing={artifact.missing || undefined}
    >
      <button
        type="button"
        className="sws-artifact-open"
        disabled={!openable}
        onClick={props.onOpen}
        aria-description={artifact.path ?? artifact.url ?? undefined}
      >
        <span className="sws-artifact-thumb">
          <ArtifactThumbnail
            artifact={artifact}
            environmentId={props.environmentId}
            workspaceRoot={props.workspaceRoot}
          />
        </span>
        <span className="sws-artifact-title" title={artifact.title}>
          {artifact.title}
        </span>
        <span className="sws-artifact-meta">
          {artifact.missing ? "Missing" : props.meta}
          {artifact.thread ? (
            <span className="sws-artifact-thread"> · {artifact.thread.title}</span>
          ) : null}
        </span>
      </button>
      <span className="sws-artifact-actions">
        <ArtifactPinButton artifact={artifact} onPin={props.onPin} />
        <ArtifactMenu
          artifact={artifact}
          className="sws-artifact-more"
          onOpen={props.onOpen}
          onPin={props.onPin}
          onOpenThread={props.onOpenThread}
          onShowInLibrary={props.onShowInLibrary}
        />
      </span>
    </li>
  );
}
