// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { assemble } from "./assemble.ts";
import { sourceText } from "./common.ts";
import { discoverCssClasses } from "./discoverComponents.ts";
import { collectCss } from "./extractCss.ts";
import { collectDtcg, modeFromFileName } from "./extractDtcg.ts";
import { collectTsTheme, loadTypeScript } from "./extractTsTheme.ts";
import { collectWeave, crossCheckWeave, weaveCopyDrift } from "./extractWeave.ts";

const fixture = (name: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, "fixtures", name), "utf8");
const weaveJson = () =>
  sourceText("design/weave/tokens.json", fixture("weave/tokens.json.fixture"));
const weaveCss = () => sourceText("design/weave/weave.css", fixture("weave/weave.css.fixture"));
const lineOf = (text: string, needle: string) =>
  text.slice(0, text.indexOf(needle)).split("\n").length;

const APP_CSS = `@custom-variant dark (&:is(.dark, .dark *));
:root {
  --radius: 0.625rem;
  --ink: #111111;
  --surface: var(--ink);
  --card: color-mix(in srgb, var(--surface) 20%, transparent);
  --loop-a: var(--loop-b);
  --loop-b: var(--loop-a);
  --runtime: var(--app-theme-canvas);

  @variant dark {
    --ink: #eeeeee;
  }
}
@theme inline {
  --font-sans: "Inter", system-ui, sans-serif;
  --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
  --color-*: initial;
}
html[data-theme="ocean"] {
  --ink: #003366;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ink: #eeeeef;
  }
}
@media (min-width: 640px) {
  :root { --radius: 1rem; }
}
.card { --card-pad: 12px; }
`;

