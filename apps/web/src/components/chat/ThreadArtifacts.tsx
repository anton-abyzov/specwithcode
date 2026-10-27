import { executeAtomQuery } from "@specweave-studio/client-runtime/state/runtime";
import { turnItemDetailRevision } from "@specweave-studio/client-runtime/work-log/item-detail";
import type {
  AssetResource,
  EnvironmentId,
  OrchestrationV2TurnItem,
  ScopedThreadRef,
} from "@specweave-studio/contracts";
import { htmlRenderFileName } from "@specweave-studio/shared/htmlRender";
import { visibleThreadPullRequests } from "@specweave-studio/shared/threadPullRequests";
import { htmlRenderFromToolItem } from "@specweave-studio/shared/toolOutput";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileTextIcon,
  FileVideoIcon,
  GlobeIcon,
  HashIcon,
  ImageIcon,
  LinkIcon,
  PanelRightOpenIcon,
  ShapesIcon,
} from "lucide-react";
import { type ReactNode, type Ref, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useAssetUrlState } from "~/assets/assetUrls";
import ChatMarkdown from "~/components/ChatMarkdown";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { stepOutOfViewerOverlay } from "~/lib/openInFront";
import { readLocalApi } from "~/localApi";
import {
  ARTIFACT_KIND_LABEL,
  canonicalLinkKey,
  shelfEntries,
  shelfLocalPath,
  type ShelfEntry,
  type ShelfPullRequest,
} from "~/artifactShelf";
import {
  cachedDetailRead,
  isClaudeArtifactUrl,
  isNativeArtifactCandidate,
  type NativeArtifactDetailRead,
  type NativeArtifactReference,
  resolveNativeArtifacts,
} from "~/nativeArtifacts";
import { appAtomRegistry } from "../../rpc/atomRegistry";
// Relative, so the headless fixture (tests/project-workspace) can stand in for it.
import { useThreadProjection, useThreadShell } from "../../state/entities";
import { useEnvironment, useUnreachableEnvironmentIds } from "../../state/environments";
import { orchestrationEnvironment } from "../../state/orchestration";
import { formatViewerDate, viewerIso } from "~/viewerDate";
import {
  InViewerOverlay,
  useKeepViewerFocus,
  useViewerContentKeys,
  useViewerOverlay,
} from "~/viewerOverlayStore";
import {
  collectThreadArtifacts,
  settleThreadArtifacts,
  isViewableArtifact,
  nativeArtifact,
  type ThreadArtifact,
  type ThreadArtifactKind,
  type ThreadFileArtifact,
  type ThreadRenderArtifact,
  fileArtifact,
} from "~/threadArtifacts";
import { fileLinkMetaAtPath, mayBeDirectory, type MarkdownFileLinkMeta } from "~/markdown-links";
import { AudioPreview } from "../files/AudioPreview";
import { ReadOnlySourcePreview } from "../files/AttachmentFilePreview";
import { BrowserDocumentFrame } from "../files/BrowserDocumentFrame";
import { FilePreviewCard, HostDeckPreview } from "../files/DeckPreview";
import { hostArtifactPath, hostFilePreview, noPreviewReason } from "../files/hostFilePreview";
import { useProjectFileQuery } from "../files/projectFilesQueryState";
import { Button } from "../ui/button";
import { MenuItem } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ArtifactShelfList } from "./ArtifactShelfList";
import { mayBeMissing, MissingFileNotice } from "./MissingFileNotice";
import { MarkdownDocumentView } from "./ReportReader";
import {
  readOriginSnapshot,
  remapShelfPath,
  shelfOrigins,
  type ShelfOrigin,
  type ShelfSnapshotEntry,
  useArtifactShelfState,
} from "./useArtifactShelfState";
import { useArtifactFileChecks } from "./useMissingArtifactFiles";
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
  native: GlobeIcon,
};

