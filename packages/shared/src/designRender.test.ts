import type { DesignDocument, DesignSystem } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";
import { applyDesignOperations } from "./designOps.ts";

import {
  cssLengthToPx,
  DESIGN_FRAME_CSP,
  designComponentSrcdoc,
  designHtmlSrcdoc,
  designNodeStyle,
  designPageBounds,
  designRenderMode,
  designTokenAlias,
  designTokensCss,
  designTokenValue,
  detachDesignTokens,
  isConcreteCssColor,
  isFontFamilyList,
  renderDesignHtml,
  resolveDesignPaint,
  safeCssValue,
  type DesignRenderContext,
} from "./designRender.ts";

const system: DesignSystem = {
  schema: "swc.design-system/1",
  id: "s_weave",
  name: "Weave",
  revision: 1,
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  modes: [
    { id: "light", name: "Light" },
    { id: "dark", name: "Dark" },
  ],
  tokens: [
    {
      name: "wv-ink",
      type: "color",
      values: {
        light: {
          raw: "#241523",
          resolved: "#241523",
          provenance: { source: "file", location: "t.json", extractor: "x" },
        },
        dark: {
          raw: "#f3eff9",
          resolved: "#f3eff9",
          provenance: { source: "file", location: "t.json", extractor: "x" },
        },
      },
    },
    {
      name: "wv-radius-lg",
      type: "dimension",
      values: {
        light: {
          raw: "1rem",
          resolved: "1rem",
          provenance: { source: "file", location: "t.json", extractor: "x" },
        },
      },
    },
  ],
  components: [
    {
      id: "wv-btn",
      name: "Button",
      framework: "css-class",
      previewHtml: '<button class="wv-btn">Go</button>',
      provenance: { source: "file", location: "weave.css", line: 120, extractor: "css-class" },
    },
  ],
  stylesheet: ".wv-btn{color:red}",
  sources: [],
  copiedFrom: null,
};

const context = (mode = "light"): DesignRenderContext => ({
  system,
  mode,
  assetUrl: (asset) => `/assets/${asset}`,
});

const document: DesignDocument = {
  schema: "swc.design/1",
  id: "d_1",
  kind: "design",
  title: "Hero <b>",
  revision: 1,
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  designSystem: "s_weave",
  pages: [
    {
      id: "p1",
      name: "Page 1",
      nodes: [
        {
          id: "f1",
          parentId: null,
          type: "frame",
          x: 100,
          y: 50,
          width: 400,
          height: 300,
          fill: "#fff",
          radius: { token: "wv-radius-lg" },
        },
        {
          id: "t1",
          parentId: "f1",
          type: "text",
          x: 10,
          y: 10,
          width: 200,
          height: 40,
          text: "<script>x</script>",
          color: { token: "wv-ink" },
        },
        {
          id: "h1",
          parentId: "f1",
          type: "html",
          x: 0,
          y: 100,
          width: 100,
          height: 50,
          html: '<p onclick="x">"q"</p>',
        },
        {
          id: "c1",
          parentId: "f1",
          type: "component",
          x: 0,
          y: 200,
          width: 100,
          height: 40,
          componentId: "wv-btn",
        },
        {
          id: "l1",
          parentId: null,
          type: "line",
          x: 600,
          y: 0,
          width: 100,
          height: 10,
          points: [
            [0, 0],
            [100, 10],
          ],
        },
      ],
    },
  ],
  comments: [],
  createdBy: { kind: "user" },
  copiedFrom: null,
};

