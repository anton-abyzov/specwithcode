import type { DesignNode, DesignSystem } from "@specweave-studio/contracts";
import type { SlideLayoutId } from "@specweave-studio/shared/slideLayouts";
import { useEffect, useState } from "react";
import type { CameraStore } from "../canvas/camera";
import type { Camera, Rect } from "../canvas/geometry";
import { SlideLayoutGrid } from "./SlideThumbnail";

const INSET = 12;
const MIN_WIDTH = 264;
const MIN_HEIGHT = 168;
/** Below this width the prompt drops its second sentence. */
const COMPACT_WIDTH = 440;

/** A frame's rectangle on screen, relative to the canvas viewport. */
export function screenRect(
  frame: Pick<DesignNode, "x" | "y" | "width" | "height">,
  camera: Camera,
) {
  return {
    x: camera.x + frame.x * camera.zoom,
    y: camera.y + frame.y * camera.zoom,
    width: frame.width * camera.zoom,
    height: frame.height * camera.zoom,
  };
}

/**
 * Where the layout prompt goes: the visible part of the empty slide, inset,
 * so it covers nothing but the slide it fills. A slide drawn smaller than the
 * prompt's minimum grows the box around the slide's center, kept inside the
 * viewport; the prompt scrolls when the box is shorter than its content.
 */
export function promptBox(slide: Rect, viewport: { width: number; height: number }): Rect {
  const left = Math.max(slide.x, 0);
  const top = Math.max(slide.y, 0);
  const right = Math.min(slide.x + slide.width, viewport.width);
  const bottom = Math.min(slide.y + slide.height, viewport.height);
  const fit = (start: number, end: number, minimum: number, limit: number) => {
    const room = Math.max(0, limit - INSET * 2);
    const size = Math.min(Math.max(end - start - INSET * 2, minimum), room);
    const center = right > left && bottom > top ? (start + end) / 2 : limit / 2;
    const at = Math.min(Math.max(center - size / 2, INSET), Math.max(INSET, limit - INSET - size));
    return { at, size };
  };
  const horizontal = fit(left, right, MIN_WIDTH, viewport.width);
  const vertical = fit(top, bottom, MIN_HEIGHT, viewport.height);
  return { x: horizontal.at, y: vertical.at, width: horizontal.size, height: vertical.size };
}

/** Follows the camera (pan, zoom) and the viewport's size. */
function useCameraView(camera: CameraStore) {
  const read = () => ({ camera: camera.get(), size: camera.viewportSize() });
  const [view, setView] = useState(read);
  useEffect(() => {
    const update = () => setView({ camera: camera.get(), size: camera.viewportSize() });
    update();
    const unsubscribe = camera.subscribeView(update);
    const element = camera.viewportElement();
    const observer = element === null ? null : new ResizeObserver(update);
    if (element !== null) observer?.observe(element);
    return () => {
      unsubscribe();
      observer?.disconnect();
    };
  }, [camera]);
  return view;
}

/** "Start this slide from a layout", laid over the empty slide itself. */
export function SlideLayoutPrompt({
  camera,
  frame,
  system,
  onPick,
}: {
  camera: CameraStore;
  frame: DesignNode;
  system: DesignSystem | null;
  onPick: (layout: SlideLayoutId) => void;
}) {
  const view = useCameraView(camera);
  const box = promptBox(screenRect(frame, view.camera), view.size);
  const compact = box.width < COMPACT_WIDTH;
  return (
    <div
      className="pointer-events-none absolute flex items-center justify-center"
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    >
      <div
        data-testid="slide-layout-prompt"
        data-compact={compact ? "true" : undefined}
        className="pointer-events-auto max-h-full w-full max-w-[46rem] overflow-y-auto rounded-xl border bg-popover/95 p-3 shadow-md backdrop-blur"
      >
        <p className="mb-2 px-1 text-sm">
          <span className="font-medium">Start this slide from a layout.</span>
          {!compact && (
            <span className="text-muted-foreground">
              {" "}
              Colors and fonts come from the design system.
            </span>
          )}
        </p>
        <SlideLayoutGrid system={system} width="fill" columns="fit" onPick={onPick} />
      </div>
    </div>
  );
}
