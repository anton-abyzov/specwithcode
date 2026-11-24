// @effect-diagnostics nodeBuiltinImport:off -- Fixture files and a scratch project folder use node:fs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  WHITEBOARD_LIMITS,
  mergeWhiteboardSave,
  parseWhiteboard,
  summarizeWhiteboard,
  whiteboardRevision,
} from "@specweave-studio/shared/officeWhiteboard";
import { Tool } from "effect/ai";
import { afterAll, describe, expect, it } from "@effect/vitest";

import { ProjectLibraryProblem } from "../../../project/ProjectLibrary.ts";
import {
  readWhiteboardArtifact,
  writeWhiteboardArtifact,
} from "../../../project/WhiteboardArtifacts.ts";
import {
  type SceneElement,
  SkeletonError,
  buildScene,
  fractionalIndex,
} from "../../../project/whiteboardBuild.ts";
import { lintScene } from "../../../project/whiteboardLint.ts";
import { WhiteboardToolkit } from "./whiteboard.ts";

const fixtures = NodePath.join(import.meta.dirname, "fixtures");
const lifecycleText = NodeFS.readFileSync(
  NodePath.join(fixtures, "specweave-lifecycle.excalidraw"),
  "utf8",
);
const lifecycleSkeleton = JSON.parse(
  NodeFS.readFileSync(NodePath.join(fixtures, "specweave-lifecycle.skeleton.json"), "utf8"),
) as Array<Record<string, unknown>>;

const roots: string[] = [];
function scratchProject(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "whiteboard-"));
  roots.push(root);
  NodeFS.mkdirSync(NodePath.join(root, ".specweave"));
  return root;
}
afterAll(() => {
  for (const root of roots) NodeFS.rmSync(root, { recursive: true, force: true });
});

const byId = (elements: ReadonlyArray<SceneElement>) =>
  new Map(elements.map((element) => [element.id, element]));

