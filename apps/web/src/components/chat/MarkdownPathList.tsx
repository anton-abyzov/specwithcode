import { Check, Copy } from "lucide";
import { GripVerticalIcon } from "lucide-react";
import { type DragEvent, type ReactNode, useCallback } from "react";

import { exactPathListText, exactPathText } from "~/exactClipboardText";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { MorphIcon } from "../MorphIcon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface MarkdownPathListEntry {
  /** The line as the message wrote it. */
  readonly line: string;
  /** The file chip that opens, previews or reveals it. */
  readonly chip: ReactNode;
  /** Where the file is on the host, as far as it is known. */
  readonly fullPath: string;
  /** The host has no file at any place the line may point to. */
  readonly missing: boolean;
}

/**
 * Drag data for a path: a native file drag when the desktop app can start one,
 * else the path as text and a file URL, which terminals and editors accept.
 */
export function startPathDrag(
  event: Pick<DragEvent, "preventDefault" | "dataTransfer">,
  path: string,
  startFileDrag: ((path: string) => Promise<boolean>) | undefined,
): void {
  if (startFileDrag && path.startsWith("/")) {
    // Electron's own drag carries the file itself, so it drops into a
    // browser's upload field or Finder; the HTML drag would carry only text.
    event.preventDefault();
    void startFileDrag(path).catch(() => false);
    return;
  }
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("text/plain", path);
  if (path.startsWith("/")) {
    event.dataTransfer.setData("text/uri-list", `file://${encodeURI(path)}`);
  }
}

function PathRow(props: {
  entry: MarkdownPathListEntry;
  startFileDrag: ((path: string) => Promise<boolean>) | undefined;
}) {
  const { entry, startFileDrag } = props;
  const path = exactPathText(entry.fullPath);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "path", timeout: 1200 });
  const onDragStart = useCallback(
    (event: DragEvent<HTMLDivElement>) => startPathDrag(event, path, startFileDrag),
    [path, startFileDrag],
  );
  const copyLabel = isCopied ? "Copied" : "Copy full path";
  return (
    <div
      className="group/path flex min-w-0 items-center gap-1.5 py-0.5"
      data-path-list-row=""
      draggable={!entry.missing}
      onDragStart={onDragStart}
    >
      <GripVerticalIcon
        aria-hidden
        className="size-3 shrink-0 cursor-grab text-muted-foreground opacity-0 transition-opacity group-hover/path:opacity-100"
      />
      <span className="shrink-0">{entry.chip}</span>
      {/* The whole path selects on one click, ready to paste by hand. */}
      <code
        className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground select-all"
        data-path-list-path=""
        title={path}
      >
        {entry.missing ? `${entry.line} (not found)` : path}
      </code>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              aria-label={copyLabel}
              onClick={() => copyToClipboard(path, undefined)}
            />
          }
        >
          <MorphIcon className="size-3" icon={isCopied ? Check : Copy} />
        </TooltipTrigger>
        <TooltipPopup side="top">{copyLabel}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

/**
 * A fenced block that lists files, shown as the files: each one opens,
 * previews or reveals from its chip, shows its full path, copies it exactly
 * and drags out as the file. "Copy all paths" puts one path per line on the
 * clipboard with nothing around them.
 */
export function MarkdownPathList(props: {
  entries: ReadonlyArray<MarkdownPathListEntry>;
  startFileDrag?: ((path: string) => Promise<boolean>) | undefined;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "paths", timeout: 1200 });
  const count = props.entries.length;
  const allPaths = exactPathListText(
    props.entries.filter((entry) => !entry.missing).map((entry) => entry.fullPath),
  );
  const copyAllLabel = isCopied ? "Copied" : count === 1 ? "Copy path" : "Copy all paths";
  return (
    <div
      className="chat-markdown-pathlist my-[0.65rem] rounded-lg border border-border/70 bg-secondary px-3 py-1.5 dark:border-transparent dark:bg-input/32"
      data-path-list=""
    >
      <div className="flex items-center justify-between gap-2 select-none">
        <span className="font-mono text-2xs text-muted-foreground">
          {count === 1 ? "1 file" : `${count} files`}
        </span>
        <Button
          type="button"
          variant="ghost-muted"
          size="micro"
          disabled={allPaths.length === 0}
          onClick={() => copyToClipboard(allPaths, undefined)}
        >
          <MorphIcon className="size-3" icon={isCopied ? Check : Copy} />
          {copyAllLabel}
        </Button>
      </div>
      {props.entries.map((entry) => (
        <PathRow key={entry.line} entry={entry} startFileDrag={props.startFileDrag} />
      ))}
    </div>
  );
}
