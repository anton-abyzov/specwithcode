// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

import "culori/css";
import { converter, parse } from "culori/fn";
import { BUILT_IN_THEMES } from "@specweave-studio/shared/themePalettes";
import { describe, expect, it } from "vite-plus/test";

// A thread chip's text against its own tint, read from the shipped CSS so a
// token edit that drops a surface under WCAG AA fails here. Surfaces: the
// conversation background and a message bubble (the coordinator page's and the
// chat view's, which share --message-surface), at rest and on hover,
// in the default palette and in every built-in theme.

// Read from disk: the unit project stubs CSS imports, `?raw` included.
const read = (url: URL) => NodeFS.readFileSync(NodeURL.fileURLToPath(url), "utf8");
const shellCss = read(new URL("./shell.css", import.meta.url));
const indexCss = read(new URL("../../../index.css", import.meta.url));
const tailwindThemeCss = NodeFS.readFileSync(
  NodeModule.createRequire(import.meta.url).resolve("tailwindcss/theme.css"),
  "utf8",
);

type Rgba = { rgb: [number, number, number]; alpha: number };
type Vars = Record<string, string>;

const toRgb = converter("rgb");
const toOklab = converter("oklab");

/** The selectors of a selector list, split on top-level commas only. */
function selectorList(text: string): string[] {
  const list: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "," && depth === 0) {
      list.push(current);
      current = "";
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    current += char;
  }
  return [...list, current].map((selector) => selector.replace(/\s+/g, " ").trim());
}

/** The declarations of the top-level rule that lists `selector`, whitespace aside. */
function rule(css: string, selector: string): Vars {
  const wanted = selectorList(selector)[0];
  const match = Array.from(css.matchAll(/(?:^|\n)([^\s@}/][^{}]*)\{([^{}]*)\}/g)).find(
    (candidate) => selectorList(candidate[1]!).includes(wanted!),
  );
  if (!match) throw new Error(`No rule for ${selector}`);
  return Object.fromEntries(
    Array.from(match[2]!.matchAll(/^\s*([\w-]+):\s*([^;]+);/gm), (m) => [m[1]!, m[2]!]),
  );
}

/** Every value a custom property takes in a stylesheet, in source order. */
function values(css: string, name: string): string[] {
  return Array.from(css.matchAll(new RegExp(`${name}:\\s*([^;]+);`, "g")), (match) => match[1]!);
}

