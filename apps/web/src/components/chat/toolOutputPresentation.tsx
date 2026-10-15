import type { WorkLogPresentationEntry } from "@specweave-studio/client-runtime/work-log/presentation";
import {
  commandDisplayText,
  commandHighlightLanguage,
  withVisibleControlCharacters,
} from "@specweave-studio/client-runtime/work-log/command-label";
import { CopyIcon, CheckIcon } from "lucide-react";
import { Suspense, use, useMemo, useState } from "react";

import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { useTheme } from "../../hooks/useTheme";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { HighlightedTokens } from "./HighlightedTokens";

export interface ToolPresentationBlock {
  readonly label: string;
  readonly text: string;
  readonly language?: "shellscript" | "powershell" | "javascript" | "json";
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
  const firstLine =
    (description ?? display)
      .split(/\r?\n/u)
      .find((line) => line.trim())
      ?.trim() ?? "";
  const preview = firstLine.length > 96 ? `${firstLine.slice(0, 95)}…` : firstLine;
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
    blocks.push({ label: "Output", text: detail });
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

/** Scroll belongs to the code block, never the page. Copy keeps original whitespace. */
export function ToolCodePanel({ label, text: content, language }: ToolPresentationBlock) {
  const { resolvedTheme } = useTheme();
  // Show invisible control bytes without changing whitespace or the original copied text.
  const displayContent = withVisibleControlCharacters(content);
  const [wrapped, setWrapped] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copyResult, setCopyResult] = useState<{
    content: string;
    status: "idle" | "pending" | "copied" | "failed";
  }>({ content, status: "idle" });
  const copyState = copyResult.content === content ? copyResult.status : "idle";
  const long = content.split(/\r?\n/u).length > 12 || content.length > 1600;
  const controlClass =
    "inline-flex min-h-7 items-center gap-1 rounded px-1.5 text-xs text-secondary-label hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const copy = async () => {
    if (copyState === "pending") return;
    setCopyResult({ content, status: "pending" });
    try {
      await writeTextToClipboard(content, label.toLowerCase());
      setCopyResult((previous) =>
        previous.content === content ? { content, status: "copied" } : previous,
      );
    } catch {
      setCopyResult((previous) =>
        previous.content === content ? { content, status: "failed" } : previous,
      );
    }
  };
  return (
    <section
      className="min-w-0 max-w-full overflow-hidden rounded-lg border border-border/60 bg-muted/15 font-sans"
      data-tool-code-panel={label.toLowerCase()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 border-b border-border/45 px-3 py-1.5">
        <span className="font-sans text-xs font-medium text-foreground/85">{label}</span>
        <div
          className="flex items-center gap-1"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
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
            aria-label={`Copy ${label.toLowerCase()}`}
            onClick={() => void copy()}
          >
            {copyState === "copied" ? (
              <CheckIcon className="size-3" aria-hidden />
            ) : (
              <CopyIcon className="size-3" aria-hidden />
            )}
            {copyState === "copied" ? "Copied" : copyState === "pending" ? "Copying…" : "Copy"}
          </button>
        </div>
      </div>
      <pre
        tabIndex={0}
        aria-label={`${label} content`}
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
