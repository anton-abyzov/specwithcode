import { describe, expect, it } from "vite-plus/test";

import { parseCssColor } from "./cssColor.ts";

/** Out-of-gamut colors are clipped, so allow a step of rounding per channel. */
const near = (actual: string | undefined, expected: string) => {
  const channels = (hex: string) => [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
  const a = channels(actual ?? "zzzzzz");
  channels(expected).forEach((value, index) =>
    expect(Math.abs(a[index]! - value)).toBeLessThanOrEqual(2),
  );
};

describe("parseCssColor", () => {
  it("reads hex, rgb, hsl and names as PowerPoint hex with transparency", () => {
    expect(parseCssColor("#fff")).toEqual({ hex: "FFFFFF", transparency: 0 });
    expect(parseCssColor("#12345680")).toEqual({ hex: "123456", transparency: 50 });
    expect(parseCssColor("rgb(234, 88, 12)")).toEqual({ hex: "EA580C", transparency: 0 });
    expect(parseCssColor("rgb(234 88 12 / 25%)")).toEqual({ hex: "EA580C", transparency: 75 });
    expect(parseCssColor("rgba(0,0,0,0.5)")).toEqual({ hex: "000000", transparency: 50 });
    expect(parseCssColor("hsl(210 100% 50%)")).toEqual({ hex: "0080FF", transparency: 0 });
    expect(parseCssColor("White")).toEqual({ hex: "FFFFFF", transparency: 0 });
    expect(parseCssColor("transparent")).toEqual({ hex: "000000", transparency: 100 });
  });

  it("converts oklch and oklab to sRGB", () => {
    // Tailwind's slate-900 and orange-600 in oklch.
    near(parseCssColor("oklch(0.208 0.042 265.755)")?.hex, "0F172B");
    near(parseCssColor("oklch(64.6% 0.222 41.116)")?.hex, "F54A00");
    expect(parseCssColor("oklab(1 0 0)")?.hex).toBe("FFFFFF");
  });

  it("refuses what PowerPoint cannot hold as one color", () => {
    for (const value of [
      "linear-gradient(red, blue)",
      "var(--ink)",
      "color-mix(in srgb, red, blue)",
      "#12",
      "rgb(1 2)",
      "notacolor",
    ]) {
      expect(parseCssColor(value), value).toBeNull();
    }
    expect(parseCssColor(undefined)).toBeNull();
  });
});