/** What an artifact is, in the overlay header's words. */
const KIND_LABEL = ARTIFACT_KIND_LABEL;

function extensionBadge(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1, dot + 5).toUpperCase() : "FILE";
}

function openExternally(url: string) {
  const api = readLocalApi();
  if (api) void api.shell.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

const artifactDetailReaders = new Map<string, NativeArtifactDetailRead<OrchestrationV2TurnItem>>();
/** A host that has not returned a tool call by then is asked again next time. */
const DETAIL_READ_TIMEOUT_MS = 10_000;

/**
 * Reads an Artifact call's full result, which the timeline withholds, once
 * per finished revision for the session.
 */
function artifactDetailReader(
  threadRef: ScopedThreadRef,
): NativeArtifactDetailRead<OrchestrationV2TurnItem> {
  const scope = `${threadRef.environmentId}:${threadRef.threadId}`;
  const existing = artifactDetailReaders.get(scope);
  if (existing) return existing;
  const reader = cachedDetailRead<OrchestrationV2TurnItem>(
    async (item) => {
      const result = await executeAtomQuery(
        appAtomRegistry,
        orchestrationEnvironment.turnItem({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            itemId: item.id,
            revision: turnItemDetailRevision(item),
          },
        }),
        // A reconnecting host never answers; a hung read must not stay cached.
        {
          reportFailure: false,
          reportDefect: false,
          signal: AbortSignal.timeout(DETAIL_READ_TIMEOUT_MS),
        },
      );
      if (result._tag !== "Success") throw new Error("The host did not return the tool call.");
      return result.value.item;
    },
    (item) => `${item.id}:${turnItemDetailRevision(item)}`,
  );
  artifactDetailReaders.set(scope, reader);
  return reader;
}

const NO_NATIVE_ARTIFACTS: ReadonlyArray<NativeArtifactReference> = [];
/** A page the host did not answer for is asked again after this, doubling to the cap. */
const DETAIL_RETRY_MS = 15_000;
const DETAIL_RETRY_CAP_MS = 5 * 60_000;

/**
 * The pages the thread published with Claude Code's Artifact tool, one per
 * page at its latest version. Their results reach the client only on a
 * detail read, so one read per page, and only for publish calls. A page the
 * host did not answer for is asked again later, and at once when its machine
 * comes back; nothing is asked while it is offline.
 */
function useNativeArtifacts(
  threadRef: ScopedThreadRef | null,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem> | undefined,
): ReadonlyArray<NativeArtifactReference> {
  const candidates = useMemo(
    () => (turnItems ?? []).filter(isNativeArtifactCandidate),
    [turnItems],
  );
  const signature = candidates
    .map((item) => `${item.id}:${turnItemDetailRevision(item)}`)
    .join("\n");
  const scope = threadRef === null ? null : `${threadRef.environmentId}:${threadRef.threadId}`;
  const unreachable = useUnreachableEnvironmentIds();
  const offline = threadRef !== null && unreachable.has(threadRef.environmentId);
  const [attempt, setAttempt] = useState(0);
  const [resolved, setResolved] = useState<{
    readonly scope: string;
    readonly refs: ReadonlyArray<NativeArtifactReference>;
  } | null>(null);
  useEffect(() => {
    if (threadRef === null || scope === null || candidates.length === 0 || offline) return;
    let active = true;
    let unanswered = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const read = artifactDetailReader(threadRef);
    void resolveNativeArtifacts(candidates, (item) =>
      read(item).catch((error: unknown) => {
        unanswered = true;
        throw error;
      }),
    ).then((refs) => {
      if (!active) return;
      setResolved({ scope, refs });
      if (unanswered) {
        const delay = Math.min(DETAIL_RETRY_CAP_MS, DETAIL_RETRY_MS * 2 ** Math.min(attempt, 5));
        retry = setTimeout(() => setAttempt((count) => count + 1), delay);
      }
    });
    return () => {
      active = false;
      if (retry !== undefined) clearTimeout(retry);
    };
  }, [scope, signature, offline, attempt]);
  return candidates.length > 0 && resolved?.scope === scope ? resolved.refs : NO_NATIVE_ARTIFACTS;
}

