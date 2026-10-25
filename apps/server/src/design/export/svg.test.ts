import {
  DESIGN_DOCUMENT_SCHEMA,
  DESIGN_SYSTEM_SCHEMA,
  type DesignDocument,
  type DesignNode,
  type DesignSystem,
  type DesignTokenValue,
} from "@specweave-studio/contracts";
import type { DesignRenderContext } from "@specweave-studio/shared/designRender";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import type * as HtmlRender from "../../htmlRender/HtmlRender.ts";
import { MAX_FIXED_CAPTURE_EDGE, type TextLines } from "../../htmlRender/headlessChrome.ts";
import { descendants, parseXml, type XmlElement } from "../import/xml.ts";
import { exportSvg, planSvg, writeSvg } from "./svg.ts";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const value = (raw: string): DesignTokenValue => ({
  raw,
  resolved: raw,
  provenance: { source: "agent", location: "board", extractor: "test" },
});
const system: DesignSystem = {
  schema: DESIGN_SYSTEM_SCHEMA,
  id: "s_board",
  name: "Board",
  revision: 0,
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  modes: [
    { id: "light", name: "Light" },
    { id: "dark", name: "Dark" },
  ],
  tokens: [
    { name: "bg", type: "color", values: { light: value("#ffffff"), dark: value("#000000") } },
    {
      name: "ink",
      type: "color",
      values: { light: value("#111827"), dark: value("rgb(248 250 252)") },
    },
    { name: "corner", type: "dimension", values: { light: value("24px") } },
  ],
  components: [],
  sources: [],
  copiedFrom: null,
};

const inFrame = (node: Record<string, unknown>) =>
  ({ parentId: "n_frame", x: 0, y: 0, width: 100, height: 100, ...node }) as DesignNode;

const document = (nodes: ReadonlyArray<DesignNode>, title = "Board review"): DesignDocument => ({
  schema: DESIGN_DOCUMENT_SCHEMA,
  id: "d_board",
  kind: "design",
  title,
  revision: 1,
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  designSystem: "s_board",
  comments: [],
  createdBy: { kind: "user" },
  copiedFrom: null,
  pages: [{ id: "p_main", name: "Main", nodes: [...nodes] }],
});

const frame = {
  id: "n_frame",
  parentId: null,
  type: "frame",
  name: "Board",
  x: 500,
  y: 300,
  width: 800,
  height: 600,
  fill: { token: "bg" },
  clip: true,
} as DesignNode;

const board = document([
  frame,
  inFrame({
    id: "n_title",
    type: "text",
    name: "Headline",
    text: "Fish & <chips>\nMatchday 🏆 2-1",
    x: 40,
    y: 40,
    width: 300,
    height: 100,
    color: { token: "ink" },
    fontSize: 20,
    fontWeight: 700,
    align: "center",
    rotation: 15,
    opacity: 0.5,
  }),
  inFrame({
    id: "n_chart",
    type: "html",
    x: 0,
    y: 200,
    width: 200,
    height: 100,
    html: "<b>Chart</b>",
  }),
  inFrame({ id: "n_button", type: "component", componentId: "c_button", x: 220, y: 200 }),
  inFrame({ id: "n_glow", type: "rect", x: 340, y: 200, fill: "linear-gradient(#000, #fff)" }),
  inFrame({
    id: "n_photo",
    type: "image",
    asset: `${"a".repeat(64)}.png`,
    x: 0,
    y: 320,
    width: 300,
    height: 200,
    radius: { token: "corner" },
  }),
  inFrame({
    id: "n_logo",
    type: "image",
    asset: `${"b".repeat(64)}.svg`,
    x: 320,
    y: 320,
    fit: "contain",
  }),
  inFrame({
    id: "n_stretch",
    type: "image",
    asset: `${"c".repeat(64)}.png`,
    x: 440,
    y: 320,
    fit: "fill",
  }),
  inFrame({ id: "n_hidden", type: "text", text: "Hidden words", hidden: true }),
  inFrame({
    id: "n_note",
    type: "note",
    text: "Check <this>",
    color: "blue",
    x: 600,
    y: 40,
    width: 160,
  }),
]);

const context = (mode = "light"): DesignRenderContext => ({
  system,
  mode,
  assetUrl: (asset) => `https://assets.test/${asset}?w=1&h=2`,
});
const target = { pageId: "p_main", frameId: "n_frame" };

/** The parsed SVG and a lookup of each layer's group by node id. */
const read = (text: string) => {
  const svg = parseXml(text);
  const group = (id: string): XmlElement | undefined =>
    descendants(svg, "g").find((g) => g.attrs.id === id);
  const child = (id: string, name: string) =>
    group(id)!.children.find((element) => element.name === name)!;
  return { svg, group, child };
};

