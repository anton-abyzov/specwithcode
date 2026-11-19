// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  boardColumn,
  boardCopiesFor,
  boardPlacement,
  boardStatus,
  ledgerPullRequests,
  ledgerLastAt,
  readBoardCard,
  readProjectBoard,
} from "./ProjectBoard.ts";
import { commitAll, repository, setRemote, worktree } from "./incrementCopies.testkit.ts";

const roots: string[] = [];
const NOW = Date.parse("2026-11-14T12:00:00Z");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const cardAt = async (root: string, id: string, now: number) =>
  (await readBoardCard(await boardCopiesFor(root), id, now))?.card ?? null;

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
    metadata?: Record<string, unknown>;
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
      ...input.metadata,
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

  it("reads the status spellings older increments and other tools wrote", () => {
    expect(boardColumn("in_progress", { total: 3, done: 1 })).toBe("active");
    expect(boardColumn("ready-for-review", { total: 3, done: 1 })).toBe("review");
    expect(boardColumn("Done", { total: 3, done: 1 })).toBe("done");
    expect(boardColumn("closed", { total: 0, done: 0 })).toBe("done");
    expect(boardStatus("cancelled")).toBe("dropped");
    expect(boardStatus("superseded")).toBe("dropped");
    expect(boardStatus("abandoned")).toBe("dropped");
    expect(boardStatus("something else")).toBe("planned");
  });

  it("lets ledger evidence move a planned increment, and says why", () => {
    const none = { finished: 0, blocked: 0, active: 0 };
    expect(boardPlacement("planned", { total: 3, done: 1 }, { ...none, finished: 1 })).toEqual({
      column: "active",
      reason: "ledger",
    });
    expect(boardPlacement("unknown", { total: 3, done: 0 }, { ...none, active: 1 })).toEqual({
      column: "active",
      reason: "ledger",
    });
    expect(boardPlacement("planned", { total: 3, done: 1 }, none)).toEqual({
      column: "planned",
      reason: "status",
    });
    expect(boardPlacement("planned", { total: 2, done: 2 }, { ...none, finished: 2 })).toEqual({
      column: "review",
      reason: "tasks",
    });
    expect(boardPlacement("paused", { total: 2, done: 2 })).toEqual({
      column: "active",
      reason: "status",
    });
    expect(boardPlacement("active", { total: 3, done: 1 })).toEqual({
      column: "active",
      reason: "status",
    });
    expect(boardPlacement("in-review", { total: 3, done: 1 })).toEqual({
      column: "review",
      reason: "status",
    });
    expect(boardPlacement("abandoned", { total: 3, done: 1 })).toEqual({
      column: "done",
      reason: "status",
    });
    expect(boardColumn("planned", { total: 3, done: 0 }, { ...none, blocked: 1 })).toBe("active");
  });
});

describe("ledgerPullRequests", () => {
  it("lists each pull request once, the last mentioned first, at most five", () => {
    const pull = (number: number) => `https://github.com/example/app/pull/${number}`;
    const ledger = [1, 2, 1, 3, 4, 5, 6].map((number) =>
      event("T-01", "done", { link: pull(number) }),
    );
    expect(ledgerPullRequests(ledger.join("\n"))).toEqual([6, 5, 4, 3, 1].map(pull));
    expect(ledgerPullRequests("https://github.com/example/app/issues/4")).toEqual([]);
  });
});