/**
 * Everything a thread produced or pointed at: the files, pages, documents and
 * links its replies name, the pages it published with `html_render`, and the
 * claude.ai pages Claude Code published. Paths are settled on the host, so a
 * file in a sibling worktree lists where it really is.
 */
export function useThreadArtifacts(
  threadRef: ScopedThreadRef | null,
  cwd: string | undefined,
): ReadonlyArray<ThreadArtifact> {
  const thread = useThreadProjection(threadRef);
  const messages = thread?.projection.messages;
  const turnItems = thread?.projection.turnItems;
  const natives = useNativeArtifacts(threadRef, turnItems);
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
    // Before the replies, so a reply's own mention of the page's URL lists as this entry.
    return [...renders.reverse(), ...natives.map(nativeArtifact), ...fromText];
  }, [cwd, messages, natives, turnItems]);
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
  return useMemo(() => settleThreadArtifacts(authored, settled), [authored, settled]);
}

/**
 * The thread header's artifacts chip: a count that opens the organized list,
 * and the viewer that steps through it. A thread continued from another
 * machine lists what its origin listed, found again in this checkout.
 */
export function ThreadArtifactsMenu(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly cwd: string | undefined;
}) {
  const thread = useThreadProjection(props.threadRef);
  const appThread = thread?.projection.thread;
  const environmentId = props.threadRef?.environmentId ?? null;
  const originsKey = JSON.stringify([
    appThread?.execution?.sourceRoot ?? null,
    appThread?.movedFrom ?? null,
  ]);
  const origins = useMemo(
    () => (environmentId === null ? [] : shelfOrigins(appThread, environmentId)),
    [environmentId, originsKey],
  );
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const own = useThreadArtifacts(props.threadRef, props.cwd);
  const origin = origins[0] ?? null;
  const originSnapshot = useMemo(
    () => (origin === null ? false : readOriginSnapshot(origin).length > 0),
    [origin],
  );
  // With a snapshot of the origin's list to count from, its own thread is
  // read only while its entries are on screen.
  const inherited = useInheritedArtifacts(
    origin,
    props.cwd,
    !originSnapshot || listOpen || openKey !== null,
  );
  const artifacts = useMemo(
    () => (inherited.artifacts.length === 0 ? own : [...own, ...inherited.artifacts]),
    [inherited.artifacts, own],
  );
  // Oldest first, so stepping forward moves forward in the thread.
  const viewable = useMemo(() => artifacts.filter(isViewableArtifact).toReversed(), [artifacts]);
  // When the list last opened: what has gone quiet since is aged against it.
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  const shelfState = useArtifactShelfState(props.threadRef, {
    origins,
    workspaceRoot: props.cwd ?? null,
  });
  const { entries, notice } = useShelfEntries(
    props.threadRef,
    artifacts,
    shelfState,
    listOpen,
    openedAt,
    props.cwd,
    inherited,
  );
  const { recordSnapshot } = shelfState;
  useEffect(() => {
    if (listOpen) recordSnapshot(entries);
  }, [listOpen]);
  const stateByKey = useMemo(
    () => new Map(entries.map((entry) => [entry.artifact.key, entry] as const)),
    [entries],
  );
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
            now={openedAt}
            notice={notice}
            iconFor={(entry) => KIND_ICON[entry.artifact.kind]}
            onOpen={(entry) => {
              // Links and claude.ai pages open in the browser; nothing frames them here.
              if (entry.artifact.kind === "native") {
                const url = entry.artifact.native.url;
                // A result that named another site has no link to offer.
                if (url === null) return;
                setListOpen(false);
                openExternally(url);
                return;
              }
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
          fileStateOf={(artifact) => {
            const entry = stateByKey.get(artifact.key);
            return entry?.fileState
              ? { state: entry.fileState, reason: entry.stateReason, offline: notice !== null }
              : null;
          }}
        />
      ) : null}
    </>
  );
}

