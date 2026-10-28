import {
  type ComponentProps,
  createContext,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Check, Copy } from "lucide";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { serializeTableElementToCsv, serializeTableElementToMarkdown } from "../markdown-clipboard";
import { MorphIcon } from "./MorphIcon";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { ScrollBar } from "./ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** True inside a table, where inline code renders each word as its own box. */
export const InsideMarkdownTable = createContext(false);

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
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyLabel = copied ? "Copied" : "Copy table";

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
    <div ref={containerRef} className="chat-markdown-table-container">
      <ScrollAreaPrimitive.Root className="relative size-full min-h-0 w-full max-w-full overflow-hidden rounded-none">
        <ScrollAreaPrimitive.Viewport
          role="region"
          aria-label="Scrollable data table"
          tabIndex={0}
          data-slot="scroll-area-viewport"
          className="h-full max-h-[inherit] overflow-auto overscroll-x-contain overscroll-y-auto rounded-none outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))] mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))] mask-l-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-start)))] mask-r-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-end)))] [--fade-size:1.5rem] scroll-p-[var(--fade-size)]"
        >
          <table {...props}>
            <InsideMarkdownTable value>{children}</InsideMarkdownTable>
          </table>
        </ScrollAreaPrimitive.Viewport>
        <ScrollBar orientation="vertical" />
        <ScrollBar orientation="horizontal" />
        <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />
      </ScrollAreaPrimitive.Root>
      <div className="mt-0.5 flex items-center justify-end select-none">
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
