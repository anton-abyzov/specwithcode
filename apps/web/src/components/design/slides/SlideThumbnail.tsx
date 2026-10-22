import type { DesignPage, DesignSystem } from "@specweave-studio/contracts";
import {
  slideLayoutPage,
  SLIDE_LAYOUTS,
  type SlideLayoutId,
} from "@specweave-studio/shared/slideLayouts";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { artboards } from "../canvas/geometry";
import { DesignPageView } from "../canvas/NodeView";
import { framePage } from "../canvas/FrameStage";

/**
 * A slide drawn at `width` pixels wide by the canvas's own node renderer, so
 * the rail, the layout picker and the presenter view match the canvas.
 */
export const SlideThumbnail = memo(function SlideThumbnail({
  page,
  width,
  className,
}: {
  page: DesignPage;
  /** Pixels, or "fill" to take the container's width. */
  width: number | "fill";
  className?: string;
}) {
  const frame = artboards(page)[0];
  const view = useMemo(() => (frame === undefined ? null : framePage(page, frame)), [frame, page]);
  const box = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(0);
  useLayoutEffect(() => {
    const element = box.current;
    if (width !== "fill" || element === null) return;
    const measure = () => setMeasured(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [width]);
  const pixels = width === "fill" ? measured : width;
  const ratio = frame === undefined ? 9 / 16 : frame.height / frame.width;
  return (
    <div
      ref={box}
      aria-hidden
      inert
      className={cn(
        "pointer-events-none relative shrink-0 overflow-hidden",
        frame === undefined && "bg-muted",
        width === "fill" && "w-full",
        className,
      )}
      style={
        width === "fill"
          ? { aspectRatio: `${1 / ratio}` }
          : { width, height: Math.round(width * ratio) }
      }
    >
      {frame !== undefined && view !== null && pixels > 0 && (
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{ transform: `scale(${pixels / frame.width})` }}
        >
          <DesignPageView page={view} />
        </div>
      )}
    </div>
  );
});

/** Fixed ids, so a layout preview renders the same nodes every time. */
function previewRandom() {
  let seed = 3;
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

/** One button per layout, each previewed in the design's own tokens. */
export function SlideLayoutGrid({
  system,
  width,
  columns,
  onPick,
}: {
  system: DesignSystem | null;
  width: number | "fill";
  /** A fixed column count, or "fit" to fit as many of `minWidth` as the space allows. */
  columns: 3 | "fit";
  onPick: (layout: SlideLayoutId) => void;
}) {
  const previews = useMemo(
    () =>
      SLIDE_LAYOUTS.map((layout) => ({
        ...layout,
        page: slideLayoutPage(layout.id, { name: layout.label, system, random: previewRandom() }),
      })),
    [system],
  );
  return (
    <ul
      className={cn(
        "grid gap-2",
        columns === 3 ? "grid-cols-3" : "grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))]",
      )}
      aria-label="Slide layouts"
    >
      {previews.map((layout) => (
        <li key={layout.id}>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-testid="slide-layout"
                  data-layout={layout.id}
                  aria-description={layout.description}
                  onClick={() => onPick(layout.id)}
                  className="group flex w-full flex-col gap-1 rounded-md p-1 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              <SlideThumbnail
                page={layout.page}
                width={width}
                className="rounded-sm ring-1 ring-border/80"
              />
              <span className="truncate px-0.5 text-xs">{layout.label}</span>
            </TooltipTrigger>
            <TooltipPopup side="top">{layout.description}</TooltipPopup>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}
