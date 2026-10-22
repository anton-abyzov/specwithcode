import type { DesignDocument, DesignOperation } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyDesignOperations,
  designAccess,
  designAccessAllows,
  designBoundThread,
  designId,
  designOperationWrites,
  designSubtreeIds,
  designWritesOverlap,
  newDesignDocument,
} from "./designOps.ts";

const seeded = () => {
  let seed = 7;
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
};

function fixture(): DesignDocument {
  const document = newDesignDocument({
    id: "d_fixture",
    kind: "design",
    title: "Fixture",
    now: "2026-10-20T00:00:00.000Z",
    createdBy: { kind: "user" },
    random: seeded(),
  });
  return document;
}

const frameOf = (document: DesignDocument) => document.pages[0]!.nodes[0]!;
const pageOf = (document: DesignDocument) => document.pages[0]!;

function apply(document: DesignDocument, operations: DesignOperation[]): DesignDocument {
  const outcome = applyDesignOperations(document, operations);
  if (!outcome.ok) throw new Error(outcome.error.detail);
  return outcome.document;
}

describe("designOps", () => {
  it("creates a one-page document with a frame sized for its kind", () => {
    const design = fixture();
    expect(design.pages).toHaveLength(1);
    expect(frameOf(design)).toMatchObject({ type: "frame", width: 1440, height: 1024 });
    const slides = newDesignDocument({
      id: "d_slides",
      kind: "slides",
      title: "Deck",
      now: "2026-10-20T00:00:00.000Z",
      createdBy: { kind: "user" },
    });
    expect(slides.pages[0]!.nodes[0]).toMatchObject({ width: 1920, height: 1080 });
    expect(designId("n", seeded())).toMatch(/^n_[a-z0-9]{12}$/);
  });

  it("adds, updates, moves and deletes nodes without mutating the input", () => {
    const design = fixture();
    const frozen = JSON.stringify(design);
    const page = pageOf(design);
    const frame = frameOf(design);
    const next = apply(design, [
      {
        op: "add_node",
        pageId: page.id,
        node: { id: "r1", parentId: frame.id, type: "rect", x: 1, y: 2, width: 3, height: 4 },
      },
      { op: "update_node", pageId: page.id, id: "r1", patch: { fill: "#123456", x: 10 } },
      {
        op: "add_node",
        pageId: page.id,
        node: {
          id: "t1",
          parentId: null,
          type: "text",
          text: "Hi",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        },
      },
      { op: "move_node", pageId: page.id, id: "t1", parentId: frame.id, index: 1 },
    ]);
    expect(JSON.stringify(design)).toBe(frozen);
    const nodes = pageOf(next).nodes;
    expect(nodes.map((node) => node.id)).toEqual([frame.id, "t1", "r1"]);
    expect(nodes.find((node) => node.id === "r1")).toMatchObject({ fill: "#123456", x: 10 });
    expect(nodes.find((node) => node.id === "t1")?.parentId).toBe(frame.id);

    const removed = apply(next, [{ op: "delete_node", pageId: page.id, id: frame.id }]);
    expect(pageOf(removed).nodes).toHaveLength(0);
  });

  it("removes optional fields when the patch value is null", () => {
    const design = fixture();
    const next = apply(design, [
      {
        op: "update_node",
        pageId: pageOf(design).id,
        id: frameOf(design).id,
        patch: { fill: null },
      },
    ]);
    expect(frameOf(next)).not.toHaveProperty("fill");
  });

  it("rejects bad operations with a typed error and the failing index", () => {
    const design = fixture();
    const page = pageOf(design);
    const cases: Array<[DesignOperation[], string]> = [
      [[{ op: "delete_node", pageId: page.id, id: "missing" }], "not_found"],
      [[{ op: "update_node", pageId: "nope", id: "x", patch: {} }], "not_found"],
      [
        [{ op: "update_node", pageId: page.id, id: frameOf(design).id, patch: { type: "rect" } }],
        "invalid",
      ],
      [
        [{ op: "update_node", pageId: page.id, id: frameOf(design).id, patch: { width: -5 } }],
        "invalid",
      ],
      [
        [
          {
            op: "add_node",
            pageId: page.id,
            node: {
              id: frameOf(design).id,
              parentId: null,
              type: "rect",
              x: 0,
              y: 0,
              width: 1,
              height: 1,
            },
          },
        ],
        "invalid",
      ],
      [[{ op: "delete_page", pageId: page.id }], "invalid"],
    ];
    for (const [operations, code] of cases) {
      const outcome = applyDesignOperations(design, operations);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.code).toBe(code);
        expect(outcome.error.index).toBe(0);
      }
    }
  });

  it("is atomic: a failing operation discards the whole batch", () => {
    const design = fixture();
    const page = pageOf(design);
    const outcome = applyDesignOperations(design, [
      { op: "set_title", title: "Renamed" },
      { op: "delete_node", pageId: page.id, id: "missing" },
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.index).toBe(1);
    expect(design.title).toBe("Fixture");
  });

  it("refuses to move a frame into its own subtree or under a non-frame", () => {
    const design = fixture();
    const page = pageOf(design);
    const frame = frameOf(design);
    const withChild = apply(design, [
      {
        op: "add_node",
        pageId: page.id,
        node: { id: "inner", parentId: frame.id, type: "frame", x: 0, y: 0, width: 10, height: 10 },
      },
      {
        op: "add_node",
        pageId: page.id,
        node: { id: "dot", parentId: null, type: "ellipse", x: 0, y: 0, width: 1, height: 1 },
      },
    ]);
    expect(designSubtreeIds(pageOf(withChild), frame.id)).toEqual(new Set([frame.id, "inner"]));
    const intoSelf = applyDesignOperations(withChild, [
      { op: "move_node", pageId: page.id, id: frame.id, parentId: "inner" },
    ]);
    expect(intoSelf.ok).toBe(false);
    const underShape = applyDesignOperations(withChild, [
      { op: "move_node", pageId: page.id, id: "inner", parentId: "dot" },
    ]);
    expect(underShape.ok).toBe(false);
  });

  it("manages pages and comments", () => {
    const design = fixture();
    const page = pageOf(design);
    const next = apply(design, [
      { op: "add_page", page: { id: "p2", name: "Two", nodes: [] } },
      { op: "update_page", pageId: "p2", name: "Second", skipped: true, notes: "Say hi" },
      { op: "move_page", pageId: "p2", index: 0 },
      {
        op: "add_comment",
        comment: {
          id: "c1",
          pageId: page.id,
          nodeId: frameOf(design).id,
          x: 0,
          y: 0,
          text: "Tighter",
          author: { kind: "user" },
          createdAt: "2026-10-20T00:00:00.000Z",
          resolved: false,
        },
      },
      { op: "resolve_comment", commentId: "c1", resolved: true },
    ]);
    expect(next.pages.map((candidate) => candidate.name)).toEqual(["Second", page.name]);
    expect(next.pages[0]).toMatchObject({ skipped: true, notes: "Say hi" });
    expect(next.comments[0]?.resolved).toBe(true);
    // Deleting a node unpins its comments instead of losing them.
    const unpinned = apply(next, [{ op: "delete_node", pageId: page.id, id: frameOf(design).id }]);
    expect(unpinned.comments[0]?.nodeId).toBeNull();
    // Deleting a page drops its comments.
    const dropped = apply(unpinned, [{ op: "delete_page", pageId: page.id }]);
    expect(dropped.comments).toHaveLength(0);
  });

  it("reports which keys an operation writes so concurrent edits rebase", () => {
    const fill: DesignOperation = {
      op: "update_node",
      pageId: "p",
      id: "n",
      patch: { fill: "#000" },
    };
    const move: DesignOperation = { op: "update_node", pageId: "p", id: "n", patch: { x: 1 } };
    const remove: DesignOperation = { op: "delete_node", pageId: "p", id: "n" };
    expect(
      designWritesOverlap(designOperationWrites(fill), new Set(designOperationWrites(move))),
    ).toBe(false);
    expect(
      designWritesOverlap(designOperationWrites(fill), new Set(designOperationWrites(fill))),
    ).toBe(true);
    expect(
      designWritesOverlap(designOperationWrites(remove), new Set(designOperationWrites(fill))),
    ).toBe(true);
    expect(
      designWritesOverlap(designOperationWrites(fill), new Set(designOperationWrites(remove))),
    ).toBe(true);
  });

  it("scopes reorder writes to the moved node", () => {
    const moveA: DesignOperation = { op: "move_node", pageId: "p", id: "a", index: 0 };
    const moveB: DesignOperation = { op: "move_node", pageId: "p", id: "b", index: 3 };
    const removeA: DesignOperation = { op: "delete_node", pageId: "p", id: "a" };
    expect(designOperationWrites(moveA)).toEqual(["node:a:parentId", "node:a:order"]);
    expect(
      designWritesOverlap(designOperationWrites(moveA), new Set(designOperationWrites(moveB))),
    ).toBe(false);
    expect(
      designWritesOverlap(designOperationWrites(moveA), new Set(designOperationWrites(moveA))),
    ).toBe(true);
    expect(
      designWritesOverlap(designOperationWrites(removeA), new Set(designOperationWrites(moveA))),
    ).toBe(true);
  });

  it("binds a thread and sets access, with defaults when absent", () => {
    const design = fixture();
    expect(designBoundThread(design)).toBeNull();
    expect(designAccess(design)).toEqual({ members: "edit", agents: "edit" });
    const thread = { environmentId: "env-1", threadId: "thread-1" } as never;
    const bound = apply(design, [
      { op: "set_thread", thread },
      { op: "set_access", agents: "comment" },
    ]);
    expect(designBoundThread(bound)).toEqual(thread);
    expect(designAccess(bound)).toEqual({ members: "edit", agents: "comment" });
    const unbound = apply(bound, [{ op: "set_thread", thread: null }]);
    expect(unbound).not.toHaveProperty("thread");
    expect(designOperationWrites({ op: "set_access", members: "view" })).toEqual([
      "access:members",
    ]);
  });

  it("limits comment and view audiences to the operations they may apply", () => {
    const comment: DesignOperation = { op: "resolve_comment", commentId: "c", resolved: true };
    const edit: DesignOperation = { op: "set_title", title: "x" };
    expect(designAccessAllows("edit", [edit, comment])).toBe(true);
    expect(designAccessAllows("comment", [comment])).toBe(true);
    expect(designAccessAllows("comment", [comment, edit])).toBe(false);
    expect(designAccessAllows("view", [comment])).toBe(false);
  });
});
