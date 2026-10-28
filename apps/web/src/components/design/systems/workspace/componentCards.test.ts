import type { DesignSystemComponent } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  componentGroups,
  NO_PREVIEW,
  previewKind,
  previewSummary,
  storyNames,
} from "./componentCards";
import { fontFacesIn } from "./kitFonts";
import { TEST_SYSTEM } from "./testSystem";

const component = (
  name: string,
  extra: Partial<DesignSystemComponent> = {},
): DesignSystemComponent => ({
  id: `react:kit#${name}`,
  name,
  framework: "react",
  provenance: { source: "file", location: `kit/src/${name}.tsx`, extractor: "components@1" },
  ...extra,
});

describe("component cards", () => {
  it("shows a built preview first, then hand-written HTML, then why there is none", () => {
    expect(
      previewKind(component("A", { previewFile: "previews/a.html", previewHtml: "<b>" })),
    ).toEqual({ kind: "built", file: "previews/a.html" });
    expect(previewKind(component("B", { previewHtml: "<b>B</b>" }))).toEqual({ kind: "html" });
    expect(previewKind(component("C", { previewNote: "It needs props to render." }))).toEqual({
      kind: "none",
      note: "It needs props to render.",
    });
    expect(previewKind(component("D", { previewHtml: "  " }))).toEqual({
      kind: "none",
      note: NO_PREVIEW,
    });
  });

  it("groups by folder in first-seen order, previews first, and filters by name, group or import", () => {
    const list = [
      component("Bare", { group: "forms" }),
      component("Input", { group: "forms", previewFile: "previews/forms/Input.html" }),
      component("Table", { group: "standings", importPath: "@kit/standings" }),
      component("chip", { framework: "css-class" }),
    ];
    expect(
      componentGroups(list, "").map((group) => [group.name, group.components.map((c) => c.name)]),
    ).toEqual([
      ["Forms", ["Input", "Bare"]],
      ["Standings", ["Table"]],
      ["CSS classes", ["chip"]],
    ]);
    expect(componentGroups(list, "STANDINGS").map((group) => group.name)).toEqual(["Standings"]);
    expect(
      componentGroups(list, "inp").flatMap((group) => group.components.map((c) => c.name)),
    ).toEqual(["Input"]);
  });

  it("summarizes a build and reads story captions back", () => {
    expect(previewSummary(TEST_SYSTEM)).toBeNull();
    expect(
      previewSummary({
        ...TEST_SYSTEM,
        previews: {
          stylesheetFile: "previews/preview.css",
          builtAt: "2026-10-26T00:00:00Z",
          rendered: 1275,
          total: 1317,
        },
      }),
    ).toBe("1,275 of 1,317 components render from the kit's stories.");
    expect(
      storyNames(
        '<section data-swc-story="Both themes">x</section>\n<section data-swc-story="A &amp; &quot;B&quot;">y</section>',
      ),
    ).toEqual(["Both themes", 'A & "B"']);
  });

  it("takes a kit's inlined font faces and never one that loads from the network", () => {
    const css =
      '@font-face{font-family:"Inter Variable";font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,AAAA) format("woff2-variations");unicode-range:U+0000-00FF}' +
      "@font-face{font-family:Remote;src:url(https://fonts.example/remote.woff2)}" +
      ".a{color:red}";
    expect(fontFacesIn(css)).toEqual([
      {
        family: "Inter Variable",
        source: 'url(data:font/woff2;base64,AAAA) format("woff2-variations")',
        descriptors: {
          display: "swap",
          weight: "100 900",
          style: "normal",
          unicodeRange: "U+0000-00FF",
        },
      },
    ]);
  });
});
