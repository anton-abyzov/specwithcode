/**
 * The project's artifacts above its Threads list, as a row of cards: a small
 * picture of the document or a sheet of facts on a tinted card, the title and
 * its age on one line, a pin, a ... menu and View all into the Library's
 * Artifacts view. The pieces here (thumbnail, menu,
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
import {
  createContext,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useAssetUrlRefresh, useAssetUrlState } from "../../../assets/assetUrls";
import { isWebUrl } from "../../../browser/browserLinkTarget";
import { useOpenLink } from "../../../browser/useOpenLink";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { useLocalStorage } from "../../../hooks/useLocalStorage";
import {
  artifactPreviewCache,
  artifactPreviewFormat,
  artifactPreviewKey,
  artifactPreviewSlots,
  artifactTintIndex,
  type ArtifactPreview,
  type ArtifactPreviewFormat,
} from "../../../studio/artifactPreview";
import { documentPreview, imagePreview } from "../../../studio/artifactPreviewRaster";
import {
  artifactAge,
  ARTIFACT_KIND_LABELS,
  ARTIFACT_SHELF_LIMIT,
  type ProjectArtifact,
  type ProjectArtifactKind,
} from "../../../studio/projectArtifacts";
import { useProjectFileReader } from "../../files/projectFilesQueryState";
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
  link: LinkIcon,
};

function extensionOf(artifact: ProjectArtifact): string | null {
  if (artifact.path === null) return null;
  const name = artifact.path.slice(artifact.path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1, dot + 5).toUpperCase() : null;
}

export function ArtifactKindIcon({ artifact }: { artifact: ProjectArtifact }) {
  const Icon = KIND_ICON[artifact.kind];
  return <Icon aria-hidden />;
}

/** Shared by every card: one observer, and a margin so a preview is ready before it shows. */
const NEAR_VIEW_MARGIN = "400px";
const PreviewAnchorContext = createContext<RefObject<HTMLSpanElement | null> | null>(null);
const nearViewCallbacks = new WeakMap<Element, (near: boolean) => void>();
let nearViewObserver: IntersectionObserver | null = null;

function observeNearView(element: Element, onChange: (near: boolean) => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onChange(true);
    return () => undefined;
  }
  nearViewObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) nearViewCallbacks.get(entry.target)?.(entry.isIntersecting);
    },
    // scrollMargin carries the margin through the pane's own scrolling, which
    // rootMargin stops at.
    {
      rootMargin: NEAR_VIEW_MARGIN,
      scrollMargin: NEAR_VIEW_MARGIN,
    } as IntersectionObserverInit,
  );
  nearViewCallbacks.set(element, onChange);
  nearViewObserver.observe(element);
  return () => {
    nearViewObserver?.unobserve(element);
    nearViewCallbacks.delete(element);
  };
}

/** How long scrolling must rest before a card reads, so a fast scroll reads nothing. */
const PREVIEW_REST_MS = 120;
/** A read with no answer by now gives its slot back, so it cannot hold up other cards. */
const PREVIEW_STALL_MS = 10_000;
/** Images download whole, so a slow link gets longer. */
const IMAGE_STALL_MS = 60_000;
const IMAGE_READ_TRIES = 2;
const PREVIEW_RETRY_MS = 15_000;
const PREVIEW_RETRY_MAX_MS = 120_000;

/**
 * A number for each try at building a preview, null while waiting for its turn.
 * `retry` gives the slot back and tries again later, as does a try that stalls.
 */
