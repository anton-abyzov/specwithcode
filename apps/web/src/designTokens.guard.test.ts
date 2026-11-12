// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * The web app has one set of design tokens (styles/base.css) and one page that
 * says how to use them (docs/studio/design-guidelines.md). This guard fails
 * when a stylesheet or a component goes around them: a typeface that is not
 * one of the three tokens, a font size or corner written as a raw number, a
 * weight outside 400, 500 and 600, or a raw palette color.
 */
const sourceRoot = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const TOKEN_SHEET = "styles/base.css";

/** Deliberate exceptions, each with the reason it is not on the scale. */
const FONT_SIZE_EXCEPTIONS: Readonly<Record<string, ReadonlyArray<string>>> = {
  // A document in its reader has its own measured scale, in rem.
  "index.css": ["1.375rem", "1.0625rem", "0.9375rem"],
  // Artifact thumbnails draw a page at a fraction of its size.
  "components/studio/shell/panes.css": ["5px", "5.5px", "7px", "8.5px", "9.5px"],
  // Mastheads that grow with the window.
  "components/studio/projectWorkspace.css": ["clamp(32px, 3.8vw, 54px)"],
  "components/studio/overview.css": ["clamp(30px, 3vw, 38px)"],
};
/** Components allowed an arbitrary text size: the design system cover is a document title. */
const ARBITRARY_TEXT_SIZE_EXCEPTIONS = new Set([
  "components/design/systems/workspace/SystemWorkspace.tsx",
]);
/** Serif is for documents: the report reader and the design system cover. */
const SERIF_CLASS_EXCEPTIONS = new Set(["components/design/systems/workspace/SystemWorkspace.tsx"]);
/** The project icon tints: a fixed palette people pick from, not status colors. */
const PALETTE_EXCEPTIONS = new Set(["projectIconColors.ts"]);
/** A design system's cover shows that system's own weight. */
const WEIGHT_CLASS_EXCEPTIONS = new Set(["components/design/systems/workspace/OverviewCover.tsx"]);

const FONT_FAMILY_ALLOWED = /^(?:var\(--font-(?:sans|mono|serif|composer)\)|inherit)$/;
const FONT_SIZE_ALLOWED =
  /^(?:var\(--[\w-]+(?:,\s*(?:inherit|var\(--text-[\w-]+\)))?\)|inherit|[\d.]+(?:em|%)|0)$/;
const FONT_WEIGHT_ALLOWED = /^(?:400|500|600|inherit|normal|var\(.+\))$/;
/** 5px to 14px, in px or rem, is the range the corner scale covers; smaller is detail, larger is a shape. */
const RAW_SCALE_RADIUS =
  /(?<![\w.-])(?:(?:[5-9]|1[0-4])(?:\.\d+)?px|0?\.(?:3[2-9]|[4-7]|8[0-7]?)\d*rem)(?![\w-])/;
const RAW_PALETTE_CLASS =
  /(?<![\w-])(?:[a-z0-9-]+:)*(?:text|bg|border|ring|fill|stroke|outline|from|via|to|decoration|divide)-(?:[a-z]-)?(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?![\w-])/g;
const OFF_SCALE_WEIGHT_CLASS =
  /(?<![\w-])font-(?:thin|extralight|light|bold|extrabold|black|\[\d+\])(?![\w-])/g;
const ARBITRARY_CORNER_CLASS = /(?<![\w-])rounded(?:-[a-z]{1,2})?-\[([\d.]+)(px|rem)\]/g;

function walk(directory: string, extension: RegExp, found: Array<string> = []): Array<string> {
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(path, extension, found);
    } else if (extension.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

function relative(path: string): string {
  return NodePath.relative(sourceRoot, path).split(NodePath.sep).join("/");
}

function declarations(
  css: string,
): Array<{ readonly line: number; readonly property: string; readonly value: string }> {
  // Comments become spaces so line numbers hold; a declaration may span lines,
  // share a line with its selector, or end at the brace without a semicolon.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const found: Array<{ line: number; property: string; value: string }> = [];
  for (const match of stripped.matchAll(
    /(?:^|[;{}])\s*([a-zA-Z-]+)\s*:\s*([^;{}]+?)\s*(?=[;}])/g,
  )) {
    if (!match[1] || !match[2]) continue;
    const start = match.index + match[0].indexOf(match[1]);
    found.push({
      line: stripped.slice(0, start).split("\n").length,
      property: match[1].toLowerCase(),
      value: match[2]
        .replace(/\s*!important$/i, "")
        .replace(/\s+/g, " ")
        .trim(),
    });
  }
  return found;
}

