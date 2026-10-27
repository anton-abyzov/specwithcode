import { describe, expect, it } from "vite-plus/test";

import { TEST_SYSTEM, testToken } from "./testSystem";
import {
  aliasTarget,
  colorLabel,
  colorProblem,
  familyLabel,
  formatColor,
  formatTypeStyle,
  inferValueType,
  lengthProblem,
  measureColor,
  lineHeightProblem,
  modeValue,
  parseColor,
  parseTypeStyle,
  plainValueProblem,
  resolveFamily,
  shadowProblem,
  shadowStage,
  sizeProblem,
  tokenNameProblem,
  tokensCss,
  trackingOf,
  trackingProblem,
  withTracking,
} from "./tokenValues";

describe("token names", () => {
  it("explains what is wrong", () => {
    expect(tokenNameProblem(" ", [])).toBe("A token needs a name.");
    expect(tokenNameProblem("brand 500", [])).toBe(
      "“brand 500” is not a token name — letters, digits, . _ and - only.",
    );
    expect(tokenNameProblem("space-1", ["space-1"])).toBe("“space-1” already exists.");
    expect(tokenNameProblem("space-1", ["space-1"], "space-1")).toBeNull();
    expect(tokenNameProblem("brand.500_a-b", [])).toBeNull();
  });
});

