import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { fontFiles } from "./FontFiles";
import {
  coverColors,
  coverNameSize,
  displayFamily,
  mosaicColumns,
  OverviewCover,
} from "./OverviewCover";
import { TEST_SYSTEM, testToken } from "./testSystem";

describe("the Overview cover", () => {
  it("draws the system's own colors, brand first, without near-white grounds", () => {
    const colors = coverColors(TEST_SYSTEM);
    expect(colors[0]).toBe("#595ECC");
    expect(colors).not.toContain("#FAFAFA");
    expect(colors.length).toBeLessThanOrEqual(8);
    expect(new Set(colors).size).toBe(colors.length);
    expect(coverColors({ ...TEST_SYSTEM, tokens: [] })).toEqual([]);
  });

  it("draws oklch() and hsl() colors as well as hex", () => {
    const tokens = [
      testToken("primary", "color", "color", "oklch(0.55 0.2 260)"),
      testToken("accent", "color", "color", "hsl(160 60% 35%)"),
      testToken("mix", "color", "color", "color-mix(in srgb, red, blue)"),
    ];
    const colors = coverColors({ tokens, modes: TEST_SYSTEM.modes });
    expect(colors).toHaveLength(2);
    for (const color of colors) expect(color).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("lays out one tile per column up to four colors, then pairs", () => {
    expect(mosaicColumns(["#1", "#2"])).toEqual([["#1"], ["#2"]]);
    expect(mosaicColumns(["#1", "#2", "#3", "#4", "#5"])).toEqual([
      ["#1", "#2"],
      ["#3", "#4"],
      ["#5"],
    ]);
  });

  it("sizes the name so its longest word fits its column, down to 1rem", () => {
    expect(coverNameSize("Acceptance Basics")).toBe(
      "max(1rem, min(clamp(1.25rem, 10cqi, 5.5rem), calc(100cqi / 6.20)))",
    );
    expect(coverNameSize("  Internationalization ")).toBe(
      "max(1rem, min(clamp(1.25rem, 10cqi, 5.5rem), calc(100cqi / 12.40)))",
    );
    expect(coverNameSize("")).toContain("calc(100cqi / 0.62)");
  });

  it("lays out on its own width from inside the cover container", () => {
    const html = renderToStaticMarkup(
      createElement(OverviewCover, { system: TEST_SYSTEM, headingId: "cover", children: null }),
    );
    // A container can't query itself: the element naming `cover` must not
    // carry the classes that ask about it.
    const own = /class="([^"]*@container\/cover[^"]*)"/.exec(html)?.[1] ?? "";
    expect(own).not.toBe("");
    expect(own).not.toMatch(/@[\w-]+\/cover:/);
    expect(html.indexOf("@2xl/cover:grid-cols")).toBeGreaterThan(html.indexOf("@container/cover"));
  });

  it("sets the name in the display style's family, or the app's face", () => {
    const tokens = [
      testToken("font-display", "fontFamily", "type", '"Fraunces", serif'),
      testToken("type-display", "typography", "type", "700 48px/1.1 var(--font-display)"),
    ];
    expect(displayFamily({ tokens, modes: TEST_SYSTEM.modes })).toBe('"Fraunces", serif');
    expect(displayFamily({ tokens: [], modes: TEST_SYSTEM.modes })).toBeNull();
  });
});

describe("font files", () => {
  it("lists stored and source fonts by path, nothing else", () => {
    const file = (path: string, origin: "stored" | "source" = "stored") => ({
      path,
      origin,
      bytes: 10,
      mimeType: "font/woff2",
    });
    expect(
      fontFiles([
        file("fonts/b.woff2"),
        file("assets/Brand/logo.svg"),
        file("fonts/a.TTF"),
        file("web/fonts/c.otf", "source"),
      ]).map((entry) => entry.path),
    ).toEqual(["fonts/a.TTF", "fonts/b.woff2", "web/fonts/c.otf"]);
  });
});
