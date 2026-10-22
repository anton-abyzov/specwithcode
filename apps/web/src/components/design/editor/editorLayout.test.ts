import { describe, expect, it } from "vite-plus/test";
import { COMFORTABLE_CANVAS_WIDTH, editorLayout, MIN_CANVAS_WIDTH } from "./editorLayout";

// The app sidebar takes 256 px of the window; the editor gets the rest.
const SIDEBAR = 256;
const slides = (window: number, chatOpen = true) =>
  editorLayout({ width: window - SIDEBAR, chatWidth: 400, chatOpen, slides: true });

describe("editorLayout", () => {
  it("keeps everything beside a wide canvas", () => {
    expect(slides(1920)).toMatchObject({
      chat: "column",
      chatWidth: 400,
      rail: "full",
      side: "column",
    });
  });

  it("narrows the thread before anything else at 1600 px", () => {
    const layout = slides(1600);
    expect(layout).toMatchObject({ chat: "column", rail: "full", side: "column" });
    expect(layout.chatWidth).toBeLessThan(400);
    expect(layout.canvasWidth).toBeGreaterThanOrEqual(COMFORTABLE_CANVAS_WIDTH);
  });

  it.each([
    [1280, { chat: "overlay", rail: "compact", side: "column" }],
    [1024, { chat: "overlay", rail: "compact", side: "overlay" }],
  ])("gives the canvas room for a 25%% slide at %i px", (window, expected) => {
    const layout = slides(window);
    expect(layout).toMatchObject(expected);
    expect(layout.canvasWidth).toBeGreaterThanOrEqual(COMFORTABLE_CANVAS_WIDTH);
    // Zoom to fit pads 48 px a side.
    expect((layout.canvasWidth - 96) / 1920).toBeGreaterThanOrEqual(0.25);
  });

  it("keeps the canvas at its minimum when a comfortable fit is impossible", () => {
    const layout = editorLayout({ width: 600, chatWidth: 400, chatOpen: true, slides: true });
    expect(layout).toMatchObject({ chat: "overlay", rail: "compact", side: "overlay" });
    expect(layout.canvasWidth).toBeGreaterThanOrEqual(MIN_CANVAS_WIDTH);
    expect(layout.canvasWidth).toBeLessThan(COMFORTABLE_CANVAS_WIDTH);
  });

  it("a hidden thread stays hidden, and designs have no rail", () => {
    expect(slides(1024, false).chat).toBe("hidden");
    const design = editorLayout({ width: 1024, chatWidth: 400, chatOpen: true, slides: false });
    expect(design.rail).toBeNull();
    expect(design.canvasWidth).toBeGreaterThanOrEqual(MIN_CANVAS_WIDTH);
  });
});
