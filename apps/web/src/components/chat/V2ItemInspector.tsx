import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { FileDiffMetadata } from "@pierre/diffs/types";
import {
  fileChangeDiffNote,
  type EnvironmentId,
  type OrchestrationV2FileChangeDiffNote,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  type OrchestrationV2TurnItemDetailField,
  type OrchestrationV2TurnItemPage,
  type OrchestrationV2TurnItemPageInfo,
  type RunId,
  type ThreadId,
} from "@specweave-studio/contracts";
import {
  LIVE_DETAIL_REFRESH_MS,
  readFullTurnItemText,
  stripTransportMarker,
  toolCallLines,
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
  turnItemOutputImages,
  turnItemOutputText,
} from "@specweave-studio/client-runtime/work-log/item-detail";
import { commandHighlightLanguage } from "@specweave-studio/client-runtime/work-log/command-label";
import { providerFailureDisplayMessage } from "@specweave-studio/shared/orchestrationV2ThreadError";
import {
  countPatchLines,
  headedPatch,
  isUnifiedPatch,
  splitPatchByFile,
  structuredEditResultPatch,
} from "@specweave-studio/shared/structuredPatch";
import { sliceTextPage, TRANSPORT_TRUNCATION_MARKER } from "@specweave-studio/shared/toolOutput";
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  RotateCcwIcon,
} from "lucide-react";
import { memo, Suspense, use, useEffect, useMemo, useState } from "react";