/** What a continued thread carries from its origin, already moved into this checkout. */
interface InheritedArtifacts {
  readonly artifacts: ReadonlyArray<ThreadArtifact>;
  /** When the origin's messages named them, by message id. */
  readonly dates: ReadonlyMap<string, number>;
  readonly machineLabel: string | null;
}

const NO_INHERITED: InheritedArtifacts = { artifacts: [], dates: new Map(), machineLabel: null };

/** An origin's artifact as this checkout has it; a page kept as an attachment stays behind. */
function carriedArtifact(
  artifact: ThreadArtifact,
  fromRoot: string | null,
  toRoot: string | undefined,
): ThreadArtifact | null {
  const into = toRoot ?? null;
  if (artifact.kind === "native") {
    const localPath = remapShelfPath(artifact.native.localPath, fromRoot, into);
    return localPath === artifact.native.localPath
      ? artifact
      : nativeArtifact({ ...artifact.native, localPath });
  }
  if ("attachmentId" in artifact) return null;
  if (!("meta" in artifact)) return artifact;
  const path = remapShelfPath(artifact.meta.filePath, fromRoot, into);
  if (path === artifact.meta.filePath) return artifact;
  return fileArtifact(fileLinkMetaAtPath(artifact.meta, path, toRoot), artifact.messageId);
}

