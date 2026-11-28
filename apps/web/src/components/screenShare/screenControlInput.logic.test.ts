import { SCREEN_SHARE_INPUT_MAX_EVENTS } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ControlInput,
  isControlKey,
  pointerButton,
  pointerFraction,
  wheelPixels,
} from "./screenControlInput.logic";

describe("control input on the viewer (1519)", () => {
  it("places the pointer as fractions of the picture", () => {
    const rect = { left: 100, top: 50, width: 800, height: 500 };
    expect(pointerFraction(500, 300, rect)).toEqual({ x: 0.5, y: 0.5 });
    expect(pointerFraction(0, 9_000, rect)).toEqual({ x: -0.05, y: 1.05 });
    expect(pointerFraction(1, 1, { left: 0, top: 0, width: 0, height: 10 })).toBeNull();
  });

  it("names buttons and turns wheel lines and pages into pixels", () => {
    expect([0, 1, 2, 3].map(pointerButton)).toEqual(["left", "middle", "right", null]);
    expect(wheelPixels(3, 1)).toBe(48);
    expect(wheelPixels(-1, 2)).toBe(-800);
    expect(wheelPixels(1e9, 0)).toBe(10_000);
    expect(wheelPixels(Number.NaN, 0)).toBe(0);
  });

  it("sends only keys the machine knows", () => {
    expect(isControlKey("KeyA")).toBe(true);
    expect(isControlKey("MediaPlayPause")).toBe(false);
  });

  it("folds moves together, keeps order, and lets go of everything held", () => {
    const input = new ControlInput();
    input.push({ t: "move", x: 0.1, y: 0.1 });
    input.push({ t: "move", x: 0.2, y: 0.2 });
    input.push({ t: "button", button: "left", down: true, x: 0.2, y: 0.2 });
    input.push({ t: "key", code: "ShiftLeft", down: true });
    input.push({ t: "key", code: "KeyZ", down: false });
    input.push({ t: "key", code: "Fn", down: true });
    expect(input.take()).toEqual([
      { t: "move", x: 0.2, y: 0.2 },
      { t: "button", button: "left", down: true, x: 0.2, y: 0.2 },
      { t: "key", code: "ShiftLeft", down: true },
    ]);
    expect(input.held).toBe(true);
    input.releaseAll();
    expect(input.take()).toEqual([
      { t: "key", code: "ShiftLeft", down: false },
      { t: "button", button: "left", down: false, x: 0.2, y: 0.2 },
    ]);
    expect(input.held).toBe(false);
  });

  it("splits a long burst across records", () => {
    const input = new ControlInput();
    for (let index = 0; index < SCREEN_SHARE_INPUT_MAX_EVENTS + 5; index += 1)
      input.push({ t: "scroll", dx: 0, dy: 1, x: 0, y: 0 });
    expect(input.take()).toHaveLength(SCREEN_SHARE_INPUT_MAX_EVENTS);
    expect(input.take()).toHaveLength(5);
  });
});