/** Splits on `separator` outside parentheses. */
function splitTop(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += char;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

function resolve(value: string, vars: Vars): string {
  const trimmed = value.trim();
  const reference = /^var\((--[\w-]+)\)$/.exec(trimmed);
  if (!reference) return trimmed;
  const next = vars[reference[1]!];
  if (next === undefined) throw new Error(`Unset ${reference[1]}`);
  return resolve(next, vars);
}

/** Evaluates hex, rgb(), oklch(), var() and color-mix() the way the browser does. */
function evaluate(value: string, vars: Vars): Rgba {
  const color = resolve(value, vars);
  if (color === "transparent") return { rgb: [0, 0, 0], alpha: 0 };
  const mix = /^color-mix\(in (srgb|oklab),(.*)\)$/s.exec(color);
  if (mix) {
    const [first, second] = splitTop(mix[2]!, ",").map((part) => {
      const words = splitTop(part, " ");
      const last = resolve(words.at(-1)!, vars);
      return last.endsWith("%")
        ? { color: words.slice(0, -1).join(" "), weight: Number.parseFloat(last) / 100 }
        : { color: part, weight: undefined };
    });
    const p = first!.weight ?? 1 - (second!.weight ?? 0.5);
    const a = evaluate(first!.color, vars);
    const b = evaluate(second!.color, vars);
    const alpha = a.alpha * p + b.alpha * (1 - p);
    if (mix[1] === "oklab") {
      const [la, lb] = [a, b].map((c) =>
        toOklab({ mode: "rgb", r: c.rgb[0], g: c.rgb[1], b: c.rgb[2] })!,
      );
      const mixed = toRgb({
        mode: "oklab",
        l: la!.l * p + lb!.l * (1 - p),
        a: la!.a * p + lb!.a * (1 - p),
        b: la!.b * p + lb!.b * (1 - p),
      });
      return { rgb: clamp([mixed.r, mixed.g, mixed.b]), alpha };
    }
    // srgb mixes premultiply, so a mix with transparent keeps the color and scales alpha.
    const rgb = [0, 1, 2].map((i) =>
      alpha === 0 ? 0 : (a.rgb[i]! * a.alpha * p + b.rgb[i]! * b.alpha * (1 - p)) / alpha,
    );
    return { rgb: rgb as Rgba["rgb"], alpha };
  }
  const parsed = toRgb(parse(color));
  if (!parsed) throw new Error(`Unparsed color ${color}`);
  return { rgb: clamp([parsed.r, parsed.g, parsed.b]), alpha: parsed.alpha ?? 1 };
}

function clamp(rgb: number[]): Rgba["rgb"] {
  return rgb.map((channel) => Math.min(1, Math.max(0, channel))) as Rgba["rgb"];
}

function over(top: Rgba, bottom: Rgba["rgb"]): Rgba["rgb"] {
  return [0, 1, 2].map(
    (i) => top.rgb[i]! * top.alpha + bottom[i]! * (1 - top.alpha),
  ) as Rgba["rgb"];
}

function contrast(first: Rgba["rgb"], second: Rgba["rgb"]): number {
  const luminance = (rgb: Rgba["rgb"]) =>
    rgb
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
  const [light, dark] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

const tailwindColors: Vars = Object.fromEntries(
  Array.from(tailwindThemeCss.matchAll(/(--color-[\w-]+):\s*([^;]+);/g), (m) => [m[1]!, m[2]!]),
);
// The app's light :root, then its dark variant.
const [infoLight, infoDark] = values(indexCss, "--info-foreground");
const chip = rule(shellCss, ".sws-thread-link");
const chipHover = rule(shellCss, ".sws-thread-link:hover");
const chipInBubble = rule(
  shellCss,
  ":is(.project-message-user, [data-message-bubble]) .sws-thread-link",
);
const chipInThemedDarkBubble = rule(
  shellCss,
  'html.dark[data-theme-id]:not([data-theme-id=""]) :is(.project-message-user, [data-message-bubble]) .sws-thread-link',
);

/** Each ratio a chip shows on one palette: page and bubble, rest and hover. */
function chipRatios(palette: Vars, themedDark: boolean): Record<string, number> {
  const page = { ...tailwindColors, ...palette, ...chip };
  const bubble = { ...page, ...chipInBubble, ...(themedDark ? chipInThemedDarkBubble : {}) };
  const background = evaluate("var(--background)", page).rgb;
  const bubbleSurface = over(evaluate("var(--message-surface)", page), background);
  const ratios: Record<string, number> = {};
  for (const [surfaceName, vars, surface] of [
    ["page", page, background],
    ["bubble", bubble, bubbleSurface],
  ] as const) {
    for (const [state, fill] of [
      ["rest", chip.background!],
      ["hover", chipHover.background!],
    ] as const) {
      const tinted = over(evaluate(fill, vars), surface);
      ratios[`${surfaceName} ${state}`] = contrast(
        over(evaluate(chip.color!, vars), tinted),
        tinted,
      );
    }
  }
  return ratios;
}

function expectReadable(ratios: Record<string, number>) {
  for (const [where, ratio] of Object.entries(ratios)) {
    expect(ratio, `${where} ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  }
}

describe("thread chip contrast", () => {
  const defaultLight = rule(shellCss, 'html[data-theme-id=""]');
  const defaultDark = { ...defaultLight, ...rule(shellCss, 'html.dark[data-theme-id=""]') };
  // The default palette leaves the bubble to the app's tokens.
  const appBubble = {
    "--message-surface": values(indexCss, "--message-surface")[0]!,
    "--message-foreground": values(indexCss, "--message-foreground")[0]!,
  };

  it("reads the chip's own color, not the bare link blue", () => {
    expect(chip.color).toBe("var(--sws-thread-link-ink)");
    expect(chip.background).toContain("--sws-thread-link-tint");
    expect(chipHover.background).toContain("--sws-thread-link-tint-hover");
  });

  it("keeps markdown link colors off thread chips, which render as links in chat", () => {
    // A `.chat-markdown a` color rule outranks `.sws-thread-link` and would undo the ink.
    const offenders = Array.from(
      indexCss.matchAll(/(?:^|\n)([^\s@}/][^{}]*)\{([^{}]*)\}/g),
      (match) => [selectorList(match[1]!), match[2]!] as const,
    ).flatMap(([selectors, body]) =>
      /(?:^|[\s;])color:/.test(body)
        ? selectors.filter(
            (selector) =>
              /\.chat-markdown a(?![\w-])/.test(selector) && !selector.includes(".sws-thread-link"),
          )
        : [],
    );
    expect(offenders).toEqual([]);
  });

  it("gives the chat view's message bubble the bubble ink", () => {
    const timeline = read(new URL("../../chat/MessagesTimeline.tsx", import.meta.url));
    const bubble = timeline.slice(timeline.indexOf("data-message-bubble"));
    expect(bubble.slice(0, bubble.indexOf(">"))).toContain("bg-message ");
  });

  it.each([
    ["light", defaultLight],
    ["dark", defaultDark],
  ])("keeps AA in the default %s palette", (_, palette) => {
    expectReadable(chipRatios({ ...palette, ...appBubble }, false));
  });

  const themed = BUILT_IN_THEMES.flatMap((theme) =>
    [
      [theme.appearance, theme.colors] as const,
      ...Object.entries(theme.variants ?? {}).map(([mode, colors]) => [mode, colors] as const),
    ].map(([mode, colors]) => [`${theme.id} ${mode}`, mode, colors!] as const),
  );

  it.each(themed)("keeps AA in the %s theme", (_, mode, colors) => {
    const palette: Vars = {
      "--background": colors.canvas,
      "--foreground": colors.text,
      "--message-surface": colors.messageSurface,
      "--message-foreground": colors.messageForeground,
      "--info-foreground": mode === "dark" ? infoDark! : infoLight!,
      "--shell-link": rule(shellCss, ":root")["--shell-link"]!,
    };
    expectReadable(chipRatios(palette, mode === "dark"));
  });
});
