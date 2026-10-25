import type {
  DesignActor,
  DesignSystem,
  DesignSystemOperation,
  DesignToken,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DESIGN_SYSTEM_EDITOR_EXTRACTOR,
  applyDesignSystemOperations,
  formatColor,
  formatTypography,
  newDesignSystem,
  parseColor,
  parseTypography,
} from "./designSystemOps.ts";

const NOW = "2026-10-24T12:00:00.000Z";
const user: DesignActor = { kind: "user" };
const imported = { source: "file", location: "src/tokens.css", extractor: "css@1" } as const;

const token = (name: string, light: string, dark = light): DesignToken => ({
  name,
  type: "color",
  group: "color",
  values: {
    light: { raw: light, resolved: light.startsWith("var(") ? null : light, provenance: imported },
    dark: { raw: dark, resolved: dark.startsWith("var(") ? null : dark, provenance: imported },
  },
});

function fixture(tokens: DesignToken[] = []): DesignSystem {
  return {
    ...newDesignSystem({ id: "s_fixture", name: "Fixture", now: "2026-10-20T00:00:00.000Z" }),
    tokens,
  };
}

function apply(system: DesignSystem, operations: DesignSystemOperation[]): DesignSystem {
  const outcome = applyDesignSystemOperations(system, operations, { actor: user, now: NOW });
  if (!outcome.ok) throw new Error(outcome.detail);
  return outcome.system;
}

function refuse(system: DesignSystem, operations: DesignSystemOperation[]) {
  const outcome = applyDesignSystemOperations(system, operations, { actor: user, now: NOW });
  if (outcome.ok) throw new Error("Expected the batch to be refused.");
  return outcome;
}

const find = (system: DesignSystem, name: string) =>
  system.tokens.find((candidate) => candidate.name === name);

describe("newDesignSystem", () => {
  it("starts empty with Light and Dark at revision 0", () => {
    const system = newDesignSystem({ id: "s_new", name: "  Brand  ", now: NOW });
    expect(system).toMatchObject({
      id: "s_new",
      name: "Brand",
      revision: 0,
      modes: [
        { id: "light", name: "Light" },
        { id: "dark", name: "Dark" },
      ],
      tokens: [],
      components: [],
      sources: [],
      copiedFrom: null,
    });
    expect("description" in system).toBe(false);
  });
});

