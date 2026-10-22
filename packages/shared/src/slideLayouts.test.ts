import {
  DesignNode,
  type DesignSystem,
  type DesignToken,
  type DesignTokenType,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { applyDesignOperations, newDesignDocument } from "./designOps.ts";
import { designNodeStyle } from "./designRender.ts";
import {
  applySlideLayout,
  SLIDE_LAYOUTS,
  slideLayoutNodes,
  slideLayoutPage,
  slideTokens,
} from "./slideLayouts.ts";

const seeded = (start = 11) => {
  let seed = start;
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
};

function token(name: string, type: DesignTokenType, light: string, dark = light): DesignToken {
  const value = (raw: string) => ({
    raw,
    resolved: raw,
    provenance: { source: "file" as const, location: "tokens.css", extractor: "css" },
  });
  return { name, type, values: { light: value(light), dark: value(dark) } };
}

function system(tokens: DesignToken[]): DesignSystem {
  return {
    schema: "swc.design-system/1",
    id: "s_test" as DesignSystem["id"],
    name: "Test",
    revision: 0,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    modes: [
      { id: "light", name: "Light" },
      { id: "dark", name: "Dark" },
    ] as never,
    tokens,
    components: [],
    sources: [],
    copiedFrom: null,
  };
}

/** shadcn-style names: `muted` is a surface because `muted-foreground` exists. */
const shadcn = system([
  token("background", "color", "#ffffff", "#09090b"),
  token("foreground", "color", "#09090b", "#fafafa"),
  token("card", "color", "#ffffff", "#0c0c0f"),
  token("card-foreground", "color", "#09090b", "#fafafa"),
  token("primary", "color", "#7c3aed", "#a78bfa"),
  token("primary-foreground", "color", "#ffffff", "#1e1035"),
  token("muted", "color", "#f4f4f5", "#27272a"),
  token("muted-foreground", "color", "#71717a", "#a1a1aa"),
  token("sidebar-background", "color", "#fafafa", "#18181b"),
  token("font-sans", "fontFamily", "Inter, sans-serif"),
  token("font-display", "fontFamily", "Fraunces, serif"),
]);

/** Namespaced names, a bare `muted` ink and a single font. */
const weave = system([
  token("wv-accent", "color", "#2f62f0", "#6f95ff"),
  token("wv-ink", "color", "#18181b", "#f4f4f5"),
  token("wv-line", "color", "#dcdce0", "#34343a"),
  token("wv-muted", "color", "#5f5f69", "#a1a1aa"),
  token("wv-paper", "color", "#ffffff", "#141416"),
  token("wv-font", "fontFamily", "Söhne, sans-serif"),
]);

const decode = Schema.decodeUnknownExit(DesignNode);

describe("slideTokens", () => {
  it("maps shadcn-style names to roles without qualified look-alikes", () => {
    const tokens = slideTokens(shadcn);
    expect(tokens.background).toEqual({ paint: { token: "background" } });
    expect(tokens.ink).toEqual({ paint: { token: "foreground" } });
    expect(tokens.muted).toEqual({ paint: { token: "muted-foreground" } });
    expect(tokens.surface).toEqual({ paint: { token: "card" } });
    expect(tokens.accent).toEqual({ paint: { token: "primary" } });
    expect(tokens.accentInk).toEqual({ paint: { token: "primary-foreground" } });
    expect(tokens.display).toEqual({ token: "font-display" });
    expect(tokens.body).toEqual({ token: "font-sans" });
  });

  it("reads namespaced names, a bare muted ink and one font for both roles", () => {
    const tokens = slideTokens(weave);
    expect(tokens.background).toEqual({ paint: { token: "wv-paper" } });
    expect(tokens.ink).toEqual({ paint: { token: "wv-ink" } });
    expect(tokens.muted).toEqual({ paint: { token: "wv-muted" } });
    expect(tokens.accent).toEqual({ paint: { token: "wv-accent" } });
    // No surface or accent-ink token: the accent at low opacity, the paper on the accent.
    expect(tokens.surface).toEqual({ paint: { token: "wv-accent" }, opacity: 0.1 });
    expect(tokens.accentInk).toEqual({ paint: { token: "wv-paper" } });
    expect(tokens.display).toEqual({ token: "wv-font" });
    expect(tokens.body).toEqual({ token: "wv-font" });
  });

  it("falls back to neutral literals without a system", () => {
    const tokens = slideTokens(null);
    for (const role of ["background", "surface", "ink", "muted", "accent", "accentInk"] as const)
      expect(typeof tokens[role].paint).toBe("string");
    expect(tokens.display).toBeUndefined();
  });
});

describe("slide layouts", () => {
  it("offers the six layouts", () => {
    expect(SLIDE_LAYOUTS.map((layout) => layout.id)).toEqual([
      "title",
      "section",
      "title-body",
      "two-columns",
      "image-caption",
      "quote",
    ]);
  });

  it.each(SLIDE_LAYOUTS.map((layout) => layout.id))(
    "%s: valid nodes inside the 1920x1080 frame, colors and fonts from tokens",
    (id) => {
      const { fill, nodes } = slideLayoutNodes(id, "n_frame", {
        system: shadcn,
        random: seeded(),
      });
      expect(typeof fill).toBe("object");
      expect(nodes.length).toBeGreaterThanOrEqual(3);
      expect(new Set(nodes.map((node) => node.id)).size).toBe(nodes.length);
      for (const node of nodes) {
        expect(decode(node)._tag).toBe("Success");
        expect(node.parentId).toBe("n_frame");
        expect(node.x).toBeGreaterThanOrEqual(0);
        expect(node.y).toBeGreaterThanOrEqual(0);
        if (node.type === "text") {
          expect(node.x + node.width).toBeLessThanOrEqual(1920);
          expect(node.y + node.height).toBeLessThanOrEqual(1080);
          expect(typeof node.color).toBe("object");
          expect(typeof node.fontFamily).toBe("object");
          expect(node.fontSize).toBeGreaterThanOrEqual(28);
        }
        if (node.type === "rect" || node.type === "ellipse")
          expect(typeof node.fill).toBe("object");
      }
    },
  );

  it("resolves through the shared renderer in each mode", () => {
    const { nodes } = slideLayoutNodes("title", "n_frame", { system: shadcn, random: seeded() });
    const title = nodes.find((node) => node.name === "Title")!;
    const assetUrl = () => "";
    expect(designNodeStyle(title, { system: shadcn, mode: "light", assetUrl }).color).toBe(
      "#09090b",
    );
    expect(designNodeStyle(title, { system: shadcn, mode: "dark", assetUrl }).color).toBe(
      "#fafafa",
    );
    expect(designNodeStyle(title, { system: shadcn, mode: "dark", assetUrl })["font-family"]).toBe(
      "Fraunces, serif",
    );
  });

  it("scales to another frame size", () => {
    const { nodes } = slideLayoutNodes("quote", "n_frame", {
      system: null,
      size: { width: 960, height: 540 },
      random: seeded(),
    });
    const quote = nodes.find((node) => node.name === "Quote")!;
    expect(quote.type === "text" && quote.fontSize).toBe(36);
    expect(quote.x + quote.width).toBeLessThanOrEqual(960);
  });

  it("a layout page lands through add_page and its nodes edit like any other", () => {
    const random = seeded();
    const document = newDesignDocument({
      id: "d_deck",
      kind: "slides",
      title: "Deck",
      now: "2026-10-20T00:00:00.000Z",
      createdBy: { kind: "user" },
      random,
    });
    const page = slideLayoutPage("two-columns", { name: "Slide 2", system: weave, random });
    expect(page.nodes[0]).toMatchObject({ type: "frame", width: 1920, height: 1080 });
    const added = applyDesignOperations(document, [{ op: "add_page", page, index: 1 }]);
    if (!added.ok) throw new Error(added.error.detail);
    const heading = page.nodes.find((node) => node.name === "Left heading")!;
    const edited = applyDesignOperations(added.document, [
      { op: "update_node", pageId: page.id, id: heading.id, patch: { text: "Today" } },
    ]);
    expect(edited.ok).toBe(true);
  });

  it("applySlideLayout fills an empty slide in place", () => {
    const document = newDesignDocument({
      id: "d_deck",
      kind: "slides",
      title: "Deck",
      now: "2026-10-20T00:00:00.000Z",
      createdBy: { kind: "user" },
      random: seeded(),
    });
    const page = document.pages[0]!;
    const operations = applySlideLayout(page, "title", { system: shadcn, random: seeded(29) })!;
    const outcome = applyDesignOperations(document, operations);
    if (!outcome.ok) throw new Error(outcome.error.detail);
    const nodes = outcome.document.pages[0]!.nodes;
    expect(nodes[0]).toMatchObject({ type: "frame", fill: { token: "background" } });
    expect(nodes.filter((node) => node.parentId === page.nodes[0]!.id)).toHaveLength(4);
    expect(applySlideLayout({ ...page, nodes: [] }, "title", { system: null })).toBeNull();
  });
});
