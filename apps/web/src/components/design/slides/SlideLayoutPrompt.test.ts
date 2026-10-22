import { describe, expect, it } from "vite-plus/test";
import { promptBox, screenRect } from "./SlideLayoutPrompt";

const within = (
  inner: { x: number; y: number; width: number; height: number },
  outer: typeof inner,
) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

describe("layout prompt placement", () => {
  it("maps the slide frame to the screen through the camera", () => {
    expect(
      screenRect({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 40, y: 100, zoom: 0.25 }),
    ).toEqual({ x: 40, y: 100, width: 480, height: 270 });
  });

  it("sits inside a slide that has room for it", () => {
    const slide = { x: 48, y: 120, width: 960, height: 540 };
    const box = promptBox(slide, { width: 1056, height: 800 });
    expect(within(box, slide)).toBe(true);
    expect(box).toEqual({ x: 60, y: 132, width: 936, height: 516 });
  });

  it("grows around a small slide's center and stays inside a narrow canvas", () => {
    const viewport = { width: 300, height: 700 };
    const slide = { x: 10, y: 300, width: 280, height: 158 };
    const box = promptBox(slide, viewport);
    expect(box.width).toBe(264);
    expect(box.height).toBe(168);
    expect(within(box, { x: 0, y: 0, ...viewport })).toBe(true);
    // Centered on the slide.
    expect(box.x + box.width / 2).toBeCloseTo(slide.x + slide.width / 2, 0);
    expect(box.y + box.height / 2).toBeCloseTo(slide.y + slide.height / 2, 0);
  });

  it("never exceeds a canvas narrower than its minimum", () => {
    const box = promptBox({ x: 0, y: 0, width: 160, height: 90 }, { width: 160, height: 600 });
    expect(box.x).toBe(12);
    expect(box.width).toBe(136);
  });

  it("uses the visible part of a slide panned partly off screen", () => {
    const box = promptBox(
      { x: -400, y: -100, width: 1200, height: 675 },
      { width: 600, height: 500 },
    );
    expect(box).toEqual({ x: 12, y: 12, width: 576, height: 476 });
  });
});
