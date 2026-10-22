import type { DesignComment, DesignNode, DesignPage } from "@specweave-studio/contracts";
import { DownloadIcon, ScanIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { memo, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import {
  HANDLES,
  artboards,
  pageRect,
  type Handle,
  type NodeIndex,
  type Point,
  type Rect,
} from "./geometry";

/**
 * Everything drawn over the design: frame labels, selection outlines and
 * handles, the marquee and draft shapes, comment pins. It lives inside the
 * scaled world layer and divides by `--zoom` so strokes and handles keep
 * their screen size.
 */

const px = (value: number) => `${value}px`;

/** Keeps a child at screen size inside the scaled world layer. */
const unscale = "origin-bottom-left [transform:scale(calc(1/var(--zoom)))]";

export const FrameLabels = memo(function FrameLabels({
  page,
  selected,
  onLabelPointerDown,
  onExport,
  onFocus,
}: {
  page: DesignPage;
  selected: ReadonlySet<string>;
  onLabelPointerDown: (event: ReactPointerEvent, frame: DesignNode) => void;
  onExport: (frame: DesignNode, anchor: HTMLElement) => void;
  onFocus: (frame: DesignNode) => void;
}) {
  return artboards(page).map((frame) => (
    <div
      key={frame.id}
      className="absolute h-0"
      style={{ left: px(frame.x), top: px(frame.y), width: px(frame.width) }}
    >
      <div
        className={cn(
          "group/label absolute bottom-0 left-0 flex h-6 items-center gap-1 pb-1 text-xs select-none",
          unscale,
        )}
        style={{ width: `calc(${frame.width}px * var(--zoom))` }}
      >
        <button
          type="button"
          data-frame-label={frame.id}
          tabIndex={-1}
          className={cn(
            "min-w-0 truncate rounded-sm px-0.5 text-left text-muted-foreground hover:text-foreground",
            selected.has(frame.id) && "text-primary hover:text-primary",
          )}
          onPointerDown={(event) => onLabelPointerDown(event, frame)}
        >
          {frame.name ?? "Frame"}
        </button>
        <span
          className={cn(
            "ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/label:opacity-100 focus-within:opacity-100",
            selected.has(frame.id) && "opacity-100",
          )}
        >
          <LabelAction
            label="Focus"
            ariaLabel={`Focus ${frame.name ?? "frame"}`}
            onClick={() => onFocus(frame)}
          >
            <ScanIcon className="size-3.5" />
          </LabelAction>
          <LabelAction
            label="Export"
            ariaLabel={`Export ${frame.name ?? "frame"}`}
            onClick={(anchor) => onExport(frame, anchor)}
          >
            <DownloadIcon className="size-3.5" />
          </LabelAction>
        </span>
      </div>
    </div>
  ));
});

export function SelectionOutline({
  index,
  ids,
  showHandles,
  onHandlePointerDown,
}: {
  index: NodeIndex;
  ids: readonly string[];
  showHandles: boolean;
  onHandlePointerDown: (event: ReactPointerEvent, handle: Handle) => void;
}) {
  const rects = ids
    .map((id) => index.get(id))
    .filter((node) => node !== undefined)
    .map((node) => pageRect(index, node));
  if (rects.length === 0) return null;
  const bounds = rects.reduce((a, b) => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x),
    height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y),
  }));
  return (
    <>
      {rects.length > 1 &&
        rects.map((rect, i) => <Box key={ids[i]} rect={rect} className="border-primary/60" />)}
      <Box rect={bounds} className="border-primary" testId="selection-bounds" />
      {showHandles &&
        HANDLES.map((handle) => (
          <div
            key={handle}
            data-handle={handle}
            className="absolute size-[calc(8px/var(--zoom))] -translate-1/2 border-primary bg-background"
            style={{
              borderWidth: "calc(1.5px / var(--zoom))",
              left: px(
                bounds.x +
                  (handle.includes("w")
                    ? 0
                    : handle.includes("e")
                      ? bounds.width
                      : bounds.width / 2),
              ),
              top: px(
                bounds.y +
                  (handle.includes("n")
                    ? 0
                    : handle.includes("s")
                      ? bounds.height
                      : bounds.height / 2),
              ),
              cursor: `${handle}-resize`,
            }}
            onPointerDown={(event) => onHandlePointerDown(event, handle)}
          />
        ))}
      {showHandles && (
        <div
          className={cn(
            "absolute rounded-sm bg-primary px-1 py-px text-2xs whitespace-nowrap text-primary-foreground tabular-nums",
            "origin-top-left [transform:scale(calc(1/var(--zoom)))_translateX(-50%)]",
          )}
          style={{
            left: px(bounds.x + bounds.width / 2),
            top: `calc(${bounds.y + bounds.height}px + 6px / var(--zoom))`,
          }}
        >
          {Math.round(bounds.width)} × {Math.round(bounds.height)}
        </div>
      )}
    </>
  );
}

