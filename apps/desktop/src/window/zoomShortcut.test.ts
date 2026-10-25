import { describe, expect, it } from "vite-plus/test";
import { isAppZoomShortcut } from "./zoomShortcut.ts";

describe("native app zoom chords", () => {
  it.each(["darwin", "win32", "linux"] as const)("matches only zoom on %s", (platform) => {
    const input = (key: string, overrides: Partial<Electron.Input> = {}) =>
      ({
        type: "keyDown",
        key,
        meta: platform === "darwin",
        control: platform !== "darwin",
        shift: false,
        alt: false,
        ...overrides,
      }) as Electron.Input;
    for (const key of ["=", "+", "-", "0"]) {
      expect(isAppZoomShortcut(input(key), platform)).toBe(true);
      for (const overrides of [
        { alt: true },
        { meta: true, control: true },
        { meta: false, control: false },
        { type: "keyUp" as const },
        { isComposing: true },
      ]) {
        expect(isAppZoomShortcut(input(key, overrides), platform)).toBe(false);
      }
    }
    expect(isAppZoomShortcut(input("+", { shift: true }), platform)).toBe(true);
    expect(isAppZoomShortcut(input("=", { shift: true, code: "Equal" }), platform)).toBe(true);
    expect(isAppZoomShortcut(input("=", { shift: true, alt: true, code: "Equal" }), platform)).toBe(
      false,
    );
    for (const key of ["=", "-", "0", "_", ")", "k", "w", "r", "c"]) {
      expect(isAppZoomShortcut(input(key, { shift: true }), platform)).toBe(false);
    }
    for (const key of ["w", "r", "c", "a"]) {
      expect(isAppZoomShortcut(input(key), platform)).toBe(false);
    }
  });
});
