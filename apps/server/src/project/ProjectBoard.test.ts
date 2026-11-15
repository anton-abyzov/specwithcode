// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { boardColumn, ledgerPullRequests, readProjectBoard } from "./ProjectBoard.ts";

const roots: string[] = [];
const NOW = Date.parse("2026-11-14T12:00:00Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true })));
});

async function project(): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "project-board-"));
  roots.push(root);
  await NodeFSP.mkdir(NodePath.join(root, ".specweave", "increments"), { recursive: true });
  return root;
}

const spec = (tasks: number) =>
  [
    "# Example",
    "",
    "## Tasks",
    "",
    ...Array.from({ length: tasks }, (_, index) => {
      const id = `T-${String(index + 1).padStart(2, "0")}`;
      return `### ${id} Step ${index + 1}\n- AC: AC-01 | Files: a.ts | Test: true\n`;
    }),
  ].join("\n");

const event = (task: string, kind: string, extra: Record<string, string> = {}) =>
  JSON.stringify({ t: task, e: kind, by: "tool@host", at: "2026-11-14T10:00:00.000Z", ...extra });

async function increment(
  root: string,
  id: string,
  input: {
    status?: string;
    title?: string;
    updated?: string;
    tasks?: number;
    ledger?: ReadonlyArray<string>;
  } = {},
): Promise<string> {
  const folder = NodePath.join(root, ".specweave", "increments", id);
  await NodeFSP.mkdir(folder, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(folder, "metadata.json"),
    JSON.stringify({
      id,
      status: input.status ?? "active",
      title: input.title ?? `Title of ${id}`,
      updated: input.updated ?? "2026-11-01T00:00:00.000Z",
    }),
  );
  if (input.tasks !== undefined) {
    await NodeFSP.writeFile(NodePath.join(folder, "spec.md"), spec(input.tasks));
  }
  if (input.ledger !== undefined) {
    await NodeFSP.writeFile(NodePath.join(folder, "ledger.jsonl"), `${input.ledger.join("\n")}\n`);
  }
  return folder;
}

describe("boardColumn", () => {
  it("places an increment by status and task counts", () => {
    expect(boardColumn("planned", { total: 3, done: 0 })).toBe("planned");
    expect(boardColumn("backlog", { total: 0, done: 0 })).toBe("planned");
    expect(boardColumn("unknown", { total: 0, done: 0 })).toBe("planned");
    expect(boardColumn("active", { total: 3, done: 1 })).toBe("active");
    expect(boardColumn("in-progress", { total: 0, done: 0 })).toBe("active");
    expect(boardColumn("paused", { total: 3, done: 1 })).toBe("active");
    expect(boardColumn("active", { total: 3, done: 3 })).toBe("review");
    expect(boardColumn("ready_for_review", { total: 3, done: 1 })).toBe("review");
    expect(boardColumn("completed", { total: 3, done: 1 })).toBe("done");
  });
});

describe("ledgerPullRequests", () => {
  it("lists each pull request once, the last mentioned first, at most five", () => {
    const pull = (number: number) => `https://github.com/example/app/pull/${number}`;
    const ledger = [1, 2, 1, 3, 4, 5, 6].map((number) => event("T-01", "done", { link: pull(number) }));
    expect(ledgerPullRequests(ledger.join("\n"))).toEqual([6, 5, 4, 3, 1].map(pull));
    expect(ledgerPullRequests("https://github.com/example/app/issues/4")).toEqual([]);
  });
});

