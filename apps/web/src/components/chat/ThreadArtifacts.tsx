import type { AssetResource, EnvironmentId, ScopedThreadRef } from "@specweave-studio/contracts";
import { htmlRenderFileName } from "@specweave-studio/shared/htmlRender";
import { visibleThreadPullRequests } from "@specweave-studio/shared/threadPullRequests";
import { htmlRenderFromToolItem } from "@specweave-studio/shared/toolOutput";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileTextIcon,
  FileVideoIcon,
  HashIcon,
  ImageIcon,
  LinkIcon,
  PanelRightOpenIcon,
  ShapesIcon,
} from "lucide-react";
import { type ReactNode, type Ref, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useAssetUrlState } from "~/assets/assetUrls";
import ChatMarkdown from "~/components/ChatMarkdown";
import { stepOutOfViewerOverlay } from "~/lib/openInFront";
import { readLocalApi } from "~/localApi";
import {
  canonicalLinkKey,
  shelfEntries,
  type ShelfEntry,
  type ShelfPullRequest,
} from "~/artifactShelf";
// Relative, so the headless fixture (tests/project-workspace) can stand in for it.
import { useThreadProjection, useThreadShell } from "../../state/entities";
import { formatViewerDate, viewerIso } from "~/viewerDate";
import {
  InViewerOverlay,
  useKeepViewerFocus,
  useViewerContentKeys,
  useViewerOverlay,
} from "~/viewerOverlayStore";
import {
  collectThreadArtifacts,
  isViewableArtifact,
  type ThreadArtifact,
  type ThreadArtifactKind,
  type ThreadFileArtifact,
  type ThreadRenderArtifact,
  fileArtifact,
} from "~/threadArtifacts";
import { mayBeDirectory, type MarkdownFileLinkMeta } from "~/markdown-links";
import { AudioPreview } from "../files/AudioPreview";
import { ReadOnlySourcePreview } from "../files/AttachmentFilePreview";
import { BrowserDocumentFrame } from "../files/BrowserDocumentFrame";
import { useProjectFileQuery } from "../files/projectFilesQueryState";
import { Button } from "../ui/button";
import { MenuItem } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ArtifactShelfList } from "./ArtifactShelfList";
import { MarkdownDocumentView } from "./ReportReader";
import { useArtifactShelfState } from "./useArtifactShelfState";
import { useMissingArtifactFiles } from "./useMissingArtifactFiles";
import { ViewerFileActions } from "./ViewerFileActions";
import { ViewerImageStage } from "./ViewerImageStage";
import type { ZoomableImageHandle } from "./ZoomableImage";
import { useExistingFileLinks } from "./useExistingFileLinks";

type ViewableArtifact = ThreadFileArtifact | ThreadRenderArtifact;

const KIND_ICON: Record<ThreadArtifactKind, typeof FileIcon> = {
  image: ImageIcon,
  video: FileVideoIcon,
  audio: FileAudioIcon,
  html: HashIcon,
  markdown: FileTextIcon,
  pdf: FileTextIcon,
  code: FileCodeIcon,
  file: FileIcon,
  link: LinkIcon,
};

/** What an artifact is, in the overlay header's words. */
const KIND_LABEL: Record<ThreadArtifactKind, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  html: "Page",
  markdown: "Document",
  pdf: "PDF",
  code: "File",
  file: "File",
  link: "Link",
};

function extensionBadge(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1, dot + 5).toUpperCase() : "FILE";
}