function usePreviewAttempt(stallMs = PREVIEW_STALL_MS): {
  readonly attempt: number | null;
  readonly retry: () => void;
} {
  const anchor = useContext(PreviewAnchorContext);
  const [state, setState] = useState<{ round: number; granted: boolean }>({
    round: 0,
    granted: false,
  });
  const retry = useCallback(
    () => setState((current) => ({ round: current.round + 1, granted: false })),
    [],
  );
  const { round } = state;
  useEffect(() => {
    let release: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let stall: ReturnType<typeof setTimeout>;
    const delay =
      round === 0
        ? PREVIEW_REST_MS
        : Math.min(PREVIEW_RETRY_MS * 2 ** (round - 1), PREVIEW_RETRY_MAX_MS);
    const wait = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        document.removeEventListener("scroll", onScroll, true);
        release = artifactPreviewSlots.acquire(() => {
          setState({ round, granted: true });
          stall = setTimeout(retry, stallMs);
        });
      }, delay);
    };
    // Only what scrolls this card counts: a streaming chat beside it does not.
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && target.contains(anchor?.current ?? null)) wait();
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    wait();
    return () => {
      clearTimeout(timer);
      clearTimeout(stall);
      document.removeEventListener("scroll", onScroll, true);
      release?.();
    };
  }, [anchor, retry, round, stallMs]);
  return { attempt: state.granted ? round : null, retry };
}

/** Reads one document while it holds a slot; only the finished preview is kept. */
function DocumentPreviewBuilder(props: {
  readonly cacheKey: string;
  readonly format: "markdown" | "html" | "text";
  readonly path: string;
  readonly environmentId: EnvironmentId;
  readonly root: string;
}) {
  const { cacheKey, format, path, environmentId, root } = props;
  const { attempt, retry } = usePreviewAttempt();
  const read = useProjectFileReader();
  useEffect(() => {
    if (attempt === null) return;
    let live = true;
    void read(environmentId, root, path).then(async (result) => {
      if (!live) return;
      if (result._tag === "unavailable") return retry();
      const preview =
        result._tag === "gone"
          ? ({ type: "none" } as const)
          : await documentPreview(result.contents, format);
      if (live) artifactPreviewCache.set(cacheKey, preview);
    });
    return () => {
      live = false;
    };
  }, [attempt, cacheKey, environmentId, format, path, read, retry, root]);
  return null;
}

function ImagePreviewBuilder(props: {
  readonly cacheKey: string;
  readonly path: string;
  readonly environmentId: EnvironmentId;
  readonly root: string;
}) {
  const { cacheKey } = props;
  const { attempt, retry } = usePreviewAttempt(IMAGE_STALL_MS);
  const resource = useImageResource(props.path, props.root);
  // A new URL each try: a cached failure would never let the card recover.
  const createUrl = useAssetUrlRefresh(props.environmentId, resource);
  useEffect(() => {
    if (attempt === null) return;
    const controller = new AbortController();
    void (async () => {
      const url = await createUrl().catch(() => null);
      if (controller.signal.aborted) return;
      if (url === null) return retry();
      const preview = await imagePreview(url, controller.signal);
      if (controller.signal.aborted) return;
      // Reads still failing after two tries: likely another origin, so show the file.
      if (preview === null && attempt < IMAGE_READ_TRIES - 1) return retry();
      artifactPreviewCache.set(cacheKey, preview ?? { type: "original" });
    })();
    return () => controller.abort();
  }, [attempt, cacheKey, createUrl, retry]);
  return null;
}

function useImageResource(path: string | null, root: string): AssetResource | null {
  return useMemo(
    () => (path === null ? null : { _tag: "draft-workspace-file", cwd: root, path }),
    [path, root],
  );
}

/** An image that could not be scaled, from a URL that is live while the card shows it. */
function OriginalImage(props: {
  readonly path: string;
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly fallback: ReactNode;
}) {
  const resource = useImageResource(props.path, props.root);
  const asset = useAssetUrlState(props.environmentId, resource);
  const [broken, setBroken] = useState(false);
  if (asset._tag !== "Success" || broken) return props.fallback;
  return (
    <span className="sws-artifact-sheet" data-page>
      <img
        src={asset.url}
        alt=""
        className="sws-artifact-thumb-image"
        decoding="async"
        onError={() => setBroken(true)}
      />
    </span>
  );
}

/** One key per file version, across the card and the preview it shows. */
function previewKey(artifact: ProjectArtifact, environmentId: EnvironmentId, root: string) {
  return artifactPreviewKey(artifact, `${environmentId}\u0000${root}`);
}

