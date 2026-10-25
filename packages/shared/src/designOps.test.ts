import type { DesignComment, DesignDocument, DesignOperation } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyDesignOperations,
  designAccess,
  designAccessAllows,
  designBoundThread,
  designCommentThreads,
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

  it("threads replies under the first comment", () => {
    const design = fixture();
    const page = pageOf(design);
    const frame = frameOf(design);
    const comment = (id: string, extra: Partial<DesignComment> = {}): DesignOperation => ({
      op: "add_comment",
      comment: {
        id,
        pageId: page.id,
        nodeId: frame.id,
        x: 12,
        y: 8,
        text: `Comment ${id}`,
        author: { kind: "user" },
        createdAt: "2026-10-24T00:00:00.000Z",
        resolved: false,
        ...extra,
      },
    });
    const threaded = apply(design, [
      { op: "add_page", page: { id: "p2", name: "Two", nodes: [] } },
      comment("c_root"),
      comment("c_other", { nodeId: null, x: 100, y: 100 }),
      // A reply sent with another anchor takes the root's.
      comment("c_reply", { parentId: "c_root", pageId: "p2", nodeId: null, x: 1, y: 2 }),
      // A reply to a reply joins the root's thread.
      comment("c_nested", { parentId: "c_reply" }),
    ]);
    const byId = new Map(threaded.comments.map((c) => [c.id, c]));
    for (const id of ["c_reply", "c_nested"])
      expect(byId.get(id)).toMatchObject({
        parentId: "c_root",
        pageId: page.id,
        nodeId: frame.id,
        x: 12,
        y: 8,
      });
    expect(byId.get("c_root")).not.toHaveProperty("parentId");

    const missing = applyDesignOperations(threaded, [comment("c_lost", { parentId: "c_gone" })]);
    expect(missing).toMatchObject({ ok: false, error: { code: "not_found", index: 0 } });

    // Resolving the root, or any reply, resolves and reopens the whole thread.
    const resolved = apply(threaded, [
      { op: "resolve_comment", commentId: "c_root", resolved: true },
    ]);
    expect(resolved.comments.map((c) => [c.id, c.resolved])).toEqual([
      ["c_root", true],
      ["c_other", false],
      ["c_reply", true],
      ["c_nested", true],
    ]);
    const reopened = apply(resolved, [
      { op: "resolve_comment", commentId: "c_nested", resolved: false },
    ]);
    expect(reopened.comments.every((c) => !c.resolved)).toBe(true);
    // A reply to a resolved thread arrives resolved.
    const late = apply(resolved, [comment("c_late", { parentId: "c_root" })]);
    expect(late.comments.at(-1)).toMatchObject({ id: "c_late", resolved: true });

    // Deleting a reply leaves the thread; deleting the root drops its replies.
    const withoutReply = apply(threaded, [{ op: "delete_comment", commentId: "c_reply" }]);
    expect(withoutReply.comments.map((c) => c.id)).toEqual(["c_root", "c_other", "c_nested"]);
    const withoutRoot = apply(threaded, [{ op: "delete_comment", commentId: "c_root" }]);
    expect(withoutRoot.comments.map((c) => c.id)).toEqual(["c_other"]);

    // Replies share the root's page and node, so they unpin and drop with it.
    const unpinned = apply(threaded, [{ op: "delete_node", pageId: page.id, id: frame.id }]);
    expect(unpinned.comments.filter((c) => c.nodeId !== null)).toEqual([]);
    const dropped = apply(threaded, [{ op: "delete_page", pageId: page.id }]);
    expect(dropped.comments).toEqual([]);

    // Threads keep document order, and a reply whose root is gone is a thread of its own.
    const orphan: DesignComment = {
      ...threaded.comments[2]!,
      id: "c_orphan",
      parentId: "c_missing",
    };
    const threads = designCommentThreads([...threaded.comments, orphan]);
    expect(threads.map((t) => [t.root.id, t.replies.map((r) => r.id)])).toEqual([
      ["c_root", ["c_reply", "c_nested"]],
      ["c_other", []],
      ["c_orphan", []],
    ]);
    // Replying to that orphan threads under it rather than failing.
    const adopted = apply({ ...threaded, comments: [...threaded.comments, orphan] }, [
      comment("c_adopted", { parentId: "c_orphan" }),
    ]);
    expect(adopted.comments.at(-1)).toMatchObject({ parentId: "c_orphan" });
    // Links that loop (a hand-edited file) still list every comment once.
    const looped = designCommentThreads([
      { ...orphan, id: "c_a", parentId: "c_b" },
      { ...orphan, id: "c_b", parentId: "c_a" },
    ]);
    expect(looped.map((t) => t.root.id)).toEqual(["c_a", "c_b"]);
    // Reply operations write only their own comment key, like any comment.
    expect(designOperationWrites(comment("c_new", { parentId: "c_root" }))).toEqual([
      "comment:c_new",
    ]);
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