describe("applyDesignSystemOperations", () => {
  it("adds a token with editor provenance, inheriting the first mode for a missing one", () => {
    const system = apply(fixture(), [
      { op: "put_token", token: { name: "brand", type: "color", values: { light: "#ff0000" } } },
    ]);
    const brand = find(system, "brand")!;
    expect(brand.values.light).toEqual({
      raw: "#ff0000",
      resolved: "#ff0000",
      provenance: { source: "user", location: "editor", extractor: DESIGN_SYSTEM_EDITOR_EXTRACTOR },
    });
    expect(brand.values.dark?.raw).toBe("#ff0000");
    expect(system.updatedAt).toBe(NOW);
    expect(system.revision).toBe(0);
  });

  it("replaces a token with the same name in place and keeps names unique", () => {
    const start = fixture([token("a", "#111111"), token("b", "#222222")]);
    const system = apply(start, [
      { op: "put_token", token: { name: "a", type: "color", values: { light: "#333333" } } },
    ]);
    expect(system.tokens.map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(find(system, "a")?.values.dark?.raw).toBe("#333333");
  });

  it("keeps the imported provenance of a value whose raw text did not change", () => {
    const start = fixture([token("a", "#111111", "#000000")]);
    const system = apply(start, [
      {
        op: "put_token",
        token: { name: "a", type: "color", values: { light: "#111111", dark: "#ffffff" } },
      },
    ]);
    expect(find(system, "a")?.values.light?.provenance).toEqual(imported);
    expect(find(system, "a")?.values.dark?.provenance.source).toBe("user");
  });

  it("resolves same-mode references and recomputes the tokens that refer to an edit", () => {
    const start = fixture([
      token("base", "#111111", "#eeeeee"),
      token("ink", "var(--base)"),
      token("border", "1px solid {ink}"),
    ]);
    const system = apply(start, [
      {
        op: "put_token",
        token: { name: "base", type: "color", values: { light: "#000000", dark: "#ffffff" } },
      },
    ]);
    expect(find(system, "ink")?.values.light?.resolved).toBe("#000000");
    expect(find(system, "ink")?.values.dark?.resolved).toBe("#ffffff");
    expect(find(system, "border")?.values.dark?.resolved).toBe("1px solid #ffffff");
  });

  it("leaves an unresolvable reference and a cycle unresolved, and uses a fallback", () => {
    const system = apply(fixture(), [
      { op: "put_token", token: { name: "x", type: "color", values: { light: "var(--y)" } } },
      { op: "put_token", token: { name: "y", type: "color", values: { light: "var(--x)" } } },
      { op: "put_token", token: { name: "z", type: "color", values: { light: "var(--nope)" } } },
      {
        op: "put_token",
        token: { name: "w", type: "color", values: { light: "var(--nope, #abcdef)" } },
      },
    ]);
    expect(find(system, "x")?.values.light?.resolved).toBeNull();
    expect(find(system, "y")?.values.light?.resolved).toBeNull();
    expect(find(system, "z")?.values.light?.resolved).toBeNull();
    expect(find(system, "w")?.values.light?.resolved).toBe("#abcdef");
  });

  it("records a pure reference as an alias", () => {
    const system = apply(fixture([token("base", "#111111")]), [
      { op: "put_token", token: { name: "ink", type: "color", values: { light: "{base}" } } },
    ]);
    expect(find(system, "ink")?.aliasOf).toBe("base");
  });

  it("refuses a value for a mode the system lacks, a missing value and a self alias", () => {
    expect(
      refuse(fixture(), [
        { op: "put_token", token: { name: "a", type: "color", values: { dim: "#000" } } },
      ]),
    ).toMatchObject({ code: "not_found", detail: "No mode dim in this design system.", index: 0 });
    expect(
      refuse(fixture(), [
        { op: "put_token", token: { name: "a", type: "color", values: { light: "  " } } },
      ]).detail,
    ).toBe("Give a a value.");
    expect(
      refuse(fixture([token("a", "#000000")]), [
        {
          op: "put_token",
          token: { name: "a", type: "color", values: { light: "#000" }, aliasOf: "a" },
        },
      ]).code,
    ).toBe("invalid");
  });

  it("renames a token and every reference and alias of it in this system", () => {
    const start = fixture([
      token("base", "#111111"),
      { ...token("ink", "var(--base)"), aliasOf: "base" },
      token("border", "1px solid {base}"),
    ]);
    const system = apply(start, [{ op: "rename_token", from: "base", to: "brand" }]);
    expect(system.tokens.map((entry) => entry.name)).toEqual(["brand", "ink", "border"]);
    expect(find(system, "ink")).toMatchObject({ aliasOf: "brand" });
    // Rewritten text is the editor's, not the source file's.
    expect(find(system, "ink")?.values.light).toMatchObject({
      raw: "var(--brand)",
      resolved: "#111111",
      provenance: { source: "user" },
    });
    expect(find(system, "border")?.values.light?.raw).toBe("1px solid {brand}");
  });

  it("renames the dotted aliases a DTCG import keeps", () => {
    const start = fixture([
      token("color-primary", "#0000ff"),
      { ...token("button-bg", "{color.primary}"), aliasOf: "color-primary" },
      token("ring", "0 0 0 2px {color.primary}"),
    ]);
    const system = apply(start, [{ op: "rename_token", from: "color-primary", to: "brand" }]);
    expect(find(system, "button-bg")?.values.dark?.raw).toBe("{brand}");
    expect(find(system, "button-bg")?.values.dark?.resolved).toBe("#0000ff");
    expect(find(system, "ring")?.values.light?.raw).toBe("0 0 0 2px {brand}");
  });

  it("gives the new first mode the values that fell back on a removed first mode", () => {
    const base = token("base", "#111111");
    const { dark: _dark, ...lightOnly } = base.values;
    const start = fixture([{ ...base, values: lightOnly }, token("ink", "#222222", "#eeeeee")]);
    const system = apply(start, [{ op: "delete_mode", modeId: "light" }]);
    expect(system.modes.map((mode) => mode.id)).toEqual(["dark"]);
    expect(find(system, "base")?.values.dark?.raw).toBe("#111111");
    expect(find(system, "ink")?.values).toEqual({
      dark: expect.objectContaining({ raw: "#eeeeee" }),
    });
  });

  it("keeps import-resolved values when a later mode is deleted", () => {
    // `base` stayed out of the system; the import resolved `ink` from the source.
    const ink = token("ink", "var(--base)", "var(--base)");
    const resolvedInk: DesignToken = {
      ...ink,
      values: {
        light: { ...ink.values.light!, resolved: "#111111" },
        dark: { ...ink.values.dark!, resolved: "#eeeeee" },
        hc: { raw: "var(--base)", resolved: "#000000", provenance: imported },
      },
    };
    const start = {
      ...fixture([resolvedInk]),
      modes: [...fixture().modes, { id: "hc", name: "High contrast" }],
    };
    const system = apply(start, [{ op: "delete_mode", modeId: "hc" }]);
    expect(find(system, "ink")?.values.light?.resolved).toBe("#111111");
    expect(find(system, "ink")?.values.dark?.resolved).toBe("#eeeeee");
    expect(find(system, "ink")?.values.hc).toBeUndefined();
  });

  it("reads the alias from the new first mode when the first mode is deleted", () => {
    const start = fixture([
      token("a", "#111111"),
      { ...token("b", "var(--a)", "#000000"), aliasOf: "a" },
      { ...token("c", "var(--a)", "{a}"), aliasOf: "a" },
    ]);
    const system = apply(start, [{ op: "delete_mode", modeId: "light" }]);
    expect(find(system, "b")?.aliasOf).toBeUndefined();
    expect(find(system, "c")?.aliasOf).toBe("a");
  });

  it("refuses a dotted name that would take another token's {a.b} references", () => {
    const start = fixture([
      token("color-primary", "#0000ff"),
      token("accent", "#ff0000"),
      token("button-bg", "{color.primary}"),
    ]);
    const message = "{color.primary} already refers to color-primary. Pick another name.";
    expect(
      refuse(start, [{ op: "rename_token", from: "accent", to: "color.primary" }]).detail,
    ).toBe(message);
    expect(
      refuse(start, [
        {
          op: "put_token",
          token: { name: "color.primary", type: "color", values: { light: "#00ff00" } },
        },
      ]).detail,
    ).toBe(message);
    // Renaming the token itself to its dotted spelling is fine.
    const system = apply(start, [
      { op: "rename_token", from: "color-primary", to: "color.primary" },
    ]);
    expect(find(system, "button-bg")?.values.light?.resolved).toBe("#0000ff");
  });

  it("refuses a rename onto a taken name, and a rename of a missing token", () => {
    const start = fixture([token("a", "#111111"), token("b", "#222222")]);
    expect(refuse(start, [{ op: "rename_token", from: "a", to: "b" }]).detail).toBe(
      "A token named b already exists.",
    );
    expect(refuse(start, [{ op: "rename_token", from: "c", to: "d" }]).code).toBe("not_found");
  });

  it("deletes a token; references to it no longer resolve and aliases are cleared", () => {
    const start = fixture([
      token("base", "#111111"),
      { ...token("ink", "var(--base)"), aliasOf: "base" },
    ]);
    const system = apply(start, [{ op: "delete_token", name: "base" }]);
    expect(find(system, "base")).toBeUndefined();
    expect(find(system, "ink")?.aliasOf).toBeUndefined();
    expect(find(system, "ink")?.values.light?.resolved).toBeNull();
  });

  it("adds and renames modes, deletes a mode's values, and refuses the last mode", () => {
    const start = fixture([token("a", "#111111", "#000000")]);
    const added = apply(start, [
      { op: "put_mode", mode: { id: "contrast", name: "High contrast" } },
      { op: "put_mode", mode: { id: "dark", name: "Night" } },
    ]);
    expect(added.modes).toEqual([
      { id: "light", name: "Light" },
      { id: "dark", name: "Night" },
      { id: "contrast", name: "High contrast" },
    ]);
    const removed = apply(added, [{ op: "delete_mode", modeId: "dark" }]);
    expect(removed.modes.map((mode) => mode.id)).toEqual(["light", "contrast"]);
    expect(Object.keys(find(removed, "a")!.values)).toEqual(["light"]);
    const single = apply(removed, [{ op: "delete_mode", modeId: "contrast" }]);
    expect(refuse(single, [{ op: "delete_mode", modeId: "light" }]).detail).toBe(
      "A design system needs at least one mode.",
    );
  });

  it("sets and removes the name and description", () => {
    const named = apply(fixture(), [
      { op: "set_info", name: " Weave ", description: "The app's own system." },
    ]);
    expect(named).toMatchObject({ name: "Weave", description: "The app's own system." });
    const cleared = apply(named, [{ op: "set_info", description: null }]);
    expect("description" in cleared).toBe(false);
    expect(refuse(named, [{ op: "set_info", name: "   " }]).code).toBe("invalid");
  });

  it("stamps a component's provenance and replaces it by id", () => {
    const component = { id: "button", name: "Button", framework: "css-class" } as const;
    const added = apply(fixture(), [{ op: "put_component", component }]);
    expect(added.components[0]?.provenance).toEqual({
      source: "user",
      location: "editor",
      extractor: DESIGN_SYSTEM_EDITOR_EXTRACTOR,
    });
    const renamed = apply(added, [
      { op: "put_component", component: { ...component, name: "Primary button" } },
    ]);
    expect(renamed.components).toHaveLength(1);
    expect(renamed.components[0]?.name).toBe("Primary button");
    const removed = apply(renamed, [{ op: "delete_component", componentId: "button" }]);
    expect(removed.components).toEqual([]);
    expect(refuse(removed, [{ op: "delete_component", componentId: "button" }]).code).toBe(
      "not_found",
    );
  });

  it("rejects the whole batch at the first failing operation, leaving the input alone", () => {
    const start = fixture([token("a", "#111111")]);
    const outcome = refuse(start, [
      { op: "delete_token", name: "a" },
      { op: "delete_token", name: "a" },
    ]);
    expect(outcome).toMatchObject({ code: "not_found", index: 1 });
    expect(start.tokens).toHaveLength(1);
  });
});

describe("colors", () => {
  it.each([
    ["#ABC", "#aabbcc", 100],
    ["#abcd", "#aabbcc", 87],
    ["#112233", "#112233", 100],
    ["#11223380", "#112233", 50],
    ["rgb(255 0 0)", "#ff0000", 100],
    ["rgba(255, 0, 0, 0.5)", "#ff0000", 50],
    ["rgb(100% 0% 0% / 25%)", "#ff0000", 25],
    ["hsl(120 100% 50%)", "#00ff00", 100],
    ["hsla(240, 100%, 50%, .1)", "#0000ff", 10],
    ["hsl(0.5turn 100% 50% / 50%)", "#00ffff", 50],
    ["transparent", "#000000", 0],
  ])("reads %s as hex and alpha", (input, hex, alpha) => {
    expect(parseColor(input)).toEqual({ hex, base: hex, alpha });
  });

  it("keeps oklch as written and reads its alpha", () => {
    expect(parseColor("oklch(0.7 0.12 250 / 40%)")).toEqual({
      hex: null,
      base: "oklch(0.7 0.12 250)",
      alpha: 40,
    });
    expect(formatColor("oklch(70% 0.12 250deg)", 50)).toBe("oklch(70% 0.12 250deg / 50%)");
    expect(formatColor("oklch(0.7 0.12 250 / 40%)")).toBe("oklch(0.7 0.12 250)");
  });

  it("refuses what it cannot read", () => {
    for (const input of ["var(--x)", "red", "color-mix(in srgb, red, blue)", "#12", "rgb(1 2)"]) {
      expect(parseColor(input)).toBeNull();
    }
    expect(formatColor("var(--x)", 50)).toBeNull();
  });

  it("writes hex with an alpha byte only when not opaque, and round-trips", () => {
    expect(formatColor("#AABBCC")).toBe("#aabbcc");
    expect(formatColor("rgb(255 0 0)", 50)).toBe("#ff000080");
    for (const alpha of [0, 1, 33, 50, 99, 100]) {
      expect(parseColor(formatColor("#123456", alpha)!)?.alpha).toBe(alpha);
    }
  });
});

describe("typography", () => {
  it("reads and writes weight, size, line height and family", () => {
    const parts = parseTypography("600 32px/1.2 var(--font-sans)");
    expect(parts).toEqual({
      style: null,
      weight: "600",
      size: "32px",
      lineHeight: "1.2",
      family: "var(--font-sans)",
    });
    expect(formatTypography(parts!)).toBe("600 32px/1.2 var(--font-sans)");
    expect(formatTypography({ ...parts!, weight: "400", lineHeight: null })).toBe(
      "400 32px var(--font-sans)",
    );
  });

  it("keeps a style, spaces around the slash and quoted families", () => {
    expect(parseTypography('italic bold 1rem / 1.5 "Inter Display", sans-serif')).toEqual({
      style: "italic",
      weight: "bold",
      size: "1rem",
      lineHeight: "1.5",
      family: '"Inter Display", sans-serif',
    });
    expect(parseTypography("14px Inter")).toMatchObject({ weight: null, size: "14px" });
  });

  it("is null without a size or a family", () => {
    expect(parseTypography("var(--type-body)")).toBeNull();
    expect(parseTypography("600 32px/1.2")).toBeNull();
  });
});