const fakeRender = (lines: ReadonlyArray<TextLines> = []) => {
  const measured: Array<{ html: string; width: number; height: number }> = [];
  const captured: number[] = [];
  const render = {
    measureTextLines: (input: { html: string; width: number; height: number }) =>
      Effect.sync(() => {
        measured.push(input);
        return lines;
      }),
    captureImages: ({ items }: { items: ReadonlyArray<unknown> }) =>
      Effect.sync(() => {
        captured.push(items.length);
        return items.map(() => PNG_1X1);
      }),
  } as unknown as HtmlRender.HtmlRender["Service"];
  return { render, measured, captured };
};

describe("planSvg", () => {
  it("resolves token paints in the chosen mode", () => {
    const paints = (mode: string) => {
      const plan = planSvg(board, target, context(mode));
      const { child } = read(writeSvg(plan, [], [], board.title));
      return { bg: child("n_frame", "rect").attrs.fill, ink: child("n_title", "text").attrs.fill };
    };
    expect(paints("light")).toEqual({ bg: "#FFFFFF", ink: "#111827" });
    expect(paints("dark")).toEqual({ bg: "#000000", ink: "#F8FAFC" });
  });

  it("draws HTML, components and gradients as PNGs the size of the node", () => {
    const plan = planSvg(board, target, context());
    expect(plan.rasters.map((job) => [job.width, job.height])).toEqual([
      [200, 100],
      [100, 100],
      [100, 100],
    ]);
    expect(plan.rasters[0]!.html).toContain("&lt;b&gt;Chart&lt;/b&gt;");
    expect(plan.rasters[1]!.html).toContain("c_button");
    const { child } = read(writeSvg(plan, [], ["CHART", "BUTTON", "GLOW"], board.title));
    expect(child("n_chart", "image").attrs).toEqual({
      width: "200",
      height: "100",
      "xlink:href": "data:image/png;base64,CHART",
    });
    expect(child("n_button", "image").attrs["xlink:href"]).toBe("data:image/png;base64,BUTTON");
    expect(child("n_glow", "image").attrs["xlink:href"]).toBe("data:image/png;base64,GLOW");
  });

  it("fits images with preserveAspectRatio and clips a radius", () => {
    const plan = planSvg(board, target, context());
    const { svg, child } = read(writeSvg(plan, [], [], board.title));
    const photo = child("n_photo", "image").attrs;
    expect(photo).toMatchObject({
      width: "300",
      height: "200",
      preserveAspectRatio: "xMidYMid slice",
      "xlink:href": `https://assets.test/${"a".repeat(64)}.png?w=1&h=2`,
      // clip.1 is the frame's own clip.
      "clip-path": "url(#clip.2)",
    });
    const clip = descendants(svg, "clipPath").find((el) => el.attrs.id === "clip.2")!;
    expect(clip.children[0]!.attrs).toEqual({ width: "300", height: "200", rx: "24" });
    expect(child("n_logo", "image").attrs.preserveAspectRatio).toBe("xMidYMid meet");
    expect(child("n_logo", "image").attrs["clip-path"]).toBeUndefined();
    expect(child("n_stretch", "image").attrs.preserveAspectRatio).toBe("none");
  });

  it("leaves hidden nodes out of the file and the measuring page", () => {
    const plan = planSvg(board, target, context());
    expect(read(writeSvg(plan, [], [], board.title)).group("n_hidden")).toBeUndefined();
    expect(plan.measure!.html).not.toContain("Hidden words");
    expect(plan.measure!.html).toContain('data-node="n_title"');
    expect(plan.measure!.html).toContain('data-node="n_note"');
    expect(plan.measuredChars).toBe(
      "Fish & <chips>\nMatchday 🏆 2-1".length + "Check <this>".length,
    );
  });

  it("puts rotation and opacity on the node's group", () => {
    const plan = planSvg(board, target, context());
    const { group } = read(writeSvg(plan, [], [], board.title));
    expect(group("n_title")!.attrs).toMatchObject({
      "data-name": "Headline",
      transform: "translate(40 40) rotate(15 150 50)",
      opacity: "0.5",
    });
    // The exported frame sits at the origin whatever its place on the page.
    expect(group("n_frame")!.attrs.transform).toBe("translate(0 0)");
    expect(group("n_chart")!.attrs.opacity).toBeUndefined();
  });

  it("has nothing to measure without text", () => {
    const plan = planSvg(document([frame]), target, context());
    expect(plan.measure).toBeNull();
    expect(plan.measuredChars).toBe(0);
  });
});

