// The overlay guard's window filter, read the way the desktop's click target reads windows.

import { describe, expect, it } from "vite-plus/test";

import { overlaysOver } from "./iphone-mirroring-live.mjs";

// A laptop display with the Dock at the bottom, and a second display to its left.
const laptop = {
  frame: { x: 0, y: 0, width: 1512, height: 982 },
  visible: { x: 0, y: 34, width: 1512, height: 894 },
};
const left = {
  frame: { x: -1920, y: 0, width: 1920, height: 1080 },
  visible: { x: -1920, y: 25, width: 1920, height: 980 },
};
const dockOn = (screen) => ({ app: "Dock", name: "Dock", layer: 20, alpha: 1, ...screen.frame });
const mirroring = (x, y) => ({ x, y, width: 360, height: 770 });

describe("overlaysOver", () => {
  it("looks through the Dock's window while Mirroring stays inside the visible frame", () => {
    expect(overlaysOver(mirroring(600, 100), [dockOn(laptop)], [laptop, left])).toEqual([]);
  });

  it("reports the Dock's bottom strip where Mirroring reaches into it", () => {
    // Mirroring ends at y 970; the visible frame at 928.
    expect(overlaysOver(mirroring(600, 200), [dockOn(laptop)], [laptop, left])).toEqual([
      { app: "Dock", name: "Dock", layer: 20, x: 600, y: 928, width: 360, height: 42 },
    ]);
  });

  it("reports a Dock strip at the side of the display", () => {
    const dockLeft = {
      frame: laptop.frame,
      visible: { x: 70, y: 34, width: 1442, height: 948 },
    };
    expect(overlaysOver(mirroring(100, 100), [dockOn(dockLeft)], [dockLeft])).toEqual([]);
    expect(overlaysOver(mirroring(40, 100), [dockOn(dockLeft)], [dockLeft])).toEqual([
      { app: "Dock", name: "Dock", layer: 20, x: 40, y: 100, width: 30, height: 770 },
    ]);
  });

  it("reads a display with a nonzero origin by its own frames", () => {
    const screens = [laptop, left];
    expect(overlaysOver(mirroring(-1000, 200), [dockOn(left)], screens)).toEqual([]);
    expect(overlaysOver(mirroring(-1000, 300), [dockOn(left)], screens)).toEqual([
      { app: "Dock", name: "Dock", layer: 20, x: -1000, y: 1005, width: 360, height: 65 },
    ]);
  });

  it("matches the Dock's window to a display by origin as well as size", () => {
    // Same size as the laptop display, but nowhere a display is: the Dock's
    // window then takes clicks everywhere, as the desktop reads it.
    const stray = { ...dockOn(laptop), x: 200 };
    expect(overlaysOver(mirroring(600, 100), [stray], [laptop])).toEqual([
      { app: "Dock", name: "Dock", layer: 20, x: 200, y: 0, width: 1512, height: 982 },
    ]);
  });

  it("passes over see-through and Window Server windows but not the menu bar", () => {
    const at = { x: 500, y: 0, width: 600, height: 900 };
    const before = [
      { app: "Wispr Flow", name: "Hidden", layer: 1000, alpha: 0, ...at },
      { app: "Window Server", name: "Cursor", layer: 2000, alpha: 1, ...at },
      {
        app: "Window Server",
        name: "Menubar",
        layer: 24,
        alpha: 1,
        x: 0,
        y: 0,
        width: 1512,
        height: 34,
      },
      { app: "Notes", name: "Far", layer: 0, alpha: 1, x: 0, y: 0, width: 600, height: 100 },
    ];
    expect(overlaysOver({ x: 600, y: 20, width: 360, height: 770 }, before, [laptop])).toEqual([
      { app: "Window Server", name: "Menubar", layer: 24, x: 0, y: 0, width: 1512, height: 34 },
    ]);
  });

  it("reports a window that overlaps Mirroring, not one that only touches it", () => {
    const box = (x, y, width, height) => ({ alpha: 1, x, y, width, height });
    const wispr = { app: "Wispr Flow", name: "Status", layer: 1000, ...box(500, 180, 512, 614) };
    const touching = { app: "Notes", name: "Side", layer: 0, ...box(960, 100, 200, 200) };
    const { alpha: _alpha, ...reported } = wispr;
    expect(overlaysOver(mirroring(600, 100), [wispr, touching], [laptop])).toEqual([reported]);
    expect(overlaysOver(null, [wispr], [laptop])).toEqual([]);
  });
});