function openExternally(url: string) {
  const api = readLocalApi();
  if (api) void api.shell.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Everything a thread produced or pointed at: the files, pages, documents and
 * links its replies name, and the pages it published with `html_render`.
 * Paths are settled on the host, so a file in a sibling worktree lists where
 * it really is.
 */
export function useThreadArtifacts(
  threadRef: ScopedThreadRef | null,
  cwd: string | undefined,
): ReadonlyArray<ThreadArtifact> {
  const thread = useThreadProjection(threadRef);
  const messages = thread?.projection.messages;
  const turnItems = thread?.projection.turnItems;
  const authored = useMemo(() => {
    const replies = (messages ?? [])
      .filter((message) => message.role === "assistant")
      .map((message) => ({ id: message.id, text: message.text }));
    const createdFiles = (turnItems ?? []).flatMap((item) =>
      item.type === "file_change" && item.status === "completed"
        ? (item.changes?.length
            ? item.changes.flatMap((change) =>
                /^(?:delete|remove)/i.test(change.operation) ? [] : [change.path],
              )
            : [item.fileName]
          ).map((path) => ({ path, itemId: item.id }))
        : [],
    );
    const fromText = collectThreadArtifacts(replies, cwd, createdFiles);
    const renders: ThreadRenderArtifact[] = [];
    for (const item of turnItems ?? []) {
      if (item.type !== "dynamic_tool" || item.status !== "completed") continue;
      const render = htmlRenderFromToolItem(item);
      if (!render) continue;
      renders.push({
        key: `render:${render.attachmentId}`,
        kind: "html",
        name: htmlRenderFileName(render.title),
        attachmentId: render.attachmentId,
        messageId: item.id,
      });
    }
    return [...renders.reverse(), ...fromText];
  }, [cwd, messages, turnItems]);
  return useSettledArtifacts(authored, threadRef, cwd);
}

/** The thread's artifacts the viewer opens, oldest first, as stepping through them goes. */
export function useThreadViewables(
  threadRef: ScopedThreadRef | null,
  cwd: string | undefined,
): ReadonlyArray<ViewableArtifact> {
  const artifacts = useThreadArtifacts(threadRef, cwd);
  return useMemo(() => artifacts.filter(isViewableArtifact).toReversed(), [artifacts]);
}

/** The artifacts with their paths settled on the host; files it lacks drop out. */
function useSettledArtifacts(
  authored: ReadonlyArray<ThreadArtifact>,
  threadRef: ScopedThreadRef | null,
  cwd: string | undefined,
): ReadonlyArray<ThreadArtifact> {
  const metaByKey = useMemo(
    () =>
      new Map(
        authored.flatMap((artifact) =>
          artifact.kind !== "link" && "meta" in artifact ? [[artifact.key, artifact.meta]] : [],
        ),
      ),
    [authored],
  );
  const settled = useExistingFileLinks(metaByKey, threadRef?.environmentId ?? null, cwd);
  return useMemo(
    () =>
      authored.flatMap((artifact): ThreadArtifact[] => {
        if (!("meta" in artifact)) return [artifact];
        const meta = settled.get(artifact.key) ?? artifact.meta;
        // A file the host does not have is not something to open.
        if (meta.unresolved) return [];
        return [{ ...artifact, meta }];
      }),
    [authored, settled],
  );
}

/**
 * The thread header's artifacts chip: a count that opens the organized list,
 * and the viewer that steps through it.
 */
export function ThreadArtifactsMenu(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly cwd: string | undefined;
}) {
  const artifacts = useThreadArtifacts(props.threadRef, props.cwd);
  // Oldest first, so stepping forward moves forward in the thread.
  const viewable = useMemo(() => artifacts.filter(isViewableArtifact).toReversed(), [artifacts]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  // When the list last opened: what has gone quiet since is aged against it.
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  const shelfState = useArtifactShelfState(props.threadRef);
  const entries = useShelfEntries(props.threadRef, artifacts, shelfState, listOpen, openedAt);
  if (artifacts.length === 0 || props.threadRef === null) return null;
  const index = viewable.findIndex((artifact) => artifact.key === openKey);
  const visible = entries.filter((entry) => !entry.hidden).length;
  return (
    <>
      <Popover
        open={listOpen}
        onOpenChange={(open) => {
          if (open) setOpenedAt(Date.now());
          setListOpen(open);
        }}
      >
        <PopoverTrigger
          render={
            <Button
              size="xs"
              variant="ghost"
              aria-label={`${visible} artifacts`}
              data-thread-artifacts={visible}
            />
          }
        >
          <ShapesIcon aria-hidden />
          <span className="tabular-nums">{visible}</span>
        </PopoverTrigger>
        <PopoverPopup align="end" padding="compact" className="w-96 max-w-[90vw]">
          <ArtifactShelfList
            entries={entries}
            iconFor={(entry) => KIND_ICON[entry.artifact.kind]}
            onOpen={(entry) => {
              setListOpen(false);
              if (entry.artifact.kind === "link") openExternally(entry.artifact.url);
              else setOpenKey(entry.artifact.key);
            }}
            onPin={(entry, pinned) => shelfState.setPinned(entry.id, pinned)}
            onHide={(entry, hidden) => shelfState.setHidden(entry.id, hidden)}
          />
        </PopoverPopup>
      </Popover>
      {index >= 0 ? (
        <ArtifactViewer
          threadRef={props.threadRef}
          cwd={props.cwd}
          artifacts={viewable}
          index={index}
          onIndex={(next) => setOpenKey(viewable[next]?.key ?? null)}
          onClose={() => setOpenKey(null)}
        />
      ) : null}
    </>
  );
}

/**
 * The thread's artifacts as list entries: deduplicated, dated by the message
 * that last named them, pull requests with their tracked state, and files
 * checked against the host while the list is open.
 */
function useShelfEntries(
  threadRef: ScopedThreadRef | null,
  artifacts: ReadonlyArray<ThreadArtifact>,
  { pinned, hidden }: Pick<ReturnType<typeof useArtifactShelfState>, "pinned" | "hidden">,
  checkFiles: boolean,
  now: number,
): ReadonlyArray<ShelfEntry> {
  const thread = useThreadProjection(threadRef);
  const shell = useThreadShell(threadRef);
  const messages = thread?.projection.messages;
  const turnItems = thread?.projection.turnItems;
  const dates = useMemo(() => {
    const byId = new Map<string, number>();
    for (const message of messages ?? []) {
      const at = Date.parse(viewerIso(message.createdAt) ?? "");
      if (!Number.isNaN(at)) byId.set(message.id, at);
    }
    for (const item of (turnItems ?? []) as ReadonlyArray<unknown>) {
      if (item === null || typeof item !== "object" || !("id" in item)) continue;
      const createdAt = "createdAt" in item ? item.createdAt : null;
      const at = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
      if (typeof item.id === "string" && !Number.isNaN(at)) byId.set(item.id, at);
    }
    return byId;
  }, [messages, turnItems]);
  const pullRequests = useMemo(
    () =>
      new Map(
        visibleThreadPullRequests(shell?.pullRequests ?? []).map(
          (link): [string, ShelfPullRequest] => [
            canonicalLinkKey(link.url),
            { state: link.snapshot?.state ?? "open", title: link.snapshot?.title ?? null },
          ],
        ),
      ),
    [shell?.pullRequests],
  );
  const paths = useMemo(
    () => artifacts.flatMap((artifact) => ("meta" in artifact ? [artifact.meta.filePath] : [])),
    [artifacts],
  );
  const missingPaths = useMissingArtifactFiles(threadRef?.environmentId ?? null, paths, checkFiles);
  return useMemo(
    () =>
      shelfEntries({
        artifacts,
        mentionedAt: (artifact) => dates.get(artifact.messageId) ?? null,
        pullRequests,
        missingPaths,
        pinned,
        hidden,
        now,
      }),
    [artifacts, dates, hidden, missingPaths, now, pinned, pullRequests],
  );
}

function artifactResource(
  threadRef: ScopedThreadRef,
  artifact: ViewableArtifact,
): AssetResource | null {
  if (artifact.kind === "html" && "attachmentId" in artifact) {
    return {
      _tag: "attachment",
      attachmentId: artifact.attachmentId,
      fileName: artifact.name,
      mimeType: "text/html",
      disposition: "inline",
    };
  }
  if (!("meta" in artifact)) return null;
  // Host media streams through the server, with ranges for seeking, so it
  // plays the same in the desktop app, a browser and on a remote host.
  return ["image", "video", "audio", "html", "pdf"].includes(artifact.kind)
    ? { _tag: "media-file", threadId: threadRef.threadId, path: artifact.meta.filePath }
    : null;
}

/** When the message that names an artifact was written. */
function useArtifactDate(threadRef: ScopedThreadRef, artifact: ViewableArtifact): string | null {
  const thread = useThreadProjection(threadRef);
  const messages = thread?.projection.messages;
  const turnItems = thread?.projection.turnItems;
  return useMemo(() => {
    const message = messages?.find((entry) => entry.id === artifact.messageId);
    if (message) return viewerIso(message.createdAt);
    const item: unknown = turnItems?.find((entry) => entry.id === artifact.messageId);
    return item !== null &&
      typeof item === "object" &&
      "createdAt" in item &&
      typeof item.createdAt === "string"
      ? item.createdAt
      : null;
  }, [artifact.messageId, messages, turnItems]);
}

/**
 * One artifact at a time, in the app's viewer overlay beside its thread:
 * video and audio in native players, HTML sandboxed, images, markdown as a
 * document and code read-only, with the thread's other artifacts a step away.
 */
export function ArtifactViewer(props: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
  readonly artifacts: ReadonlyArray<ViewableArtifact>;
  readonly index: number;
  readonly onIndex: (index: number) => void;
  readonly onClose: () => void;
  /** The line a file link pointed at, for the artifact it opened on. */
  readonly reveal?: { readonly key: string; readonly line: number } | undefined;
  /** Hands a file to the side panel, where it can be edited. */
  readonly onOpenInPanel?: ((artifact: ThreadFileArtifact) => void) | undefined;
}) {
  const artifact = props.artifacts[props.index]!;
  const count = props.artifacts.length;
  const imageRef = useRef<ZoomableImageHandle>(null);
  const resource = useMemo(
    () => artifactResource(props.threadRef, artifact),
    [artifact, props.threadRef],
  );
  const asset = useAssetUrlState(props.threadRef.environmentId, resource);
  const url = asset._tag === "Success" ? asset.url : null;
  const path = "meta" in artifact ? artifact.meta.filePath : null;
  const createdAt = useArtifactDate(props.threadRef, artifact);
  const date = formatViewerDate(createdAt);
  const slots = useViewerOverlay({
    open: true,
    title: artifact.name,
    kind: KIND_LABEL[artifact.kind],
    badge: extensionBadge(artifact.name),
    detail: date,
    threadRef: props.threadRef,
    onClose: props.onClose,
  });
  const keepFocus = useKeepViewerFocus(slots?.content ?? null);
  const step = (by: 1 | -1) => {
    keepFocus();
    props.onIndex((props.index + by + count) % count);
  };
  const onKeys = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    // A zoomed image pans with the arrows, as it does when it holds focus.
    if (imageRef.current?.pan(event.key)) {
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowLeft" && count > 1) step(-1);
    if (event.key === "ArrowRight" && count > 1) step(1);
  };
  useViewerContentKeys(slots?.content ?? null, onKeys);
  if (slots === null) return null;
  const actions = (
    <>
      {count > 1 ? (
        <>
          <span
            className="px-1 text-muted-foreground text-xs tabular-nums"
            data-artifact-position="true"
          >
            {props.index + 1} of {count}
          </span>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Previous artifact"
            onClick={() => step(-1)}
          >
            <ChevronLeftIcon aria-hidden />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Next artifact"
            onClick={() => step(1)}
          >
            <ChevronRightIcon aria-hidden />
          </Button>
        </>
      ) : null}
      {url ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Download ${artifact.name}`}
          render={<a href={url} download={artifact.name} />}
        >
          <DownloadIcon aria-hidden />
        </Button>
      ) : null}
      <ViewerFileActions
        environmentId={props.threadRef.environmentId}
        path={path}
        name={artifact.name}
        menuItems={
          <>
            {props.onOpenInPanel && "meta" in artifact ? (
              <MenuItem
                onClick={() => {
                  // Out of the overlay first, or the file opens in it as it closes.
                  stepOutOfViewerOverlay();
                  props.onOpenInPanel?.(artifact);
                  props.onClose();
                }}
              >
                <PanelRightOpenIcon aria-hidden />
                Open in panel
              </MenuItem>
            ) : null}
            {url ? (
              <MenuItem onClick={() => openExternally(url)}>
                <ExternalLinkIcon aria-hidden />
                Open in browser
              </MenuItem>
            ) : null}
          </>
        }
      />
    </>
  );
  return createPortal(
    <div
      className="viewer-overlay-frame"
      data-artifact-viewer={artifact.kind}
      onKeyDown={(event) => {
        // Keys from a lightbox a document opened bubble here through its
        // portal; they are that lightbox's, not this viewer's.
        if (!event.currentTarget.contains(event.target as Node)) return;
        if (event.target instanceof HTMLInputElement) return;
        onKeys(event.nativeEvent);
      }}
    >
      {slots.actions ? createPortal(actions, slots.actions) : null}
      {/* Links in what is open here open in the overlay, never behind it. */}
      <InViewerOverlay value>
        <div className="artifact-viewer-stage" data-artifact-stage="true">
          <ArtifactBody
            key={artifact.key}
            artifact={artifact}
            environmentId={props.threadRef.environmentId}
            threadRef={props.threadRef}
            cwd={props.cwd}
            url={url}
            failed={asset._tag === "Failure"}
            revealLine={props.reveal?.key === artifact.key ? props.reveal.line : undefined}
            imageRef={imageRef}
          />
        </div>
      </InViewerOverlay>
    </div>,
    slots.content,
  );
}

/**
 * The viewer opened on one artifact with every viewable artifact of its
 * thread a step away, oldest first; the ones the click came with stay in
 * reach even when the thread's own list does not name them.
 */
function ThreadSequenceViewer(props: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
  /** What the click came with: a message's cards or its file links. */
  readonly local: ReadonlyArray<ViewableArtifact>;
  readonly initialKey: string;
  readonly onClose: () => void;
  readonly reveal?: { readonly key: string; readonly line: number } | undefined;
  readonly onOpenInPanel?: ((artifact: ThreadFileArtifact) => void) | undefined;
}) {
  const thread = useThreadArtifacts(props.threadRef, props.cwd);
  const sequence = useMemo(() => {
    const inThread = thread.filter(isViewableArtifact).toReversed();
    const keys = new Set(inThread.map((artifact) => artifact.key));
    return [...inThread, ...props.local.filter((artifact) => !keys.has(artifact.key))];
  }, [props.local, thread]);
  const [key, setKey] = useState(props.initialKey);
  const index = sequence.findIndex((artifact) => artifact.key === key);
  if (sequence.length === 0) return null;
  return (
    <ArtifactViewer
      threadRef={props.threadRef}
      cwd={props.cwd}
      artifacts={sequence}
      index={Math.max(0, index)}
      onIndex={(next) => setKey(sequence[next]?.key ?? props.initialKey)}
      onClose={props.onClose}
      reveal={props.reveal}
      onOpenInPanel={props.onOpenInPanel}
    />
  );
}

function ArtifactBody(props: {
  readonly artifact: ViewableArtifact;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
  readonly url: string | null;
  readonly failed: boolean;
  readonly revealLine?: number | undefined;
  readonly imageRef: Ref<ZoomableImageHandle>;
}): ReactNode {
  const { artifact, url } = props;
  const notice = (text: string) => (
    <p className="m-auto p-6 text-center text-muted-foreground text-sm">{text}</p>
  );
  switch (artifact.kind) {
    case "markdown":
    case "code":
    case "file":
      return (
        <ArtifactText
          environmentId={props.environmentId}
          threadRef={props.threadRef}
          cwd={props.cwd}
          revealLine={props.revealLine}
          artifact={artifact as ThreadFileArtifact}
        />
      );
    default:
      break;
  }
  if (props.failed) return notice(`${artifact.name} could not be loaded from the host.`);
  if (url === null) return notice("Loading…");
  switch (artifact.kind) {
    case "image":
      return <ArtifactImage key={url} src={url} name={artifact.name} imageRef={props.imageRef} />;
    case "video":
      return (
        <video
          src={url}
          controls
          playsInline
          preload="metadata"
          className="artifact-viewer-media"
        />
      );
    case "audio":
      return <AudioPreview src={url} name={artifact.name} />;
    case "html":
    case "pdf":
      return (
        <BrowserDocumentFrame
          src={url}
          title={artifact.name}
          pdf={artifact.kind === "pdf"}
          htmlRender={"attachmentId" in artifact}
        />
      );
    default:
      return notice(`${artifact.name} has no preview.`);
  }
}

/** An image artifact, zoomable on the stage, or a notice when its bytes do not load. */
function ArtifactImage(props: {
  readonly src: string;
  readonly name: string;
  readonly imageRef: Ref<ZoomableImageHandle>;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <p className="m-auto p-6 text-center text-muted-foreground text-sm">
        {props.name} could not be loaded from the host.
      </p>
    );
  }
  return (
    <ViewerImageStage
      ref={props.imageRef}
      src={props.src}
      name={props.name}
      onError={() => setFailed(true)}
    />
  );
}

function ArtifactText(props: {
  readonly artifact: ThreadFileArtifact;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
  readonly revealLine?: number | undefined;
}) {
  const { meta } = props.artifact;
  const file = useProjectFileQuery(props.environmentId, props.cwd ?? "", meta.filePath);
  const contents = file.data?.contents ?? null;
  if (contents === null) {
    return (
      <p className="m-auto p-6 text-center text-muted-foreground text-sm">
        {file.error ?? "Loading…"}
      </p>
    );
  }
  if (props.artifact.kind === "markdown") {
    const baseDir = meta.filePath.slice(0, meta.filePath.lastIndexOf("/"));
    return (
      <div className="report-reader-body">
        <article className="report-document report-document-page">
          <MarkdownDocumentView
            text={contents}
            renderMarkdown={(markdown) => (
              <ChatMarkdown
                text={markdown}
                cwd={props.cwd}
                imageBaseDir={baseDir}
                threadRef={props.threadRef}
              />
            )}
          />
        </article>
      </div>
    );
  }
  return (
    <ReadOnlySourcePreview
      name={props.artifact.name}
      text={contents}
      revealLine={props.revealLine}
    />
  );
}

const CARD_KINDS = new Set<ThreadArtifactKind>([
  "image",
  "video",
  "audio",
  "html",
  "pdf",
  "markdown",
]);

/**
 * The images, videos, pages and documents one message names, as cards. A card
 * opens the viewer, which steps through the rest.
 */
export function ArtifactCards(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly cwd: string | undefined;
  readonly text: string;
}) {
  const authored = useMemo(
    () =>
      collectThreadArtifacts([{ id: "message", text: props.text }], props.cwd)
        .filter((artifact) => CARD_KINDS.has(artifact.kind))
        .reverse(),
    [props.cwd, props.text],
  );
  const cards = useSettledArtifacts(authored, props.threadRef, props.cwd).filter(
    isViewableArtifact,
  );
  const [openKey, setOpenKey] = useState<string | null>(null);
  if (cards.length === 0 || props.threadRef === null) return null;
  const threadRef = props.threadRef;
  return (
    <>
      <ul className="artifact-cards" aria-label="Attachments">
        {cards.map((card) => (
          <li key={card.key}>
            <button
              type="button"
              className="artifact-card"
              data-artifact-card={card.kind}
              onClick={() => setOpenKey(card.key)}
            >
              <ArtifactThumbnail threadRef={threadRef} artifact={card} />
              <span className="artifact-card-label">
                <span className="report-reader-badge" aria-hidden>
                  {extensionBadge(card.name)}
                </span>
                <span className="truncate">{card.name}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {openKey !== null ? (
        <ThreadSequenceViewer
          threadRef={threadRef}
          cwd={props.cwd}
          local={cards}
          initialKey={openKey}
          onClose={() => setOpenKey(null)}
        />
      ) : null}
    </>
  );
}

function ArtifactThumbnail(props: {
  readonly threadRef: ScopedThreadRef;
  readonly artifact: ViewableArtifact;
}) {
  const { artifact } = props;
  const media = artifact.kind === "image" || artifact.kind === "video";
  const resource = useMemo(
    () => (media ? artifactResource(props.threadRef, artifact) : null),
    [artifact, media, props.threadRef],
  );
  const asset = useAssetUrlState(props.threadRef.environmentId, resource);
  const url = asset._tag === "Success" ? asset.url : null;
  if (url && artifact.kind === "image") {
    return <img src={url} alt="" className="artifact-card-thumb" loading="lazy" />;
  }
  if (url && artifact.kind === "video") {
    return <video src={`${url}#t=0.1`} muted preload="metadata" className="artifact-card-thumb" />;
  }
  const Icon = KIND_ICON[artifact.kind];
  return (
    <span className="artifact-card-thumb artifact-card-icon">
      <Icon aria-hidden />
    </span>
  );
}

/**
 * A file a message links to, opened in the overlay with the message's other
 * files a step away. The links are already settled on the host.
 */
export function MessageFileViewer(props: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
  /** The link that was clicked. */
  readonly target: MarkdownFileLinkMeta;
  /** Every file link in the message, in the order it names them. */
  readonly links: ReadonlyArray<MarkdownFileLinkMeta>;
  readonly onClose: () => void;
  readonly onOpenInPanel?: ((meta: MarkdownFileLinkMeta) => void) | undefined;
}) {
  const artifacts = useMemo(() => {
    const byKey = new Map<string, ThreadFileArtifact>();
    for (const meta of [...props.links, props.target]) {
      if (mayBeDirectory(meta) || meta.unresolved) continue;
      const artifact = fileArtifact(meta, "message");
      if (artifact.kind === "markdown" || byKey.has(artifact.key)) continue;
      byKey.set(artifact.key, artifact);
    }
    return [...byKey.values()];
  }, [props.links, props.target]);
  const targetKey = fileArtifact(props.target, "message").key;
  if (artifacts.length === 0) return null;
  return (
    <ThreadSequenceViewer
      threadRef={props.threadRef}
      cwd={props.cwd}
      local={artifacts}
      initialKey={targetKey}
      onClose={props.onClose}
      reveal={props.target.line ? { key: targetKey, line: props.target.line } : undefined}
      onOpenInPanel={
        props.onOpenInPanel
          ? (artifact) =>
              props.onOpenInPanel?.(
                artifact.key === targetKey ? props.target : (artifact.meta as MarkdownFileLinkMeta),
              )
          : undefined
      }
    />
  );
}