describe("buildScene", () => {
  it("turns a shape label into bound text, never an empty box", () => {
    const { elements } = buildScene([
      { type: "rectangle", id: "a", x: 0, y: 0, width: 150, height: 80, label: "Spec" },
    ]);
    const map = byId(elements);
    const box = map.get("a")!;
    const text = map.get("a-label")!;
    expect(box.boundElements).toEqual([{ type: "text", id: "a-label" }]);
    expect(box).not.toHaveProperty("label");
    expect(text).toMatchObject({
      type: "text",
      containerId: "a",
      text: "Spec",
      originalText: "Spec",
      textAlign: "center",
      verticalAlign: "middle",
      fontFamily: 5,
      lineHeight: 1.25,
    });
    // Bound text sits right after its container.
    expect(elements.map((element) => element.id)).toEqual(["a", "a-label"]);
    // The label is centred in the box.
    expect(text.x + text.width / 2).toBeCloseTo(box.x + box.width / 2, 1);
    expect(text.y + text.height / 2).toBeCloseTo(box.y + box.height / 2, 1);
  });

  it("grows a box to fit a long label and wraps with fixedWidth", () => {
    const grown = byId(
      buildScene([
        {
          type: "rectangle",
          id: "a",
          x: 0,
          y: 0,
          width: 60,
          height: 40,
          label: "Supercalifragilistic",
        },
      ]).elements,
    ).get("a")!;
    expect(grown.width).toBeGreaterThan(60);
    const fixed = byId(
      buildScene([
        {
          type: "rectangle",
          id: "b",
          x: 0,
          y: 0,
          width: 120,
          height: 40,
          fixedWidth: true,
          label: "one two three four five six",
        },
      ]).elements,
    );
    expect(fixed.get("b")!.width).toBe(120);
    expect(String(fixed.get("b-label")!.text)).toContain("\n");
    expect(fixed.get("b")!.height).toBeGreaterThan(40);
  });

  it("binds arrows from and to both ways, on the shapes' edges", () => {
    const { elements } = buildScene([
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 60 },
      { type: "ellipse", id: "b", x: 300, y: 0, width: 100, height: 60 },
      { type: "arrow", id: "ab", from: "a", to: "b", label: "next" },
    ]);
    const map = byId(elements);
    const arrow = map.get("ab")!;
    expect(arrow.startBinding).toMatchObject({ elementId: "a" });
    expect(arrow.endBinding).toMatchObject({ elementId: "b" });
    expect(map.get("a")!.boundElements).toContainEqual({ type: "arrow", id: "ab" });
    expect(map.get("b")!.boundElements).toContainEqual({ type: "arrow", id: "ab" });
    expect(arrow.points).toEqual([
      [0, 0],
      [192, 0],
    ]);
    expect(arrow.x).toBe(104);
    expect(arrow.boundElements).toEqual([{ type: "text", id: "ab-label" }]);
    expect(map.get("ab-label")!.containerId).toBe("ab");
  });

  it("routes ortho arrows as an L and keeps width and height the points' extents", () => {
    const arrow = byId(
      buildScene([
        { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 60 },
        { type: "rectangle", id: "b", x: 300, y: 200, width: 100, height: 60 },
        { type: "arrow", id: "ab", from: "a", to: "b", route: "ortho" },
      ]).elements,
    ).get("ab")!;
    const points = arrow.points as number[][];
    expect(points).toHaveLength(4);
    expect(points[0]).toEqual([0, 0]);
    const xs = points.map((point) => point[0]!);
    const ys = points.map((point) => point[1]!);
    expect(arrow.width).toBeCloseTo(Math.max(...xs) - Math.min(...xs), 1);
    expect(arrow.height).toBeCloseTo(Math.max(...ys) - Math.min(...ys), 1);
  });

  it("normalizes free arrow points to start at the origin", () => {
    const arrow = byId(
      buildScene([
        {
          type: "arrow",
          id: "z",
          x: 10,
          y: 10,
          points: [
            [5, 5],
            [105, 5],
          ],
        },
      ]).elements,
    ).get("z")!;
    expect(arrow).toMatchObject({
      x: 15,
      y: 15,
      points: [
        [0, 0],
        [100, 0],
      ],
      width: 100,
    });
  });

  it("captions a zone top-left instead of binding a label to it", () => {
    const map = byId(
      buildScene([
        { type: "zone", id: "z", x: 0, y: 0, width: 400, height: 300, label: "Data layer" },
      ]).elements,
    );
    expect(map.get("z")!.type).toBe("rectangle");
    expect(map.get("z")!.boundElements).toBeNull();
    expect(map.get("z-zone")).toMatchObject({ type: "text", containerId: null, x: 12, y: 8 });
  });

  it("refuses arrows to shapes not yet defined and duplicate ids", () => {
    expect(() => buildScene([{ type: "arrow", id: "x", from: "a", to: "b" }])).toThrow(
      SkeletonError,
    );
    expect(() =>
      buildScene([
        { type: "rectangle", id: "a" },
        { type: "rectangle", id: "a" },
      ]),
    ).toThrow(/duplicate/);
  });

  it("drops deleted ids with their bound text and repairs bindings", () => {
    const { elements } = buildScene([
      { type: "rectangle", id: "a", x: 0, y: 0, label: "A" },
      { type: "rectangle", id: "b", x: 300, y: 0, label: "B" },
      { type: "arrow", id: "ab", from: "a", to: "b" },
      { type: "delete", ids: "b" },
      { type: "cameraUpdate", width: 800, height: 600 },
    ]);
    const map = byId(elements);
    expect(map.has("b")).toBe(false);
    expect(map.has("b-label")).toBe(false);
    expect(map.get("ab")!.endBinding).toBeNull();
  });

  it("drops links and unknown style values from a skeleton", () => {
    const box = byId(
      buildScene([
        {
          type: "rectangle",
          id: "a",
          link: "javascript:alert(1)",
          strokeStyle: "wavy",
          backgroundColor: "#a5d8ff",
        },
      ]).elements,
    ).get("a")!;
    expect(box.link).toBeNull();
    expect(box.strokeStyle).toBe("solid");
    expect(box.backgroundColor).toBe("#a5d8ff");
  });

  it("writes valid ascending fractional indices", () => {
    const keys = Array.from({ length: 4000 }, (_, index) => fractionalIndex(index));
    expect(keys.slice(0, 3)).toEqual(["a0", "a1", "a2"]);
    expect(keys[62]).toBe("b00");
    for (let index = 1; index < keys.length; index += 1) {
      expect(keys[index - 1]! < keys[index]!).toBe(true);
      expect(keys[index]!.endsWith("0") && keys[index]!.length === 2 ? false : true).toBe(true);
    }
  });

  it("builds the vskill lifecycle skeleton like the Python builder did", () => {
    const python = parseWhiteboard(lifecycleText);
    if (!python.ok) throw new Error(python.error);
    const ours = buildScene(lifecycleSkeleton).elements;
    const theirs = python.file.elements;
    expect(ours.map((element) => element.id)).toEqual(theirs.map((element) => element.id));
    const keys = [
      "type",
      "x",
      "y",
      "width",
      "height",
      "containerId",
      "text",
      "boundElements",
      "startBinding",
      "endBinding",
      "points",
    ];
    theirs.forEach((expected, index) => {
      const actual = ours[index]!;
      for (const key of keys) {
        const want = expected[key];
        const got = actual[key];
        if (typeof want === "number") expect(got, `${actual.id}.${key}`).toBeCloseTo(want, 1);
        else if (want !== undefined) expect(got, `${actual.id}.${key}`).toEqual(want);
      }
    });
    expect(lintScene(ours).errors).toEqual([]);
  });
});