describe("colors", () => {
  it("reads hex and rgb with alpha", () => {
    expect(parseColor("#0f141e")).toEqual({ r: 15, g: 20, b: 30, a: 1 });
    expect(parseColor("#fff8")).toEqual({ r: 255, g: 255, b: 255, a: 0.53 });
    expect(parseColor("rgba(15, 20, 30, 0.52)")).toEqual({ r: 15, g: 20, b: 30, a: 0.52 });
    expect(parseColor("rgb(15 20 30 / 72%)")).toEqual({ r: 15, g: 20, b: 30, a: 0.72 });
    expect(parseColor("oklch(0.7 0.1 200)")).toBeNull();
  });

  it("measures oklch() and hsl() as sRGB, leaving parseColor to hex and rgb()", () => {
    expect(measureColor("#0f141e")).toEqual({ r: 15, g: 20, b: 30, a: 1 });
    expect(measureColor("oklch(1 0 0)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(measureColor("hsl(0 100% 50% / 50%)")).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
    expect(measureColor("{color.brand}")).toBeNull();
  });

  it("shows hex with alpha and stores CSS", () => {
    expect(colorLabel("rgba(15, 20, 30, 0.52)")).toEqual({ text: "#0F141E", alpha: "52%" });
    expect(colorLabel("#595ecc")).toEqual({ text: "#595ECC", alpha: null });
    expect(colorLabel("oklch(0.7 0.1 200)")).toEqual({ text: "oklch(0.7 0.1 200)", alpha: null });
    expect(formatColor({ r: 15, g: 20, b: 30, a: 0.52 })).toBe("rgba(15, 20, 30, 0.52)");
    expect(formatColor({ r: 89, g: 94, b: 204, a: 1 })).toBe("#595ecc");
  });

  it("checks colors and aliases", () => {
    const colors = ["color-brand", "color-ink"];
    expect(colorProblem("", "x", colors)).toBe("A color is needed.");
    expect(colorProblem("blueish", "x", colors)).toBe(
      "Not a color — try #rrggbb, rgb(), oklch() or {token}.",
    );
    expect(colorProblem("url(x)", "x", colors)).not.toBeNull();
    expect(colorProblem("{color-ink}", "color-ink", colors)).toBe("A token cannot alias itself.");
    expect(colorProblem("{space-1}", "x", colors)).toBe("space-1 names no color token.");
    expect(colorProblem("var(--color-brand)", "x", colors)).toBeNull();
    expect(colorProblem("oklch(0.7 0.1 200 / 50%)", "x", colors)).toBeNull();
    expect(aliasTarget("{a.b}")).toBe("a.b");
    expect(aliasTarget("var( --x )")).toBe("x");
    expect(aliasTarget("#fff")).toBeNull();
  });

  it("inherits the first mode's value when a later mode has none", () => {
    const scrim = TEST_SYSTEM.tokens.find((token) => token.name === "color-scrim")!;
    expect(modeValue(scrim, TEST_SYSTEM.modes, "dark")).toMatchObject({
      raw: "rgba(15, 20, 30, 0.52)",
      inherited: true,
    });
    expect(modeValue(scrim, TEST_SYSTEM.modes, "light")).toMatchObject({ inherited: false });
  });
});

describe("other values", () => {
  it("checks lengths, shadows and plain values", () => {
    expect(lengthProblem("8px")).toBeNull();
    expect(lengthProblem("0")).toBeNull();
    expect(lengthProblem("{space-1}")).toBeNull();
    expect(lengthProblem("-4px")).toBe("Not a length — try 8px or 0.5rem.");
    expect(lengthProblem("wide")).toBe("Not a length — try 8px or 0.5rem.");
    expect(shadowProblem("")).toBe("A box-shadow is needed.");
    expect(shadowProblem("0 1px 2px rgba(0,0,0,.2)")).toBeNull();
    expect(shadowProblem("inset 0 0 0 1px #000, 0 8px 20px rgba(0, 0, 0, 0.55)")).toBeNull();
    expect(shadowProblem("big")).toBe("Not a box-shadow — try 0 1px 2px rgba(0,0,0,.2).");
    expect(plainValueProblem("cubic-bezier(0.2, 0, 0, 1)")).toBeNull();
    expect(plainValueProblem("1; color: red")).toBe("Not a plain CSS value.");
    expect(inferValueType("120ms")).toBe("duration");
    expect(inferValueType("cubic-bezier(0.2, 0, 0, 1)")).toBe("easing");
    expect(inferValueType("40rem")).toBe("dimension");
    expect(inferValueType("30")).toBe("number");
  });
});

describe("typography", () => {
  it("reads and writes the font shorthand", () => {
    const style = parseTypeStyle("600 11px/1.35 var(--font-sans)");
    expect(style).toEqual({
      italic: false,
      weight: 600,
      size: "11px",
      lineHeight: "1.35",
      family: "var(--font-sans)",
    });
    expect(formatTypeStyle({ ...style!, weight: 700, size: "12px" })).toBe(
      "700 12px/1.35 var(--font-sans)",
    );
    expect(parseTypeStyle("italic bold 1rem Georgia, serif")).toMatchObject({
      italic: true,
      weight: 700,
      size: "1rem",
      lineHeight: null,
    });
    expect(parseTypeStyle("Inter")).toBeNull();
  });

  it("resolves the family through tokens and names it", () => {
    const family = resolveFamily("var(--font-sans)", TEST_SYSTEM.tokens);
    expect(family).toBe('"Inter Variable", system-ui, sans-serif');
    expect(familyLabel(family)).toBe("Inter Variable");
  });

  it("checks sizes, line heights and tracking", () => {
    expect(sizeProblem("16")).toBeNull();
    expect(sizeProblem("1rem")).toBeNull();
    expect(sizeProblem("big")).toBe("Not a size — try 16 or 1rem.");
    expect(lineHeightProblem("1.5")).toBeNull();
    expect(lineHeightProblem("tall")).toBe("Not a line height — try 1.5 or 24px.");
    expect(trackingProblem("-0.01em")).toBeNull();
    expect(trackingProblem("wide")).toBe("Not a length — try 0.2px or -0.01em.");
  });

  it("keeps letter spacing in the usage note", () => {
    expect(trackingOf("The only uppercase label. Letter spacing 0.06em.")).toBe("0.06em");
    expect(withTracking("The only uppercase label. Letter spacing 0.06em.", "0.08em")).toBe(
      "The only uppercase label. Letter spacing 0.08em.",
    );
    expect(withTracking("Letter spacing 0.06em.", null)).toBe("");
    expect(withTracking(undefined, "0.1em")).toBe("Letter spacing 0.1em.");
  });
});

describe("shadow stages and preview CSS", () => {
  it("finds the ground and card colors by name, with fallbacks", () => {
    expect(shadowStage(TEST_SYSTEM, { id: "light", name: "Light" })).toEqual({
      ground: "#fafafa",
      surface: "#ffffff",
    });
    expect(shadowStage(TEST_SYSTEM, { id: "dark", name: "Dark" })).toEqual({
      ground: "#12161c",
      surface: "#1a1f27",
    });
    expect(
      shadowStage(
        { tokens: [], modes: [{ id: "night", name: "Night" }] },
        { id: "night", name: "Night" },
      ),
    ).toEqual({ ground: "#1f1e1d", surface: "#30302e" });
  });

  it("writes token variables for a mode and skips unsafe values", () => {
    const css = tokensCss(
      {
        modes: TEST_SYSTEM.modes,
        tokens: [
          testToken("color-brand", "color", "color", "#595ecc", "#7d84ff"),
          testToken("bad", "other", undefined, "red; } body { color: blue"),
          testToken("color-link", "color", "color", "{color-brand}"),
        ],
      },
      "dark",
    );
    expect(css).toBe(":root{--color-brand:#7d84ff;--color-link:var(--color-brand)}");
  });
});
