import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { noteReaderScrollAround } from "~/lib/readerScroll";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { shouldCollapseReport } from "./longReport";

const FADE_HEIGHT_REM = 1.75;
const FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${FADE_HEIGHT_REM}rem), transparent)`;

/** True when the clamped body hides content. Null when there is no layout to read. */
export function reportBodyOverflows(
  body: Pick<HTMLElement, "scrollHeight" | "clientHeight"> | null,
): boolean | null {
  if (body === null || body.clientHeight <= 0) return null;
  return body.scrollHeight > body.clientHeight + 1;
}

/** The top edge of the nearest scrolling ancestor, or of the window. */
function scrollerTop(element: HTMLElement): number {
  for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
    const overflowY = getComputedStyle(parent).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      parent.scrollHeight > parent.clientHeight
    ) {
      return parent.getBoundingClientRect().top;
    }
  }
  return 0;
}

/** Brings a block's top back into view when collapsing it left the reader below it. */
export function revealCollapsedTop(element: HTMLElement | null): void {
  if (element === null || typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => {
    if (typeof element.getBoundingClientRect !== "function") return;
    if (element.getBoundingClientRect().top >= scrollerTop(element)) return;
    noteReaderScrollAround(element);
    element.scrollIntoView?.({ block: "start", behavior: "auto" });
  });
}

/**
 * Classes for the row holding the toggle; open, it rides the bottom of the
 * view, above the chat composer where one overlays the timeline's end.
 */
export function collapsibleFooterClassName(open: boolean): string | undefined {
  return open ? "sticky bottom-[calc(var(--composer-timeline-inset,0px)+0.5rem)] z-10" : undefined;
}

/** The one expand/collapse control every folded block in chat uses. */
export function CollapsibleToggle(props: {
  /** The block is expanded and folding is possible. */
  readonly open: boolean;
  readonly expanded: boolean;
  readonly expandLabel: string;
  readonly onClick: () => void;
  readonly className?: string;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant={props.open ? "outline" : "ghost-muted"}
      aria-expanded={props.expanded}
      data-scroll-anchor-ignore
      data-collapsible-toggle={props.open ? "collapse" : "expand"}
      onClick={props.onClick}
      className={cn(
        "-ml-1",
        props.open &&
          "ml-0 bg-background/95 shadow-xs backdrop-blur supports-backdrop-filter:bg-background/80",
        props.className,
      )}
    >
      {props.open ? <ChevronUpIcon aria-hidden /> : <ChevronDownIcon aria-hidden />}
      {props.open ? "Show less" : props.expandLabel}
    </Button>
  );
}

/**
 * Folds long content to its opening lines behind one toggle, the same way
 * everywhere in chat: collapsed, the body fades out above "Show full …";
 * expanded, a rule marks where the block starts and ends, and "Show less"
 * stays pinned to the bottom of the view until the block scrolls past, so it
 * can be folded again from anywhere inside it. Short content, content still
 * streaming, and content whose rendered height already fits show in full.
 * The wrapper always renders, whether or not folding is enabled, so the body
 * never remounts when folding turns on or off or when streaming finishes.
 */
export function CollapsibleReport(props: {
  readonly text: string;
  readonly streaming?: boolean;
  /** False renders the body as is. */
  readonly enabled?: boolean;
  /** Starts open, for example when the reader asked to see it in chat. */
  readonly defaultExpanded?: boolean;
  /** Keeps the block open, with no toggle, while a citation inside it is shown. */
  readonly forceExpanded?: boolean;
  /** Runs before the toggle changes, with the state it changes to. */
  readonly onToggle?: (expanded: boolean) => void;
  /** Whether this text is long enough to fold. Defaults to the report rule. */
  readonly shouldCollapse?: (text: string) => boolean;
  readonly expandLabel?: string;
  /** Height of the folded body. */
  readonly collapsedClassName?: string;
  /** Draw the rule beside the open block. Off where a bubble already bounds it. */
  readonly boundary?: boolean;
  /** Content shown beside the toggle, such as a message's actions. */
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(props.defaultExpanded === true);
  // Until layout says otherwise, long content is assumed to overflow.
  const [overflows, setOverflows] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  if (props.forceExpanded && !expanded) setExpanded(true);

  const enabled = props.enabled !== false;
  const longEnough = (props.shouldCollapse ?? shouldCollapseReport)(props.text);
  const candidate = enabled && !props.streaming && longEnough;
  const clamped = candidate && !expanded;
  const collapsed = clamped && overflows;
  const showToggle = candidate && (expanded || overflows) && !props.forceExpanded;
  const open = candidate && expanded && (showToggle || props.forceExpanded === true);
  const boundary = props.boundary !== false;

  useLayoutEffect(() => {
    if (!clamped) return;
    const measure = () => {
      const result = reportBodyOverflows(bodyRef.current);
      if (result !== null) setOverflows(result);
    };
    measure();
    const content = contentRef.current;
    if (content === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [clamped]);

  const toggle = () => {
    const next = !expanded;
    props.onToggle?.(next);
    setExpanded(next);
    if (!next) revealCollapsedTop(rootRef.current);
  };

  const button = showToggle ? (
    <CollapsibleToggle
      open={open}
      expanded={expanded}
      expandLabel={props.expandLabel ?? "Show full report"}
      onClick={toggle}
    />
  ) : null;

  return (
    <div
      ref={rootRef}
      className={
        cn(
          open && "relative",
          open &&
            boundary &&
            // Inset by the row's own padding, so a lane that clips horizontal overflow keeps it.
            "before:pointer-events-none before:absolute before:-left-[3px] before:inset-y-0 before:w-0.5 before:rounded-full before:bg-border",
        ) || undefined
      }
      data-report-collapsible={enabled ? String(showToggle) : undefined}
      data-report-expanded={
        enabled && candidate && (showToggle || props.forceExpanded) ? String(open) : undefined
      }
    >
      <div
        ref={bodyRef}
        className={
          cn(
            candidate && "relative",
            clamped && (props.collapsedClassName ?? "max-h-60"),
            clamped && "overflow-hidden",
          ) || undefined
        }
        data-report-collapsed={enabled ? String(collapsed) : undefined}
        style={collapsed ? { WebkitMaskImage: FADE_MASK, maskImage: FADE_MASK } : undefined}
      >
        <div ref={contentRef}>{props.children}</div>
      </div>
      {button || props.footer ? (
        <div
          className={cn(
            "mt-1 flex items-center gap-2",
            button && props.footer ? "justify-between" : button ? "justify-start" : "justify-end",
            collapsibleFooterClassName(open),
          )}
          data-collapsible-footer="true"
        >
          {button}
          {props.footer ? (
            <div className="ml-auto flex items-center gap-2">{props.footer}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
