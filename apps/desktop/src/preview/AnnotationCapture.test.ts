import { describe, expect, it } from "vite-plus/test";
import { annotationCaptureRect } from "./AnnotationCapture.ts";

describe("annotation capture coordinates", () => {
  it.each([
    [0.75, { x: 180, y: 225, width: 285, height: 60 }],
    [1, { x: 240, y: 300, width: 380, height: 80 }],
    [1.5, { x: 360, y: 450, width: 570, height: 120 }],
  ])("captures the selected DOM content at zoom %s", (zoom, expected) => {
    expect(
      annotationCaptureRect({ x: 240, y: 300, width: 380, height: 80 }, zoom as number),
    ).toEqual(expected);
  });

  it("rounds fractional edges outward", () => {
    expect(annotationCaptureRect({ x: 10.5, y: 20.5, width: 100, height: 30 }, 1.25)).toEqual({
      x: 13,
      y: 25,
      width: 126,
      height: 39,
    });
  });

  it.each([0, -1, NaN, Infinity])("falls back for invalid zoom %s", (zoom) => {
    expect(annotationCaptureRect({ x: 10, y: 20, width: 30, height: 40 }, zoom)).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    });
  });
});