describe("design tokens", () => {
  const sheets = walk(sourceRoot, /\.css$/)
    .map((path) => ({ file: relative(path), css: NodeFS.readFileSync(path, "utf8") }))
    .filter((sheet) => sheet.file !== TOKEN_SHEET);
  const components = walk(sourceRoot, /\.tsx?$/)
    .filter((path) => !/\.test\.tsx?$/.test(path))
    .map((path) => ({ file: relative(path), source: NodeFS.readFileSync(path, "utf8") }));

  it("names a typeface only through --font-sans, --font-mono and --font-serif", () => {
    const offenders = sheets.flatMap((sheet) =>
      declarations(sheet.css)
        .filter((entry) => entry.property === "font-family")
        .filter((entry) => !FONT_FAMILY_ALLOWED.test(entry.value))
        .map((entry) => `${sheet.file}:${entry.line} font-family: ${entry.value}`),
    );
    expect(offenders).toEqual([]);
  });

  it("defines no serif stack outside the token sheet", () => {
    const offenders = sheets.flatMap((sheet) =>
      sheet.css
        .split("\n")
        .map((text, index) => ({ text, line: index + 1 }))
        .filter(({ text }) => /^\s*--[\w-]*serif[\w-]*:/.test(text))
        .map(({ text, line }) => `${sheet.file}:${line} ${text.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("takes every font size from the type scale", () => {
    const offenders = sheets.flatMap((sheet) =>
      declarations(sheet.css)
        .filter((entry) => entry.property === "font-size")
        .filter((entry) => !FONT_SIZE_ALLOWED.test(entry.value))
        .filter((entry) => !(FONT_SIZE_EXCEPTIONS[sheet.file] ?? []).includes(entry.value))
        .map((entry) => `${sheet.file}:${entry.line} font-size: ${entry.value}`),
    );
    expect(offenders).toEqual([]);
  });

  it("writes the font shorthand with a scale token or not at all", () => {
    const offenders = sheets.flatMap((sheet) =>
      declarations(sheet.css)
        .filter((entry) => entry.property === "font")
        .filter((entry) => {
          if (entry.value === "inherit") return false;
          const parts = /^(?:(\S+)\s+)?var\(--text-[\w-]+\)(?:\s*\/\s*\S+)?\s+(.+)$/.exec(
            entry.value,
          );
          return !(
            parts?.[2] &&
            (!parts[1] || FONT_WEIGHT_ALLOWED.test(parts[1])) &&
            FONT_FAMILY_ALLOWED.test(parts[2].trim())
          );
        })
        .map((entry) => `${sheet.file}:${entry.line} font: ${entry.value}`),
    );
    expect(offenders).toEqual([]);
  });

  it("uses three weights: 400, 500 and 600", () => {
    const offenders = sheets.flatMap((sheet) =>
      declarations(sheet.css)
        .filter((entry) => entry.property === "font-weight")
        .filter((entry) => !FONT_WEIGHT_ALLOWED.test(entry.value))
        .map((entry) => `${sheet.file}:${entry.line} font-weight: ${entry.value}`),
    );
    expect(offenders).toEqual([]);
  });

  it("takes control and card corners from the corner scale", () => {
    const offenders = sheets.flatMap((sheet) =>
      declarations(sheet.css)
        .filter((entry) => /^border(?:-[a-z]+)*-radius$/.test(entry.property))
        .filter((entry) => RAW_SCALE_RADIUS.test(entry.value))
        .map((entry) => `${sheet.file}:${entry.line} ${entry.property}: ${entry.value}`),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps arbitrary text sizes out of components", () => {
    const offenders = components
      .filter((component) => !ARBITRARY_TEXT_SIZE_EXCEPTIONS.has(component.file))
      .flatMap((component) =>
        [...component.source.matchAll(/\btext-\[[\d.]+(?:px|rem)\]/g)].map(
          (match) => `${component.file} ${match[0]}`,
        ),
      );
    expect(offenders).toEqual([]);
  });

  it("keeps serif out of interface components", () => {
    const offenders = components
      .filter((component) => !SERIF_CLASS_EXCEPTIONS.has(component.file))
      .filter((component) => /["'`\s]font-serif["'`\s]/.test(component.source))
      .map((component) => component.file);
    expect(offenders).toEqual([]);
  });

  it("keeps component weights at 400, 500 and 600", () => {
    const offenders = components
      .filter((component) => !WEIGHT_CLASS_EXCEPTIONS.has(component.file))
      .flatMap((component) =>
        [...component.source.matchAll(OFF_SCALE_WEIGHT_CLASS)].map(
          (match) => `${component.file} ${match[0]}`,
        ),
      );
    expect(offenders).toEqual([]);
  });

  it("takes component corners over 4px from the corner scale", () => {
    const offenders = components.flatMap((component) =>
      [...component.source.matchAll(ARBITRARY_CORNER_CLASS)]
        .filter((match) => {
          const px = Number(match[1]) * (match[2] === "rem" ? 16 : 1);
          return px > 4 && px < 15;
        })
        .map((match) => `${component.file} ${match[0]}`),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps raw palette colors out of components", () => {
    const offenders = components
      .filter((component) => !PALETTE_EXCEPTIONS.has(component.file))
      .flatMap((component) =>
        [...component.source.matchAll(RAW_PALETTE_CLASS)].map(
          (match) => `${component.file} ${match[0]}`,
        ),
      );
    expect(offenders).toEqual([]);
  });
});
