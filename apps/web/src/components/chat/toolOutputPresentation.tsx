import type { WorkLogPresentationEntry } from "@specweave-studio/client-runtime/work-log/presentation";
import {
  commandDisplayText,
  commandHighlightLanguage,
  withVisibleControlCharacters,
} from "@specweave-studio/client-runtime/work-log/command-label";
import { CopyIcon, CheckIcon } from "lucide-react";
import { Suspense, use, useLayoutEffect, useMemo, useRef, useState } from "react";

import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { useTheme } from "../../hooks/useTheme";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import {
  resolveOutputLanguage,
  toolOutputContext,
  type OutputLanguageContext,
} from "../../lib/outputLanguage";
import { cn } from "../../lib/utils";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { HighlightedTokens } from "./HighlightedTokens";
import { terminalOutputPlainText, withoutTerminalEscapes } from "./shellCodeBlocks";

export interface ToolPresentationBlock {
  readonly label: string;
  readonly text: string;
  readonly language?: string;
  readonly context?: OutputLanguageContext | undefined;
  /** Terminal output: shown without ANSI sequences, with a Raw toggle. Copy keeps the bytes. */
  readonly terminal?: boolean | undefined;
}

/** Where a panel's text sits in the stored text, and how to read the pages around it. */
export interface ToolCodePaging {
  /** Command output opens on its last page; other text on its first. */
  readonly anchor: "start" | "end";
  /** UTF-16 offsets of the shown text in the stored text. */
  readonly offset: number;
  readonly end: number;
  readonly totalLength: number;
  readonly onLoadEarlier?: (() => void) | undefined;
  readonly onLoadMore?: (() => void) | undefined;
  readonly loading?: boolean | undefined;
  readonly error?: string | null | undefined;
}

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

/** "Showing last X of Y characters" for an end-anchored tail, else "Showing X of Y characters". */
export function toolCodePagingLabel(paging: ToolCodePaging): string {
  const shown = COUNT_FORMAT.format(paging.end - paging.offset);
  const total = COUNT_FORMAT.format(paging.totalLength);
  const tail = paging.anchor === "end" && paging.end === paging.totalLength;
  return `Showing ${tail ? "last " : ""}${shown} of ${total} characters`;
}

/** The notice for output SpecWithCode's own ingestion cut to its tail (ACP, Antigravity). */
export function outputKeptTailNotice(keptChars: number): string {
  return `SpecWithCode kept only the last ${COUNT_FORMAT.format(keptChars)} characters of this output`;
}