describe("collectCss", () => {
  it("reads modes, keeps raw next to resolved and records provenance", () => {
    const source = sourceText("apps/web/src/index.css", APP_CSS);
    const extraction = assemble([collectCss(source)]);
    expect(extraction.modes.map((mode) => mode.id)).toEqual(["light", "dark", "ocean"]);
    const ink = extraction.tokens.find((token) => token.name === "ink")!;
    expect(ink.values.light).toMatchObject({ raw: "#111111", resolved: "#111111" });
    expect(ink.values.dark).toMatchObject({ raw: "#eeeeee", resolved: "#eeeeee" });
    expect(ink.values.ocean?.raw).toBe("#003366");
    expect(ink.values.light!.provenance).toEqual({
      source: "file",
      location: "apps/web/src/index.css",
      line: 4,
      column: 3,
      context: ":root",
      sha256: source.sha256,
      extractor: "css@1",
    });
    expect(ink.values.dark!.provenance.context).toBe(":root @variant dark");
    expect(ink.type).toBe("color");
    expect(ink.group).toBe("color");
  });

  it("resolves var() within the mode and derives values for dependants", () => {
    const extraction = assemble([collectCss(sourceText("a.css", APP_CSS))]);
    const surface = extraction.tokens.find((token) => token.name === "surface")!;
    expect(surface.aliasOf).toBe("ink");
    expect(surface.values.light).toMatchObject({ raw: "var(--ink)", resolved: "#111111" });
    // Declared only in :root, but its dependency changes in dark.
    expect(surface.values.dark).toMatchObject({ raw: "var(--ink)", resolved: "#eeeeee" });
    expect(surface.values.dark!.provenance.line).toBe(5);
    const card = extraction.tokens.find((token) => token.name === "card")!;
    expect(card.values.ocean?.resolved).toBe("color-mix(in srgb, #003366 20%, transparent)");
    const runtime = extraction.tokens.find((token) => token.name === "runtime")!;
    expect(runtime.values.light?.resolved).toBeNull();
  });

  it("reports cycles once instead of looping", () => {
    const extraction = assemble([collectCss(sourceText("a.css", APP_CSS))]);
    const loop = extraction.tokens.find((token) => token.name === "loop-a")!;
    expect(loop.values.light?.resolved).toBeNull();
    const cycles = extraction.findings.filter((finding) => finding.code === "cycle");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.message).toContain("--loop-a");
  });

  it("does not call a Tailwind @theme self re-export a reference cycle", () => {
    const css = [
      ":root { --color-ground: #fafafa; }",
      ".dark { --color-ground: #111111; }",
      "@theme { --color-ground: var(--color-ground); }",
    ].join("\n");
    const extraction = assemble([collectCss(sourceText("entry.css", css))]);
    expect(extraction.findings.filter((finding) => finding.code === "cycle")).toEqual([]);
    expect(extraction.tokens.some((token) => token.name === "color-ground")).toBe(true);
  });

  it("compares the prefers-color-scheme fallback with the explicit dark rule", () => {
    const extraction = assemble([collectCss(sourceText("a.css", APP_CSS))]);
    const mismatch = extraction.findings.find((finding) => finding.code === "mismatch");
    expect(mismatch?.message).toContain("--ink");
    expect(mismatch?.line).toBe(lineOf(APP_CSS, "--ink: #eeeeef"));
  });

  it("treats a bare theme attribute as every theme and other attributes as sub-trees", () => {
    const css = [
      ":root, [data-theme] { --ink: #111; }",
      'html[data-theme-id]:not([data-theme-id=""]) { --ink: var(--app-theme-ink); }',
      "[data-app-sidebar] { --ink: #222; }",
      '[data-density="compact"] { --gap: 4px; }',
      '[data-theme="dark"] { --ink: #eee; }',
    ].join("\n");
    const extraction = assemble([collectCss(sourceText("a.css", css))]);
    expect(extraction.modes.map((mode) => mode.id)).toEqual(["light", "dark"]);
    const ink = extraction.tokens.find((token) => token.name === "ink")!;
    // The later rule for every theme wins, as in the cascade.
    expect(ink.values.light?.raw).toBe("var(--app-theme-ink)");
    expect(extraction.tokens.map((token) => token.name)).toEqual(["ink"]);
    expect(extraction.findings.find((finding) => finding.code === "skipped")?.message).toContain(
      "[data-app-sidebar]",
    );
  });

  it("skips component-local and responsive properties and Tailwind resets", () => {
    const extraction = assemble([collectCss(sourceText("a.css", APP_CSS))]);
    const names = extraction.tokens.map((token) => token.name);
    expect(names).not.toContain("card-pad");
    expect(names.some((name) => name.includes("*"))).toBe(false);
    expect(extraction.tokens.find((token) => token.name === "radius")!.values.light!.raw).toBe(
      "0.625rem",
    );
    expect(extraction.findings.filter((finding) => finding.code === "skipped")).toHaveLength(2);
    expect(extraction.tokens.find((token) => token.name === "font-sans")!.type).toBe("fontFamily");
    expect(extraction.tokens.find((token) => token.name === "ease-drawer")!.type).toBe("easing");
  });

  it("is deterministic: the same bytes give byte-identical output", () => {
    const once = JSON.stringify(assemble([collectCss(sourceText("a.css", APP_CSS))]));
    const twice = JSON.stringify(assemble([collectCss(sourceText("a.css", APP_CSS))]));
    expect(twice).toBe(once);
  });
});

