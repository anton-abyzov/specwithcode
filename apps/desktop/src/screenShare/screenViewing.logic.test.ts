import { describe, expect, it } from "vite-plus/test";

import { ScreenViewingRegistry } from "./screenViewing.logic.ts";

const A = "token-aaaaaaaa";
const B = "token-bbbbbbbb";

describe("ScreenViewingRegistry", () => {
  it("keeps computer use paused until the last of two views in one window ends", () => {
    const registry = new ScreenViewingRegistry();
    expect(registry.begin(1, A, "m1").kind).toBe("ok");
    expect(registry.begin(1, B, "m3").kind).toBe("ok");
    registry.end(1, A);
    expect(registry.active()).toBe(true);
    registry.end(1, B);
    expect(registry.active()).toBe(false);
  });

  it("treats a repeated start or end of one view as one", () => {
    const registry = new ScreenViewingRegistry();
    registry.begin(1, A, "m1");
    expect(registry.begin(1, A, "m1").kind).toBe("ok");
    registry.end(1, A);
    registry.end(1, A);
    expect(registry.active()).toBe(false);
    expect(registry.begin(1, A, "m1").kind).toBe("ok");
    expect(registry.begin(1, A, "m3").kind).toBe("invalid");
  });

  it("refuses tokens and machine ids it cannot trust", () => {
    const registry = new ScreenViewingRegistry();
    expect(registry.begin(1, "short", "m1").kind).toBe("invalid");
    expect(registry.begin(1, A, "").kind).toBe("invalid");
    expect(registry.begin(1, A, "m1/../x y").kind).toBe("invalid");
    expect(registry.begin(1, 42, "m1").kind).toBe("invalid");
    expect(registry.active()).toBe(false);
  });

  it("sends a second view of the same machine to the window that shows it", () => {
    const registry = new ScreenViewingRegistry();
    registry.begin(1, A, "m1");
    expect(registry.begin(2, B, "m1")).toEqual({ kind: "elsewhere", owner: 1 });
    expect(registry.begin(1, B, "m1")).toEqual({ kind: "elsewhere", owner: 1 });
    expect(registry.begin(2, B, "m3").kind).toBe("ok");
  });

  it("drops a page's views when it reloads or crashes", () => {
    const registry = new ScreenViewingRegistry();
    registry.begin(1, A, "m1");
    registry.dropViews(1);
    expect(registry.active()).toBe(false);
    expect(registry.ownerOf("m1")).toBeUndefined();
  });

  it("counts a viewer window from creation to close whatever its page says", () => {
    const registry = new ScreenViewingRegistry();
    registry.holdWindow(7, "m1");
    expect(registry.active()).toBe(true);
    expect(registry.begin(7, A, "m1").kind).toBe("ok");
    registry.end(7, A);
    registry.dropViews(7);
    expect(registry.active()).toBe(true);
    expect(registry.begin(1, B, "m1")).toEqual({ kind: "elsewhere", owner: 7 });
    registry.release(7);
    expect(registry.active()).toBe(false);
  });
});