describe("lintScene", () => {
  it("flags an empty box, a missing reciprocity and an overflowing label", () => {
    const report = lintScene([
      { id: "a", type: "rectangle", x: 0, y: 0, width: 40, height: 40, text: "inline" },
      {
        id: "t",
        type: "text",
        x: 0,
        y: 0,
        width: 10,
        height: 25,
        text: "A long label for a small box",
        fontSize: 20,
        fontFamily: 5,
        lineHeight: 1.25,
        containerId: "a",
      },
      {
        id: "r",
        type: "arrow",
        x: 0,
        y: 0,
        width: 10,
        height: 0,
        points: [
          [0, 0],
          [10, 0],
        ],
        startBinding: { elementId: "missing" },
      },
    ]);
    const rules = report.errors.map((line) => line.split(":")[0]);
    expect(rules).toEqual(
      expect.arrayContaining([
        "R14-INLINE-TEXT",
        "R15-RECIPROCITY",
        "R1-LABEL-WIDTH",
        "R13-DANGLING",
      ]),
    );
  });
});

describe("whiteboard files", () => {
  it("reads a file from excalidraw.com and summarizes labels and arrow ends", () => {
    const parsed = parseWhiteboard(lifecycleText);
    if (!parsed.ok) throw new Error(parsed.error);
    const summary = summarizeWhiteboard(parsed.file);
    expect(summary.find((element) => element.id === "b1")).toMatchObject({ label: "Idea / Issue" });
    expect(summary.find((element) => element.id === "a1")).toMatchObject({ from: "b1", to: "b2" });
    expect(summary.some((element) => element.id === "b1-label")).toBe(false);
  });

  it("keeps fields and image entries the editor does not load on save", () => {
    const source = JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "https://excalidraw.com",
      elements: [],
      appState: {},
      files: {
        ok: { id: "ok", mimeType: "image/png", dataURL: "data:image/png;base64,iVBORw0KGgo=" },
        remote: { id: "remote", mimeType: "image/png", dataURL: "https://example.com/a.png" },
      },
      libraryItems: ["kept"],
    });
    const parsed = parseWhiteboard(source);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(Object.keys(parsed.file.files)).toEqual(["ok"]);
    expect(Object.keys(parsed.file.heldFiles)).toEqual(["remote"]);
    const serialized = JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "app",
      elements: [{ id: "x" }],
      appState: { viewBackgroundColor: "#fff" },
      files: { ok: parsed.file.files.ok },
    });
    const merged = JSON.parse(mergeWhiteboardSave(serialized, parsed.file));
    expect(merged.libraryItems).toEqual(["kept"]);
    expect(Object.keys(merged.files).sort()).toEqual(["ok", "remote"]);
    expect(merged.elements).toEqual([{ id: "x" }]);
  });

  it("refuses libraries and non-drawings", () => {
    expect(parseWhiteboard('{"type":"excalidrawlib"}').ok).toBe(false);
    expect(parseWhiteboard("[1,2]").ok).toBe(false);
    expect(parseWhiteboard("not json").ok).toBe(false);
    expect(parseWhiteboard("").ok).toBe(true);
  });
});