describe("ledgerLastAt", () => {
  it("reads the time of the last line that has one, past blank and torn lines", () => {
    const first = event("T-01", "claim", { at: "2026-11-14T09:00:00.000Z" });
    const last = event("T-01", "done", { at: "2026-11-14T11:30:00+01:00" });
    expect(ledgerLastAt(`${first}\n${last}\n`)).toBe("2026-11-14T10:30:00.000Z");
    expect(ledgerLastAt(`${first}\n${last}\n\n{"t":"T-02","e":"cla`)).toBe(
      "2026-11-14T10:30:00.000Z",
    );
    expect(ledgerLastAt(`${first}\n{"t":"T-02","e":"note"}\n`)).toBe("2026-11-14T09:00:00.000Z");
    expect(ledgerLastAt("")).toBeNull();
    expect(ledgerLastAt("not json\n")).toBeNull();
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
    await increment(root, "0007-cancelled", { status: "cancelled", tasks: 1 });
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
    expect(first.detail).toBe(true);
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
      active: 0,
      finished: 0,
    });

    // The card's time is the last ledger event's, not the file's: a checkout
    // stamps every file as new.
    const later = new Date(NOW + 60_000);
    await NodeFSP.appendFile(
      NodePath.join(folder, "ledger.jsonl"),
      `${event("T-01", "done", { evidence: "abc1234", at: later.toISOString() })}\n`,
    );
    const stamped = new Date(NOW + 3_600_000);
    await NodeFSP.utimes(NodePath.join(folder, "ledger.jsonl"), stamped, stamped);
    expect((await readProjectBoard(root, { now: NOW })).cards[0]).toMatchObject({
      tasks: { total: 2, done: 1, finished: 1 },
      updatedAt: later.toISOString(),
    });
  });

  it("answers an empty board for a folder without increments", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "project-board-"));
    roots.push(root);
    expect(await readProjectBoard(root, { now: NOW })).toEqual({
      cards: [],
      counts: { planned: 0, active: 0, review: 0, done: 0 },
      detail: true,
      notDone: 0,
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

  it("keeps that bound with worktrees and a remote branch in play", async () => {
    const root = await repository("project-board-copies-", roots);
    const ledger = [event("T-01", "done", { evidence: "abc1234" }), event("T-02", "claim")];
    const name = (index: number) => `${String(index).padStart(4, "0")}-bulk-increment`;
    for (let start = 1; start <= 1_500; start += 100) {
      await Promise.all(
        Array.from({ length: 100 }, (_, offset) => {
          const index = start + offset;
          return increment(root, name(index), {
            status: index % 10 === 0 ? "active" : "completed",
            tasks: 4,
            ledger,
          });
        }),
      );
    }
    const merged = commitAll(root, "all");
    setRemote(root, merged);
    // Four thread worktrees, each holding every increment; one is ahead on an open one.
    const lanes = [];
    for (const lane of ["lane-a", "lane-b", "lane-c", "lane-d"]) {
      lanes.push(await worktree(root, lane, merged, roots));
    }
    await NodeFSP.appendFile(
      NodePath.join(lanes[2]!, ".specweave", "increments", name(10), "ledger.jsonl"),
      `${event("T-02", "done", { evidence: "abc1234" })}\n`,
    );
    const cacheDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "project-board-cache-"));
    roots.push(cacheDir);

    const startedCold = performance.now();
    const cold = await readProjectBoard(root, { now: NOW, cacheDir });
    const coldMs = performance.now() - startedCold;
    const startedWarm = performance.now();
    const warm = await readProjectBoard(root, { now: NOW, cacheDir });
    const warmMs = performance.now() - startedWarm;

    expect(cold.counts).toEqual({ planned: 0, active: 150, review: 0, done: 1_350 });
    expect(cold.notDone).toBe(150);
    expect(cold.cards).toHaveLength(180);
    expect(cold.cards.filter((card) => card.source !== undefined)).toMatchObject([
      { incrementId: name(10), tasks: { done: 2 }, source: { kind: "worktree", name: "lane-c" } },
    ]);
    expect(cold.behind).toMatchObject({ ref: "origin/main", count: 0 });
    expect(warm).toEqual(cold);
    expect(coldMs).toBeLessThan(1_000);
    expect(warmMs).toBeLessThan(150);
  }, 120_000);

  const at = (iso: string) => ({ at: iso });
  const cardOf = async (root: string, id: string, now = NOW) =>
    (await readProjectBoard(root, { now })).cards.find((entry) => entry.incrementId === id);

  it("moves a planned increment to Active only on real ledger work", async () => {
    const root = await project();
    await increment(root, "0001-one-done", {
      status: "planned",
      tasks: 3,
      ledger: [event("T-01", "done", { evidence: "abc1234" })],
    });
    await increment(root, "0002-stale-claim", {
      status: "planned",
      tasks: 3,
      ledger: [event("T-01", "claim", at("2026-11-14T09:00:00.000Z"))],
    });
    await increment(root, "0003-skipped", {
      status: "planned",
      tasks: 3,
      ledger: [event("T-01", "skip", { note: "not needed" })],
    });
    await increment(root, "0004-blocked", {
      status: "planned",
      tasks: 3,
      ledger: [event("T-01", "block", { note: "waiting for keys" })],
    });
    await increment(root, "0005-untouched", { status: "planned", tasks: 3, ledger: [] });

    expect(await cardOf(root, "0001-one-done")).toMatchObject({
      column: "active",
      columnReason: "ledger",
    });
    expect(await cardOf(root, "0002-stale-claim")).toMatchObject({
      column: "planned",
      columnReason: "status",
      tasks: { active: 0 },
    });
    expect(await cardOf(root, "0003-skipped")).toMatchObject({
      column: "planned",
      tasks: { done: 1 },
    });
    expect(await cardOf(root, "0004-blocked")).toMatchObject({
      column: "active",
      columnReason: "ledger",
      blocked: true,
      blockedTasks: 1,
    });
    expect(await cardOf(root, "0005-untouched")).toMatchObject({
      column: "planned",
      columnReason: "status",
      blocked: false,
      blockedTasks: 0,
      blockers: [],
      paused: false,
      pausedReason: null,
    });
  });

  it("drops a claim from Active once its lease ends, with no file change", async () => {
    const root = await project();
    await increment(root, "0001-claimed", {
      status: "planned",
      tasks: 2,
      ledger: [event("T-01", "claim", at("2026-11-14T11:00:00.000Z"))],
    });
    expect(await cardOf(root, "0001-claimed")).toMatchObject({
      column: "active",
      columnReason: "ledger",
      tasks: { total: 2, done: 0, active: 1 },
    });
    const afterLease = Date.parse("2026-11-14T13:01:00.000Z");
    expect(await cardOf(root, "0001-claimed", afterLease)).toMatchObject({
      column: "planned",
      columnReason: "status",
      tasks: { active: 0 },
    });
  });

  it("counts done tasks apart from skipped ones", async () => {
    const root = await project();
    await increment(root, "0001-skipped", {
      status: "planned",
      tasks: 4,
      ledger: [
        event("T-01", "skip", { note: "not needed" }),
        event("T-02", "skip", { note: "not needed" }),
        event("T-03", "done", { evidence: "abc1234" }),
      ],
    });
    expect(await cardOf(root, "0001-skipped")).toMatchObject({
      column: "active",
      tasks: { total: 4, done: 3, finished: 1 },
    });
  });

  it("keeps a paused increment in Active even with every task done", async () => {
    const root = await project();
    await increment(root, "0001-paused", {
      status: "paused",
      tasks: 2,
      metadata: { pausedReason: `  waiting on design review${" ".repeat(4)}${"x".repeat(400)}` },
      ledger: [
        event("T-01", "done", { evidence: "abc1234" }),
        event("T-02", "skip", { note: "covered by T-01" }),
      ],
    });
    const card = await cardOf(root, "0001-paused");
    expect(card).toMatchObject({
      column: "active",
      columnReason: "status",
      paused: true,
      blocked: true,
      blockedTasks: 0,
      tasks: { total: 2, done: 2 },
    });
    expect(card?.pausedReason?.startsWith("waiting on design review")).toBe(true);
    expect(card?.pausedReason).toHaveLength(300);
  });

  it("names the blocked tasks of a paused increment, who blocked them and when", async () => {
    const root = await project();
    await increment(root, "0001-stuck", {
      status: "paused",
      tasks: 3,
      metadata: { pausedReason: "Waiting on keys" },
      ledger: [
        event("T-01", "block", {
          note: "needs the signing key",
          by: "agent@host-a",
          at: "2026-11-14T11:30:00.000Z",
        }),
        event("T-03", "block", { at: "2026-11-14T08:00:00.000Z" }),
      ],
    });
    expect(await cardOf(root, "0001-stuck")).toMatchObject({
      column: "active",
      blocked: true,
      paused: true,
      pausedReason: "Waiting on keys",
      blockedTasks: 2,
      blockers: [
        {
          taskId: "T-01",
          title: "Step 1",
          note: "needs the signing key",
          by: "agent@host-a",
          at: "2026-11-14T11:30:00.000Z",
          leased: true,
        },
        {
          taskId: "T-03",
          title: "Step 3",
          note: null,
          by: "tool@host",
          at: "2026-11-14T08:00:00.000Z",
          leased: false,
        },
      ],
    });
    // The block's own lease ends at 13:30 with no file change; the cached card must say so.
    const later = await cardOf(root, "0001-stuck", Date.parse("2026-11-14T13:31:00.000Z"));
    expect(later?.blockers?.map((blocker) => blocker.leased)).toEqual([false, false]);
    expect(later?.blockedTasks).toBe(2);
  });

  it("carries at most three blockers but counts every blocked task", async () => {
    const root = await project();
    await increment(root, "0001-many", {
      tasks: 5,
      ledger: ["T-01", "T-02", "T-03", "T-04", "T-05"].map((task) =>
        event(task, "block", { note: `blocked ${task}` }),
      ),
    });
    const card = await cardOf(root, "0001-many");
    expect(card?.blockedTasks).toBe(5);
    expect(card?.blockers?.map((blocker) => blocker.taskId)).toEqual(["T-01", "T-02", "T-03"]);
  });

  it("reports no blockers on a completed increment", async () => {
    const root = await project();
    await increment(root, "0001-closed", {
      status: "completed",
      tasks: 2,
      metadata: { pausedReason: "old reason" },
      ledger: [event("T-01", "block", { note: "never cleared" })],
    });
    expect(await cardOf(root, "0001-closed")).toMatchObject({
      column: "done",
      columnReason: "status",
      blocked: false,
      paused: false,
      pausedReason: null,
      blockedTasks: 0,
      blockers: [],
    });
  });

  it("reads one card exactly as the board shows it", async () => {
    const root = await project();
    await increment(root, "0001-live", {
      status: "planned",
      tasks: 3,
      ledger: [
        event("T-01", "done", {
          evidence: "abc1234",
          link: "https://github.com/example/app/pull/9",
        }),
        event("T-02", "block", { note: "waiting" }),
      ],
    });
    await increment(root, "0002-abandoned", { status: "abandoned", tasks: 1 });

    const board = await readProjectBoard(root, { now: NOW });
    expect(await cardAt(root, "0001-live", NOW)).toEqual(
      board.cards.find((entry) => entry.incrementId === "0001-live"),
    );
    expect(await cardAt(root, "0009-missing", NOW)).toBeNull();
    expect(await cardAt(root, "../0001-live", NOW)).toBeNull();
    expect(board.cards.some((entry) => entry.incrementId === "0002-abandoned")).toBe(false);
    expect(await cardAt(root, "0002-abandoned", NOW)).toMatchObject({
      incrementId: "0002-abandoned",
      status: "abandoned",
      column: "done",
      columnReason: "status",
      blocked: false,
    });
  });

  it("answers only for folders the board itself would list", async () => {
    const root = await project();
    await increment(root, "0001-live", { status: "planned", tasks: 1 });
    await NodeFSP.mkdir(NodePath.join(root, ".specweave", "increments", "notes"));
    const outside = await project();
    const target = await increment(outside, "0002-elsewhere", { status: "active", tasks: 1 });
    await NodeFSP.symlink(
      target,
      NodePath.join(root, ".specweave", "increments", "0002-elsewhere"),
    );

    const board = await readProjectBoard(root, { now: NOW });
    expect(board.cards.map((entry) => entry.incrementId)).toEqual(["0001-live"]);
    // The increments folder itself, a folder that is not an increment, and a link out of the root.
    expect(await cardAt(root, "", NOW)).toBeNull();
    expect(await cardAt(root, "notes", NOW)).toBeNull();
    expect(await cardAt(root, "0002-elsewhere", NOW)).toBeNull();
  });
});