function LabelAction({
  label,
  ariaLabel,
  onClick,
  children,
}: {
  label: string;
  ariaLabel: string;
  onClick: (anchor: HTMLElement) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={ariaLabel}
            className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => onClick(event.currentTarget)}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function Box({
  rect,
  className,
  testId,
  round = false,
}: {
  rect: Rect;
  className?: string;
  testId?: string;
  /** Draws an ellipse inside the rect. */
  round?: boolean;
}) {
  return (
    <div
      data-testid={testId}
      className={cn("pointer-events-none absolute", className)}
      style={{
        left: px(rect.x),
        top: px(rect.y),
        width: px(rect.width),
        height: px(rect.height),
        borderWidth: "calc(1.5px / var(--zoom))",
        ...(round ? { borderRadius: "50%" } : {}),
      }}
    />
  );
}

export function HoverOutline({ index, id }: { index: NodeIndex; id: string | null }) {
  const node = id === null ? undefined : index.get(id);
  if (node === undefined) return null;
  return <Box rect={pageRect(index, node)} className="border-primary/50" />;
}

export function DraftPolyline({
  points,
  cursor,
}: {
  points: readonly Point[];
  cursor: Point | null;
}) {
  const all = cursor === null ? points : [...points, cursor];
  if (all.length === 0) return null;
  return (
    <svg
      className="pointer-events-none absolute top-0 left-0 overflow-visible"
      width={1}
      height={1}
    >
      <polyline
        points={all.map((point) => `${point.x},${point.y}`).join(" ")}
        fill="none"
        className="stroke-primary"
        style={{ strokeWidth: "calc(1.5px / var(--zoom))" }}
      />
      {points.map((point, i) => (
        <circle
          key={i}
          cx={point.x}
          cy={point.y}
          r="calc(3px / var(--zoom))"
          style={{ r: "calc(3px / var(--zoom))" }}
          className="fill-background stroke-primary"
        />
      ))}
    </svg>
  );
}

/** Where a comment pin sits on the page. */
export function commentPoint(index: NodeIndex, comment: DesignComment): Point {
  const node = comment.nodeId === null ? undefined : index.get(comment.nodeId);
  if (node === undefined) return { x: comment.x, y: comment.y };
  const rect = pageRect(index, node);
  return { x: rect.x + comment.x, y: rect.y + comment.y };
}

export function CommentPins({
  index,
  comments,
  activeId,
  onOpen,
}: {
  index: NodeIndex;
  comments: readonly DesignComment[];
  activeId: string | null;
  onOpen: (comment: DesignComment) => void;
}) {
  return comments.map((comment, i) => {
    const point = commentPoint(index, comment);
    return (
      <button
        key={comment.id}
        type="button"
        data-comment-pin={comment.id}
        aria-label={`Comment ${i + 1}: ${comment.text.slice(0, 60)}`}
        className={cn(
          "absolute grid size-6 origin-top-left place-items-center rounded-full rounded-bl-none border text-2xs font-medium shadow-sm",
          "[transform:scale(calc(1/var(--zoom)))_translateY(-100%)]",
          comment.resolved
            ? "border-border bg-muted text-muted-foreground"
            : "border-primary bg-primary text-primary-foreground",
          activeId === comment.id && "ring-2 ring-ring ring-offset-1 ring-offset-background",
        )}
        style={{ left: px(point.x), top: px(point.y) }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => onOpen(comment)}
      >
        {i + 1}
      </button>
    );
  });
}