function PreviewPage({ preview }: { preview: ArtifactPreview }) {
  if (preview.type === "image") {
    return <img src={preview.src} alt="" className="sws-artifact-thumb-image" decoding="async" />;
  }
  if (preview.type !== "lines") return null;
  return (
    <span className="sws-artifact-page" data-mono={preview.mono || undefined} aria-hidden>
      {preview.lines.map((line, index) => (
        <span key={index} className="sws-artifact-page-line" data-heading={line.heading}>
          {line.text}
        </span>
      ))}
    </span>
  );
}

/** A card's preview: nothing happens until it nears the view, and leaving drops it from the page. */
function LazyPreview(props: {
  readonly artifact: ProjectArtifact;
  readonly format: ArtifactPreviewFormat;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}) {
  const { artifact, format } = props;
  const ref = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => observeNearView(ref.current!, setNear), []);
  const root = artifact.root ?? props.workspaceRoot;
  const key = previewKey(artifact, props.environmentId, props.workspaceRoot);
  const preview = useSyncExternalStore(
    useCallback((listener) => artifactPreviewCache.subscribe(key, listener), [key]),
    () => artifactPreviewCache.peek(key),
  );
  useEffect(() => {
    if (near) artifactPreviewCache.touch(key);
  }, [key, near]);
  // Scroll away and the page goes; the cache still has it for coming back.
  const shown = near && (preview?.type === "image" || preview?.type === "lines");
  return (
    <span
      ref={ref}
      className="sws-artifact-preview"
      data-ready={shown || undefined}
      style={
        preview?.type === "image" && preview.tint
          ? ({ "--sws-artifact-wash": preview.tint } as CSSProperties)
          : undefined
      }
    >
      {shown ? (
        <span className="sws-artifact-sheet" data-page data-format={format}>
          <PreviewPage preview={preview} />
        </span>
      ) : near && preview?.type === "original" && artifact.path !== null ? (
        <OriginalImage
          path={artifact.path}
          environmentId={props.environmentId}
          root={root}
          fallback={<FactSheet artifact={artifact} />}
        />
      ) : (
        <FactSheet artifact={artifact} />
      )}
      {near && preview === undefined && artifact.path !== null ? (
        <PreviewAnchorContext value={ref}>
          {format === "image" ? (
            <ImagePreviewBuilder
              cacheKey={key}
              path={artifact.path}
              environmentId={props.environmentId}
              root={root}
            />
          ) : (
            <DocumentPreviewBuilder
              cacheKey={key}
              format={format}
              path={artifact.path}
              environmentId={props.environmentId}
              root={root}
            />
          )}
        </PreviewAnchorContext>
      ) : null}
    </span>
  );
}

function hostOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** What a card says when there is no page to show: its kind, its name, where it is from. */
function factSheetContent(artifact: ProjectArtifact): {
  readonly label: string;
  readonly detail: string | null;
  readonly footer: string | null;
} {
  if (artifact.design) {
    const pages = artifact.design.pageCount;
    return {
      label: ARTIFACT_KIND_LABELS[artifact.kind],
      detail: pages > 0 ? (pages === 1 ? "1 page" : `${pages} pages`) : null,
      footer: artifact.design.ownerLabel,
    };
  }
  return {
    label: ARTIFACT_KIND_LABELS[artifact.kind],
    detail: extensionOf(artifact),
    footer: hostOf(artifact.url),
  };
}

function FactSheet({ artifact }: { artifact: ProjectArtifact }) {
  const { label, detail, footer } = factSheetContent(artifact);
  return (
    <span className="sws-artifact-sheet sws-artifact-facts" data-kind={artifact.kind}>
      <span className="sws-artifact-facts-head">
        <ArtifactKindIcon artifact={artifact} />
        <span className="sws-artifact-facts-label">{label}</span>
        {detail ? <span className="sws-artifact-facts-detail">{detail}</span> : null}
      </span>
      <span className="sws-artifact-facts-title">{artifact.title}</span>
      {footer ? <span className="sws-artifact-facts-foot">{footer}</span> : null}
    </span>
  );
}

