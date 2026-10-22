import type { DesignDocument, DesignSystem } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cssLengthToPx,
  DESIGN_FRAME_CSP,
  designComponentSrcdoc,
  designHtmlSrcdoc,
  designNodeStyle,
  designPageBounds,
  designTokenValue,
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
});