describe("Weave", () => {
  it("imports 18 colors in light and dark with type, spacing, radius, shadow and motion", () => {
    const extraction = assemble([collectWeave(weaveJson())]);
    expect(extraction.modes).toEqual([
      { id: "light", name: "Light" },
      { id: "dark", name: "Dark" },
    ]);
    const colors = extraction.tokens.filter((token) => token.type === "color");
    expect(colors).toHaveLength(18);
    for (const color of colors) expect(Object.keys(color.values)).toEqual(["dark", "light"]);
    const groups = new Set(extraction.tokens.map((token) => token.group));
    for (const group of ["color", "type", "spacing", "radius", "shadow", "layout", "motion"]) {
      expect(groups).toContain(group);
    }
    const canvas = extraction.tokens.find((token) => token.name === "wv-canvas")!;
    expect(canvas.values.light!.provenance.line).toBe(11);
    expect(canvas.values.dark!.raw).toBe("#16131d");
    expect(canvas.description).toContain("Page ground");
    const h1 = extraction.tokens.find((token) => token.name === "wv-h1")!;
    expect(h1.type).toBe("typography");
    expect(h1.values.light!.resolved).toContain("Schibsted Grotesk");
    expect(
      extraction.tokens.find((token) => token.name === "wv-radius-lg")!.values.light!.provenance
        .line,
    ).toBe(86);
  });

  it("lists the 11 .wv-* component class families with modifiers as variants", () => {
    const { components } = discoverCssClasses(weaveCss(), "wv-");
    expect(components.map((component) => component.importPath)).toEqual([
      ".wv-btn",
      ".wv-chip",
      ".wv-cmd",
      ".wv-code",
      ".wv-evidence",
      ".wv-family",
      ".wv-link",
      ".wv-note",
      ".wv-root",
      ".wv-thread",
      ".wv-window",
    ]);
    const button = components.find((component) => component.name === "btn")!;
    expect(button.variants).toEqual(["lg", "primary", "quiet", "secondary"]);
    expect(button.previewHtml).toContain('class="wv-btn wv-btn--primary"');
    expect(button.provenance.line).toBe(lineOf(weaveCss().text, ".wv-btn {"));
  });

  it("finds no value mismatch between tokens.json and weave.css, and names JSON-only tokens", () => {
    const findings = crossCheckWeave(
      collectWeave(weaveJson()),
      collectCss(weaveCss()),
      "design/weave/weave.css",
    );
    expect(findings.filter((finding) => finding.code === "mismatch")).toEqual([]);
    expect(findings.find((finding) => finding.code === "only-in-json")?.message).toContain("wv-h1");
  });

  it("reports drift in a copy, such as a token only that copy declares", () => {
    const canonical = weaveCss();
    const drifted = canonical.text
      .replace(
        "  --wv-brand-tile: #5b6cff;\n",
        "  --wv-brand-tile: #5b6cff;\n  --wv-scrim: rgba(36,21,35,0.4);\n",
      )
      .replace(/(\.wv-cmd code \{[^}]*?)white-space: pre;/, "$1white-space: pre-wrap;");
    const copy = sourceText("src/app/weave.css", drifted);
    const findings = weaveCopyDrift(canonical, copy);
    expect(findings.find((finding) => finding.message.includes("--wv-scrim"))).toMatchObject({
      code: "drift",
      severity: "warning",
      location: "src/app/weave.css",
      line: lineOf(drifted, "--wv-scrim"),
    });
    expect(findings.some((finding) => finding.message.includes("Rule .wv-cmd code differs"))).toBe(
      true,
    );
    expect(
      weaveCopyDrift(canonical, sourceText("docs-site/src/css/weave.css", canonical.text)),
    ).toEqual([]);
  });
});

describe("collectDtcg", () => {
  const primitives = `{
  "color": {
    "$type": "color",
    "brand": { "$value": "#5b6cff", "$description": "Brand" },
    "ink": { "$value": { "colorSpace": "srgb", "components": [0, 0, 0], "hex": "#000000" } }
  },
  "space": { "$type": "dimension", "sm": { "$value": { "value": 8, "unit": "px" } } }
}`;
  const semantic = (accent: string) => `{
  "accent": { "$type": "color", "$value": "{color.${accent}}" }
}`;

  it("names modes and collections from Figma export file names", () => {
    expect(modeFromFileName("Primitives.Light.tokens.json")).toEqual({
      collection: "Primitives",
      mode: "Light",
    });
    expect(modeFromFileName("Dark.tokens.json")).toEqual({ mode: "Dark" });
    expect(modeFromFileName("tokens.json")).toEqual({});
  });

  it("maps a Figma variables export to tokens with figma-export provenance", () => {
    const light = sourceText("Primitives.Light.tokens.json", primitives);
    const dark = sourceText(
      "Primitives.Dark.tokens.json",
      primitives.replace("#5b6cff", "#8a96ff"),
    );
    const extraction = assemble([
      collectDtcg(light, { origin: "figma-export" }),
      collectDtcg(dark, { origin: "figma-export" }),
      collectDtcg(sourceText("Semantic.Light.tokens.json", semantic("brand")), {
        origin: "figma-export",
      }),
      collectDtcg(sourceText("Semantic.Dark.tokens.json", semantic("brand")), {
        origin: "figma-export",
      }),
    ]);
    expect(extraction.modes.map((mode) => mode.id)).toEqual(["light", "dark"]);
    const brand = extraction.tokens.find((token) => token.name === "color-brand")!;
    expect(brand.group).toBe("primitives");
    expect(brand.description).toBe("Brand");
    expect(brand.values.light!.provenance).toMatchObject({
      source: "figma-export",
      location: "Primitives.Light.tokens.json#color/brand",
      line: 4,
    });
    expect(brand.values.dark!.raw).toBe("#8a96ff");
    const accent = extraction.tokens.find((token) => token.name === "accent")!;
    expect(accent.aliasOf).toBe("color-brand");
    expect(accent.values.dark).toMatchObject({ raw: "{color.brand}", resolved: "#8a96ff" });
    expect(extraction.tokens.find((token) => token.name === "space-sm")!.values.light!.raw).toBe(
      "8px",
    );
    expect(extraction.tokens.find((token) => token.name === "color-ink")!.values.light!.raw).toBe(
      "#000000",
    );
  });

  it("builds one mode per Tokens Studio theme from its enabled sets", () => {
    const text = JSON.stringify(
      {
        global: { blue: { value: "#0000ff", type: "color" } },
        light: { bg: { value: "#ffffff", type: "color" } },
        dark: { bg: { value: "{blue}", type: "color" } },
        $themes: [
          { name: "Light", selectedTokenSets: { global: "source", light: "enabled" } },
          { name: "Dark", selectedTokenSets: { global: "source", dark: "enabled" } },
        ],
        $metadata: { tokenSetOrder: ["global", "light", "dark"] },
      },
      null,
      2,
    );
    const extraction = assemble([collectDtcg(sourceText("tokens.json", text))]);
    expect(extraction.modes.map((mode) => mode.id)).toEqual(["light", "dark"]);
    const bg = extraction.tokens.find((token) => token.name === "bg")!;
    expect(bg.values.light!.resolved).toBe("#ffffff");
    expect(bg.values.dark!.resolved).toBe("#0000ff");
  });
});

