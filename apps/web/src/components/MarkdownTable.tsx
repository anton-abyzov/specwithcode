import {
  type ComponentProps,
  createContext,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Check, Copy, Maximize2, Minimize2 } from "lucide";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { getClientSettings } from "../hooks/useSettings";
import { serializeTableElementToCsv, serializeTableElementToMarkdown } from "../markdown-clipboard";
import { MorphIcon } from "./MorphIcon";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { ScrollBar } from "./ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** True inside a table, where inline code renders each word as its own box. */
export const InsideMarkdownTable = createContext(false);

function readInitialWordWrapSetting(): boolean {
  return getClientSettings().wordWrap;
}

/** CSV is data export, so date presentation must not replace the source values. */
export function markdownTableCopyText(table: HTMLTableElement, format: "markdown" | "csv"): string {
  if (format === "markdown") return serializeTableElementToMarkdown(table);
  const source = table.cloneNode(true) as HTMLTableElement;
  for (const date of source.querySelectorAll("time[data-markdown-copy]")) {
    date.textContent = date.getAttribute("data-markdown-copy");
  }
  return serializeTableElementToCsv(source);
}

export function MarkdownTable({ children, ...props }: ComponentProps<"table">) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [expanded, setExpanded] = useState(readInitialWordWrapSetting);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expandLabel = expanded ? "Collapse table cells" : "Expand table cells";
  const copyLabel = copied ? "Copied" : "Copy table";

  function toggleExpanded() {
    const table = tableRef.current;
    if (!table) return;

    if (!expanded) {
      const rows = [...table.rows];
      const columnWidths = rows.reduce<number[]>((widths, row) => {
        [...row.cells].forEach((cell, columnIndex) => {
          widths[columnIndex] = Math.max(
            widths[columnIndex] ?? 0,
            cell.getBoundingClientRect().width,
          );
        });
        return widths;
      }, []);

      [...(table.tHead?.rows[0]?.cells ?? [])].forEach((cell, columnIndex) => {
        cell.style.minWidth = `${columnWidths[columnIndex] ?? cell.getBoundingClientRect().width}px`;
      });
    }

    setExpanded((value) => !value);
  }

  const handleCopy = useCallback((format: "markdown" | "csv") => {
    const table = containerRef.current?.querySelector("table");
    if (!table || typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    const text = markdownTableCopyText(table, format);
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause) => {
        console.error("[chat-markdown] action failed", { operation: "copy-table", format }, cause);
      });
  }, []);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      className="chat-markdown-table-container"
      data-expanded={expanded ? "true" : "false"}
    >
      <ScrollAreaPrimitive.Root className="relative size-full min-h-0 w-full max-w-full overflow-hidden rounded-none">
        <ScrollAreaPrimitive.Viewport
          role="region"
          aria-label="Scrollable data table"
          tabIndex={0}
          data-slot="scroll-area-viewport"
          className="h-full max-h-[inherit] overflow-auto overscroll-x-contain overscroll-y-auto rounded-none outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))] mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))] mask-l-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-start)))] mask-r-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-end)))] [--fade-size:1.5rem] scroll-p-[var(--fade-size)]"
        >
          <table ref={tableRef} {...props}>
            <InsideMarkdownTable value>{children}</InsideMarkdownTable>
          </table>
        </ScrollAreaPrimitive.Viewport>
        <ScrollBar orientation="vertical" />
        <ScrollBar orientation="horizontal" />
        <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />
      </ScrollAreaPrimitive.Root>
      <div className="mt-0.5 flex items-center justify-between select-none">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant={expanded ? "secondary" : "ghost-muted"}
                size="icon-xs"
                aria-pressed={expanded}
                onClick={toggleExpanded}
                aria-label={expandLabel}
              />
            }
          >
            <MorphIcon className="size-3" icon={expanded ? Minimize2 : Maximize2} />
          </TooltipTrigger>
          <TooltipPopup side="top">{expandLabel}</TooltipPopup>
        </Tooltip>
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="icon-xs"
                      aria-label={copyLabel}
                    />
                  }
                />
              }
            >
              <MorphIcon className="size-3" icon={copied ? Check : Copy} />
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <MenuItem onClick={() => handleCopy("markdown")}>Copy as Markdown</MenuItem>
            <MenuItem onClick={() => handleCopy("csv")}>Copy as CSV</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}