describe("readProjectBoard", () => {
  it("returns one card per increment in the column its files put it in", async () => {
    const root = await project();
    await increment(root, "0001-planned", { status: "planned", tasks: 2 });
    const active = await increment(root, "0002-active", {
      tasks: 3,
      ledger: [
        event("T-01", "claim"),
        event("T-01", "done", {
          evidence: "abc1234",
          link: "https://github.com/example/app/pull/7",
        }),
        event("T-02", "skip", { note: "not needed" }),
        event("T-03", "block", { note: "waiting" }),
      ],
    });
    await increment(root, "0003-review", {
      tasks: 1,
      ledger: [event("T-01", "done", { evidence: "abc1234" })],
    });
    await increment(root, "0004-done", { status: "completed", tasks: 1 });
    await increment(root, "0005-abandoned", { status: "abandoned", tasks: 1 });
    await increment(root, "0006-paused", { status: "paused" });
    await NodeFSP.mkdir(NodePath.join(root, ".specweave", "increments", "notes"));

    const board = await readProjectBoard(root, { now: NOW });
    const card = (id: string) => board.cards.find((entry) => entry.incrementId === id);

    expect(board.counts).toEqual({ planned: 1, active: 2, review: 1, done: 1 });
    expect(board.cards.map((entry) => entry.incrementId).toSorted()).toEqual([
      "0001-planned",
      "0002-active",
      "0003-review",
      "0004-done",
      "0006-paused",
    ]);
    expect(card("0001-planned")).toMatchObject({
      column: "planned",
      title: "Title of 0001-planned",
      tasks: { total: 2, done: 0 },
      blocked: false,
      pullRequests: [],
    });
    expect(card("0002-active")).toMatchObject({
      column: "active",
      tasks: { total: 3, done: 2 },
      blocked: true,
      pullRequests: ["https://github.com/example/app/pull/7"],
      specPath: NodePath.join(active, "spec.md"),
    });
    expect(card("0003-review")).toMatchObject({ column: "review", tasks: { total: 1, done: 1 } });
    expect(card("0004-done")).toMatchObject({ column: "done", blocked: false });
    expect(card("0006-paused")).toMatchObject({
      column: "active",
      blocked: true,
      tasks: { total: 0, done: 0 },
      specPath: null,
    });
  });

  it("cuts only the Done column, newest first, and keeps its full count", async () => {
    const root = await project();
    for (let index = 1; index <= 40; index += 1) {
      await increment(root, `${String(index).padStart(4, "0")}-closed`, {
        status: "completed",
        updated: new Date(Date.UTC(2026, 0, index)).toISOString(),
      });
    }
    await increment(root, "0100-open", { tasks: 1 });

    const first = await readProjectBoard(root, { now: NOW });
    const done = first.cards.filter((entry) => entry.column === "done");
    expect(first.counts.done).toBe(40);
    expect(done).toHaveLength(30);
    expect(done[0]?.incrementId).toBe("0040-closed");
    expect(done.at(-1)?.incrementId).toBe("0011-closed");
    expect(first.cards.some((entry) => entry.incrementId === "0100-open")).toBe(true);

    const more = await readProjectBoard(root, { now: NOW, doneLimit: 300 });
    expect(more.cards.filter((entry) => entry.column === "done")).toHaveLength(40);
  });

  it("matches every query word against the folder name or title", async () => {
    const root = await project();
    await increment(root, "0001-login-form", { title: "Login form" });
    await increment(root, "0002-billing", { title: "Billing page", status: "completed" });

    const board = await readProjectBoard(root, { now: NOW, query: "LOGIN 0001" });
    expect(board.cards.map((entry) => entry.incrementId)).toEqual(["0001-login-form"]);
    expect(board.counts).toEqual({ planned: 0, active: 1, review: 0, done: 0 });
    expect((await readProjectBoard(root, { now: NOW, query: "billing form" })).cards).toEqual([]);
  });

  it("re-reads an increment only after its files change", async () => {
    const root = await project();
    const folder = await increment(root, "0001-live", { tasks: 2, ledger: [] });
    expect((await readProjectBoard(root, { now: NOW })).cards[0]?.tasks).toEqual({
      total: 2,
      done: 0,
    });

    await NodeFSP.appendFile(
      NodePath.join(folder, "ledger.jsonl"),
      `${event("T-01", "done", { evidence: "abc1234" })}\n`,
    );
    const later = new Date(NOW + 60_000);
    await NodeFSP.utimes(NodePath.join(folder, "ledger.jsonl"), later, later);
    expect((await readProjectBoard(root, { now: NOW })).cards[0]).toMatchObject({
      tasks: { total: 2, done: 1 },
      updatedAt: later.toISOString(),
    });
  });

  it("answers an empty board for a folder without increments", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "project-board-"));
    roots.push(root);
    expect(await readProjectBoard(root, { now: NOW })).toEqual({
      cards: [],
      counts: { planned: 0, active: 0, review: 0, done: 0 },
    });
  });

  it("reads 1,500 increments in under a second, and unchanged ones much faster", async () => {
    const root = await project();
    const ledger = [event("T-01", "done", { evidence: "abc1234" }), event("T-02", "claim")];
    for (let start = 1; start <= 1_500; start += 100) {
      await Promise.all(
        Array.from({ length: 100 }, (_, offset) => {
          const index = start + offset;
          const open = index % 10 === 0;
          return increment(root, `${String(index).padStart(4, "0")}-bulk-increment`, {
            status: open ? "active" : "completed",
            tasks: 4,
            ledger,
          });
        }),
      );
    }

    const startedCold = performance.now();
    const cold = await readProjectBoard(root, { now: NOW });
    const coldMs = performance.now() - startedCold;
    const startedWarm = performance.now();
    const warm = await readProjectBoard(root, { now: NOW });
    const warmMs = performance.now() - startedWarm;

    expect(cold.counts).toEqual({ planned: 0, active: 150, review: 0, done: 1_350 });
    expect(cold.cards).toHaveLength(180);
    expect(warm).toEqual(cold);
    expect(coldMs).toBeLessThan(1_000);
    expect(warmMs).toBeLessThan(150);
  }, 30_000);
});