describe("collectTsTheme", () => {
  const THEME = `export const BASE_COLORS = { canvas: "#ffffff", text: "#111111", accent: "#5b6cff", border: "#dddddd", muted: "#777777" };
export const IRIS: ThemeDefinition = {
  id: "iris",
  appearance: "light",
  colors: { ...BASE_COLORS, accent: "oklch(0.52 0.15 294)" },
  variants: { dark: { canvas: "#16131d", text: "#f3eff9", accent: "#a88cf6", border: "#322c3e", muted: "#a69fb2" } },
} as const;
export const computed = { canvas: makeColor() };
`;

  it("reads literal theme objects as modes with line provenance", async () => {
    const ts = await loadTypeScript();
    const source = sourceText("theme.ts", THEME);
    const collected = collectTsTheme(ts, source, { prefix: "app-theme-" });
    expect(collected.modes.map((mode) => mode.id)).toEqual(["iris-light", "iris-dark", "base"]);
    const extraction = assemble([collected]);
    const accent = extraction.tokens.find((token) => token.name === "app-theme-accent")!;
    expect(accent.values["iris-light"]).toMatchObject({ raw: "oklch(0.52 0.15 294)" });
    expect(accent.values["iris-light"]!.provenance).toMatchObject({
      line: 5,
      context: "IRIS.colors.accent",
      extractor: "ts-theme@1",
    });
    expect(accent.values["iris-dark"]!.raw).toBe("#a88cf6");
    // A spread keeps the provenance of the constant it came from.
    expect(
      extraction.tokens.find((token) => token.name === "app-theme-canvas")!.values["iris-light"]!
        .provenance.line,
    ).toBe(1);
  });

  it("reads the app's themePalettes.ts: 12 palette modes with Iris at its own lines", async () => {
    const ts = await loadTypeScript();
    const path = NodePath.join(
      import.meta.dirname,
      "../../../../../packages/shared/src/themePalettes.ts",
    );
    const text = NodeFS.readFileSync(path, "utf8");
    const collected = collectTsTheme(ts, sourceText("packages/shared/src/themePalettes.ts", text), {
      prefix: "app-theme-",
    });
    expect(collected.modes).toHaveLength(12);
    expect(collected.modes.map((mode) => mode.id)).toContain("iris-light");
    const canvas = collected.tokens.find((token) => token.name === "app-theme-canvas")!;
    const irisLine = text.split("\n")[canvas.values["iris-light"]!.provenance.line! - 1]!;
    expect(irisLine).toContain('canvas: "oklch(');
    expect(lineOf(text, "export const IRIS_THEME")).toBeLessThan(
      canvas.values["iris-light"]!.provenance.line!,
    );
  });
});
