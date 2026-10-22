import type { DesignDocument, DesignPage } from "@specweave-studio/contracts";
import { applyDesignOperations, newDesignDocument } from "@specweave-studio/shared/designOps";
import { describe, expect, it } from "vite-plus/test";
import {
  alignOperations,
  distributeOperations,
  fitRect,
  indexNodes,
  marqueeSelection,
  pageRect,
  reorderOperations,
  resizeRect,
  screenToPage,
  snapAngle,
  zoomAt,
} from "./geometry";
import {
  createBoxNode,
  createLineNode,
  createPenNode,
  duplicateOperations,
  penPoint,
  toolForKey,
} from "./tools";

function documentWith(): DesignDocument {
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const doc = newDesignDocument({
    id: "d_t",
    kind: "design",
    title: "T",
    now: "2026-10-20T00:00:00.000Z",
    createdBy: { kind: "user" },
    random,
  });
  const page = doc.pages[0]!;
  const frame = page.nodes[0]!;
  const outcome = applyDesignOperations(doc, [
    { op: "update_node", pageId: page.id, id: frame.id, patch: { x: 100, y: 100 } },
    ...[0, 1, 2].map((i) => ({
      op: "add_node" as const,
      pageId: page.id,
      node: {
        id: `n_r${i}`,
        parentId: frame.id,
        type: "rect" as const,
        x: 10 + i * 50 + (i === 2 ? 100 : 0),
        y: 10 * i,
        width: 20,
        height: 20,
      },
    })),
  ]);
  if (!outcome.ok) throw new Error(outcome.error.detail);
  return outcome.document;
}

const run = (doc: DesignDocument, ops: Parameters<typeof applyDesignOperations>[1]) => {
  const outcome = applyDesignOperations(doc, ops);
  if (!outcome.ok) throw new Error(outcome.error.detail);
  return outcome.document;
};

describe("tools", () => {
  it("maps single keys to tools", () => {
    expect(toolForKey("V")).toBe("select");
    expect(toolForKey("f")).toBe("frame");
    expect(toolForKey("o")).toBe("ellipse");
    expect(toolForKey("x")).toBeNull();
  });

  it("creates a rectangle inside the frame under the pointer, relative to it", () => {
    const doc = documentWith();
    const page = doc.pages[0]!;
    const { operation, node } = createBoxNode(
      "rect",
      { page, index: indexNodes(page) },
      { x: 150, y: 160 },
      { x: 190, y: 170 },
      true,
    );
    expect(node).toMatchObject({
      parentId: page.nodes[0]!.id,
      x: 50,
      y: 60,
      width: 40,
      height: 40,
    });
    const next = run(doc, [operation]);
    expect(pageRect(indexNodes(next.pages[0]!), node)).toEqual({
      x: 150,
      y: 160,
      width: 40,
      height: 40,
    });
  });

  it("creates a top-level frame with the default size on a click outside frames", () => {
    const doc = documentWith();
    const page = doc.pages[0]!;
    const { node } = createBoxNode(
      "frame",
      { page, index: indexNodes(page), frameCount: 1 },
      { x: -900, y: 0 },
      { x: -900, y: 0 },
      false,
    );
    expect(node).toMatchObject({
      parentId: null,
      type: "frame",
      name: "Frame 2",
      width: 400,
      height: 300,
    });
  });

  it("draws lines snapped to 45 degrees and pen polylines", () => {
    const doc = documentWith();
    const page = doc.pages[0]!;
    const context = { page, index: indexNodes(page) };
    expect(snapAngle({ x: 0, y: 0 }, { x: 100, y: 8 })).toEqual({ x: 100, y: 0 });
    const line = createLineNode(context, { x: -500, y: 0 }, { x: -400, y: 95 }, true);
    expect(line?.node).toMatchObject({
      type: "line",
      points: [
        [0, 0],
        [98, 98],
      ],
    });
    expect(createLineNode(context, { x: 0, y: 0 }, { x: 1, y: 1 }, false)).toBeNull();
    const points = [{ x: -500, y: -500 }];
    points.push(penPoint(points, { x: -400, y: -495 }, true));
    points.push(penPoint(points, { x: -400, y: -300 }, false));
    const pen = createPenNode(context, points, false);
    expect(pen?.node).toMatchObject({
      type: "path",
      x: -500,
      y: -500,
      points: [
        [0, 0],
        [100, 0],
        [100, 200],
      ],
    });
    expect(run(doc, [pen!.operation]).pages[0]!.nodes.at(-1)!.type).toBe("path");
  });

  it("duplicates a frame with its children under new ids", () => {
    const doc = documentWith();
    const page = doc.pages[0]!;
    const { operations, newIds } = duplicateOperations(page, [page.nodes[0]!.id], 20);
    expect(newIds).toHaveLength(1);
    expect(operations).toHaveLength(4);
    const next = run(doc, operations);
    expect(next.pages[0]!.nodes).toHaveLength(8);
    expect(next.pages[0]!.nodes[4]).toMatchObject({ x: 120, y: 120 });
  });
});

