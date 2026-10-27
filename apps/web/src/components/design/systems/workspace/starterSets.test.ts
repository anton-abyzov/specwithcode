import type { DesignSystem } from "@specweave-studio/contracts";
import { slideTokens } from "@specweave-studio/shared/slideLayouts";
import { describe, expect, it } from "vite-plus/test";

import weaveTokens from "../../../../../../server/src/design/systems/fixtures/weave/tokens.json.fixture?raw";
import { contrastRatio } from "./contrast";
import {
  DEFAULT_ACCENT,
  DEFAULT_FAMILY,
  modeValues,
  starterKit,
  starterTokens,
} from "./starterSets";
import { buildSections } from "./systemSections";
import { TEST_SYSTEM } from "./testSystem";
import {
  colorProblem,
  lengthProblem,
  parseTypeStyle,
  plainValueProblem,
  shadowProblem,
} from "./tokenValues";

const LIGHT_DARK: DesignSystem["modes"] = [
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
];

const value = (tokens: ReturnType<typeof starterTokens>, name: string, mode: string) =>
  tokens.find((token) => token.name === name)!.values[mode]!;

describe("starter sets", () => {
  it("gives the first mode and later modes unlike it their own values; alike modes inherit", () => {
    const pair = { light: "L", dark: "D" };
    expect(modeValues(LIGHT_DARK, pair)).toEqual({ light: "L", dark: "D" });
    expect(
      modeValues(
        [
          { id: "day", name: "Day" },
          { id: "print", name: "Print" },
          { id: "night", name: "Night" },
        ],
        pair,
      ),
    ).toEqual({ day: "L", night: "D" });
    expect(modeValues([{ id: "dark", name: "Dark" }], pair)).toEqual({ dark: "D" });
    // A dark first mode: a later Light mode gets light values, a later Midnight inherits.
    expect(
      modeValues(
        [
          { id: "dark", name: "Dark" },
          { id: "light", name: "Light" },
          { id: "midnight", name: "Midnight" },
        ],
        pair,
      ),
    ).toEqual({ dark: "D", light: "L" });
  });

  it("builds a palette from the chosen accent with readable text in both modes", () => {
    const tokens = starterTokens("colors", LIGHT_DARK, { accent: "#0e7490" });
    expect(value(tokens, "color-accent", "light")).toBe("#0E7490");
    for (const token of tokens) {
      expect(token.type).toBe("color");
      expect(token.group).toBe("color");
      for (const raw of Object.values(token.values))
        expect(colorProblem(raw, token.name, [])).toBeNull();
    }
    for (const mode of ["light", "dark"]) {
      const ground = value(tokens, "color-surface-ground", mode);
      expect(contrastRatio(value(tokens, "color-text-ink", mode), ground)).toBeGreaterThan(12);
      expect(contrastRatio(value(tokens, "color-text-muted", mode), ground)).toBeGreaterThan(4.5);
      expect(
        contrastRatio(
          value(tokens, "color-text-on-accent", mode),
          value(tokens, "color-accent", mode),
        ),
      ).toBeGreaterThan(3);
    }
  });

  it("falls back to the default accent for a value that is not a color", () => {
    const tokens = starterTokens("colors", LIGHT_DARK, { accent: "oklch(0.6 0.2 250)" });
    expect(value(tokens, "color-accent", "light")).toBe("#2F6FED");
  });

  it("names the chosen family font-body, serif or not, and the styles use it", () => {
    const serif = 'ui-serif, Georgia, "Times New Roman", serif';
    const tokens = starterTokens("typography", LIGHT_DARK, { family: serif });
    expect(value(tokens, "font-body", "light")).toBe(serif);
    expect(tokens.some((token) => token.name === "font-sans")).toBe(false);
    expect(value(tokens, "type-body", "light")).toContain("var(--font-body)");
    // Slides built from the system find it as their body face.
    const system = {
      ...TEST_SYSTEM,
      tokens: tokens.map((edit) => ({
        ...edit,
        values: Object.fromEntries(
          Object.entries(edit.values).map(([mode, raw]) => [mode, { raw, resolved: raw }]),
        ),
      })),
    } as unknown as DesignSystem;
    expect(slideTokens(system).body).toEqual({ token: "font-body" });
  });

  it("builds a type scale on the chosen family, sizes in the first mode only", () => {
    const tokens = starterTokens("typography", LIGHT_DARK, { family: "  " });
    expect(value(tokens, "font-body", "light")).toBe(DEFAULT_FAMILY);
    const styles = tokens.filter((token) => token.type === "typography");
    expect(styles.map((token) => token.name)).toContain("type-body");
    for (const style of styles) {
      expect(Object.keys(style.values)).toEqual(["light"]);
      expect(parseTypeStyle(style.values.light!)).not.toBeNull();
    }
  });

  it("checks out as lengths and shadows, and lands in its own section", () => {
    for (const token of starterTokens("spacing", LIGHT_DARK))
      expect(lengthProblem(token.values.light!)).toBeNull();
    for (const token of starterTokens("radius", LIGHT_DARK))
      expect(lengthProblem(token.values.light!)).toBeNull();
    for (const token of starterTokens("shadows", LIGHT_DARK))
      for (const raw of Object.values(token.values)) expect(shadowProblem(raw)).toBeNull();
    for (const token of starterTokens("typography", LIGHT_DARK))
      expect(plainValueProblem(token.values.light!)).toBeNull();

    const kit = starterKit(LIGHT_DARK).map((edit) => ({
      ...edit,
      values: Object.fromEntries(
        Object.entries(edit.values).map(([mode, raw]) => [mode, { raw, resolved: raw }]),
      ),
    }));
    const sections = buildSections({ tokens: kit as never });
    const counts = Object.fromEntries(
      sections.map((section) => [section.id, section.tokens.length]),
    );
    expect(counts).toMatchObject({ colors: 13, type: 10, spacing: 8, corners: 5, shadows: 2 });
    expect(sections.filter((section) => section.kind === "family")).toEqual([]);
  });

  it("names nothing after a sample brand", () => {
    const names = starterKit(LIGHT_DARK).map((token) => token.name);
    expect(names.some((name) => /wv-|weave|harbor/i.test(name))).toBe(false);
    expect(new Set(names).size).toBe(names.length);
  });

  it("copies no value from the Weave sample", () => {
    // Plain lengths and pure black or white are everyone's; anything else must be our own.
    const common = /^(?:-?\d+(?:\.\d+)?(?:px|rem|em)?|#000000|#ffffff)$/;
    const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, "");
    const sample = new Set<string>();
    const collect = (node: unknown): void => {
      if (typeof node === "string") sample.add(normalize(node));
      else if (Array.isArray(node)) node.forEach(collect);
      else if (node !== null && typeof node === "object") Object.values(node).forEach(collect);
    };
    collect(JSON.parse(weaveTokens));
    const copied = starterKit(LIGHT_DARK, { accent: DEFAULT_ACCENT })
      .flatMap((token) => Object.values(token.values).map((raw) => [token.name, raw] as const))
      .filter(([, raw]) => {
        const value = normalize(raw);
        if (common.test(value)) return false;
        // A whole sample value, or a long run of one (a font stack missing its first family).
        return [...sample].some(
          (copy) => copy === value || (value.length >= 20 && copy.includes(value)),
        );
      });
    expect(copied).toEqual([]);
    // The check itself catches such a run: Weave's mono stack without its first family.
    const run = normalize('ui-monospace, "SF Mono", Menlo, Consolas, monospace');
    expect([...sample].some((copy) => copy.includes(run))).toBe(true);
    // The two shadows also differ in shape, not only in tint.
    const geometry = (value: string) => normalize(value).replace(/rgba?\([^)]*\)/g, "");
    const sampleShadows = [...sample]
      .filter((value) => value.includes("px") && value.includes("rgba("))
      .map(geometry);
    for (const shadow of starterTokens("shadows", LIGHT_DARK)) {
      for (const raw of Object.values(shadow.values)) {
        expect(sampleShadows).not.toContain(geometry(raw));
      }
    }
  });
});