describe("recorded reviews on a card", () => {
  const record = async (folder: string, name: string, fields: string, verdict: string) => {
    const dir = NodePath.join(folder, "reports", "reviews");
    await NodeFSP.mkdir(dir, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(dir, name),
      `<!-- specweave review: ${fields} -->\n# Review\nVerdict: ${verdict}\n`,
    );
  };

  it("lists the increment's reviews newest first, with the ledger's author for records without one", async () => {
    const root = await project();
    const folder = await increment(root, "0001-feature", {
      status: "completed",
      tasks: 1,
      ledger: [
        JSON.stringify({ t: "T-01", e: "done", by: "claude@m4", at: "2026-11-14T10:00:00.000Z" }),
      ],
    });
    await increment(root, "0002-unreviewed", { status: "completed", tasks: 1 });
    await record(
      folder,
      "review-claude-opus-5-5-1.md",
      "reviewer=claude-opus-5-5 model=claude-opus-5-5 family=claude at=2026-11-14T10:30:00Z",
      "fix first",
    );
    await record(
      folder,
      "review-muse-wonder-full-1.0-1.md",
      "reviewer=muse-wonder-full-1.0 model=muse-wonder-full-1.0 family=meta author=claude at=2026-11-14T11:00:00Z",
      "ship",
    );

    const board = await readProjectBoard(root, { now: NOW });
    const card = (id: string) => board.cards.find((entry) => entry.incrementId === id);
    expect(card("0001-feature")?.reviews).toEqual([
      {
        model: "muse-wonder-full-1.0",
        family: "meta",
        author: "claude",
        verdict: "ship",
        at: "2026-11-14T11:00:00Z",
      },
      {
        model: "claude-opus-5-5",
        family: "claude",
        author: "claude",
        verdict: "fix first",
        at: "2026-11-14T10:30:00Z",
      },
    ]);
    // No reviews: the field is left out, as older servers do.
    expect(card("0002-unreviewed")).not.toHaveProperty("reviews");
    expect(await cardAt(root, "0001-feature", NOW)).toEqual(card("0001-feature"));
  });

  it("shows a review recorded after the board was first read", async () => {
    const root = await project();
    const folder = await increment(root, "0001-feature", { tasks: 1 });
    expect((await readProjectBoard(root, { now: NOW })).cards[0]).not.toHaveProperty("reviews");
    // A reports folder with no review in it, read twice: still none.
    await NodeFSP.mkdir(NodePath.join(folder, "reports"));
    await NodeFSP.writeFile(NodePath.join(folder, "reports", "notes.md"), "Notes\n");
    expect((await readProjectBoard(root, { now: NOW })).cards[0]).not.toHaveProperty("reviews");
    expect((await readProjectBoard(root, { now: NOW })).cards[0]).not.toHaveProperty("reviews");
    await record(
      folder,
      "review-gpt-6.1-sol-1.md",
      "reviewer=gpt-6.1-sol family=openai author=claude at=2026-11-14T11:00:00Z",
      "ship",
    );
    expect((await readProjectBoard(root, { now: NOW })).cards[0]?.reviews).toEqual([
      {
        model: "gpt-6.1-sol",
        family: "openai",
        author: "claude",
        verdict: "ship",
        at: "2026-11-14T11:00:00Z",
      },
    ]);
  });
});