describe("writeSvg", () => {
  it("sets each measured line as an escaped tspan", () => {
    const plan = planSvg(board, target, context());
    // "Fish & <chips>" | "Matchday 🏆 " (the emoji is two UTF-16 units) | "2-1".
    const lines: TextLines = {
      id: "n_title",
      baseline: 18,
      lineHeight: 28,
      starts: [
        [0, 0],
        [15, 1],
        [27, 2],
      ],
    };
    const text = writeSvg(plan, [lines], [], board.title);
    expect(text).toContain("Fish &amp; &lt;chips&gt;");
    expect(text).not.toContain("<chips>");
    const { child } = read(text);
    const node = child("n_title", "text");
    expect(node.attrs).toMatchObject({
      "font-size": "20",
      "font-weight": "700",
      "text-anchor": "middle",
      "xml:space": "preserve",
    });
    expect(node.children.map((tspan) => [tspan.attrs.x, tspan.attrs.y, tspan.text])).toEqual([
      ["150", "18", "Fish & <chips>"],
      ["150", "46", "Matchday 🏆"],
      ["150", "74", "2-1"],
    ]);
  });

  it("breaks unmeasured text at its hard line breaks", () => {
    const plan = planSvg(board, target, context());
    const { child } = read(writeSvg(plan, [], [], board.title));
    // Baseline: half the 28 px line height plus 0.35 of the 20 px size.
    expect(child("n_title", "text").children.map((tspan) => [tspan.attrs.y, tspan.text])).toEqual([
      ["21", "Fish & <chips>"],
      ["49", "Matchday 🏆 2-1"],
    ]);
    const note = child("n_note", "text").children[0]!;
    expect([note.attrs.x, note.attrs.y, note.text]).toEqual(["12", "26.7", "Check <this>"]);
    expect(child("n_note", "rect").attrs.fill).toBe("#d6e8fb");
  });
});

/** Characters XML 1.0 cannot hold: a noncharacter pair, a lone surrogate and a control. */
const NONCHARACTERS = String.fromCharCode(0xfffe, 0xffff);
const LONE_SURROGATE = String.fromCharCode(0xd800);
const BELL = String.fromCharCode(7);
const forbidden = (text: string) =>
  [...text].filter((character) => {
    const code = character.codePointAt(0)!;
    return code === 0xfffe || code === 0xffff || code === 7 || (code >= 0xd800 && code <= 0xdfff);
  });

describe("exportSvg", () => {
  it.effect(
    "keeps emoji and other characters above U+FFFF in text, layer names and the title",
    () =>
      Effect.gen(function* () {
        const emoji = document(
          [
            { ...frame, name: "Board 🏆" } as DesignNode,
            inFrame({
              id: "n_score",
              type: "text",
              name: `Score 🏆${NONCHARACTERS}`,
              text: `Matchday 🏆 2-1 𠜎 ext-B${LONE_SURROGATE}${BELL}`,
              width: 400,
              height: 60,
            }),
          ],
          `Matchday 🏆 review${NONCHARACTERS}`,
        );
        // "Matchday 🏆 " (the emoji is two UTF-16 units) | "2-1 𠜎 ext-B".
        const lines: TextLines = {
          id: "n_score",
          baseline: 16,
          lineHeight: 22,
          starts: [
            [0, 0],
            [12, 1],
          ],
        };
        const result = yield* exportSvg({
          document: emoji,
          target,
          context: context(),
          render: fakeRender([lines]).render,
        });
        const { svg, group, child } = read(result.text);
        expect(svg.children.find((element) => element.name === "title")!.text).toBe(
          "Matchday 🏆 review",
        );
        expect(group("n_frame")!.attrs["data-name"]).toBe("Board 🏆");
        expect(group("n_score")!.attrs["data-name"]).toBe("Score 🏆");
        expect(child("n_score", "text").children.map((tspan) => tspan.text)).toEqual([
          "Matchday 🏆",
          "2-1 𠜎 ext-B",
        ]);
        expect(forbidden(result.text)).toEqual([]);
      }),
  );

  it.effect("does not open the measuring page without text", () =>
    Effect.gen(function* () {
      const { render, measured, captured } = fakeRender();
      const result = yield* exportSvg({
        document: document([frame]),
        target,
        context: context(),
        render,
      });
      expect(measured).toEqual([]);
      expect(captured).toEqual([0]);
      expect(result).toMatchObject({ width: 800, height: 600 });
    }),
  );

  it.effect("measures text in a viewport no larger than any other capture", () =>
    Effect.gen(function* () {
      const wide = document([
        {
          id: "n_wide",
          parentId: null,
          type: "text",
          text: "A very wide line",
          x: 0,
          y: 0,
          width: 100_000,
          height: 40,
        } as DesignNode,
      ]);
      const { render, measured } = fakeRender();
      yield* exportSvg({
        document: wide,
        target: { pageId: "p_main" },
        context: context(),
        render,
      });
      expect(measured).toHaveLength(1);
      expect([measured[0]!.width, measured[0]!.height]).toEqual([MAX_FIXED_CAPTURE_EDGE, 40]);
      expect(measured[0]!.html).toContain('data-node="n_wide"');
    }),
  );

  it.effect("refuses an image part whose edge is too large for a 2x capture", () =>
    Effect.gen(function* () {
      const huge = document([
        frame,
        inFrame({ id: "n_huge", type: "html", html: "<b>Huge</b>", width: 9_000, height: 100 }),
      ]);
      const failure = yield* Effect.flip(
        exportSvg({ document: huge, target, context: context(), render: fakeRender().render }),
      );
      expect(failure).toMatchObject({ code: "too_large" });
    }),
  );
});
