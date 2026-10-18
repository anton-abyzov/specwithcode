import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";

export const MAX_ZOOM = 8;

export interface ZoomableImageHandle {
  pan: (key: string) => boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  /** Back to the whole image in view. */
  fit: () => void;
}

/** The room an image has to fit in, when that is not the window. */
export interface ZoomableImageBounds {
  readonly width: number;
  readonly height: number;
}

/** Zooms around the pointer and keeps the whole image accessible by dragging or scrolling. */
export function ZoomableImage({
  src,
  name,
  onError,
  bounds,
  onZoomChange,
  ref,
}: {
  src: string;
  name: string;
  onError: () => void;
  /** Fits the image to this box instead of the window, as in the viewer overlay. */
  bounds?: ZoomableImageBounds | null | undefined;
  onZoomChange?: ((zoom: number) => void) | undefined;
  ref?: Ref<ZoomableImageHandle>;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [windowSize, setWindowSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const anchorRef = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const maxHeight = bounds
    ? Math.max(1, bounds.height)
    : Math.max(1, Math.min(windowSize.height * 0.86, windowSize.height - 160));
  const maxWidth = bounds
    ? Math.max(1, bounds.width)
    : windowSize.width * 0.92 - (windowSize.width >= 640 ? 96 : 0);
  const fit = Math.min(
    1,
    maxWidth / (naturalSize.width || 1),
    maxHeight / (naturalSize.height || 1),
  );
  const width = naturalSize.width * fit * zoom;
  const height = naturalSize.height * fit * zoom;

  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;
  const changeZoom = useCallback((next: number, point?: { x: number; y: number }) => {
    const viewport = viewportRef.current;
    const previous = zoomRef.current;
    const clamped = Math.min(MAX_ZOOM, Math.max(1, next));
    if (!viewport || previous === clamped) return;
    const rect = viewport.getBoundingClientRect();
    const x = point ? point.x - rect.left : viewport.clientWidth / 2;
    const y = point ? point.y - rect.top : viewport.clientHeight / 2;
    anchorRef.current = {
      x: (viewport.scrollLeft + x) / previous,
      y: (viewport.scrollTop + y) / previous,
      clientX: rect.left + x,
      clientY: rect.top + y,
    };
    zoomRef.current = clamped;
    setZoom(clamped);
    onZoomChangeRef.current?.(clamped);
  }, []);

  const pan = useCallback((key: string) => {
    const viewport = viewportRef.current;
    if (!viewport || zoomRef.current <= 1) return false;
    // A vertical scrollbar alone must not swallow gallery navigation.
    if (
      (key === "ArrowLeft" || key === "ArrowRight") &&
      viewport.scrollWidth <= viewport.offsetWidth
    )
      return false;
    switch (key) {
      case "ArrowLeft":
        viewport.scrollLeft -= 40;
        break;
      case "ArrowRight":
        viewport.scrollLeft += 40;
        break;
      case "ArrowUp":
        viewport.scrollTop -= 40;
        break;
      case "ArrowDown":
        viewport.scrollTop += 40;
        break;
      default:
        return false;
    }
    return true;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      pan,
      zoomIn: () => changeZoom(zoomRef.current * 1.5),
      zoomOut: () => changeZoom(zoomRef.current / 1.5),
      fit: () => changeZoom(1),
    }),
    [changeZoom, pan],
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const anchor = anchorRef.current;
    if (!viewport || !anchor) return;
    const rect = viewport.getBoundingClientRect();
    viewport.scrollLeft = anchor.x * zoom - (anchor.clientX - rect.left);
    viewport.scrollTop = anchor.y * zoom - (anchor.clientY - rect.top);
    anchorRef.current = null;
  }, [zoom]);

  useEffect(() => {
    const resize = () => {
      setWindowSize({ width: window.innerWidth, height: window.innerHeight });
      changeZoom(1);
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [changeZoom]);

  // A new box to fit in (the thread folded away, the window resized) starts from the fit again.
  const boundsWidth = bounds?.width;
  const boundsHeight = bounds?.height;
  useEffect(() => {
    if (boundsWidth !== undefined && boundsHeight !== undefined) changeZoom(1);
  }, [boundsHeight, boundsWidth, changeZoom]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      changeZoom(zoomRef.current * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)), {
        x: event.clientX,
        y: event.clientY,
      });
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => viewport.removeEventListener("wheel", wheel);
  }, [changeZoom]);

  return (
    <div className="min-w-0">
      <div
        ref={viewportRef}
        role="region"
        aria-label={`${name}, zoomable image`}
        aria-description="Click to zoom in or return to fit. Scroll to zoom, drag to pan. Use Enter to toggle zoom, plus or minus to zoom, and 0 to fit."
        tabIndex={0}
        className={
          bounds
            ? "overflow-auto overscroll-contain rounded-md bg-background shadow-lg ring-1 ring-border/70 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            : "max-w-[var(--media-width)] overflow-auto overscroll-contain rounded-lg bg-background shadow-2xl ring-1 ring-border/70 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        }
        style={{
          width: width || undefined,
          height: height || undefined,
          maxHeight,
          ...(bounds ? { maxWidth } : {}),
          cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in",
        }}
        onClick={(event) => {
          // Pointer capture also produces a click after dragging; leave the image zoomed.
          if (suppressClickRef.current || event.detail > 1) return;
          changeZoom(zoomRef.current > 1 ? 1 : 2, { x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (!event.repeat) changeZoom(zoomRef.current > 1 ? 1 : 2);
          } else if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            changeZoom(zoomRef.current * 1.5);
          } else if (event.key === "-") {
            event.preventDefault();
            changeZoom(zoomRef.current / 1.5);
          } else if (event.key === "0") {
            event.preventDefault();
            changeZoom(1);
          } else if (pan(event.key)) {
            // A zoomed image pans; the viewer around it keeps arrows for paging otherwise.
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onPointerDown={(event) => {
          if (dragRef.current) return;
          suppressClickRef.current = false;
          if (event.pointerType !== "mouse" || event.button !== 0 || zoomRef.current <= 1) return;
          const viewport = event.currentTarget;
          const rect = viewport.getBoundingClientRect();
          if (
            event.clientX - rect.left >= viewport.clientWidth ||
            event.clientY - rect.top >= viewport.clientHeight
          )
            return;
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: viewport.scrollLeft,
            top: viewport.scrollTop,
          };
          viewport.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) {
            suppressClickRef.current = true;
          }
          event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x);
          event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y);
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          dragRef.current = null;
          setDragging(false);
        }}
        onLostPointerCapture={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = null;
          setDragging(false);
        }}
      >
        <img
          src={src}
          alt={name}
          draggable={false}
          className="block max-w-none select-none"
          style={
            naturalSize.width
              ? { width, height }
              : { maxWidth: bounds ? maxWidth : "var(--media-width)", maxHeight }
          }
          onLoad={(event) => {
            setNaturalSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            });
          }}
          onError={onError}
        />
      </div>
      <span className="sr-only" aria-live="polite">
        {Math.round(zoom * 100)}% zoom
      </span>
    </div>
  );
}
