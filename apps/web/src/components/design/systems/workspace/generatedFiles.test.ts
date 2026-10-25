import type { DesignSystem, DesignToken } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildTokensCss, buildTokensJson, customProperty, generatedFiles } from "./generatedFiles";

const provenance = { source: "user" as const, location: "editor", extractor: "editor@1" };
const value = (raw: string, resolved: string | null = raw) => ({ raw, resolved, provenance });

const token = (
  name: string,
  values: Record<string, ReturnType<typeof value>>,
  extra: Partial<DesignToken> = {},
): DesignToken => ({ name, type: "color", values, ...extra });

const SYSTEM = {
  schema: 1,
  id: "acme",
  name: "Acme */ brand",
  revision: 4,
  createdAt: "2026-10-20T15:00:00Z",
  updatedAt: "2026-10-23T15:00:00Z",
  modes: [
    { id: "light", name: "Light" },
    { id: "dark", name: "Dark" },
  ],
  tokens: [
    token("ink", { light: value("#111111"), dark: value("#f5f5f5") }),
    token("ground", { light: value("#ffffff"), dark: value("#ffffff") }),
    token("brand.500", { light: value("#2f6bff") }, { description: "Primary actions." }),
    token("accent", { light: value("{brand.500}", "#2f6bff") }, { aliasOf: "brand.500" }),
    token("space-2", { default: value("8px") }, { type: "dimension", group: "spacing" }),
  ],
  components: [],
  sources: [],
  copiedFrom: null,
} as unknown as DesignSystem;

describe("tokens.css", () => {
  const css = buildTokensCss(SYSTEM);

  it("starts with a comment saying it is generated", () => {
    expect(css.split("\n")[0]).toBe(
      '/* Generated from the design system "Acme * / brand" (revision 4). */',
    );
    expect(css).toContain("Do not edit");
  });

  it("puts the first mode on :root and each other mode under its data-theme", () => {
    expect(css).toContain(
      [
        ":root {",
        "  --ink: #111111;",
        "  --ground: #ffffff;",
        "  --brand\\.500: #2f6bff;",
        "  --accent: var(--brand\\.500);",
        "  --space-2: 8px;",
        "}",
      ].join("\n"),
    );
    // Only values that differ from the first mode are repeated.
    expect(css).toContain(['[data-theme="dark"] {', "  --ink: #f5f5f5;", "}"].join("\n"));
    expect(css).not.toMatch(/\[data-theme="dark"\][^}]*--ground/);
    expect(customProperty("a.b")).toBe("--a\\.b");
  });
});

describe("tokens.json", () => {
  it("keeps raw values per mode, resolved values where they differ, notes and aliases", () => {
    const json = JSON.parse(buildTokensJson(SYSTEM));
    expect(json.name).toBe("Acme */ brand");
    expect(json.modes).toEqual(SYSTEM.modes);
    expect(json.tokens.ink).toEqual({
      type: "color",
      values: { light: "#111111", dark: "#f5f5f5" },
    });
    expect(json.tokens["brand.500"].description).toBe("Primary actions.");
    expect(json.tokens.accent).toMatchObject({
      aliasOf: "brand.500",
      values: { light: "{brand.500}" },
      resolved: { light: "#2f6bff" },
    });
    expect(json.tokens["space-2"].group).toBe("spacing");
  });
});

describe("generated files", () => {
  it("lists tokens.css and tokens.json as generated files with their size", () => {
    const files = generatedFiles(SYSTEM);
    expect(files.map((file) => [file.path, file.origin, file.mimeType])).toEqual([
      ["tokens.css", "generated", "text/css"],
      ["tokens.json", "generated", "application/json"],
    ]);
    expect(files[0]!.bytes).toBe(new TextEncoder().encode(files[0]!.text).length);
  });
});