/** The entries an origin last showed here, for when its thread cannot be read. */
function snapshotArtifacts(
  snapshot: ReadonlyArray<ShelfSnapshotEntry>,
  root: string | null,
): ThreadArtifact[] {
  return snapshot.flatMap((entry): ThreadArtifact[] => {
    const messageId = `snapshot:${entry.id}`;
    if (entry.kind === "link" && entry.url) {
      try {
        const parsed = new URL(entry.url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return [];
        const host = parsed.hostname.replace(/^www\./, "");
        return [
          { key: entry.url, kind: "link", url: entry.url, host, name: entry.name, messageId },
        ];
      } catch {
        return [];
      }
    }
    if (entry.kind === "native") {
      // A link that is not a claude.ai page's is never carried; a page kept without one is.
      const url = entry.url === undefined ? null : isClaudeArtifactUrl(entry.url);
      if (!entry.path || (entry.url !== undefined && url === null)) return [];
      return [
        nativeArtifact({
          key: `claudeAgent:${url ?? `path:${entry.path}`}`,
          provider: "claudeAgent",
          title: entry.name,
          version: null,
          seq: null,
          localPath: entry.path,
          url,
          artifactId: null,
          audience: null,
          itemId: messageId,
          publishedAt: entry.at ?? null,
          source: "snapshot",
        }),
      ];
    }
    if (!entry.path || !entry.path.startsWith("/")) return [];
    return [fileArtifact(fileLinkMetaAtPath({}, entry.path, root ?? undefined), messageId)];
  });
}

/**
 * The entries of the thread this one continued: read from its own thread
 * while `live` and its machine is connected here, else from the snapshot it
 * left when its list was last opened here. Paths move from its checkout into
 * this one, so they are checked on this machine.
 */
function useInheritedArtifacts(
  origin: ShelfOrigin | null,
  cwd: string | undefined,
  live: boolean,
): InheritedArtifacts {
  const originRef = useMemo(
    () =>
      origin === null || !live
        ? null
        : { environmentId: origin.environmentId, threadId: origin.threadId },
    [origin?.environmentId, origin?.threadId, live],
  );
  const source = useThreadProjection(originRef);
  const fromThread = useThreadArtifacts(originRef, origin?.workspaceRoot ?? undefined);
  const originEnvironment = useEnvironment(origin?.environmentId ?? null);
  const messages = source?.projection.messages;
  const turnItems = source?.projection.turnItems;
  const sourceDates = useMemo(() => artifactDates(messages, turnItems), [messages, turnItems]);
  return useMemo(() => {
    if (origin === null) return NO_INHERITED;
    const loaded = originRef !== null && (messages?.length ?? 0) > 0;
    const snapshot = loaded ? [] : readOriginSnapshot(origin);
    const listed = loaded ? fromThread : snapshotArtifacts(snapshot, origin.workspaceRoot);
    return {
      artifacts: listed.flatMap(
        (artifact) => carriedArtifact(artifact, origin.workspaceRoot, cwd) ?? [],
      ),
      dates: loaded
        ? sourceDates
        : new Map(
            snapshot.flatMap((entry) =>
              entry.at === undefined ? [] : [[`snapshot:${entry.id}`, entry.at] as const],
            ),
          ),
      machineLabel: origin.machineLabel ?? originEnvironment?.label ?? null,
    };
  }, [cwd, fromThread, messages, origin, originEnvironment?.label, originRef, sourceDates]);
}

/** When each message and tool call was written. */
function artifactDates(
  messages: ReadonlyArray<{ readonly id: string; readonly createdAt: unknown }> | undefined,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem> | undefined,
): ReadonlyMap<string, number> {
  const byId = new Map<string, number>();
  const add = (id: string, value: unknown) => {
    const iso = viewerIso(value as Parameters<typeof viewerIso>[0]);
    const at = iso === null ? Number.NaN : Date.parse(iso);
    if (!Number.isNaN(at)) byId.set(id, at);
  };
  for (const message of messages ?? []) add(message.id, message.createdAt);
  // Turn items carry when they finished, or their last update.
  for (const item of turnItems ?? []) add(item.id, item.completedAt ?? item.updatedAt);
  return byId;
}

const SOURCE_LABEL_LENGTH = 48;

/** A reply named by its first line, plain text, short enough for a row. */
function replyLabel(text: string): string {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !part.startsWith("```"));
  const plain = (line ?? "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/[*_`~]/g, "")
    .trim();
  if (plain.length === 0) return "Reply";
  return plain.length > SOURCE_LABEL_LENGTH
    ? `${plain.slice(0, SOURCE_LABEL_LENGTH - 1).trimEnd()}…`
    : plain;
}

/** What named each artifact: a reply by its first line, or the kind of tool call. */
function artifactSources(
  messages:
    | ReadonlyArray<{ readonly id: string; readonly role: string; readonly text: string }>
    | undefined,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem> | undefined,
): ReadonlyMap<string, string> {
  const byId = new Map<string, string>();
  for (const message of messages ?? []) {
    if (message.role === "assistant") byId.set(message.id, replyLabel(message.text));
  }
  for (const item of turnItems ?? []) {
    if (item.type === "file_change") byId.set(item.id, "File change");
    else if (item.type === "dynamic_tool" && isNativeArtifactCandidate(item)) {
      byId.set(item.id, "Published to claude.ai");
    } else if (item.type === "dynamic_tool" && htmlRenderFromToolItem(item)) {
      byId.set(item.id, "Published page");
    }
  }
  return byId;
}

/**
 * Where each local file stands on the thread's machine, and what the list
 * says about the machine. An offline machine makes every file unreachable
 * without asking it; otherwise each folder is checked while the list is open.
 */
function useShelfFileChecks(
  threadRef: ScopedThreadRef | null,
  paths: ReadonlyArray<string>,
  enabled: boolean,
) {
  const environmentId = threadRef?.environmentId ?? null;
  const machine = useEnvironment(environmentId)?.label ?? null;
  const unreachable = useUnreachableEnvironmentIds();
  const offline =
    environmentId !== null && unreachable.has(environmentId)
      ? `${machine ?? "The machine"} is offline`
      : null;
  const checks = useArtifactFileChecks({ environmentId, paths, enabled, offline });
  return {
    checks,
    notice:
      offline !== null && paths.length > 0
        ? `${machine ?? "The machine"} is offline. Its files can't be checked until it is back.`
        : null,
  };
}

/**
 * The thread's artifacts as list entries: deduplicated, dated and named by
 * the message that last named them, pull requests with their tracked state,
 * and files checked against the host while the list is open.
 */
function useShelfEntries(
  threadRef: ScopedThreadRef | null,
  artifacts: ReadonlyArray<ThreadArtifact>,
  { pinned, hidden }: Pick<ReturnType<typeof useArtifactShelfState>, "pinned" | "hidden">,
  checkFiles: boolean,
  now: number,
  cwd: string | undefined,
  inherited: InheritedArtifacts = NO_INHERITED,
): { readonly entries: ReadonlyArray<ShelfEntry>; readonly notice: string | null } {
  const thread = useThreadProjection(threadRef);
  const shell = useThreadShell(threadRef);
  const messages = thread?.projection.messages;
  const turnItems = thread?.projection.turnItems;
  const dates = useMemo(() => artifactDates(messages, turnItems), [messages, turnItems]);
  const sources = useMemo(() => artifactSources(messages, turnItems), [messages, turnItems]);
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
    () => artifacts.flatMap((artifact) => shelfLocalPath(artifact) ?? []),
    [artifacts],
  );
  const { checks, notice } = useShelfFileChecks(threadRef, paths, checkFiles);
  const carried = useMemo(() => new Set(inherited.artifacts), [inherited.artifacts]);
  const entries = useMemo(
    () =>
      shelfEntries({
        artifacts,
        mentionedAt: (artifact) =>
          dates.get(artifact.messageId) ?? inherited.dates.get(artifact.messageId) ?? null,
        source: (artifact) => {
          // A result with no claude.ai link does not read as published there.
          if (artifact.kind === "native" && artifact.native.url === null) return null;
          const label = sources.get(artifact.messageId);
          return label ? { label } : null;
        },
        inherited: (artifact) =>
          carried.has(artifact) ? { machineLabel: inherited.machineLabel } : null,
        root: cwd ?? null,
        pullRequests,
        fileChecks: checks,
        pinned,
        hidden,
        now,
      }),
    [artifacts, carried, checks, cwd, dates, hidden, inherited, now, pinned, pullRequests, sources],
  );
  return { entries, notice };
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

/** When the message or tool call that names an artifact was written. */
function useArtifactDate(threadRef: ScopedThreadRef, artifact: ViewableArtifact): string | null {
  const thread = useThreadProjection(threadRef);
  const messages = thread?.projection.messages;
  const turnItems = thread?.projection.turnItems;
  return useMemo(() => {
    const message = messages?.find((entry) => entry.id === artifact.messageId);
    if (message) return viewerIso(message.createdAt);
    const item = turnItems?.find((entry) => entry.id === artifact.messageId);
    return item ? viewerIso(item.completedAt ?? item.updatedAt) : null;
  }, [artifact.messageId, messages, turnItems]);
}

/** What the Files list last knew about a file the viewer opens. */
export interface ViewerFileState {
  readonly state: "present" | "missing" | "unreachable" | "remote-only" | "unknown";
  readonly reason: string | null;
  /** The machine is offline, so the file is not asked for. */
  readonly offline: boolean;
}

function CopyPathButton(props: { readonly path: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ preserveBytes: true });
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      data-copy-path={props.path}
      onClick={() => copyToClipboard(props.path, undefined)}
    >
      {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
      {isCopied ? "Copied" : "Copy path"}
    </Button>
  );
}

