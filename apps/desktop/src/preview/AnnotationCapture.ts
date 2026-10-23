import type { PreviewAnnotationRect } from "@specweave-studio/contracts";

/** DOM picks use CSS pixels; Electron capturePage rectangles use display DIPs. */
export function annotationCaptureRect(
  rect: PreviewAnnotationRect,
  zoomFactor: number,
): PreviewAnnotationRect {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const x = Math.floor(rect.x * zoom);
  const y = Math.floor(rect.y * zoom);
  return {
    x,
    y,
    // Round edges outward so fractional zoom never clips a selected edge.
    width: Math.max(1, Math.ceil((rect.x + rect.width) * zoom) - x),
    height: Math.max(1, Math.ceil((rect.y + rect.height) * zoom) - y),
  };
}
