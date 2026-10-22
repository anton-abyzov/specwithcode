import type { DesignDocument, DesignOperation } from "@specweave-studio/contracts";
import { applyDesignOperations, newDesignDocument } from "@specweave-studio/shared/designOps";
import { describe, expect, it, vi } from "vite-plus/test";
import { designDiff } from "./designDiff";
import { DesignSession, type DesignApplyResponse, type DesignTransport } from "./designSession";

function seeded() {
  let seed = 1;
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

function baseDocument(): DesignDocument {
  return newDesignDocument({
    id: "d_test",
    kind: "design",
    title: "Test",
    now: "2026-10-20T00:00:00.000Z",
    createdBy: { kind: "user" },
    random: seeded(),
  });
}

function apply(document: DesignDocument, operations: readonly DesignOperation[]) {
  const outcome = applyDesignOperations(document, operations);
  if (!outcome.ok) throw new Error(outcome.error.detail);
  return { ...outcome.document, revision: document.revision + 1 };
}

/** An in-memory server with the same revision check as the real store. */
function fakeServer(initial: DesignDocument) {
  let head = initial;
  const calls: (readonly DesignOperation[])[] = [];
  const transport: DesignTransport = {
    apply: async (expectedRevision, operations): Promise<DesignApplyResponse> => {
      calls.push(operations);
      if (expectedRevision !== head.revision)
        return { ok: false, reason: "conflict", currentRevision: head.revision };
      const outcome = applyDesignOperations(head, operations);
      if (!outcome.ok) return { ok: false, reason: "error", detail: outcome.error.detail };
      head = { ...outcome.document, revision: head.revision + 1 };
      return { ok: true, document: head };
    },
    get: async () => head,
  };
  return {
    transport,
    calls,
    get head() {
      return head;
    },
    agentEdit(operations: readonly DesignOperation[]) {
      head = apply(head, operations);
      return head;
    },
  };
}

const pageOf = (document: DesignDocument) => document.pages[0]!;
const frameOf = (document: DesignDocument) => pageOf(document).nodes[0]!;

describe("designDiff", () => {
  it("round-trips adds, deletes, field changes, reparenting and order", () => {
    const before = baseDocument();
    const page = pageOf(before);
    const frame = frameOf(before);
    const after = apply(before, [
      {
        op: "add_node",
        pageId: page.id,
        node: { id: "n_a", parentId: frame.id, type: "rect", x: 1, y: 2, width: 3, height: 4 },
      },
      {
        op: "add_node",
        pageId: page.id,
        node: { id: "n_b", parentId: null, type: "ellipse", x: 0, y: 0, width: 5, height: 5 },
      },
      { op: "update_node", pageId: page.id, id: frame.id, patch: { fill: { token: "bg" } } },
      { op: "move_node", pageId: page.id, id: "n_b", index: 0 },
      { op: "set_title", title: "Renamed" },
    ]);
    const forward = applyDesignOperations(before, designDiff(before, after));
    expect(forward.ok && forward.document.pages).toEqual(after.pages);
    const backward = applyDesignOperations(after, designDiff(after, before));
    expect(backward.ok && backward.document.pages).toEqual(before.pages);
    expect(backward.ok && backward.document.title).toBe("Test");
  });

  it("restores a deleted frame with its children", () => {
    const start = baseDocument();
    const page = pageOf(start);
    const frame = frameOf(start);
    const before = apply(start, [
      {
        op: "add_node",
        pageId: page.id,
        node: {
          id: "n_c",
          parentId: frame.id,
          type: "text",
          text: "Hi",
          x: 0,
          y: 0,
          width: 9,
          height: 9,
        },
      },
    ]);
    const after = apply(before, [{ op: "delete_node", pageId: page.id, id: frame.id }]);
    expect(designDiff(before, after)).toEqual([
      { op: "delete_node", pageId: page.id, id: frame.id },
    ]);
    const restored = applyDesignOperations(after, designDiff(after, before));
    expect(restored.ok && restored.document.pages).toEqual(before.pages);
  });
});

describe("DesignSession", () => {
  it("saves within the autosave delay and confirms the new revision", async () => {
    vi.useFakeTimers();
    const doc = baseDocument();
    const server = fakeServer(doc);
    const session = new DesignSession(doc, server.transport, 400);
    session.commit([
      { op: "update_node", pageId: pageOf(doc).id, id: frameOf(doc).id, patch: { x: 10 } },
    ]);
    session.commit([
      { op: "update_node", pageId: pageOf(doc).id, id: frameOf(doc).id, patch: { y: 20 } },
    ]);
    expect(session.getSnapshot().saveState).toBe("pending");
    await vi.advanceTimersByTimeAsync(450);
    expect(server.calls).toHaveLength(1);
    expect(session.getSnapshot().saveState).toBe("saved");
    expect(session.getSnapshot().base.revision).toBe(1);
    expect(frameOf(server.head)).toMatchObject({ x: 10, y: 20 });
    vi.useRealTimers();
  });

  it("rebases pending edits onto an agent edit to a different field", async () => {
    const doc = baseDocument();
    const server = fakeServer(doc);
    const session = new DesignSession(doc, server.transport, 60_000);
    const page = pageOf(doc).id;
    const frame = frameOf(doc).id;
    session.commit([{ op: "update_node", pageId: page, id: frame, patch: { x: 50 } }]);
    const theirs = server.agentEdit([
      { op: "update_node", pageId: page, id: frame, patch: { fill: "#000000" } },
    ]);
    session.receive(theirs);
    expect(session.getSnapshot().conflict).toBeNull();
    expect(frameOf(session.document)).toMatchObject({ x: 50, fill: "#000000" });
    await session.flush();
    expect(frameOf(server.head)).toMatchObject({ x: 50, fill: "#000000" });
    expect(server.head.revision).toBe(2);
  });

  it("retries after a revision conflict without losing either edit", async () => {
    const doc = baseDocument();
    const server = fakeServer(doc);
    const session = new DesignSession(doc, server.transport, 60_000);
    const page = pageOf(doc).id;
    const frame = frameOf(doc).id;
    session.commit([{ op: "update_node", pageId: page, id: frame, patch: { width: 300 } }]);
    server.agentEdit([{ op: "update_node", pageId: page, id: frame, patch: { name: "Hero" } }]);
    await session.flush();
    await vi.waitFor(() => expect(server.head.revision).toBe(2));
    expect(frameOf(server.head)).toMatchObject({ width: 300, name: "Hero" });
    expect(session.getSnapshot().saveState).toBe("saved");
  });

  it("reports a true conflict and lets the user keep mine or take theirs", async () => {
    for (const choice of ["mine", "theirs"] as const) {
      const doc = baseDocument();
      const server = fakeServer(doc);
      const session = new DesignSession(doc, server.transport, 60_000);
      const page = pageOf(doc).id;
      const frame = frameOf(doc).id;
      session.commit([{ op: "update_node", pageId: page, id: frame, patch: { fill: "#ff0000" } }]);
      session.receive(
        server.agentEdit([
          { op: "update_node", pageId: page, id: frame, patch: { fill: "#00ff00" } },
        ]),
      );
      const conflict = session.getSnapshot().conflict;
      expect(conflict?.keys).toContain(`node:${frame}:fill`);
      expect(session.getSnapshot().saveState).toBe("conflict");
      session.resolveConflict(choice);
      await session.flush();
      const expected = choice === "mine" ? "#ff0000" : "#00ff00";
      expect(frameOf(session.document)).toMatchObject({ fill: expected });
      expect(frameOf(server.head)).toMatchObject({ fill: expected });
    }
  });

  it("take theirs drops only the colliding writes and saves the rest", async () => {
    const doc = baseDocument();
    const server = fakeServer(doc);
    const session = new DesignSession(doc, server.transport, 60_000);
    const page = pageOf(doc).id;
    const frame = frameOf(doc).id;
    session.commit([{ op: "update_node", pageId: page, id: frame, patch: { x: 40 } }]);
    session.commit([
      { op: "update_node", pageId: page, id: frame, patch: { fill: "#ff0000", width: 300 } },
    ]);
    session.receive(
      server.agentEdit([
        { op: "update_node", pageId: page, id: frame, patch: { fill: "#00ff00" } },
      ]),
    );
    expect(session.getSnapshot().saveState).toBe("conflict");
    session.resolveConflict("theirs");
    expect(frameOf(session.document)).toMatchObject({ x: 40, width: 300, fill: "#00ff00" });
    await session.flush();
    expect(frameOf(server.head)).toMatchObject({ x: 40, width: 300, fill: "#00ff00" });
    // The agent's change undoes first; the kept edit then undoes without touching fill.
    const original = frameOf(doc) as { fill?: unknown; width: number };
    session.undo();
    expect(frameOf(session.document)).toMatchObject({ x: 40, width: 300, fill: original.fill });
    session.undo();
    expect(frameOf(session.document)).toMatchObject({
      x: 40,
      width: original.width,
      fill: original.fill,
    });
  });

  it("undoes the user's and the agent's changes in order, and redoes", () => {
    const doc = baseDocument();
    const server = fakeServer(doc);
    const session = new DesignSession(doc, server.transport, 60_000);
    const page = pageOf(doc).id;
    const frame = frameOf(doc).id;
    session.receive(
      server.agentEdit([{ op: "update_node", pageId: page, id: frame, patch: { name: "Agent" } }]),
    );
    session.commit([{ op: "update_node", pageId: page, id: frame, patch: { x: 7 } }]);
    expect(session.getSnapshot().undoSource).toBe("user");
    session.undo();
    expect(frameOf(session.document).x).toBe(0);
    expect(session.getSnapshot().undoSource).toBe("agent");
    session.undo();
    expect(frameOf(session.document).name).toBe("Frame 1");
    session.redo();
    session.redo();
    expect(frameOf(session.document)).toMatchObject({ name: "Agent", x: 7 });
  });

  it("holds a watched revision that arrives during a save until the save returns", async () => {
    const doc = baseDocument();
    let release: (value: DesignApplyResponse) => void = () => {};
    const page = pageOf(doc).id;
    const frame = frameOf(doc).id;
    const saved = apply(doc, [{ op: "update_node", pageId: page, id: frame, patch: { x: 1 } }]);
    const transport: DesignTransport = {
      apply: () => new Promise((resolve) => (release = resolve)),
      get: async () => saved,
    };
    const session = new DesignSession(doc, transport, 60_000);
    session.commit([{ op: "update_node", pageId: page, id: frame, patch: { x: 1 } }]);
    const flushing = session.flush();
    session.receive(saved);
    expect(session.getSnapshot().saveState).toBe("saving");
    release({ ok: true, document: saved });
    await flushing;
    expect(session.getSnapshot().base.revision).toBe(1);
    expect(session.getSnapshot().canUndo).toBe(true);
    expect(session.getSnapshot().undoSource).toBe("user");
  });

  it("shows a preview without recording it", () => {
    const doc = baseDocument();
    const session = new DesignSession(doc, fakeServer(doc).transport, 60_000);
    const page = pageOf(doc).id;
    const frame = frameOf(doc).id;
    session.setPreview([{ op: "update_node", pageId: page, id: frame, patch: { x: 99 } }]);
    expect(frameOf(session.document).x).toBe(99);
    expect(session.getSnapshot().canUndo).toBe(false);
    session.setPreview(null);
    expect(frameOf(session.document).x).toBe(0);
  });
});

describe("DesignSession lifecycle and undo scope", () => {
  it("finishes the in-flight save, then saves what is left after close", async () => {
    const doc = baseDocument();
    const server = fakeServer(doc);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const transport: DesignTransport = {
      apply: async (revision, operations) => {
        if (server.calls.length === 0) await gate;
        return server.transport.apply(revision, operations);
      },
      get: server.transport.get,
    };
    const session = new DesignSession(doc, transport, 60_000);
    const page = pageOf(doc).id;
    const frame = frameOf(doc).id;
    session.commit([{ op: "update_node", pageId: page, id: frame, patch: { x: 1 } }]);
    const first = session.flush();
    session.commit([{ op: "update_node", pageId: page, id: frame, patch: { y: 2 } }]);
    const closed = session.close();
    release();
    await first;
    await expect(closed).resolves.toEqual({ kind: "saved" });
    expect(frameOf(server.head)).toMatchObject({ x: 1, y: 2 });
    expect(server.head.revision).toBe(2);
  });

  it("reports a conflict on the final save instead of dropping it", async () => {
    const doc = baseDocument();
    const server = fakeServer(doc);
    const session = new DesignSession(doc, server.transport, 60_000);
    const page = pageOf(doc).id;
    const frame = frameOf(doc).id;
    session.commit([{ op: "update_node", pageId: page, id: frame, patch: { fill: "#ff0000" } }]);
    server.agentEdit([{ op: "update_node", pageId: page, id: frame, patch: { fill: "#00ff00" } }]);
    const outcome = await session.close();
    expect(outcome.kind).toBe("conflict");
    // The edit survives in the session for the next editor to resolve.
    session.open();
    expect(frameOf(session.document)).toMatchObject({ fill: "#ff0000" });
    session.resolveConflict("mine");
    await session.flush();
    expect(frameOf(server.head)).toMatchObject({ fill: "#ff0000" });
  });

  it("never undoes comments, sharing or the bound thread", () => {
    const doc = baseDocument();
    const server = fakeServer(doc);
    const session = new DesignSession(doc, server.transport, 60_000);
    session.commit([
      {
        op: "add_comment",
        comment: {
          id: "c_1",
          pageId: pageOf(doc).id,
          nodeId: null,
          x: 0,
          y: 0,
          text: "Mine",
          author: { kind: "user" },
          createdAt: "2026-10-20T00:00:00.000Z",
          resolved: false,
        },
      },
    ]);
    expect(session.document.comments).toHaveLength(1);
    expect(session.getSnapshot().canUndo).toBe(false);
    session.receive(
      server.agentEdit([
        { op: "set_access", members: "view" },
        { op: "set_title", title: "Theirs" },
      ]),
    );
    expect(session.getSnapshot().canUndo).toBe(false);
    session.undo();
    expect(session.document.comments?.length ?? 0).toBe(1);
    expect(session.document.title).toBe("Theirs");
  });

  it("after Keep mine, Cmd+Z returns the kept field to the agent's value", () => {
    const doc = baseDocument();
    const server = fakeServer(doc);
    const session = new DesignSession(doc, server.transport, 60_000);
    const page = pageOf(doc).id;
    const frame = frameOf(doc).id;
    session.commit([{ op: "update_node", pageId: page, id: frame, patch: { x: 100 } }]);
    session.receive(
      server.agentEdit([{ op: "update_node", pageId: page, id: frame, patch: { x: 7, y: 9 } }]),
    );
    session.resolveConflict("mine");
    expect(frameOf(session.document)).toMatchObject({ x: 100, y: 9 });
    session.undo();
    expect(frameOf(session.document)).toMatchObject({ x: 7, y: 9 });
    session.undo();
    expect(frameOf(session.document)).toMatchObject({ x: frameOf(doc).x, y: frameOf(doc).y });
  });

  it("backs off and stops with an error when the server keeps refusing a stale revision", async () => {
    vi.useFakeTimers();
    const doc = baseDocument();
    let applies = 0;
    const transport: DesignTransport = {
      apply: async () => {
        applies += 1;
        return { ok: false, reason: "conflict", currentRevision: 0 };
      },
      get: async () => doc,
    };
    const session = new DesignSession(doc, transport, 10);
    const page = pageOf(doc).id;
    session.commit([{ op: "update_node", pageId: page, id: frameOf(doc).id, patch: { x: 3 } }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(applies).toBe(5);
    expect(session.getSnapshot().saveState).toBe("error");
    expect(session.getSnapshot().error).toMatch(/keeps refusing/);
    // Nothing is lost: the edit is still on the canvas.
    expect(frameOf(session.document)).toMatchObject({ x: 3 });
    vi.useRealTimers();
  });
});

describe("DesignSession reorders", () => {
  it("rebases a local reorder over the agent's reorder of another layer without a conflict", () => {
    let doc = baseDocument();
    const page = pageOf(doc).id;
    const frame = frameOf(doc).id;
    doc = apply(doc, [
      {
        op: "add_node",
        pageId: page,
        node: { id: "a", parentId: frame, type: "rect", x: 0, y: 0, width: 1, height: 1 },
      },
      {
        op: "add_node",
        pageId: page,
        node: { id: "b", parentId: frame, type: "rect", x: 0, y: 0, width: 1, height: 1 },
      },
      {
        op: "add_node",
        pageId: page,
        node: { id: "c", parentId: frame, type: "rect", x: 0, y: 0, width: 1, height: 1 },
      },
    ]);
    const server = fakeServer(doc);
    const session = new DesignSession(doc, server.transport, 60_000);
    session.commit([{ op: "move_node", pageId: page, id: "a", index: 3 }]);
    session.receive(server.agentEdit([{ op: "move_node", pageId: page, id: "c", index: 1 }]));
    expect(session.getSnapshot().conflict).toBeNull();
  });
});