let scriptParser: Promise<typeof import("../../lib/embeddedScripts")> | undefined;
function HighlightedToolCode({
  code,
  language,
  theme,
}: {
  readonly code: string;
  readonly language: NonNullable<ToolPresentationBlock["language"]>;
  readonly theme: "light" | "dark";
}) {
  // Preserve the existing Python/JavaScript heredoc coloring. Parsing loads
  // only when a shell command is expanded, never for ordinary output rows.
  const parser =
    language === "shellscript" ? use((scriptParser ??= import("../../lib/embeddedScripts"))) : null;
  const embedded = useMemo(() => parser?.embeddedScripts(code) ?? [], [parser, code]);
  return <HighlightedTokens code={code} language={language} embedded={embedded} theme={theme} />;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function dynamicInput(entry: WorkLogPresentationEntry): unknown {
  return entry.structuredPayload?.type === "dynamic_tool"
    ? entry.structuredPayload.input
    : record(entry.toolData)?.input;
}

/** Input remains inert text. Recognizing an execution tool never executes its code. */
export function toolExecutionInput(entry: WorkLogPresentationEntry): ToolPresentationBlock | null {
  const item = entry.structuredPayload;
  const command =
    text(entry.rawCommand) ??
    text(entry.command) ??
    (item?.type === "command_execution" ? text(item.input) : undefined);
  if (command)
    return { label: "Command", text: command, language: commandHighlightLanguage(command) };
  const input = record(dynamicInput(entry));
  const toolName = item?.type === "dynamic_tool" ? item.toolName : (entry.toolTitle ?? entry.label);
  // Restrict these common keys to execution tools: `code` on other tools can
  // be a status code or an authored document, not an executable script.
  if (
    !/(?:^|[._\s])(?:exec(?:_command)?|bash|shell|terminal|js)(?:$|[._\s])/iu.test(toolName ?? "")
  ) {
    return null;
  }
  const shell = text(input?.cmd) ?? text(input?.command);
  if (shell) return { label: "Command", text: shell, language: commandHighlightLanguage(shell) };
  const code = text(input?.code);
  return code ? { label: "Script", text: code, language: "javascript" } : null;
}

/** A bounded preview identifies the action without flattening an entire script into a row. */
export function toolActivitySummary(
  entry: WorkLogPresentationEntry,
  fallback: string,
  active = false,
): string {
  const execution = toolExecutionInput(entry);
  if (!execution) return fallback;
  const input = record(dynamicInput(entry));
  const description = text(input?.title) ?? text(input?.description);
  const display =
    execution.label === "Command" ? commandDisplayText(execution.text) : execution.text;
  // The whole first line: the row truncates it with CSS, so its tooltip and Copy keep it all.
  const preview =
    (description ?? display)
      .split(/\r?\n/u)
      .find((line) => line.trim())
      ?.trim() ?? "";
  const count = display.split(/\r?\n/u).length;
  const status = entry.toolLifecycleStatus ?? (active ? "inProgress" : "completed");
  const verb =
    status === "inProgress"
      ? "Running"
      : status === "failed"
        ? "Failed"
        : status === "declined"
          ? "Declined"
          : status === "stopped"
            ? "Stopped"
            : status === "idle"
              ? "Queued"
              : "Ran";
  return `${verb}${execution.label === "Script" ? " script" : ""} · ${preview}${count > 1 ? ` · ${count} lines` : ""}`;
}

/** Legacy rows use the same separate sections as fetched projected items. */
export function toolPresentationBlocks(
  entry: WorkLogPresentationEntry,
  workspaceRoot: string | undefined,
  visibleLabel: string,
  viewedImagePath: string | null,
): readonly ToolPresentationBlock[] {
  const blocks: ToolPresentationBlock[] = [];
  const execution = toolExecutionInput(entry);
  if (execution) blocks.push(execution);
  const input = dynamicInput(entry);
  if (input !== undefined) {
    const values = record(input);
    const remaining =
      execution && values
        ? Object.fromEntries(
            Object.entries(values).filter(
              ([key]) =>
                !(["cmd", "command", "code"].includes(key) && values[key] === execution.text),
            ),
          )
        : input;
    if (!record(remaining) || Object.keys(record(remaining)!).length > 0) {
      const formatted =
        typeof remaining === "string" ? remaining : JSON.stringify(remaining, null, 2);
      if (formatted?.trim()) blocks.push({ label: "Input", text: formatted, language: "json" });
    }
  }
  const detail = text(entry.detail);
  if (
    detail &&
    detail.trim() !== viewedImagePath?.trim() &&
    detail.trim() !== visibleLabel.trim() &&
    detail.trim() !== execution?.text.trim()
  ) {
    const context = toolOutputContext(
      entry.structuredPayload ?? {
        type: "dynamic_tool",
        toolName: entry.toolTitle ?? entry.label,
        input: dynamicInput(entry),
        output: detail,
        status: entry.toolLifecycleStatus,
      },
    );
    const command = execution?.label === "Command" ? execution.text : undefined;
    const language = resolveOutputLanguage(detail, command ? { command } : context);
    blocks.push({
      label: "Output",
      text: detail,
      terminal: true,
      context: command ? { ...context, command } : context,
      ...(language ? { language } : {}),
    });
  }
  const imagePaths = new Set(
    viewedImagePath
      ? [viewedImagePath, formatWorkspaceRelativePath(viewedImagePath, workspaceRoot)]
      : [],
  );
  const files = [
    ...new Set(
      (entry.changedFiles ?? [])
        .map((path) => formatWorkspaceRelativePath(path, workspaceRoot))
        .filter((path) => !imagePaths.has(path) && path !== detail?.trim()),
    ),
  ];
  if (files.length) blocks.push({ label: "Files", text: files.join("\n") });
  return blocks;
}

/** A pager control: the same look as the panel's header controls. */
function PagingBar({
  paging,
  onLoadEarlier,
  position,
  controlClass,
}: {
  readonly paging: ToolCodePaging;
  /** Wraps the paging's own handler so the panel can keep the reader's place. */
  readonly onLoadEarlier: () => void;
  readonly position: "top" | "bottom";
  readonly controlClass: string;
}) {
  const earlier = paging.offset > 0 && paging.onLoadEarlier ? onLoadEarlier : undefined;
  const more = paging.end < paging.totalLength ? paging.onLoadMore : undefined;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 px-3 py-1 text-xs text-muted-foreground",
        position === "top" ? "border-b border-border/45" : "border-t border-border/45",
      )}
      data-tool-code-paging={position}
      onClick={(event) => event.stopPropagation()}
    >
      <span>{toolCodePagingLabel(paging)}</span>
      {earlier ? (
        <button
          type="button"
          className={controlClass}
          disabled={paging.loading === true}
          onClick={earlier}
        >
          Load earlier
        </button>
      ) : null}
      {more ? (
        <button
          type="button"
          className={controlClass}
          disabled={paging.loading === true}
          onClick={more}
        >
          Load more
        </button>
      ) : null}
      {paging.loading ? <span role="status">Loading…</span> : null}
      {paging.error ? (
        <span className="text-destructive-foreground" role="status">
          Couldn&apos;t load: {paging.error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Scroll belongs to the code block, never the page. Copy keeps original whitespace.
 * A paged text shows one window of the stored text with Load earlier/Load more,
 * and Copy full reads the whole stored text instead of the window.
 */
export function ToolCodePanel({
  label,
  text: content,
  language: explicitLanguage,
  context,
  terminal = false,
  paging,
  copyFull,
  notice,
  scrollToEnd = false,
}: ToolPresentationBlock & {
  readonly paging?: ToolCodePaging | undefined;
  /** Reads the whole stored text for Copy; absent copies the shown text. */
  readonly copyFull?: (() => Promise<string>) | undefined;
  readonly notice?: string | null | undefined;
  /** Opens scrolled to the end and keeps following it, as command output reads. */
  readonly scrollToEnd?: boolean | undefined;
}) {
  const { resolvedTheme } = useTheme();
  const [raw, setRaw] = useState(false);
  // Terminal output reads as the terminal drew it; Raw shows each control byte. A file's
  // own text (a read with a path or a stated language) is source: only its escape
  // sequences go, and line endings and other control bytes stay as they are.
  const source = Boolean(context?.filePath || context?.language);
  const plain = useMemo(
    () =>
      !terminal
        ? null
        : source
          ? withoutTerminalEscapes(content)
          : terminalOutputPlainText(content),
    [terminal, source, content],
  );
  const hasRaw = plain !== null && plain !== (source ? content : content.replaceAll("\r\n", "\n"));
  // Show invisible control bytes without changing whitespace or the original copied text.
  const displayContent = useMemo(
    () =>
      plain === null || (raw && hasRaw)
        ? withVisibleControlCharacters(content)
        : source
          ? withVisibleControlCharacters(plain)
          : plain,
    [plain, raw, hasRaw, source, content],
  );
  const language = useMemo(
    () =>
      resolveOutputLanguage(content, {
        ...context,
        ...(explicitLanguage ? { language: explicitLanguage } : {}),
        // Only Output is eligible for inference. Input/Files are presentation text.
        ...(!context && !explicitLanguage && label !== "Output" ? { plain: true } : {}),
      }),
    [content, context, explicitLanguage, label],
  );
  const [wrapped, setWrapped] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copyResult, setCopyResult] = useState<{
    content: string;
    status: "idle" | "pending" | "copied" | "failed";
  }>({ content, status: "idle" });
  const copyState = copyResult.content === content ? copyResult.status : "idle";
  const long = content.split(/\r?\n/u).length > 12 || content.length > 1600;
  const preRef = useRef<HTMLPreElement>(null);
  const followsEnd = useRef(true);
  const gapBelow = useRef<number | null>(null);
  // After every render: text loaded above keeps the reader's place, and a reader
  // at the end (where a tail opens) stays there as the text grows.
  useLayoutEffect(() => {
    const pre = preRef.current;
    if (!pre || !scrollToEnd) return;
    if (gapBelow.current !== null) pre.scrollTop = pre.scrollHeight - gapBelow.current;
    else if (followsEnd.current) pre.scrollTop = pre.scrollHeight;
    gapBelow.current = null;
  });
  const controlClass =
    "inline-flex min-h-7 items-center gap-1 rounded px-1.5 text-xs text-secondary-label hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";
  const loadEarlier = () => {
    const pre = preRef.current;
    if (pre) gapBelow.current = pre.scrollHeight - pre.scrollTop;
    paging?.onLoadEarlier?.();
  };
  const showsPaging =
    paging !== undefined &&
    (paging.offset > 0 || paging.end < paging.totalLength || Boolean(paging.error));
  const copy = async () => {
    if (copyState === "pending") return;
    setCopyResult({ content, status: "pending" });
    try {
      const value = copyFull ? await copyFull() : content;
      await writeTextToClipboard(value, label.toLowerCase(), undefined, {
        preserveBytes: true,
      });
      setCopyResult((previous) =>
        previous.content === content ? { content, status: "copied" } : previous,
      );
    } catch {
      setCopyResult((previous) =>
        previous.content === content ? { content, status: "failed" } : previous,
      );
    }
  };
  const copyName = `${copyFull ? "Copy full" : "Copy"} ${label.toLowerCase()}`;
  return (
    <section
      className="min-w-0 max-w-full overflow-hidden rounded-lg border border-border/60 bg-muted/15 font-sans"
      data-tool-code-panel={label.toLowerCase()}
      data-language={language ?? "text"}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 border-b border-border/45 px-3 py-1.5">
        <span className="font-sans text-xs font-medium text-foreground/85">{label}</span>
        <div
          className="flex items-center gap-1"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {hasRaw ? (
            <button
              type="button"
              className={controlClass}
              aria-pressed={raw}
              aria-label={`Show raw ${label.toLowerCase()}`}
              onClick={() => setRaw(!raw)}
            >
              Raw
            </button>
          ) : null}
          <button
            type="button"
            className={controlClass}
            aria-pressed={wrapped}
            aria-label={`Wrap ${label.toLowerCase()} lines`}
            onClick={() => setWrapped(!wrapped)}
          >
            Wrap
          </button>
          {long ? (
            <button
              type="button"
              className={controlClass}
              aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${label.toLowerCase()}`}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
          ) : null}
          <button
            type="button"
            className={controlClass}
            disabled={copyState === "pending"}
            aria-label={copyName}
            onClick={() => void copy()}
          >
            {copyState === "copied" ? (
              <CheckIcon className="size-3" aria-hidden />
            ) : (
              <CopyIcon className="size-3" aria-hidden />
            )}
            {copyState === "copied"
              ? "Copied"
              : copyState === "pending"
                ? "Copying…"
                : copyFull
                  ? "Copy full"
                  : "Copy"}
          </button>
        </div>
      </div>
      {notice ? (
        <p className="border-b border-border/45 px-3 py-1.5 text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {showsPaging && paging.anchor === "end" ? (
        <PagingBar
          paging={paging}
          onLoadEarlier={loadEarlier}
          position="top"
          controlClass={controlClass}
        />
      ) : null}
      <pre
        ref={preRef}
        tabIndex={0}
        aria-label={`${label} content`}
        onScroll={(event) => {
          const pre = event.currentTarget;
          followsEnd.current = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 8;
        }}
        className={cn(
          "m-0 min-w-0 overflow-auto px-3 py-3 font-mono text-(length:--font-size-code,var(--text-xs)) leading-relaxed text-foreground/85 select-text outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-ring",
          !expanded && "max-h-80",
          wrapped ? "whitespace-pre-wrap break-words" : "whitespace-pre",
        )}
      >
        <code>
          {language ? (
            <RenderErrorBoundary fallback={displayContent} resetKeys={[content, language]}>
              <Suspense fallback={displayContent}>
                <HighlightedToolCode
                  code={displayContent}
                  language={language}
                  theme={resolvedTheme}
                />
              </Suspense>
            </RenderErrorBoundary>
          ) : (
            displayContent
          )}
        </code>
      </pre>
      {showsPaging && paging.anchor === "start" ? (
        <PagingBar
          paging={paging}
          onLoadEarlier={loadEarlier}
          position="bottom"
          controlClass={controlClass}
        />
      ) : null}
      {copyState === "failed" ? (
        <p className="px-3 pb-2 font-sans text-xs text-destructive-foreground" role="status">
          Couldn&apos;t copy. Select the text and copy it manually.
        </p>
      ) : null}
      <span className="sr-only" role="status">
        {copyState === "copied" ? `${label} copied.` : ""}
      </span>
    </section>
  );
}

export function ToolPresentationBlocks({
  blocks,
}: {
  readonly blocks: readonly ToolPresentationBlock[];
}) {
  return (
    <div className="min-w-0 space-y-2">
      {blocks.map((block, index) => (
        <ToolCodePanel key={`${block.label}:${index}`} {...block} />
      ))}
    </div>
  );
}