describe("designRender", () => {
  it("resolves tokens per mode", () => {
    expect(designTokenValue(system, "wv-ink", "dark")).toBe("#f3eff9");
    expect(designTokenValue(system, "wv-radius-lg", "dark")).toBe("1rem");
    expect(designTokenValue(system, "missing", "light")).toBeNull();
    expect(resolveDesignPaint({ token: "wv-ink" }, context("dark"))).toBe("#f3eff9");
    expect(cssLengthToPx("1rem")).toBe(16);
    expect(cssLengthToPx("calc(1px + 2px)")).toBeUndefined();
  });

  it("refuses CSS values that could escape a declaration", () => {
    expect(safeCssValue("red;background:url(x)")).toBeUndefined();
    expect(safeCssValue("url(javascript:x)")).toBeUndefined();
    expect(safeCssValue("oklch(0.5 0.1 200)")).toBe("oklch(0.5 0.1 200)");
  });

  it("styles nodes from tokens", () => {
    const frame = document.pages[0]!.nodes[0]!;
    expect(designNodeStyle(frame, context())).toMatchObject({
      left: "100px",
      "border-radius": "16px",
      overflow: "hidden",
    });
  });

  it("renders a frame as standalone HTML with escaped text and sandboxed HTML", () => {
    const { html, width, height } = renderDesignHtml(
      document,
      { pageId: "p1", frameId: "f1" },
      context(),
    );
    expect([width, height]).toEqual([400, 300]);
    expect(html).toContain("<title>Hero &lt;b&gt;</title>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).toContain("&quot;q&quot;");
    expect(html).toContain('sandbox=""');
    expect(html).toContain("wv-btn");
    expect(html).not.toContain('data-node="l1"');
  });

  it("renders a whole page within its bounds", () => {
    expect(designPageBounds(document.pages[0]!)).toEqual({ x: 100, y: 0, width: 600, height: 350 });
    const { html, width } = renderDesignHtml(document, { pageId: "p1" }, context());
    expect(width).toBe(600);
    expect(html).toContain('data-node="l1"');
    expect(html).toContain("left:0px;top:50px");
  });
});

describe("designRenderMode", () => {
  it("renders a deck in its system's first mode whatever the viewer's theme", () => {
    expect(designRenderMode("slides", system, "dark")).toBe("light");
    expect(designRenderMode("slides", system, "light")).toBe("light");
    const darkFirst = { ...system, modes: [...system.modes].reverse() };
    expect(designRenderMode("slides", darkFirst, "light")).toBe("dark");
  });

  it("keeps other designs on the viewer's theme when the system has that mode", () => {
    expect(designRenderMode("design", system, "dark")).toBe("dark");
    expect(designRenderMode("design", system, "sepia")).toBe("light");
    expect(designRenderMode("slides", null, "dark")).toBe("light");
  });
});

describe("design frame srcdoc", () => {
  const htmlNode = (html: string) =>
    ({
      id: "n_h",
      parentId: null,
      type: "html",
      html,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    }) as const;

  it("puts the CSP first in the head, ahead of the bootstrap and the page", () => {
    const doc = designHtmlSrcdoc(
      htmlNode(
        '<!doctype html><html><head><script>fetch("/x")</script></head><body>hi</body></html>',
      ),
      { mode: "light" },
    );
    const csp = doc.indexOf('http-equiv="Content-Security-Policy"');
    expect(doc.startsWith("<!doctype html><meta http-equiv")).toBe(true);
    expect(csp).toBeLessThan(doc.indexOf("<html>"));
    expect(csp).toBeLessThan(doc.indexOf('<style id="studio-theme">'));
    expect(csp).toBeLessThan(doc.indexOf('fetch("/x")'));
    expect(doc).toContain(DESIGN_FRAME_CSP);
    expect(DESIGN_FRAME_CSP).not.toContain("connect-src");
    expect(DESIGN_FRAME_CSP).toContain("default-src 'none'");
  });

  it("keeps the CSP ahead of body content that precedes a late head tag", () => {
    const doc = designHtmlSrcdoc(
      htmlNode('<p>x</p><head></head><script>fetch("http://127.0.0.1:1/")</script>'),
      { mode: "light" },
    );
    expect(doc.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
  });

  it("is not fooled by a head tag inside a comment", () => {
    const doc = designHtmlSrcdoc(htmlNode("<!-- <head> --><p>bare fragment</p>"), {
      mode: "light",
    });
    const comment = doc.indexOf("<!-- <head> -->");
    const csp = doc.indexOf("Content-Security-Policy");
    expect(csp).toBeGreaterThanOrEqual(0);
    expect(csp < comment || csp > comment + "<!-- <head> -->".length).toBe(true);
    expect(csp).toBeLessThan(doc.indexOf("<p>bare fragment</p>"));
  });

  it("pins the frame to the design's mode instead of the viewer's OS", () => {
    const node = htmlNode("<p>tide</p>");
    const light = designHtmlSrcdoc(node, { mode: "light" });
    const dark = designHtmlSrcdoc(node, { mode: "dark" });
    expect(light).not.toContain("prefers-color-scheme");
    expect(dark).not.toContain("prefers-color-scheme");
    expect(light).toContain("color-scheme:light");
    expect(dark).toContain("color-scheme:dark");
    expect(designHtmlSrcdoc(node, { mode: "brand" })).toContain("color-scheme:light");
  });

  it("gives component previews the same policy", () => {
    const doc = designComponentSrcdoc(
      {
        id: "n_c",
        parentId: null,
        type: "component",
        componentId: "x",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      },
      { system: null, mode: "light", assetUrl: () => "" },
    );
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<style>"));
  });

  const componentNode = (componentId: string, name?: string) =>
    ({
      id: "n_c",
      parentId: null,
      type: "component",
      componentId,
      ...(name === undefined ? {} : { name }),
      x: 0,
      y: 0,
      width: 320,
      height: 120,
    }) as const;
  const tokenValue = (raw: string) => ({
    raw,
    resolved: null,
    provenance: { source: "file" as const, location: "t.json", extractor: "x" },
  });

  it("gives a component frame the system's tokens in the design's mode", () => {
    const light = designComponentSrcdoc(componentNode("wv-btn"), context("light"));
    const dark = designComponentSrcdoc(componentNode("wv-btn"), context("dark"));
    expect(light).toContain("--wv-ink:#241523");
    expect(dark).toContain("--wv-ink:#f3eff9");
    // A token without a dark value falls back to the first mode's.
    expect(dark).toContain("--wv-radius-lg:1rem");
    // Exactly one style element, still after the policy.
    expect(light.split("<style>")).toHaveLength(2);
    expect(light.indexOf("Content-Security-Policy")).toBeLessThan(light.indexOf("<style>"));
    // The system's own stylesheet comes after the tokens, so it wins on a clash.
    expect(light.indexOf("--wv-ink:")).toBeLessThan(light.indexOf(".wv-btn{color:red}"));
    expect(light).toContain('<button class="wv-btn">Go</button>');
  });

  it("re-resolves the tokens when the design switches systems", () => {
    const night: DesignSystem = {
      ...system,
      id: "s_night" as DesignSystem["id"],
      tokens: [{ name: "wv-ink", type: "color", values: { light: tokenValue("#7d32ff") } }],
    };
    const before = designComponentSrcdoc(componentNode("wv-btn"), context("light"));
    const after = designComponentSrcdoc(componentNode("wv-btn"), {
      ...context("light"),
      system: night,
    });
    expect(before).toContain("--wv-ink:#241523");
    expect(after).toContain("--wv-ink:#7d32ff");
    expect(after).not.toContain("#241523");
  });

  it("writes aliases as variables and drops values that could escape the style", () => {
    const tricky: DesignSystem = {
      ...system,
      tokens: [
        { name: "brand", type: "color", values: { light: tokenValue("#0a7d32") } },
        { name: "link", type: "color", values: { light: tokenValue("{brand}") } },
        { name: "focus", type: "color", values: { light: tokenValue("var(--brand)") } },
        { name: "bad", type: "other", values: { light: tokenValue("red}body{color:blue") } },
        { name: "worse", type: "other", values: { light: tokenValue("</style><script>x") } },
      ],
    };
    const css = designTokensCss(tricky, "light");
    expect(css).toBe(":root{--brand:#0a7d32;--link:var(--brand);--focus:var(--brand)}");
    const doc = designComponentSrcdoc(componentNode("wv-btn"), {
      ...context("light"),
      system: tricky,
    });
    expect(doc).not.toContain("</style><script>");
    expect(doc).not.toContain("body{color:blue");
    expect(designTokenAlias("{a.b}")).toBe("a.b");
    expect(designTokenAlias("#fff")).toBeNull();
  });

  it("is empty without a system or tokens", () => {
    expect(designTokensCss(null, "light")).toBe("");
    expect(designTokensCss({ tokens: [], modes: system.modes }, "light")).toBe("");
  });

  it("labels a component the system lacks with the layer's name", () => {
    const named = designComponentSrcdoc(componentNode("html:gone", "Score pill"), context());
    expect(named).toContain("Score pill");
    expect(named).not.toContain("html:gone");
    expect(designComponentSrcdoc(componentNode("html:gone"), context())).toContain("html:gone");
  });
});

describe("detachDesignTokens", () => {
  /** wv-ink in two modes, a raw-only accent, an unknown token and literal paints. */
  const tokenDocument: DesignDocument = {
    ...document,
    pages: [
      {
        id: "p1",
        name: "Page 1",
        nodes: [
          {
            id: "f1",
            parentId: null,
            type: "frame",
            x: 0,
            y: 0,
            width: 400,
            height: 300,
            fill: { token: "wv-ink" },
            stroke: { token: "wv-accent" },
            radius: { token: "wv-radius-lg" },
          },
          {
            id: "t1",
            parentId: "f1",
            type: "text",
            x: 10,
            y: 10,
            width: 200,
            height: 40,
            text: "Title",
            color: { token: "wv-ink" },
            fontSize: { token: "wv-radius-lg" },
            fontFamily: { token: "wv-font" },
          },
          {
            id: "r1",
            parentId: "f1",
            type: "rect",
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            fill: "#ff0000",
            stroke: { token: "wv-missing" },
          },
        ],
      },
    ],
  };
  const tokenSystem: DesignSystem = {
    ...system,
    tokens: [
      ...system.tokens,
      {
        name: "wv-accent",
        type: "color",
        values: {
          light: {
            raw: "#5b5bd6",
            resolved: null,
            provenance: { source: "file", location: "t.json", extractor: "x" },
          },
        },
      },
      {
        name: "wv-font",
        type: "fontFamily",
        values: {
          light: {
            raw: "Inter, sans-serif",
            resolved: "Inter, sans-serif",
            provenance: { source: "file", location: "t.json", extractor: "x" },
          },
        },
      },
    ],
  };

  it("writes each token as the value it shows in the current mode", () => {
    const operations = detachDesignTokens(tokenDocument, { system: tokenSystem, mode: "dark" });
    expect(operations).toEqual([
      {
        op: "update_node",
        pageId: "p1",
        id: "f1",
        // The resolved dark value; the accent has only a raw value; 1rem is 16 px.
        patch: { fill: "#f3eff9", stroke: "#5b5bd6", radius: 16 },
      },
      {
        op: "update_node",
        pageId: "p1",
        id: "t1",
        patch: { color: "#f3eff9", fontSize: 16, fontFamily: "Inter, sans-serif" },
      },
    ]);
  });

  it("keeps token layers painted after the system is set to None", () => {
    const before = context("light");
    const operations = [
      ...detachDesignTokens(tokenDocument, { system: tokenSystem, mode: "light" }),
      { op: "set_design_system" as const, systemId: null },
    ];
    const outcome = applyDesignOperations(tokenDocument, operations);
    if (!outcome.ok) throw new Error(outcome.error.detail);
    const none: DesignRenderContext = { system: null, mode: "light", assetUrl: before.assetUrl };
    const [frame, text, rect] = outcome.document.pages[0]!.nodes;
    expect(outcome.document.designSystem).toBeNull();
    expect(designNodeStyle(frame!, none).background).toBe("#241523");
    expect(designNodeStyle(frame!, none).border).toBe("1px solid #5b5bd6");
    expect(designNodeStyle(frame!, none)["border-radius"]).toBe("16px");
    expect(designNodeStyle(text!, none).color).toBe("#241523");
    expect(designNodeStyle(text!, none)["font-family"]).toBe("Inter, sans-serif");
    // A literal fill is untouched; a token the system lacks stays a reference.
    expect(rect).toMatchObject({ fill: "#ff0000", stroke: { token: "wv-missing" } });
  });

  it("does nothing without a system", () => {
    expect(detachDesignTokens(tokenDocument, { system: null, mode: "light" })).toEqual([]);
  });

  it("keeps a token whose value is a var() or an alias a reference", () => {
    const raw = (name: string, type: "color" | "dimension" | "fontFamily", value: string) => ({
      name,
      type,
      values: {
        light: {
          raw: value,
          resolved: null,
          provenance: { source: "file" as const, location: "t.css", extractor: "x" },
        },
      },
    });
    const aliasSystem: DesignSystem = {
      ...system,
      tokens: [
        raw("c-var", "color", "var(--brand)"),
        raw("c-alias", "color", "colors.blue.500"),
        raw("c-mix", "color", "color-mix(in srgb, red 50%, blue)"),
        raw("c-name", "color", "white"),
        raw("c-oklch", "color", "oklch(70% 0.12 250)"),
        raw("r-var", "dimension", "var(--radius)"),
        raw("f-var", "fontFamily", "var(--font-sans)"),
        raw("f-alias", "fontFamily", "$font-stack"),
      ],
    };
    const aliasDocument: DesignDocument = {
      ...document,
      pages: [
        {
          id: "p1",
          name: "Page 1",
          nodes: [
            {
              id: "a",
              parentId: null,
              type: "rect",
              x: 0,
              y: 0,
              width: 10,
              height: 10,
              fill: { token: "c-var" },
              stroke: { token: "c-alias" },
              radius: { token: "r-var" },
            },
            {
              id: "b",
              parentId: null,
              type: "rect",
              x: 0,
              y: 0,
              width: 10,
              height: 10,
              fill: { token: "c-name" },
              stroke: { token: "c-mix" },
            },
            {
              id: "c",
              parentId: null,
              type: "text",
              x: 0,
              y: 0,
              width: 10,
              height: 10,
              text: "T",
              color: { token: "c-oklch" },
              fontFamily: { token: "f-var" },
            },
            {
              id: "d",
              parentId: null,
              type: "text",
              x: 0,
              y: 0,
              width: 10,
              height: 10,
              text: "T",
              fontFamily: { token: "f-alias" },
            },
          ],
        },
      ],
    };
    expect(detachDesignTokens(aliasDocument, { system: aliasSystem, mode: "light" })).toEqual([
      { op: "update_node", pageId: "p1", id: "b", patch: { fill: "white" } },
      { op: "update_node", pageId: "p1", id: "c", patch: { color: "oklch(70% 0.12 250)" } },
    ]);
  });

  it("reads concrete colors and font lists", () => {
    for (const value of [
      "#fff",
      "#5b5bd6cc",
      "RebeccaPurple",
      "rgb(0 0 0 / 50%)",
      "hsl(210 40% 50%)",
      "color(display-p3 1 0 0)",
    ])
      expect(isConcreteCssColor(value)).toBe(true);
    for (const value of [
      "var(--x)",
      "{color.primary}",
      "colors.blue.500",
      "currentColor",
      "rgb(var(--r) 0 0)",
      "rgb()",
      "#12345",
    ])
      expect(isConcreteCssColor(value)).toBe(false);
    for (const value of [
      "Inter",
      'Inter, "SF Pro Display", -apple-system, sans-serif',
      "'Fira Code', monospace",
    ])
      expect(isFontFamilyList(value)).toBe(true);
    for (const value of ["var(--font)", "--font-sans", "$font-stack", "font.sans", "Inter,", ""])
      expect(isFontFamilyList(value)).toBe(false);
  });
});