/** A document or image shows a small page of itself; everything else, its facts. */
export function ArtifactThumbnail(props: {
  readonly artifact: ProjectArtifact;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}) {
  const format = artifactPreviewFormat(props.artifact);
  return format === null ? (
    <FactSheet artifact={props.artifact} />
  ) : (
    <LazyPreview
      artifact={props.artifact}
      format={format}
      environmentId={props.environmentId}
      workspaceRoot={props.workspaceRoot}
    />
  );
}

/**
 * Opens an artifact where it belongs: a design in its editor, a file in the
 * app's viewer, a link in the browser. Returns the viewer to
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
            now={props.now}
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
            <span className="sws-artifact-foot">
              <span className="sws-artifact-title">View all</span>
              <span className="sws-artifact-age">{artifacts.length}</span>
            </span>
          </button>
        </li>
      </ul>
      {opener.viewer}
    </section>
  );
}

/** A file known only by its name reads by the heading inside it, once its page is drawn. */
function useArtifactCardTitle(
  artifact: ProjectArtifact,
  environmentId: EnvironmentId,
  workspaceRoot: string,
): string {
  const key = previewKey(artifact, environmentId, workspaceRoot);
  const heading = useSyncExternalStore(
    useCallback((listener) => artifactPreviewCache.subscribe(key, listener), [key]),
    () => {
      const preview = artifactPreviewCache.peek(key);
      return preview?.type === "image" ? preview.title : undefined;
    },
  );
  return heading && artifact.path?.endsWith(artifact.title) ? heading : artifact.title;
}

export function ArtifactCard(props: {
  readonly artifact: ProjectArtifact;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly now: number;
  readonly onOpen: () => void;
  readonly onPin: (on: boolean) => void;
  readonly onOpenThread?: ((threadId: ThreadId, environmentId: EnvironmentId) => void) | undefined;
  readonly onShowInLibrary?: (() => void) | undefined;
  /** Hundreds of cards: one far from the view keeps its size and name, and nothing else. */
  readonly windowed?: boolean | undefined;
}) {
  const { artifact, windowed = false } = props;
  const openable = canOpenArtifact(artifact);
  const title = useArtifactCardTitle(artifact, props.environmentId, props.workspaceRoot);
  const description = [artifact.path ?? artifact.url, artifact.thread?.title]
    .filter(Boolean)
    .join(" · ");
  const ref = useRef<HTMLLIElement>(null);
  const [inView, setInView] = useState(!windowed);
  // Focus stays where it is: a pinned card moves away, a menu opens from it.
  const [focused, setFocused] = useState(false);
  const near = inView || focused;
  useEffect(() => {
    if (windowed) return observeNearView(ref.current!, setInView);
  }, [windowed]);
  return (
    <li
      ref={ref}
      className="sws-artifact-card"
      data-kind={artifact.kind}
      data-pinned={artifact.pinned || undefined}
      data-missing={artifact.missing || undefined}
      data-far={near ? undefined : true}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <button
        type="button"
        className="sws-artifact-open"
        disabled={!openable}
        onClick={props.onOpen}
        aria-label={near ? undefined : title}
        aria-description={description || undefined}
      >
        <span
          className="sws-artifact-thumb"
          data-kind={artifact.kind}
          data-tint={
            artifact.kind === "document" || artifact.kind === "page"
              ? artifactTintIndex(artifact.id)
              : undefined
          }
        >
          {near ? (
            <ArtifactThumbnail
              artifact={artifact}
              environmentId={props.environmentId}
              workspaceRoot={props.workspaceRoot}
            />
          ) : null}
        </span>
        {near ? (
          <span className="sws-artifact-foot">
            <span className="sws-artifact-title" title={title}>
              {title}
            </span>
            <span className="sws-artifact-age">
              {artifact.missing ? "Missing" : artifactAge(artifact.updatedAt, props.now)}
            </span>
          </span>
        ) : (
          <span className="sws-artifact-far-lines" />
        )}
      </button>
      {near ? (
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
      ) : null}
    </li>
  );
}