/**
 * The thread's artifacts as a strip of tiles, newest first, above the thread
 * beside the viewer: one press puts another of them on the left.
 */
export function ThreadArtifactStrip(props: {
  readonly threadRef: ScopedThreadRef;
  /** Oldest first, as `useThreadViewables` gives them. */
  readonly artifacts: ReadonlyArray<ViewableArtifact>;
  /** The one the viewer shows, if it is one of them. */
  readonly currentKey: string | null;
  readonly onOpen: (key: string) => void;
}) {
  if (props.artifacts.length === 0) return null;
  return (
    <section className="viewer-thread-artifacts" aria-label="Artifacts in this thread">
      <h3 className="viewer-thread-artifacts-title">
        Artifacts <span className="tabular-nums">{props.artifacts.length}</span>
      </h3>
      <ul className="viewer-thread-artifacts-list">
        {props.artifacts.toReversed().map((artifact) => (
          <li key={artifact.key}>
            <button
              type="button"
              className="viewer-thread-artifact"
              data-strip-artifact={artifact.kind}
              aria-current={artifact.key === props.currentKey ? "true" : undefined}
              aria-label={`${KIND_LABEL[artifact.kind]}: ${artifact.name}`}
              onClick={() => props.onOpen(artifact.key)}
            >
              <ArtifactThumbnail threadRef={props.threadRef} artifact={artifact} />
              <span className="viewer-thread-artifact-name">
                <span className="report-reader-badge" aria-hidden>
                  {extensionBadge(artifact.name)}
                </span>
                <span className="truncate">{artifact.name}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