import { type TurnDiffLinkOptions } from "../../diffPanelStore";
import { useCopyToClipboard, writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useTheme } from "../../hooks/useTheme";
import {
  rawToolOutputText,
  toolOutputContext,
  type OutputLanguageContext,
} from "../../lib/outputLanguage";
import { cn } from "../../lib/utils";
import {
  buildFileDiffIdentityKey,
  DIFF_SURFACE_THEME_UNSAFE_CSS,
  getRenderablePatch,
  resolveDiffThemeName,
} from "../../lib/diffRendering";
import { getSyntaxHighlighterPromise, PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import { fetchTurnItemDetail, useTurnItemDetail } from "../../state/queries";
import { useV2ItemSupport } from "../../state/v2ItemSupport";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { Button } from "../ui/button";
import ChatMarkdown, { ChatMarkdownAssetImage } from "../ChatMarkdown";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { resolveExternalWebLinkHref } from "./externalLinkContextMenu";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import {
  outputKeptTailNotice,
  ToolCodePanel,
  toolCodePagingLabel,
  toolExecutionInput,
  type ToolCodePaging,
  type ToolPresentationBlock,
} from "./toolOutputPresentation";

interface V2ItemInspectorProps {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly cwd?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenTurnDiff: (runId: RunId, filePath?: string, options?: TurnDiffLinkOptions) => void;
  readonly onRollbackCheckpoint?: (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => void;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  /** Where Open diff goes for a provider-native subagent's rows (runId null on the item). */
  readonly subagentDiffTarget?:
    | {
        readonly parentThreadId: ThreadId;
        readonly runId: RunId | null;
        readonly title: string;
        readonly running: boolean;
      }
    | undefined;
  /** Disables Open diff with this text (AC-05), e.g. "Diff available when the turn ends". */
  readonly diffUnavailableReason?: string | null | undefined;
  /** The provider label for the "From <provider>" caption. */
  readonly providerLabel?: string | undefined;
  /** True for providers that stream tool output (AC-13). */
  readonly streamsToolOutput?: boolean | undefined;
  /** Verbose opens the first 3 file sections of a multi-file edit (D-26). */
  readonly defaultOpenFileSections?: number | undefined;
}

type FileChangeItem = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;

function JsonTokens({ text }: { readonly text: string }) {
  const { resolvedTheme } = useTheme();
  const highlighter = use(getSyntaxHighlighterPromise("json"));
  const { tokens } = useMemo(
    () =>
      highlighter.codeToTokens(text, { lang: "json", theme: resolveDiffThemeName(resolvedTheme) }),
    [highlighter, text, resolvedTheme],
  );
  return tokens.flatMap((line, lineIndex) => [
    lineIndex > 0 ? "\n" : "",
    ...line.map((token) => (
      <span key={token.offset} style={{ color: token.color }}>
        {token.content}
      </span>
    )),
  ]);
}

const monoClassName =
  "font-mono text-(length:--font-size-code,var(--text-2xs)) leading-relaxed whitespace-pre-wrap break-words select-text";

function StructuredValue({
  value,
  highlightJson = false,
}: {
  readonly value: unknown;
  readonly highlightJson?: boolean;
}) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const isJson = useMemo(() => {
    if (!highlightJson || !text) return false;
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }, [highlightJson, text]);
  if (!text) return null;
  return (
    <pre className={cn("max-h-80 overflow-auto text-muted-foreground", monoClassName)}>
      {isJson ? (
        <RenderErrorBoundary fallback={text}>
          <Suspense fallback={text}>
            <JsonTokens text={text} />
          </Suspense>
        </RenderErrorBoundary>
      ) : (
        text
      )}
    </pre>
  );
}

/** A notice's full text with a copy action, so its diagnostics can be shared. */
function NoticeDetail({ message }: { readonly message: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  if (!message) return null;
  return (
    <div className="space-y-1.5">
      <StructuredValue value={message} />
      <Button size="xs" variant="outline" onClick={() => copyToClipboard(message, undefined)}>
        {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        {isCopied ? "Copied" : "Copy details"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paged text: one window of a stored text, with the pages around it on demand.
// ---------------------------------------------------------------------------

/** The field a page read names. */
interface PageTarget {
  readonly field: OrchestrationV2TurnItemDetailField;
  readonly changeIndex?: number | undefined;
}

/** A text the inspector shows one window of. */
interface PagedSource {
  /** The fetched text, without the transport marker. */
  readonly text: string;
  /** Where the text sits in the stored text; null when it is all of it. */
  readonly bounds: {
    readonly offset: number;
    readonly end: number;
    readonly totalLength: number;
  } | null;
  /** An older server cut the text and cannot send the rest; only its marker says so. */
  readonly cutByOlderServer: boolean;
  /** What a page read names; null when the text cannot be paged. */
  readonly target: PageTarget | null;
  /** The revision the text was read at; pages of another revision never join it. */
  readonly revision: string | null;
  /** The text is a structured value's compact JSON. */
  readonly structured: boolean;
}

/** Reads pages of the item behind a row, always fresh from its machine. */
interface PageReader {
  readonly fetchPage: (
    input: PageTarget & { readonly offset?: number; readonly before?: number },
  ) => Promise<OrchestrationV2TurnItemPage | undefined>;
  /** The whole stored text at one revision, joined from pages. */
  readonly readFull: (target: PageTarget) => Promise<string>;
}

function wholeSource(text: string): PagedSource {
  return {
    text,
    bounds: null,
    cutByOlderServer: false,
    target: null,
    revision: null,
    structured: false,
  };
}

function sourceFromPage(page: OrchestrationV2TurnItemPage): PagedSource {
  const whole = page.offset === 0 && page.end === page.totalLength;
  return {
    text: page.text,
    bounds: whole ? null : { offset: page.offset, end: page.end, totalLength: page.totalLength },
    cutByOlderServer: false,
    target: {
      field: page.field,
      ...(page.changeIndex === undefined ? {} : { changeIndex: page.changeIndex }),
    },
    revision: page.revision,
    structured: page.structured === true,
  };
}

/**
 * A text the client already holds whole, such as a command the timeline keeps,
 * shown a page at a time like a stored text; null when it fits one page.
 */
function localPagedText(
  text: string,
  target: PageTarget,
): { readonly source: PagedSource; readonly reader: PageReader } | null {
  const first = sliceTextPage(text);
  if (first.nextOffset === null) return null;
  const revision = "local";
  return {
    source: {
      text: first.text,
      bounds: { offset: first.offset, end: first.end, totalLength: first.totalLength },
      cutByOlderServer: false,
      target,
      revision,
      structured: false,
    },
    reader: {
      fetchPage: async (input) => {
        const page = sliceTextPage(text, { offset: input.offset, before: input.before });
        return {
          field: target.field,
          offset: page.offset,
          end: page.end,
          totalLength: page.totalLength,
          nextOffset: page.nextOffset,
          revision,
          text: page.text,
        };
      },
      readFull: async () => text,
    },
  };
}

/** What a detail read without a field returned beside the item; null for the timeline item. */
interface DetailRead {
  readonly truncated: ReadonlyArray<OrchestrationV2TurnItemPageInfo> | undefined;
}

/**
 * A field's text from a read without a field: its first page when the read
 * lists the field as cut. Without an entry the text is whole, unless it ends
 * in the transport marker, which only an older server leaves unlisted. The
 * timeline's own bounded text shows as it is until the detail read replaces it.
 */
function sourceFromDetail(text: string, target: PageTarget, read: DetailRead | null): PagedSource {
  if (read === null) return wholeSource(text);
  const info = read.truncated?.find(
    (entry) => entry.field === target.field && entry.changeIndex === target.changeIndex,
  );
  if (info) {
    return {
      text: stripTransportMarker(text, info),
      bounds: { offset: info.offset, end: info.end, totalLength: info.totalLength },
      cutByOlderServer: false,
      target,
      revision: info.revision,
      structured: info.structured === true,
    };
  }
  const cut = text.endsWith(TRANSPORT_TRUNCATION_MARKER);
  return {
    text: cut ? stripTransportMarker(text) : text,
    bounds: null,
    cutByOlderServer: cut,
    target: cut ? target : null,
    revision: null,
    structured: false,
  };
}

interface PagedWindow {
  readonly text: string;
  readonly offset: number;
  readonly end: number;
  readonly totalLength: number;
  readonly revision: string | null;
}

function pagedSourceKey(source: PagedSource): string {
  return JSON.stringify([
    source.target?.field ?? null,
    source.target?.changeIndex ?? null,
    source.revision,
    source.bounds?.offset ?? 0,
    source.bounds?.end ?? source.text.length,
    source.bounds?.totalLength ?? source.text.length,
    source.text.length,
  ]);
}

/**
 * The shown window of a paged text. Load earlier and Load more join the next
 * page to it when that page comes from the same revision; a page of a newer
 * revision replaces the window instead. A new source (a refetch) starts over.
 */
function usePagedWindow(source: PagedSource, reader: PageReader | null) {
  const key = pagedSourceKey(source);
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly window: PagedWindow;
  } | null>(null);
  const [request, setRequest] = useState<{
    readonly key: string;
    readonly loading: boolean;
    readonly error: string | null;
  } | null>(null);
  const view: PagedWindow =
    loaded?.key === key
      ? loaded.window
      : {
          text: source.text,
          offset: source.bounds?.offset ?? 0,
          end: source.bounds?.end ?? source.text.length,
          totalLength: source.bounds?.totalLength ?? source.text.length,
          revision: source.revision,
        };
  const loading = request?.key === key && request.loading;
  const error = request?.key === key ? request.error : null;
  const whole = view.offset === 0 && view.end === view.totalLength && !source.cutByOlderServer;
  const target = source.target;
  const pageable = reader !== null && target !== null && !source.cutByOlderServer;
  const load = async (direction: "earlier" | "more") => {
    if (!pageable || loading) return;
    setRequest({ key, loading: true, error: null });
    try {
      const page = await reader.fetchPage(
        direction === "earlier"
          ? { ...target, before: view.offset }
          : { ...target, offset: view.end },
      );
      if (!page) throw new Error("The server returned no page.");
      const sameText = page.revision === view.revision && page.totalLength === view.totalLength;
      const next: PagedWindow =
        sameText && direction === "earlier" && page.end === view.offset
          ? { ...view, text: `${page.text}${view.text}`, offset: page.offset }
          : sameText && direction === "more" && page.offset === view.end
            ? { ...view, text: `${view.text}${page.text}`, end: page.end }
            : {
                text: page.text,
                offset: page.offset,
                end: page.end,
                totalLength: page.totalLength,
                revision: page.revision,
              };
      setLoaded({ key, window: next });
      setRequest({ key, loading: false, error: null });
    } catch (cause) {
      setRequest({
        key,
        loading: false,
        error: cause instanceof Error && cause.message ? cause.message : "The page did not load.",
      });
    }
  };
  // Copy full reads every page at one revision. An older server sends no pages,
  // so its copy is the bounded text, still without the marker.
  const copyFull =
    whole || reader === null || target === null
      ? undefined
      : source.cutByOlderServer
        ? () => reader.readFull(target).catch(() => view.text)
        : () => reader.readFull(target);
  const paging: ToolCodePaging | undefined = pageable
    ? {
        anchor: "start",
        offset: view.offset,
        end: view.end,
        totalLength: view.totalLength,
        onLoadEarlier: () => void load("earlier"),
        onLoadMore: () => void load("more"),
        loading,
        error,
      }
    : undefined;
  return { view, whole, paging, copyFull };
}

const OLDER_SERVER_CUT_NOTICE =
  "Cut for transport. This machine's SpecWithCode cannot send the rest; Copy copies what arrived.";

function PagedCodePanel(props: {
  readonly label: string;
  readonly source: PagedSource;
  readonly reader: PageReader | null;
  readonly anchor: "start" | "end";
  readonly terminal?: boolean | undefined;
  readonly language?: ToolPresentationBlock["language"];
  readonly context?: ToolPresentationBlock["context"];
  /** Formats a text joined from pages once it is whole, as the item read formats it. */
  readonly format?: ((whole: string, structured: boolean) => string) | undefined;
  readonly notice?: string | null | undefined;
}) {
  const { view, whole, paging, copyFull } = usePagedWindow(props.source, props.reader);
  const text =
    whole && props.source.bounds !== null && props.format
      ? props.format(view.text, props.source.structured)
      : view.text;
  // Formatting is for reading; Copy keeps the stored text the pages joined.
  const copyStored =
    copyFull ?? (text === view.text ? undefined : () => Promise.resolve(view.text));
  const notices = [
    props.notice,
    props.source.cutByOlderServer ? OLDER_SERVER_CUT_NOTICE : null,
  ].filter(Boolean);
  return (
    <ToolCodePanel
      label={props.label}
      text={text}
      {...(props.language ? { language: props.language } : {})}
      {...(props.context ? { context: props.context } : {})}
      terminal={props.terminal}
      paging={paging ? { ...paging, anchor: props.anchor } : undefined}
      copyFull={copyStored}
      notice={notices.length > 0 ? notices.join(" ") : null}
      scrollToEnd={props.anchor === "end"}
    />
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Fetching the item behind a row.
// ---------------------------------------------------------------------------

const LIVE_ITEM_STATUSES: ReadonlySet<OrchestrationV2TurnItem["status"]> = new Set([
  "idle",
  "pending",
  "running",
  "waiting",
]);

// Must divide LIVE_DETAIL_REFRESH_MS, so each 2-second key is reached and none is skipped.
const LIVE_DETAIL_TICK_MS = LIVE_DETAIL_REFRESH_MS / 2;

/** The time, updated every second while `active`, so a live detail key moves on. */
function useLiveClock(active: boolean): number | undefined {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), LIVE_DETAIL_TICK_MS);
    return () => window.clearInterval(timer);
  }, [active]);
  return active ? nowMs : undefined;
}

/**
 * The item behind a projected row, with the output the timeline withheld
 * fetched while the row is open. Command output is read from its last page;
 * an open running row of a provider that streams output refetches every 2 s.
 */
function useFetchedTurnItem(
  projectedItem: OrchestrationV2ProjectedTurnItem,
  environmentId: EnvironmentId,
  streamsToolOutput: boolean,
) {
  const wireItem = projectedItem.item;
  const fetches = turnItemNeedsDetailFetch(wireItem);
  const live = LIVE_ITEM_STATUSES.has(wireItem.status);
  const nowMs = useLiveClock(fetches && live && streamsToolOutput);
  // Only reads are keyed; a row that reads nothing needs no revision.
  const revision = fetches
    ? turnItemDetailRevision(wireItem, {
        streamsToolOutput,
        ...(nowMs === undefined ? {} : { nowMs }),
      })
    : "";
  const base = {
    environmentId,
    threadId: projectedItem.sourceThreadId,
    itemId: projectedItem.sourceItemId,
    revision,
  };
  const readsOutputTail = wireItem.type === "command_execution";
  const detail = useTurnItemDetail(
    fetches
      ? {
          ...base,
          ...(readsOutputTail ? { field: "output" as const, anchor: "end" as const } : {}),
        }
      : null,
  );
  const fetchedItem = detail.data?.item;
  const item = fetchedItem?.type === wireItem.type ? fetchedItem : wireItem;
  const read: DetailRead | null = item === wireItem ? null : { truncated: detail.data?.truncated };
  const reader: PageReader | null = fetches
    ? {
        fetchPage: async (input) => (await fetchTurnItemDetail({ ...base, ...input })).page,
        readFull: async (target) =>
          (
            await readFullTurnItemText(
              (input) => fetchTurnItemDetail({ ...base, ...input }),
              target,
            )
          ).text,
      }
    : null;
  const page = detail.data?.page;
  let output: PagedSource | null;
  if (page?.field === "output") {
    output =
      page.offset === 0 && page.nextOffset === null && !page.text.trim()
        ? null
        : sourceFromPage(page);
  } else {
    const text = rawToolOutputText(item) ?? turnItemOutputText(item);
    output = text ? sourceFromDetail(text, { field: "output" }, read) : null;
  }
  const format = (whole: string, structured: boolean): string => {
    if (item.type === "command_execution") {
      return turnItemOutputText({ ...item, output: whole }) ?? whole;
    }
    if (item.type !== "dynamic_tool") return whole;
    const value = structured ? parseJson(whole) : whole;
    if (value === undefined) return whole;
    const loaded = { ...item, output: value, outputOmitted: false };
    return rawToolOutputText(loaded) ?? turnItemOutputText(loaded) ?? whole;
  };
  const keptTail =
    item.type === "command_execution" || item.type === "dynamic_tool"
      ? item.outputKeptTailChars
      : undefined;
  return {
    item,
    read,
    reader,
    output: {
      output,
      context: toolOutputContext(item),
      anchor: item.type === "command_execution" ? ("end" as const) : ("start" as const),
      reader,
      format,
      notice: keptTail === undefined ? null : outputKeptTailNotice(keptTail),
      waiting:
        item.type === "command_execution" && live && !streamsToolOutput && output === null
          ? "Output appears when the command ends"
          : null,
      images: turnItemOutputImages(item),
      environmentId,
      pending: item === wireItem && detail.isPending,
      error:
        item !== wireItem
          ? null
          : detail.data?.item === null
            ? "Output is no longer available."
            : detail.error,
      empty: fetches && item !== wireItem,
    },
  };
}

interface ToolOutputState {
  readonly context?: OutputLanguageContext;
  readonly output: PagedSource | null;
  readonly anchor: "start" | "end";
  readonly reader: PageReader | null;
  readonly format: (whole: string, structured: boolean) => string;
  /** SpecWithCode's own ingestion kept only the output's tail. */
  readonly notice: string | null;
  /** Why a running command shows no output yet. */
  readonly waiting: string | null;
  readonly images: ReturnType<typeof turnItemOutputImages>;
  readonly environmentId: EnvironmentId;
  readonly pending: boolean;
  readonly error: string | null;
  readonly empty: boolean;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}

function ToolOutput(props: ToolOutputState) {
  const images = props.images.map((resource) => (
    <ChatMarkdownAssetImage
      key={resource.index}
      environmentId={props.environmentId}
      resource={resource}
      alt="Tool output image"
      maxHeightRem={16}
      onImageExpand={props.onImageExpand}
    />
  ));
  const text = props.output ? (
    <PagedCodePanel
      label="Output"
      source={props.output}
      reader={props.reader}
      anchor={props.anchor}
      format={props.format}
      notice={props.notice}
      context={props.context}
      terminal
    />
  ) : props.pending ? (
    <div className="text-muted-foreground italic">Loading output…</div>
  ) : props.error ? (
    <div className="text-destructive-foreground">Couldn&apos;t load output: {props.error}</div>
  ) : props.waiting ? (
    <div className="text-muted-foreground italic">{props.waiting}</div>
  ) : props.empty && images.length === 0 ? (
    <div className="text-muted-foreground italic">No output.</div>
  ) : null;
  return (
    <>
      {images}
      {text}
    </>
  );
}

/** Fetched output for rows that show their own plain text instead of the inspector. */
export function FetchedToolOutput(props: {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  readonly streamsToolOutput?: boolean | undefined;
}) {
  const { output } = useFetchedTurnItem(
    props.projectedItem,
    props.environmentId,
    props.streamsToolOutput === true,
  );
  return (
    <div className={cn("mt-1.5 space-y-1.5", monoClassName)}>
      <ToolOutput {...output} onImageExpand={props.onImageExpand} />
    </div>
  );
}

/** A tool call's body: the call itself in the foreground, its result muted below. */
function ToolCallBody(
  props: ToolOutputState & {
    readonly command?: string;
    readonly args?: unknown;
    readonly toolName?: string | null | undefined;
    readonly exitCode?: number | undefined;
    readonly read?: DetailRead | null | undefined;
  },
) {
  const execution = props.command
    ? null
    : toolExecutionInput({
        label: props.toolName ?? "Tool",
        id: "tool-call",
        createdAt: "",
        tone: "tool",
        ...(props.toolName ? { toolTitle: props.toolName } : {}),
        toolData: { input: props.args },
      });
  const argumentsRecord =
    props.args !== null && typeof props.args === "object" && !Array.isArray(props.args)
      ? (props.args as Record<string, unknown>)
      : null;
  const remainingArgs =
    execution && argumentsRecord
      ? Object.fromEntries(
          Object.entries(argumentsRecord).filter(
            ([key, value]) =>
              !(["cmd", "command", "code"].includes(key) && value === execution.text),
          ),
        )
      : props.args;
  const call = toolCallLines({ command: props.command, args: remainingArgs });
  const inputText =
    call.args || call.argsText ? (call.argsText ?? JSON.stringify(remainingArgs, null, 2)) : null;
  // A detail read cuts a large input to its first page; it pages like output.
  const input =
    inputText === null || props.command
      ? null
      : sourceFromDetail(inputText, { field: "input" }, props.read ?? null);
  const pagedCommand = props.command ? localPagedText(props.command, { field: "input" }) : null;
  return (
    <div className={cn("space-y-1.5", monoClassName)}>
      {call.command && pagedCommand ? (
        <PagedCodePanel
          label="Command"
          source={pagedCommand.source}
          reader={pagedCommand.reader}
          anchor="start"
          language={commandHighlightLanguage(props.command!)}
        />
      ) : call.command ? (
        <ToolCodePanel
          label="Command"
          text={props.command!}
          language={commandHighlightLanguage(props.command!)}
        />
      ) : null}
      {execution ? <ToolCodePanel {...execution} /> : null}
      {input && (input.bounds !== null || input.cutByOlderServer) ? (
        <PagedCodePanel
          label="Input"
          source={input}
          reader={props.reader}
          anchor="start"
          language="json"
          format={(whole, structured) => {
            const value = structured ? parseJson(whole) : undefined;
            return value === undefined ? whole : JSON.stringify(value, null, 2);
          }}
        />
      ) : inputText !== null ? (
        <ToolCodePanel label="Input" text={inputText} language="json" />
      ) : null}
      <ToolOutput {...props} />
      {props.exitCode !== undefined && props.exitCode !== 0 ? (
        <div className="text-destructive-foreground">exit {props.exitCode}</div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit patches, rendered inline by the existing Pierre renderer.
// ---------------------------------------------------------------------------

const DIFF_NOTE_LABELS: Record<OrchestrationV2FileChangeDiffNote, string> = {
  input_snippet: "Edit snippet",
  git_patch: "Git diff of the file; may include changes this edit did not make",
  line_numbers_synthesized: "Line numbers not reported by the provider",
  too_large_to_compute: "Provider diff too large to compute",
  overwrite_without_diff: "No diff from the provider for this overwrite",
};

/** Above either limit an inline patch is replaced by a placeholder (D-26). */
const INLINE_PATCH_MAX_LINES = 5_000;
const INLINE_PATCH_MAX_BYTES = 1024 * 1024;

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function lineCount(text: string): number {
  let lines = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    lines += 1;
  }
  return lines;
}

/**
 * A paged patch's loaded text only bounds its size from below, so its +/- counts
 * (computed on the server from the whole patch) gate it too: a patch has at least
 * as many lines as it adds and deletes.
 */
function tooLargeInline(text: string, totalLength: number, changedLines = 0): boolean {
  return (
    totalLength > INLINE_PATCH_MAX_BYTES ||
    changedLines > INLINE_PATCH_MAX_LINES ||
    lineCount(text) > INLINE_PATCH_MAX_LINES ||
    utf8Length(text) > INLINE_PATCH_MAX_BYTES
  );
}

type PatchOperation = "add" | "delete" | "update" | "move";

function patchOperation(operation: string | undefined): PatchOperation | undefined {
  return operation === "add" ||
    operation === "delete" ||
    operation === "update" ||
    operation === "move"
    ? operation
    : undefined;
}

/** One file of an edit: its path, counts and where its patch comes from. */
interface EditSection {
  readonly key: string;
  readonly path: string;
  readonly oldPath?: string | undefined;
  readonly operation?: string | undefined;
  readonly detail?: string | undefined;
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
  readonly note?: OrchestrationV2FileChangeDiffNote | undefined;
  readonly body:
    | { readonly kind: "patch"; readonly source: PagedSource }
    | { readonly kind: "strings"; readonly oldStr: string; readonly newStr: string }
    | { readonly kind: "none" };
}

/**
 * The files an edit item shows, each with its own patch: every change's patch
 * when the provider sent per-change patches, else the item patch split at its
 * files, else the old and new text, else just the paths. A failed edit's
 * `diffStr` is the provider's error text, so it never becomes a patch.
 */
function editSections(item: FileChangeItem, read: DetailRead | null): ReadonlyArray<EditSection> {
  const changes = item.changes ?? [];
  const itemNote = fileChangeDiffNote(item.diffNote);
  const changeSection = (
    change: (typeof changes)[number],
    index: number,
    body: EditSection["body"],
  ): EditSection => ({
    key: `change:${index}`,
    path: change.path,
    oldPath: change.oldPath,
    operation: change.operation,
    detail: [change.fileType, change.mimeType].filter(Boolean).join(", ") || undefined,
    additions: change.additions,
    deletions: change.deletions,
    note: fileChangeDiffNote(change.diffNote) ?? (changes.length === 1 ? itemNote : undefined),
    body,
  });
  if (changes.some((change) => change.diffStr)) {
    return changes.map((change, index) =>
      changeSection(
        change,
        index,
        change.diffStr
          ? {
              kind: "patch",
              source: sourceFromDetail(change.diffStr, { field: "body", changeIndex: index }, read),
            }
          : { kind: "none" },
      ),
    );
  }
  const own = item.status === "failed" ? undefined : item.diffStr;
  if (own) {
    const source = sourceFromDetail(own, { field: "body" }, read);
    const blocks = source.bounds === null && !source.cutByOlderServer ? splitPatchByFile(own) : [];
    if (blocks.length > 1) {
      return blocks.map((block, index) => {
        const counts = countPatchLines(block.text);
        return {
          key: `block:${index}`,
          path: block.newPath ?? block.oldPath ?? item.fileName,
          oldPath:
            block.oldPath !== null && block.newPath !== null && block.oldPath !== block.newPath
              ? block.oldPath
              : undefined,
          operation:
            block.oldPath === null
              ? "add"
              : block.newPath === null
                ? "delete"
                : block.oldPath !== block.newPath
                  ? "move"
                  : "update",
          additions: counts?.additions,
          deletions: counts?.deletions,
          note: itemNote,
          body: { kind: "patch", source: wholeSource(block.text) },
        };
      });
    }
    return [
      {
        key: "item",
        path: item.fileName,
        additions: item.additions,
        deletions: item.deletions,
        note: itemNote,
        body: { kind: "patch", source },
      },
    ];
  }
  if (item.status !== "failed" && (item.oldStr !== undefined || item.newStr !== undefined)) {
    return [
      {
        key: "item",
        path: item.fileName,
        additions: item.additions,
        deletions: item.deletions,
        note: itemNote,
        body: { kind: "strings", oldStr: item.oldStr ?? "", newStr: item.newStr ?? "" },
      },
    ];
  }
  if (changes.length > 0) {
    return changes.map((change, index) => changeSection(change, index, { kind: "none" }));
  }
  return [{ key: "item", path: item.fileName, note: itemNote, body: { kind: "none" } }];
}

/** What a patch window renders as: parsed files, or its stored text with the reason. */
type InlinePatchView =
  | {
      readonly kind: "files";
      readonly files: ReadonlyArray<FileDiffMetadata>;
      readonly synthesized: boolean;
    }
  | { readonly kind: "raw"; readonly reason: string }
  | { readonly kind: "overwrite" };

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u;

/**
 * A page of a longer patch, cut at its last whole line, with the last hunk's
 * ranges recounted to the lines this page has, so the viewer draws the hunk
 * as far as it goes instead of rejecting it. A file whose headers arrived
 * without any hunk waits for the next page.
 */
function partialPatchPrefix(text: string): string {
  let patch = text.slice(0, text.lastIndexOf("\n") + 1);
  const lastFile = patch.lastIndexOf("\ndiff --git ");
  if (lastFile > patch.lastIndexOf("\n@@")) patch = patch.slice(0, lastFile + 1);
  const lastHunk = patch.lastIndexOf("\n@@");
  const hunkStart = lastHunk === -1 ? (patch.startsWith("@@") ? 0 : -1) : lastHunk + 1;
  if (hunkStart === -1) return patch;
  const headerEnd = patch.indexOf("\n", hunkStart);
  const header = HUNK_HEADER.exec(patch.slice(hunkStart, headerEnd));
  if (headerEnd === -1 || !header) return patch;
  let oldLines = 0;
  let newLines = 0;
  for (const line of patch.slice(headerEnd + 1).split("\n")) {
    if (line.startsWith("-")) oldLines += 1;
    else if (line.startsWith("+")) newLines += 1;
    else if (line.startsWith(" ")) {
      oldLines += 1;
      newLines += 1;
    }
  }
  return `${patch.slice(0, hunkStart)}@@ -${header[1]},${oldLines} +${header[2]},${newLines} @@${header[3]}${patch.slice(headerEnd)}`;
}

function inlinePatchView(
  text: string,
  whole: boolean,
  section: Pick<EditSection, "key" | "path" | "oldPath" | "operation">,
): InlinePatchView {
  let patch = whole ? text : partialPatchPrefix(text);
  // Older Claude items stored the edit tool's structured result as JSON.
  if (whole && text.trimStart().startsWith("{")) {
    const structured = structuredEditResultPatch(text, section.path);
    if (structured?.diffNote === "overwrite_without_diff" && structured.patch === undefined) {
      return { kind: "overwrite" };
    }
    if (structured?.patch) patch = structured.patch;
  }
  const scope = `inline-edit:${section.key}`;
  const renderable = getRenderablePatch(patch, scope);
  if (renderable?.kind === "files") {
    return { kind: "files", files: renderable.files, synthesized: false };
  }
  // A bare hunk without file headers gets them, with ranges counted from its lines.
  if (whole && isUnifiedPatch(patch)) {
    const headed = headedPatch({
      operation: patchOperation(section.operation) ?? "update",
      path: section.path,
      ...(section.oldPath ? { oldPath: section.oldPath } : {}),
      body: patch,
    });
    const retried = getRenderablePatch(headed.patch, scope);
    if (retried?.kind === "files") {
      return { kind: "files", files: retried.files, synthesized: headed.synthesizedLineNumbers };
    }
  }
  return {
    kind: "raw",
    reason: isUnifiedPatch(text)
      ? renderable?.kind === "raw"
        ? renderable.reason
        : "Showing the stored patch text."
      : "Not a patch the viewer can read. Showing the stored text.",
  };
}

/** How Open diff behaves for this row, from the row's run, a subagent target or a reason. */
type DiffAction =
  | { readonly kind: "open"; readonly open: (filePath: string) => void }
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "parent"; readonly open: () => void };

function DiffButton({
  action,
  filePath,
}: {
  readonly action: DiffAction | null;
  readonly filePath: string;
}) {
  if (action === null) return null;
  if (action.kind === "disabled") {
    return (
      <Button size="xs" variant="outline" disabled title={action.reason}>
        {action.reason}
      </Button>
    );
  }
  if (action.kind === "parent") {
    return (
      <Button size="xs" variant="outline" onClick={action.open}>
        Open parent thread
      </Button>
    );
  }
  return (
    <Button size="xs" variant="outline" onClick={() => action.open(filePath)}>
      Open diff
    </Button>
  );
}

function CopyFullButton({
  read,
  label,
}: {
  readonly read: () => string | Promise<string>;
  readonly label: string;
}) {
  const [state, setState] = useState<"idle" | "pending" | "copied" | "failed">("idle");
  const copy = async () => {
    if (state === "pending") return;
    setState("pending");
    try {
      await writeTextToClipboard(await read(), label, undefined, { preserveBytes: true });
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={state === "pending"}
      aria-label={`Copy full ${label}`}
      onClick={() => void copy()}
    >
      {state === "copied" ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      {state === "copied"
        ? "Copied"
        : state === "pending"
          ? "Copying…"
          : state === "failed"
            ? "Couldn't copy"
            : "Copy full"}
    </Button>
  );
}

/** Shared by every section of one edit row. */
interface EditContext {
  readonly reader: PageReader | null;
  readonly diffAction: DiffAction | null;
  readonly caption: string;
}

/**
 * The renderer colors "N unmodified lines" for a light page whatever the theme, so on the
 * dark code surface its text would be near black on near black. Take it from the surface.
 */
const INLINE_PATCH_UNSAFE_CSS = `${DIFF_SURFACE_THEME_UNSAFE_CSS}
[data-separator-content] {
  color: color-mix(in srgb, var(--code-foreground) 70%, var(--code-background)) !important;
}
`;

function InlineFiles({ files }: { readonly files: ReadonlyArray<FileDiffMetadata> }) {
  const { resolvedTheme } = useTheme();
  return (
    <DiffWorkerPoolProvider>
      {/* diff-render-surface gives the renderer the code surface's colors, as in DiffPanel;
          without it the hunk separators were a white bar in the dark theme. */}
      <div
        className="diff-render-surface max-h-60 min-w-0 overflow-auto rounded-md border border-border/60 [--code-background:var(--background)]"
        data-inline-patch
      >
        {files.map((fileDiff) => (
          <FileDiff
            key={buildFileDiffIdentityKey(fileDiff)}
            fileDiff={fileDiff}
            options={{
              collapsed: false,
              diffStyle: "unified",
              theme: resolveDiffThemeName(resolvedTheme),
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
              unsafeCSS: INLINE_PATCH_UNSAFE_CSS,
            }}
          />
        ))}
      </div>
    </DiffWorkerPoolProvider>
  );
}

function PatchCaption({
  caption,
  labels,
  copy,
}: {
  readonly caption: string;
  readonly labels: ReadonlyArray<string>;
  readonly copy?: (() => string | Promise<string>) | undefined;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-sans text-xs text-muted-foreground">
      <span>{caption}</span>
      {labels.map((label) => (
        <span key={label} className="rounded-full border border-border/60 px-1.5 py-0.5 text-3xs">
          {label}
        </span>
      ))}
      {copy ? (
        <span className="ml-auto">
          <CopyFullButton read={copy} label="patch" />
        </span>
      ) : null}
    </div>
  );
}

function TooLargePlaceholder({
  action,
  path,
}: {
  readonly action: DiffAction | null;
  readonly path: string;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border/70 px-3 py-2 font-sans text-xs text-muted-foreground"
      data-inline-patch-placeholder
    >
      <span>Too large to show here</span>
      <DiffButton action={action} filePath={path} />
    </div>
  );
}

function PatchBody({
  section,
  source,
  context,
}: {
  readonly section: EditSection;
  readonly source: PagedSource;
  readonly context: EditContext;
}) {
  const { view, whole, paging, copyFull } = usePagedWindow(source, context.reader);
  const large = tooLargeInline(
    view.text,
    view.totalLength,
    (section.additions ?? 0) + (section.deletions ?? 0),
  );
  const { key, path, oldPath, operation } = section;
  const patchView = useMemo(
    () => (large ? null : inlinePatchView(view.text, whole, { key, path, oldPath, operation })),
    [large, view.text, whole, key, path, oldPath, operation],
  );
  const labels = [
    section.note ? DIFF_NOTE_LABELS[section.note] : null,
    patchView?.kind === "files" && patchView.synthesized
      ? DIFF_NOTE_LABELS.line_numbers_synthesized
      : null,
  ].filter((label): label is string => label !== null);
  const copy = copyFull ?? (() => view.text);
  return (
    <div className="space-y-1.5">
      <PatchCaption caption={context.caption} labels={[...new Set(labels)]} copy={copy} />
      {patchView === null ? (
        <TooLargePlaceholder action={context.diffAction} path={section.path} />
      ) : patchView.kind === "overwrite" ? (
        <p className="font-sans text-xs text-muted-foreground">
          {DIFF_NOTE_LABELS.overwrite_without_diff}
        </p>
      ) : patchView.kind === "files" ? (
        <InlineFiles files={patchView.files} />
      ) : (
        <div className="space-y-1">
          <p className="font-sans text-xs text-muted-foreground">{patchView.reason}</p>
          <ToolCodePanel label="Patch" text={view.text} />
        </div>
      )}
      {/* The placeholder shows no page, so it offers no paging; Copy full has it all. */}
      {paging && !whole && patchView !== null ? (
        <div className="flex flex-wrap items-center gap-2 font-sans text-xs text-muted-foreground">
          <span>{toolCodePagingLabel(paging)}</span>
          {view.end < view.totalLength ? (
            <Button
              size="xs"
              variant="outline"
              disabled={paging.loading === true}
              onClick={paging.onLoadMore}
            >
              Load more
            </Button>
          ) : null}
          {paging.error ? (
            <span className="text-destructive-foreground">Couldn&apos;t load: {paging.error}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StringsBody({
  section,
  oldStr,
  newStr,
  context,
}: {
  readonly section: EditSection;
  readonly oldStr: string;
  readonly newStr: string;
  readonly context: EditContext;
}) {
  // A cut body cannot be paged (no field names it), so a diff of it would be wrong.
  const cut =
    oldStr.endsWith(TRANSPORT_TRUNCATION_MARKER) || newStr.endsWith(TRANSPORT_TRUNCATION_MARKER);
  const large = cut || tooLargeInline(`${oldStr}\n${newStr}`, oldStr.length + newStr.length);
  const fileDiff = useMemo(() => {
    if (large) return null;
    try {
      return parseDiffFromFile(
        { name: section.path, contents: oldStr },
        { name: section.path, contents: newStr },
      );
    } catch {
      return null;
    }
  }, [large, section.path, oldStr, newStr]);
  const labels = section.note ? [DIFF_NOTE_LABELS[section.note]] : [];
  return (
    <div className="space-y-1.5">
      <PatchCaption caption={context.caption} labels={labels} />
      {large ? (
        <TooLargePlaceholder action={context.diffAction} path={section.path} />
      ) : fileDiff ? (
        <InlineFiles files={[fileDiff]} />
      ) : (
        <p className="font-sans text-xs text-muted-foreground">
          The provider&apos;s old and new text could not be compared.
        </p>
      )}
    </div>
  );
}

function SectionBody({
  section,
  context,
}: {
  readonly section: EditSection;
  readonly context: EditContext;
}) {
  if (section.body.kind === "patch") {
    return <PatchBody section={section} source={section.body.source} context={context} />;
  }
  if (section.body.kind === "strings") {
    return (
      <StringsBody
        section={section}
        oldStr={section.body.oldStr}
        newStr={section.body.newStr}
        context={context}
      />
    );
  }
  return (
    <p className="font-sans text-xs text-muted-foreground">
      {section.note ? DIFF_NOTE_LABELS[section.note] : "No inline patch for this edit."}
    </p>
  );
}

function Counts({
  additions,
  deletions,
}: {
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
}) {
  if (additions === undefined && deletions === undefined) return null;
  return (
    <span>
      <span className="text-success-foreground">+{additions ?? 0}</span>{" "}
      <span className="text-destructive-foreground">-{deletions ?? 0}</span>
    </span>
  );
}

function FileSection({
  section,
  context,
  workspaceRoot,
  defaultOpen,
}: {
  readonly section: EditSection;
  readonly context: EditContext;
  readonly workspaceRoot: string | undefined;
  readonly defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const path = formatWorkspaceRelativePath(section.path, workspaceRoot);
  return (
    <li className="min-w-0 space-y-1.5" data-edit-file-section={section.path}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          type="button"
          className="inline-flex min-h-7 min-w-0 items-center gap-1 rounded text-left font-mono text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={open}
          onClick={(event) => {
            event.stopPropagation();
            setOpen(!open);
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <ChevronRightIcon
            className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
            aria-hidden
          />
          <span className="min-w-0 break-all">
            {section.operation ? `${section.operation} ` : ""}
            {section.oldPath
              ? `${formatWorkspaceRelativePath(section.oldPath, workspaceRoot)} → `
              : ""}
            {path}
            {section.detail ? ` (${section.detail})` : ""}
          </span>
        </button>
        <Counts additions={section.additions} deletions={section.deletions} />
        <DiffButton action={context.diffAction} filePath={section.path} />
      </div>
      {open ? <SectionBody section={section} context={context} /> : null}
    </li>
  );
}

function EditBody({
  item,
  read,
  context,
  workspaceRoot,
  defaultOpenFileSections,
}: {
  readonly item: FileChangeItem;
  readonly read: DetailRead | null;
  readonly context: EditContext;
  readonly workspaceRoot: string | undefined;
  readonly defaultOpenFileSections: number;
}) {
  const sections = editSections(item, read);
  const [showAll, setShowAll] = useState(false);
  if (sections.length === 1) return <SectionBody section={sections[0]!} context={context} />;
  const shown =
    defaultOpenFileSections > 0 && !showAll ? sections.slice(0, defaultOpenFileSections) : sections;
  return (
    <div className="space-y-1.5">
      <ul className="space-y-2">
        {shown.map((section, index) => (
          <FileSection
            key={section.key}
            section={section}
            context={context}
            workspaceRoot={workspaceRoot}
            defaultOpen={index < defaultOpenFileSections}
          />
        ))}
      </ul>
      {shown.length < sections.length ? (
        <Button size="xs" variant="outline" onClick={() => setShowAll(true)}>
          Show all {sections.length} files
        </Button>
      ) : null}
    </div>
  );
}

function diffActionFor(props: V2ItemInspectorProps, runId: RunId | null): DiffAction | null {
  if (props.diffUnavailableReason) {
    return { kind: "disabled", reason: props.diffUnavailableReason };
  }
  if (runId !== null) {
    const sourceThreadId = props.projectedItem.sourceThreadId;
    return {
      kind: "open",
      open: (filePath) => props.onOpenTurnDiff(runId, filePath, { sourceThreadId }),
    };
  }
  const target = props.subagentDiffTarget;
  if (target === undefined) return null;
  if (target.runId === null) {
    // The parent's projection is not loaded, so its launching run is not known yet.
    return { kind: "parent", open: () => props.onOpenThread(target.parentThreadId) };
  }
  const targetRunId = target.runId;
  return {
    kind: "open",
    open: (filePath) =>
      props.onOpenTurnDiff(targetRunId, filePath, {
        sourceThreadId: target.parentThreadId,
        attributedTo: { title: target.title, running: target.running },
      }),
  };
}

export const V2ItemInspector = memo(function V2ItemInspector(props: V2ItemInspectorProps) {
  const fetched = useFetchedTurnItem(
    props.projectedItem,
    props.environmentId,
    props.streamsToolOutput === true,
  );
  const item = fetched.item;
  const outputState = fetched.output;
  const support = useV2ItemSupport({
    environmentId: props.environmentId,
    sourceThreadId: props.projectedItem.sourceThreadId,
    sourceItemId: props.projectedItem.sourceItemId,
  });
  const diffAction = diffActionFor(props, item.runId);
  const editContext: EditContext = {
    reader: fetched.reader,
    diffAction,
    caption: `From ${props.providerLabel ?? "the provider"}`,
  };
  return (
    <div className="space-y-2 text-xs" data-v2-item-inspector={item.type}>
      {item.type === "reasoning" && item.text ? (
        <div className="rounded-md border border-border/45 bg-muted/15 p-2 italic text-muted-foreground">
          <ChatMarkdown
            formatDates
            text={item.text}
            cwd={props.cwd}
            threadRef={{
              environmentId: props.environmentId,
              threadId: props.projectedItem.sourceThreadId,
            }}
            lineBreaks
          />
        </div>
      ) : null}

      {item.type === "command_execution" ? (
        <ToolCallBody
          // A page read bounds the command; the timeline item keeps it whole.
          command={
            props.projectedItem.item.type === "command_execution"
              ? props.projectedItem.item.input
              : item.input
          }
          exitCode={item.exitCode}
          {...outputState}
          onImageExpand={props.onImageExpand}
        />
      ) : null}

      {item.type === "file_change" ? (
        <div className={cn("space-y-2", item.declined === true && "opacity-70")}>
          <div className="flex flex-wrap items-center gap-2">
            {/* A long path wraps inside the row instead of running past its edge. */}
            <span className="min-w-0 font-mono wrap-anywhere text-muted-foreground" data-edit-path>
              {formatWorkspaceRelativePath(item.fileName, props.workspaceRoot)}
            </span>
            <Counts additions={item.additions} deletions={item.deletions} />
            <DiffButton action={diffAction} filePath={item.fileName} />
          </div>
          {item.status === "failed" && item.diffStr?.trim() ? (
            <PagedCodePanel
              label="Error"
              source={sourceFromDetail(item.diffStr, { field: "body" }, fetched.read)}
              reader={fetched.reader}
              anchor="start"
              terminal
            />
          ) : null}
          {outputState.pending ? (
            <div className="text-muted-foreground italic">Loading patch…</div>
          ) : outputState.error ? (
            <div className="text-destructive-foreground">
              Couldn&apos;t load the patch: {outputState.error}
            </div>
          ) : item.status === "failed" && !item.changes?.some((change) => change.diffStr) ? null : (
            <EditBody
              item={item}
              read={fetched.read}
              context={editContext}
              workspaceRoot={props.workspaceRoot}
              defaultOpenFileSections={props.defaultOpenFileSections ?? 0}
            />
          )}
        </div>
      ) : null}

      {item.type === "file_search" && item.pattern?.trim() ? (
        <div className={cn("text-foreground/85", monoClassName)}>{item.pattern}</div>
      ) : null}

      {item.type === "web_search" && item.patterns?.length ? (
        <div className={cn("text-foreground/85", monoClassName)}>{item.patterns.join("\n")}</div>
      ) : null}

      {item.type === "file_search" && item.results?.length ? (
        <ul className="space-y-1">
          {item.results.map((result) => (
            <li key={JSON.stringify(result)}>
              <span className="font-mono text-foreground/80">
                {formatWorkspaceRelativePath(result.fileName, props.workspaceRoot)}
                {result.line === undefined ? "" : `:${result.line}`}
                {result.column === undefined ? "" : `:${result.column}`}
              </span>
              {result.preview ? (
                <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{result.preview}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {item.type === "web_search" && item.results?.length ? (
        <ul className="space-y-1.5">
          {item.results.map((result) => {
            const safeHref = resolveExternalWebLinkHref(result.url);
            return (
              <li key={JSON.stringify(result)}>
                {safeHref ? (
                  <a
                    href={safeHref}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
                  >
                    {result.title ?? result.url}
                    <ExternalLinkIcon className="size-3" />
                  </a>
                ) : (
                  <p className="font-medium text-foreground">
                    {result.title ?? result.url ?? "Search result"}
                  </p>
                )}
                {result.snippet ? <p className="text-muted-foreground">{result.snippet}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {item.type === "dynamic_tool" ? (
        <ToolCallBody
          args={item.input}
          toolName={item.toolName}
          read={fetched.read}
          {...outputState}
          onImageExpand={props.onImageExpand}
        />
      ) : null}

      {item.type === "approval_request" ? <StructuredValue value={item.prompt} /> : null}
      {item.type === "user_input_request" ? (
        <StructuredValue value={item.questions.map((question) => question.question).join("\n\n")} />
      ) : null}
      {item.type === "notification" ? <StructuredValue value={item.detail} /> : null}
      {item.type === "system_notice" ? <NoticeDetail message={item.message} /> : null}
      {item.type === "error" ? (
        <StructuredValue value={providerFailureDisplayMessage(item.failure)} />
      ) : null}
      {item.type === "proposed_plan" ? <StructuredValue value={item.markdown} /> : null}
      {item.type === "todo_list" ? (
        <StructuredValue
          value={item.steps
            .map((step) => `${step.status === "completed" ? "✓" : "○"} ${step.text}`)
            .join("\n")}
        />
      ) : null}

      {item.type === "checkpoint" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">
            {support.checkpoint?.status ?? item.status} · {item.files.length} files
          </span>
          {props.onRollbackCheckpoint && support.checkpoint?.status === "ready" ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                props.onRollbackCheckpoint?.({
                  checkpointId: item.checkpointId,
                  scopeId: item.scopeId,
                })
              }
            >
              <RotateCcwIcon className="size-3" />
              Roll back
            </Button>
          ) : null}
        </div>
      ) : null}

      {item.type === "fork" ? (
        <Button size="xs" variant="outline" onClick={() => props.onOpenThread(item.targetThreadId)}>
          <GitBranchIcon className="size-3" />
          Open fork
        </Button>
      ) : null}

      {item.type === "subagent" && item.childThreadId !== null ? (
        <Button size="xs" variant="outline" onClick={() => props.onOpenThread(item.childThreadId!)}>
          Open subagent thread
        </Button>
      ) : null}

      {item.type === "handoff" ? (
        <div className="space-y-1 text-muted-foreground">
          <p>
            {item.fromProviderInstanceIds.join(", ")} → {item.toProviderInstanceId}
          </p>
          <p>
            {item.strategy.replaceAll("_", " ")} · {support.contextHandoff?.status ?? item.status}
          </p>
          {support.contextTransfer ? (
            <p>
              Transfer {support.contextTransfer.type.replaceAll("_", " ")} ·{" "}
              {support.contextTransfer.status}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