describe("geometry", () => {
  it("zooms around the pointer and fits a rect", () => {
    const camera = zoomAt({ x: 0, y: 0, zoom: 1 }, 2, { x: 100, y: 100 });
    expect(screenToPage(camera, { x: 100, y: 100 })).toEqual({ x: 100, y: 100 });
    const fit = fitRect(
      { x: 0, y: 0, width: 1000, height: 500 },
      { width: 600, height: 400 },
      1,
      50,
    );
    expect(fit.zoom).toBeCloseTo(0.5);
  });

  it("resizes from every handle, keeping aspect with Shift", () => {
    const rect = { x: 0, y: 0, width: 100, height: 50 };
    expect(resizeRect(rect, "se", { x: 10, y: 10 }, false)).toEqual({
      x: 0,
      y: 0,
      width: 110,
      height: 60,
    });
    expect(resizeRect(rect, "nw", { x: 10, y: 10 }, false)).toEqual({
      x: 10,
      y: 10,
      width: 90,
      height: 40,
    });
    expect(resizeRect(rect, "e", { x: 100, y: 0 }, true)).toEqual({
      x: 0,
      y: -25,
      width: 200,
      height: 100,
    });
    expect(resizeRect(rect, "se", { x: 100, y: 0 }, true)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    });
  });

  it("aligns, distributes and selects by marquee", () => {
    const doc = documentWith();
    const page: DesignPage = doc.pages[0]!;
    const index = indexNodes(page);
    const ids = ["n_r0", "n_r1", "n_r2"];
    const aligned = run(doc, alignOperations(page, index, ids, "top"));
    expect(aligned.pages[0]!.nodes.filter((n) => ids.includes(n.id)).map((n) => n.y)).toEqual([
      0, 0, 0,
    ]);
    const spread = run(doc, distributeOperations(page, index, ids, "horizontal"));
    expect(spread.pages[0]!.nodes.filter((n) => ids.includes(n.id)).map((n) => n.x)).toEqual([
      10, 110, 210,
    ]);
    const frameId = page.nodes[0]!.id;
    expect(
      marqueeSelection(page, index, frameId, { x: 100, y: 100, width: 90, height: 40 }),
    ).toEqual(["n_r0", "n_r1"]);
  });

  it("brings nodes forward and back among siblings", () => {
    const doc = documentWith();
    const page = doc.pages[0]!;
    const forward = run(doc, reorderOperations(page, ["n_r0"], "forward"));
    expect(forward.pages[0]!.nodes.map((n) => n.id).slice(1)).toEqual(["n_r1", "n_r0", "n_r2"]);
    const front = run(doc, reorderOperations(page, ["n_r0"], "front"));
    expect(front.pages[0]!.nodes.map((n) => n.id).slice(1)).toEqual(["n_r1", "n_r2", "n_r0"]);
    const back = run(doc, reorderOperations(page, ["n_r2"], "back"));
    expect(back.pages[0]!.nodes.map((n) => n.id).slice(1)).toEqual(["n_r2", "n_r0", "n_r1"]);
  });
});