describe("whiteboard artifacts on disk", () => {
  it("writes, reads, appends with binding to existing shapes, and checks revisions", async () => {
    const root = scratchProject();
    const first = await writeWhiteboardArtifact(root, {
      title: "Release flow",
      elements: [{ type: "rectangle", id: "a", x: 0, y: 0, label: "Build" }],
    });
    expect(first).toMatchObject({
      name: "release-flow",
      relativePath: ".specweave/artifacts/release-flow.excalidraw",
      created: true,
    });
    const onDisk = NodeFS.readFileSync(NodePath.join(root, first.relativePath), "utf8");
    expect(whiteboardRevision(onDisk)).toBe(first.revision);
    expect(JSON.parse(onDisk)).toMatchObject({ type: "excalidraw", version: 2 });

    const second = await writeWhiteboardArtifact(root, {
      name: "release-flow",
      append: true,
      expectedRevision: first.revision,
      elements: [
        { type: "rectangle", id: "b", x: 300, y: 0, label: "Ship" },
        { type: "arrow", id: "ab", from: "a", to: "b" },
      ],
    });
    const read = await readWhiteboardArtifact(root, { name: "release-flow" });
    expect(read.revision).toBe(second.revision);
    const summary = summarizeWhiteboard(read.file);
    expect(summary.find((element) => element.id === "ab")).toMatchObject({ from: "a", to: "b" });
    expect(read.lint.errors).toEqual([]);

    await expect(
      writeWhiteboardArtifact(root, {
        name: "release-flow",
        expectedRevision: first.revision,
        elements: [],
      }),
    ).rejects.toThrow(/Conflict/);
  });

  it("names unnamed shapes apart from the file's own when appending", async () => {
    const root = scratchProject();
    const first = await writeWhiteboardArtifact(root, {
      title: "Unnamed",
      elements: [{ type: "rectangle", x: 0, y: 0 }],
    });
    const second = await writeWhiteboardArtifact(root, {
      name: first.name,
      append: true,
      elements: [
        { type: "rectangle", x: 300, y: 0 },
        { type: "ellipse", id: "el-1-2", x: 600, y: 0 },
      ],
    });
    const ids = second.file.elements.map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("el-1");

    // An unnamed labelled shape owns its label's id as well.
    const labelled = await writeWhiteboardArtifact(root, {
      title: "Labelled",
      elements: [{ type: "rectangle", x: 0, y: 0, label: "One" }],
    });
    const more = await writeWhiteboardArtifact(root, {
      name: labelled.name,
      append: true,
      elements: [{ type: "rectangle", x: 300, y: 0, label: "Two" }],
    });
    const all = more.file.elements.map((element) => element.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it("refuses a write over the element limit and keeps the file", async () => {
    const root = scratchProject();
    const first = await writeWhiteboardArtifact(root, {
      title: "Crowded",
      elements: [{ type: "rectangle", id: "keep", x: 0, y: 0 }],
    });
    const path = NodePath.join(root, first.relativePath);
    const crowded = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    const keep = crowded.elements[0];
    crowded.elements = Array.from({ length: WHITEBOARD_LIMITS.elements }, (_, i) => ({
      ...keep,
      id: `k${i}`,
    }));
    NodeFS.writeFileSync(path, JSON.stringify(crowded));
    const before = NodeFS.readFileSync(path, "utf8");
    await expect(
      writeWhiteboardArtifact(root, {
        name: first.name,
        append: true,
        elements: [{ type: "rectangle", x: 0, y: 0 }],
      }),
    ).rejects.toThrow();
    expect(NodeFS.readFileSync(path, "utf8")).toBe(before);
  });

  it("reads any .excalidraw in the project by path, and refuses paths outside it", async () => {
    const root = scratchProject();
    NodeFS.mkdirSync(NodePath.join(root, "docs"));
    NodeFS.writeFileSync(NodePath.join(root, "docs", "flow.excalidraw"), lifecycleText);
    const read = await readWhiteboardArtifact(root, { path: "docs/flow.excalidraw" });
    expect(read.file.elements).toHaveLength(30);
    for (const path of [
      "../flow.excalidraw",
      "/etc/passwd",
      "docs/flow.json",
      "docs/../x.excalidraw",
    ]) {
      await expect(readWhiteboardArtifact(root, { path })).rejects.toBeInstanceOf(
        ProjectLibraryProblem,
      );
    }
  });

  it("refuses a project without .specweave and a bad name", async () => {
    const bare = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "whiteboard-bare-"));
    roots.push(bare);
    await expect(writeWhiteboardArtifact(bare, { title: "x", elements: [] })).rejects.toThrow(
      /specweave/,
    );
    await expect(
      writeWhiteboardArtifact(scratchProject(), { name: "../evil", elements: [] }),
    ).rejects.toThrow(/name/);
  });
});

describe("WhiteboardToolkit", () => {
  it("publishes reference-free object schemas", () => {
    for (const tool of Object.values(WhiteboardToolkit.tools)) {
      const schema = Tool.getJsonSchema(tool);
      expect(schema).toMatchObject({ type: "object" });
      expect(JSON.stringify(schema)).not.toContain('"$ref"');
    }
  });
});