/** A file whose machine is offline: said plainly, with where it was, and nothing asked of the host. */
function UnreachableFileNotice(props: {
  readonly name: string;
  readonly path: string;
  readonly reason: string | null;
}) {
  return (
    <div
      className="flex flex-col gap-2 p-4 text-sm"
      role="status"
      data-unreachable-file={props.path}
    >
      <p>
        {props.reason ?? "The machine is offline"}. {props.name} can be opened once it is back.
      </p>
      <p className="break-all font-mono text-muted-foreground text-xs">{props.path}</p>
      <div className="flex gap-1">
        <CopyPathButton path={props.path} />
      </div>
    </div>
  );
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
  /** What the Files list knows about an artifact's file: a missing one opens as an explained notice. */
  readonly fileStateOf?: ((artifact: ViewableArtifact) => ViewerFileState | null) | undefined;
}) {
  const artifact = props.artifacts[props.index]!;
  const fileState = props.fileStateOf?.(artifact) ?? null;
  const count = props.artifacts.length;
  const imageRef = useRef<ZoomableImageHandle>(null);
  // A file on an offline machine or no longer on disk is not asked for.
  const unavailable =
    "meta" in artifact &&
    (fileState?.state === "missing" || (fileState?.state === "unreachable" && fileState.offline));
  const resource = useMemo(
    () => (unavailable ? null : artifactResource(props.threadRef, artifact)),
    [artifact, props.threadRef, unavailable],
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
        // A file gone from disk or on an offline machine has nothing to open or reveal.
        path={unavailable ? null : path}
        name={artifact.name}
        menuItems={
          <>
            {props.onOpenInPanel && "meta" in artifact && !unavailable ? (
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
            fileState={fileState}
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
  readonly fileState?: ViewerFileState | null | undefined;
}): ReactNode {
  const { artifact, url } = props;
  const notice = (text: string) => (
    <p className="m-auto p-6 text-center text-muted-foreground text-sm">{text}</p>
  );
  const path = "meta" in artifact ? artifact.meta.filePath : null;
  if (path !== null && props.fileState?.state === "missing") {
    return (
      <MissingFileNotice
        environmentId={props.environmentId}
        path={path}
        error={null}
        actions={<CopyPathButton path={path} />}
      />
    );
  }
  if (path !== null && props.fileState?.state === "unreachable" && props.fileState.offline) {
    return (
      <UnreachableFileNotice name={artifact.name} path={path} reason={props.fileState.reason} />
    );
  }
  // A deck draws its slides; a document or archive is a card that opens it in its app.
  const host = artifact.kind === "file" && path !== null ? hostFilePreview(path) : "text";
  const hostPath = path === null ? null : hostArtifactPath(path, props.cwd);
  if (host === "deck" && hostPath !== null) {
    return (
      <HostDeckPreview environmentId={props.environmentId} path={hostPath} name={artifact.name} />
    );
  }
  if (host === "card") {
    return (
      <FilePreviewCard
        environmentId={props.environmentId}
        path={hostPath}
        name={artifact.name}
        reason={noPreviewReason(artifact.name)}
      />
    );
  }
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
  if (props.failed && path !== null) {
    // Most often the file left the disk; the notice checks and says which.
    return (
      <MissingFileNotice
        environmentId={props.environmentId}
        path={path}
        error={`${artifact.name} could not be loaded from the host.`}
        actions={<CopyPathButton path={path} />}
      />
    );
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
  if (contents === null && file.error !== null && mayBeMissing(file.readError ?? null)) {
    return (
      <MissingFileNotice
        environmentId={props.environmentId}
        path={meta.filePath}
        error={file.error}
        actions={<CopyPathButton path={meta.filePath} />}
      />
    );
  }
  if (contents === null && file.readError?.failure === "binary_file") {
    return (
      <FilePreviewCard
        environmentId={props.environmentId}
        path={meta.filePath}
        name={props.artifact.name}
        reason={`${props.artifact.name} is not a text file, and has no preview here.`}
      />
    );
  }
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
