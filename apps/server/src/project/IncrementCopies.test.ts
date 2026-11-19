// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { copyBatches, rankCopies, type BoardGitRun, type CopyRank } from "./IncrementCopies.ts";
import {
  commitAll,
  doneLedger,
  eventOf,
  folderOf,
  git,
  repository,
  setRemote,
  worktree,
  writeIncrement,
} from "./incrementCopies.testkit.ts";
import { readProjectBoard } from "./ProjectBoard.ts";
import { readProjectBoardIncrement } from "./ProjectBoardIncrement.ts";

const roots: string[] = [];
const NOW = Date.parse("2026-11-14T12:00:00Z");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function cache(): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "board-copies-"));
  roots.push(dir);
  return dir;
}

const record = async (folder: string, name: string, fields: string, verdict: string) => {
  const dir = NodePath.join(folder, "reports", "reviews");
  await NodeFSP.mkdir(dir, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(dir, name),
    `<!-- specweave review: ${fields} -->\n# Review\nVerdict: ${verdict}\n`,
  );
};

/**
 * A project folder one commit behind its remote branch. The remote commit
 * holds what `remote` writes; the project folder is then put back on the
 * first commit, where `local` writes what is uncommitted there.
 */
async function behindProject(
  remote: (root: string) => Promise<void>,
  local: (root: string) => Promise<void> = async () => undefined,
  base: (root: string) => Promise<void> = async () => undefined,
) {
  const root = await repository("board-copies-project-", roots);
  await base(root);
  const first = commitAll(root, "first");
  await remote(root);
  const merged = commitAll(root, "merged");
  setRemote(root, merged);
  git(root, "reset", "-q", "--hard", first);
  await local(root);
  return { root, first, merged, cacheDir: await cache() };
}

const cardOf = async (root: string, id: string, cacheDir: string) =>
  (await readProjectBoard(root, { now: NOW, cacheDir })).cards.find(
    (entry) => entry.incrementId === id,
  );

describe("rankCopies", () => {
  const rank = (input: Partial<CopyRank>): CopyRank => ({
    reopened: 0,
    closed: false,
    ledgerBytes: 0,
    updatedAt: null,
    ...input,
  });

  it("orders by reopens, then closed, then the longer ledger, then the later metadata time", () => {
    // A reopened open copy is newer than a closed one that never heard of the reopen.
    expect(
      rankCopies(rank({ reopened: 1 }), rank({ closed: true, ledgerBytes: 900 })),
    ).toBeLessThan(0);
    // Closed wins over a longer open ledger.
    expect(rankCopies(rank({ closed: true }), rank({ ledgerBytes: 900 }))).toBeLessThan(0);
    expect(rankCopies(rank({ ledgerBytes: 10 }), rank({ ledgerBytes: 900 }))).toBeGreaterThan(0);
    expect(
      rankCopies(
        rank({ updatedAt: "2026-11-02T00:00:00.000Z" }),
        rank({ updatedAt: "2026-11-01T00:00:00.000Z" }),
      ),
    ).toBeLessThan(0);
    expect(rankCopies(rank({}), rank({}))).toBe(0);
  });
});

describe("copyBatches", () => {
  it("keeps each Git batch under the bound, counts a shared blob once, never splits a copy", () => {
    const blob = (oid: string, size: number) => ({ oid, size });
    expect(
      copyBatches(
        [[blob("a", 400)], [blob("a", 400), blob("b", 300)], [blob("c", 500)], [blob("d", 2_000)]],
        1_000,
      ),
    ).toEqual([[0, 1], [2], [3]]);
    expect(copyBatches([], 1_000)).toEqual([]);
  });
});

describe("the newest copy of an increment", () => {
  it("shows the remote branch's copy over a project-folder stub, with the folder's reviews (the 1407 shape)", async () => {
    const id = "1407-simplify-init";
    const { root, cacheDir } = await behindProject(
      async (at) => {
        await writeIncrement(at, id, {
          title: "Simplify specweave init",
          tasks: 7,
          ledger: doneLedger(7),
          metadata: { status: "active", updated: "2026-11-13T15:57:14.684Z" },
        });
      },
      async (at) => {
        // What closure sync and saved reports leave in the project folder.
        const folder = folderOf(at, id);
        await NodeFSP.mkdir(folder, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(folder, "metadata.json"),
          JSON.stringify({ id, status: "planned", created: "2026-11-13T22:38:00.000Z" }),
        );
        await record(
          folder,
          "review-gpt-6.1-sol-1.md",
          "reviewer=gpt-6.1-sol model=gpt-6.1-sol family=openai author=claude at=2026-11-13T23:00:00Z",
          "ship",
        );
      },
    );

    const board = await readProjectBoard(root, { now: NOW, cacheDir });
    const card = board.cards.find((entry) => entry.incrementId === id);
    expect(card).toMatchObject({
      title: "Simplify specweave init",
      status: "active",
      column: "review",
      columnReason: "tasks",
      tasks: { total: 7, done: 7, finished: 7 },
      source: { kind: "remote", name: "origin/main" },
      reviews: [{ model: "gpt-6.1-sol", verdict: "ship" }],
    });
    expect(board.counts).toEqual({ planned: 0, active: 0, review: 1, done: 0 });
    expect(board.notDone).toBe(1);
    expect(board.behind).toMatchObject({ ref: "origin/main", count: 1 });
    // The spec opens: a real, read-only file outside the repository.
    expect(card?.specPath?.startsWith(cacheDir)).toBe(true);
    expect(await NodeFSP.readFile(card!.specPath!, "utf8")).toContain("# Simplify specweave init");

    const view = await readProjectBoardIncrement(root, { incrementId: id, now: NOW, cacheDir });
    expect(view).not.toBe("invalid");
    expect(view).toMatchObject({
      card: { source: { kind: "remote", name: "origin/main" }, tasks: { total: 7, done: 7 } },
      problem: "Simplify specweave init is not shown.",
      doneTasks: 7,
      readable: true,
    });
  });

  it("counts an increment closed on the remote branch as done over an open stub (the 1374 shape)", async () => {
    const id = "1374-muse-access";
    const { root, cacheDir } = await behindProject(
      async (at) => {
        await writeIncrement(at, id, {
          tasks: 2,
          ledger: doneLedger(2),
          metadata: { status: "completed", updated: "2026-11-12T00:00:00.000Z" },
        });
      },
      async (at) => {
        await writeIncrement(at, id, { metadata: { status: "planned", title: undefined } });
      },
    );
    const board = await readProjectBoard(root, { now: NOW, cacheDir });
    expect(board.counts).toEqual({ planned: 0, active: 0, review: 0, done: 1 });
    expect(board.notDone).toBe(0);
    expect(board.cards[0]).toMatchObject({
      incrementId: id,
      column: "done",
      tasks: { total: 2, done: 2 },
      source: { kind: "remote", name: "origin/main" },
    });
  });

  it("lists increments that exist only on the remote branch or only in a worktree", async () => {
    const { root, first, cacheDir } = await behindProject(async (at) => {
      await writeIncrement(at, "0002-merged-elsewhere", { tasks: 1, ledger: [] });
    });
    const lane = await worktree(root, "fix-lane", first, roots);
    await writeIncrement(lane, "0003-planned-in-a-thread", {
      tasks: 2,
      ledger: [eventOf("T-01", "done", { evidence: "abc1234" })],
      metadata: { status: "planned" },
    });

    const board = await readProjectBoard(root, { now: NOW, cacheDir });
    expect(
      board.cards.map((card) => [card.incrementId, card.source?.kind, card.source?.name]),
    ).toEqual([
      ["0003-planned-in-a-thread", "worktree", "fix-lane"],
      ["0002-merged-elsewhere", "remote", "origin/main"],
    ]);
    expect(board.cards[0]).toMatchObject({ column: "active", columnReason: "ledger" });
    expect(board.cards[0]?.specPath).toBe(
      NodePath.join(folderOf(lane, "0003-planned-in-a-thread"), "spec.md"),
    );
    expect(board.notDone).toBe(2);
  });

  it("keeps the copy with the longer ledger, wherever it lives", async () => {
    const id = "0001-shared";
    const base = { tasks: 4, metadata: { status: "active" } };
    const { root, first, cacheDir } = await behindProject(
      async (at) => {
        await writeIncrement(at, id, { ...base, ledger: doneLedger(1) });
      },
      undefined,
      async (at) => {
        await writeIncrement(at, id, { ...base, ledger: [] });
      },
    );
    // The remote branch is ahead of the project folder.
    expect(await cardOf(root, id, cacheDir)).toMatchObject({
      tasks: { done: 1 },
      source: { kind: "remote" },
    });

    // A thread's worktree is ahead of both, uncommitted.
    const lane = await worktree(root, "thread-lane", first, roots);
    await writeIncrement(lane, id, { ...base, ledger: doneLedger(2) });
    expect(await cardOf(root, id, cacheDir)).toMatchObject({
      tasks: { done: 2 },
      source: { kind: "worktree", name: "thread-lane" },
    });

    // The project folder's own uncommitted work is the newest: no source.
    await writeIncrement(root, id, { ...base, ledger: doneLedger(3) });
    const own = await cardOf(root, id, cacheDir);
    expect(own).toMatchObject({ tasks: { done: 3 } });
    expect(own?.source).toBeUndefined();
    expect(own?.specPath).toBe(NodePath.join(folderOf(root, id), "spec.md"));
  });

  it("keeps a dropped increment off the board and shows a reopened one as open", async () => {
    const { root, cacheDir } = await behindProject(
      async (at) => {
        await writeIncrement(at, "0001-dropped", { tasks: 1, metadata: { status: "abandoned" } });
        await writeIncrement(at, "0002-reopened", {
          tasks: 1,
          ledger: doneLedger(1),
          metadata: { status: "planned", reopened: [{ at: "2026-11-13T00:00:00.000Z" }] },
        });
      },
      undefined,
      async (at) => {
        await writeIncrement(at, "0001-dropped", { tasks: 1, metadata: { status: "active" } });
        await writeIncrement(at, "0002-reopened", {
          tasks: 1,
          ledger: doneLedger(1),
          metadata: { status: "completed" },
        });
      },
    );
    const board = await readProjectBoard(root, { now: NOW, cacheDir });
    expect(board.cards.map((card) => card.incrementId)).toEqual(["0002-reopened"]);
    expect(board.cards[0]).toMatchObject({
      status: "planned",
      source: { kind: "remote", name: "origin/main" },
    });
    expect(board.counts.done).toBe(0);
    expect(board.notDone).toBe(1);
  });

  it("never lets a closed stub hide an open copy that has a spec", async () => {
    const id = "0001-stub-closed";
    const { root, cacheDir } = await behindProject(
      async (at) => {
        await writeIncrement(at, id, { tasks: 2, ledger: [], metadata: { status: "active" } });
      },
      async (at) => {
        await writeIncrement(at, id, { metadata: { status: "completed" } });
      },
    );
    expect(await cardOf(root, id, cacheDir)).toMatchObject({
      status: "active",
      tasks: { total: 2 },
      source: { kind: "remote" },
    });
  });

  it("reads the increment view from the same copy and lists the project folder's reports after its own", async () => {
    const id = "0001-in-a-worktree";
    const root = await repository("board-copies-project-", roots);
    const first = commitAll(root, "first");
    const lane = await worktree(root, "view-lane", first, roots);
    const folder = await writeIncrement(lane, id, {
      title: "Lives in a worktree",
      tasks: 2,
      ledger: doneLedger(1),
    });
    await NodeFSP.mkdir(NodePath.join(folder, "reports"));
    await NodeFSP.writeFile(NodePath.join(folder, "reports", "notes.md"), "notes");
    // A report saved to the project folder, where no spec lives.
    const own = NodePath.join(folderOf(root, id), "reports");
    await NodeFSP.mkdir(own, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(own, "summary.md"), "summary");

    const view = await readProjectBoardIncrement(root, { incrementId: id, now: NOW });
    expect(view).toMatchObject({
      card: {
        title: "Lives in a worktree",
        source: { kind: "worktree", name: "view-lane" },
        tasks: { total: 2, done: 1 },
      },
      problem: "Lives in a worktree is not shown.",
      doneTasks: 1,
      reports: [
        { name: "notes.md", path: NodePath.join(folder, "reports", "notes.md") },
        { name: "summary.md", path: NodePath.join(own, "summary.md") },
      ],
    });
    expect(await readProjectBoardIncrement(root, { incrementId: "0009-nowhere", now: NOW })).toBe(
      null,
    );
    expect(await readProjectBoardIncrement(root, { incrementId: "../x", now: NOW })).toBe(
      "invalid",
    );
  });

  it("writes nothing in the project folder or a worktree, and ignores inherited Git variables", async () => {
    const { root, first, cacheDir } = await behindProject(async (at) => {
      await writeIncrement(at, "0002-remote", { tasks: 1, ledger: [] });
    });
    const lane = await worktree(root, "quiet-lane", first, roots);
    await writeIncrement(lane, "0003-lane", { tasks: 1, ledger: [] });
    const listing = async (dir: string) =>
      (await NodeFSP.readdir(dir, { recursive: true })).toSorted().join("\n");
    const before = [await listing(root), await listing(lane), git(root, "status", "--porcelain")];
    const held = process.env.GIT_DIR;
    process.env.GIT_DIR = NodePath.join(cacheDir, "not-a-repository");
    try {
      const board = await readProjectBoard(root, { now: NOW, cacheDir });
      expect(board.cards.map((card) => card.incrementId)).toEqual(["0003-lane", "0002-remote"]);
    } finally {
      if (held === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = held;
    }
    expect([await listing(root), await listing(lane), git(root, "status", "--porcelain")]).toEqual(
      before,
    );
  });

  it("never lets a closed project stub hide a worktree's spec", async () => {
    const id = "0001-stub-over-worktree";
    const root = await repository("board-copies-project-", roots);
    const base = commitAll(root, "base");
    const lane = await worktree(root, "lane", base, roots);
    await writeIncrement(lane, id, {
      tasks: 3,
      ledger: [eventOf("T-01", "done", { evidence: "abc1234" })],
      metadata: { status: "active" },
    });
    // What a stale install's lazy init leaves behind: status, no spec.
    await writeIncrement(root, id, { metadata: { status: "completed" } });
    const cacheDir = await cache();
    const board = await readProjectBoard(root, { now: NOW, cacheDir });
    expect(board.cards.find((card) => card.incrementId === id)).toMatchObject({
      status: "active",
      tasks: { total: 3, done: 1 },
      source: { kind: "worktree", name: "lane" },
    });
    expect(board.notDone).toBe(1);
    // A search finds it by the title the card shows.
    const searched = await readProjectBoard(root, { now: NOW, cacheDir, query: "stub-over" });
    expect(searched.cards.map((card) => card.incrementId)).toEqual([id]);
  });

  it("keeps an increment dropped on the remote branch off the board over a completed folder", async () => {
    const id = "0001-dropped-there";
    const { root, cacheDir } = await behindProject(
      async (at) => {
        await writeIncrement(at, id, { tasks: 1, metadata: { status: "abandoned" } });
      },
      async (at) => {
        await writeIncrement(at, id, {
          tasks: 1,
          ledger: doneLedger(1),
          metadata: { status: "completed" },
        });
      },
    );
    const board = await readProjectBoard(root, { now: NOW, cacheDir });
    expect(board.cards).toEqual([]);
    expect(board.counts.done).toBe(0);
    expect(board.notDone).toBe(0);
  });

  it("lists review records from the shown copy and the project folder, newest first", async () => {
    const id = "0001-reviewed-twice";
    const { root, cacheDir } = await behindProject(
      async (at) => {
        await writeIncrement(at, id, {
          tasks: 1,
          ledger: doneLedger(1),
          metadata: { status: "active" },
        });
        await record(
          folderOf(at, id),
          "review-gpt-6.1-sol-1.md",
          "model=gpt-6.1-sol family=openai author=claude at=2026-11-13T10:00:00Z",
          "fix first",
        );
      },
      async (at) => {
        await writeIncrement(at, id, { metadata: { status: "planned" } });
        await record(
          folderOf(at, id),
          "review-gpt-6.1-sol-2.md",
          "model=gpt-6.1-sol family=openai author=claude at=2026-11-13T12:00:00Z",
          "ship",
        );
      },
    );
    const card = await cardOf(root, id, cacheDir);
    expect(card?.source).toMatchObject({ kind: "remote" });
    expect(card?.reviews?.map((review) => review.verdict)).toEqual(["ship", "fix first"]);
    const view = await readProjectBoardIncrement(root, { incrementId: id, now: NOW, cacheDir });
    expect(view).toMatchObject({ review: { latest: { verdict: "ship" } } });
  });

  it("shows status alone when a remote copy's ledger is too big to copy whole", async () => {
    const id = "0001-huge-ledger";
    const { root, cacheDir } = await behindProject(async (at) => {
      const line = eventOf("T-01", "claim");
      await writeIncrement(at, id, {
        tasks: 2,
        ledger: Array.from({ length: Math.ceil((9 * 1_048_576) / line.length) }, () => line),
        metadata: { status: "active", title: "Huge ledger" },
      });
    });
    const card = await cardOf(root, id, cacheDir);
    // Not "0 of 2 done": its files are not read at all.
    expect(card).toMatchObject({ title: "Huge ledger", status: "active", specPath: null });
    expect(card?.tasks.total).toBe(0);
    expect(card?.source).toMatchObject({ kind: "remote" });
  });

  it("falls back to origin/main when origin/HEAD names a branch that is gone", async () => {
    const id = "0001-on-main";
    const { root, cacheDir } = await behindProject(async (at) => {
      await writeIncrement(at, id, { tasks: 1, ledger: [] });
    });
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/renamed");
    expect(await cardOf(root, id, cacheDir)).toMatchObject({
      source: { kind: "remote", name: "origin/main" },
    });
  });

  it("counts the same review record kept in two copies once, and keeps records of different repositories", async () => {
    const id = "0001-two-repos";
    const fields = (repo: string) =>
      `model=gpt-6.1-sol family=openai author=claude repo=${repo} at=2026-11-13T10:00:00Z`;
    const { root, cacheDir } = await behindProject(
      async (at) => {
        await writeIncrement(at, id, {
          tasks: 1,
          ledger: doneLedger(1),
          metadata: { status: "active" },
        });
        await record(folderOf(at, id), "review-api-1.md", fields("repositories/acme/api"), "ship");
        await record(folderOf(at, id), "review-app-1.md", fields("repositories/acme/app"), "ship");
      },
      async (at) => {
        await writeIncrement(at, id, { metadata: { status: "planned" } });
        // The same record, saved in the project folder too.
        await record(folderOf(at, id), "review-api-1.md", fields("repositories/acme/api"), "ship");
      },
    );
    const card = await cardOf(root, id, cacheDir);
    expect(card?.source).toMatchObject({ kind: "remote" });
    expect(card?.reviews).toHaveLength(2);
  });

  it("never reads the project folder's reviews through a link out of its folder", async () => {
    const id = "0001-linked-reviews";
    const outside = await cache();
    const { root, cacheDir } = await behindProject(
      async (at) => {
        await writeIncrement(at, id, {
          tasks: 1,
          ledger: doneLedger(1),
          metadata: { status: "active" },
        });
        await record(
          folderOf(at, id),
          "review-gpt-6.1-sol-1.md",
          "model=gpt-6.1-sol family=openai author=claude at=2026-11-13T10:00:00Z",
          "fix first",
        );
      },
      async (at) => {
        await writeIncrement(at, id, { metadata: { status: "planned" } });
        await record(
          outside,
          "review-gpt-6.1-sol-2.md",
          "model=gpt-6.1-sol family=openai author=claude at=2026-11-13T12:00:00Z",
          "ship",
        );
        await NodeFSP.mkdir(NodePath.join(folderOf(at, id), "reports"), { recursive: true });
        await NodeFSP.symlink(
          NodePath.join(outside, "reports", "reviews"),
          NodePath.join(folderOf(at, id), "reports", "reviews"),
        );
      },
    );
    const card = await cardOf(root, id, cacheDir);
    expect(card?.reviews?.map((review) => review.verdict)).toEqual(["fix first"]);
    const view = await readProjectBoardIncrement(root, { incrementId: id, now: NOW, cacheDir });
    expect(view).toMatchObject({ review: { latest: { verdict: "fix first" } } });
  });

  it("answers the board when the cache folder cannot be made", async () => {
    const { root } = await behindProject(
      async (at) => {
        await writeIncrement(at, "0002-remote", {
          tasks: 1,
          ledger: [],
          metadata: { title: "Remote" },
        });
      },
      async (at) => {
        await writeIncrement(at, "0001-local", { tasks: 1, ledger: [] });
      },
    );
    const blocked = NodePath.join(await cache(), "not-a-folder");
    await NodeFSP.writeFile(blocked, "");
    const board = await readProjectBoard(root, { now: NOW, cacheDir: blocked });
    expect(board.cards.map((card) => card.incrementId).toSorted()).toEqual([
      "0001-local",
      "0002-remote",
    ]);
    expect(board.cards.find((card) => card.incrementId === "0002-remote")).toMatchObject({
      title: "Remote",
      specPath: null,
      source: { kind: "remote" },
    });
  });

  it("gives two views opened at once the same readable remote copy", async () => {
    const id = "0001-opened-twice";
    const { root, cacheDir } = await behindProject(async (at) => {
      await writeIncrement(at, id, { tasks: 2, ledger: doneLedger(1) });
    });
    const open = () => readProjectBoardIncrement(root, { incrementId: id, now: NOW, cacheDir });
    const views = await Promise.all([open(), open(), open()]);
    for (const view of views) expect(view).toMatchObject({ readable: true, doneTasks: 1 });
  });

  it("reads a default branch whose name the old pattern refused", async () => {
    const id = "0001-on-release";
    const { root, cacheDir } = await behindProject(async (at) => {
      await writeIncrement(at, id, { tasks: 1, ledger: [] });
    });
    const merged = git(root, "rev-parse", "refs/remotes/origin/main");
    git(root, "update-ref", "-d", "refs/remotes/origin/main");
    setRemote(root, merged, "release+next");
    expect(await cardOf(root, id, cacheDir)).toMatchObject({
      source: { kind: "remote", name: "origin/release+next" },
    });
  });

  it("never follows the project folder's review links when the shown copy cannot be read", async () => {
    const id = "0001-unreadable-linked";
    const outside = await cache();
    const { root, cacheDir } = await behindProject(
      async (at) => {
        const line = eventOf("T-01", "claim");
        await writeIncrement(at, id, {
          tasks: 2,
          ledger: Array.from({ length: Math.ceil((9 * 1_048_576) / line.length) }, () => line),
          metadata: { status: "active" },
        });
      },
      async (at) => {
        await writeIncrement(at, id, { metadata: { status: "planned" } });
        await record(
          outside,
          "review-gpt-6.1-sol-1.md",
          "model=gpt-6.1-sol family=openai author=claude at=2026-11-13T12:00:00Z",
          "ship",
        );
        await NodeFSP.mkdir(NodePath.join(folderOf(at, id), "reports"), { recursive: true });
        await NodeFSP.symlink(
          NodePath.join(outside, "reports", "reviews"),
          NodePath.join(folderOf(at, id), "reports", "reviews"),
        );
      },
    );
    const card = await cardOf(root, id, cacheDir);
    expect(card).toMatchObject({ specPath: null, source: { kind: "remote" } });
    expect(card?.reviews).toBeUndefined();
  });

  it("updates the view when a project review file becomes a link", async () => {
    const id = "0001-relinked-review";
    const { root, cacheDir } = await behindProject(
      async (at) => {
        await writeIncrement(at, id, {
          tasks: 1,
          ledger: doneLedger(1),
          metadata: { status: "active" },
        });
      },
      async (at) => {
        await writeIncrement(at, id, { metadata: { status: "planned" } });
        const folder = folderOf(at, id);
        await NodeFSP.mkdir(NodePath.join(folder, "reports"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(folder, "reports", "review-approved.md"),
          "<!-- specweave review: model=gpt-6.1-sol family=openai author=claude at=2026-11-13T12:00:00Z -->\n# Review\nVerdict: ship\n",
        );
      },
    );
    const open = () => readProjectBoardIncrement(root, { incrementId: id, now: NOW, cacheDir });
    expect(await open()).toMatchObject({ review: { latest: { verdict: "ship" } } });
    const folder = folderOf(root, id);
    await NodeFSP.mkdir(NodePath.join(folder, "archive"));
    await NodeFSP.rename(
      NodePath.join(folder, "reports", "review-approved.md"),
      NodePath.join(folder, "archive", "review-approved.md"),
    );
    await NodeFSP.symlink(
      NodePath.join(folder, "archive", "review-approved.md"),
      NodePath.join(folder, "reports", "review-approved.md"),
    );
    const view = await open();
    expect(view === "invalid" || view === null ? null : (view.review?.latest ?? null)).toBeNull();
  });

  it("asks Git for origin/main when the files cannot answer", async () => {
    const id = "0001-asked-git";
    const { root, cacheDir, merged } = await behindProject(async (at) => {
      await writeIncrement(at, id, { tasks: 1, ledger: [] });
    });
    // origin/HEAD names a branch that is gone, and origin/main is not in the files.
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone");
    git(root, "update-ref", "-d", "refs/remotes/origin/main");
    const { execFileSync } = await import("node:child_process");
    const asked: string[] = [];
    const answering: BoardGitRun = async (cwd, args, input) => {
      if (args[0] === "rev-parse" && args.at(-1) === "refs/remotes/origin/main^{commit}") {
        asked.push("main");
        return { ok: true, stdout: Buffer.from(`${merged}\n`) };
      }
      try {
        const stdout = execFileSync("git", ["-C", cwd, ...args], {
          input: input ?? "",
          maxBuffer: 64 * 1_048_576,
          stdio: ["pipe", "pipe", "ignore"],
        });
        return { ok: true, stdout };
      } catch {
        return { ok: false, stdout: Buffer.alloc(0) };
      }
    };
    const board = await readProjectBoard(root, { now: NOW, cacheDir, git: answering });
    expect(asked).toEqual(["main"]);
    expect(board.cards.find((card) => card.incrementId === id)).toMatchObject({
      source: { kind: "remote", name: "origin/main" },
    });
  });

  it("counts how far behind a project folder on a branch named with a plus sign is", async () => {
    const { root, cacheDir } = await behindProject(async (at) => {
      await writeIncrement(at, "0001-ahead", { tasks: 1, ledger: [] });
    });
    git(root, "checkout", "-q", "-b", "fix/board+refs");
    const board = await readProjectBoard(root, { now: NOW, cacheDir });
    expect(board.behind).toMatchObject({ ref: "origin/main", count: 1 });
  });

  it("names the renamed default branch at the same commit", async () => {
    const id = "0001-renamed";
    const { root, cacheDir, merged } = await behindProject(async (at) => {
      await writeIncrement(at, id, { tasks: 1, ledger: [] });
    });
    expect((await cardOf(root, id, cacheDir))?.source).toMatchObject({ name: "origin/main" });
    setRemote(root, merged, "trunk");
    git(root, "update-ref", "-d", "refs/remotes/origin/main");
    expect((await cardOf(root, id, cacheDir))?.source).toMatchObject({ name: "origin/trunk" });
  });

  it("sees a spec and a reopen written in the project folder right after a read", async () => {
    const id = "0001-reopened-here";
    const { root, cacheDir } = await behindProject(
      async (at) => {
        await writeIncrement(at, id, {
          tasks: 2,
          ledger: doneLedger(2),
          metadata: { status: "completed" },
        });
      },
      async (at) => {
        await writeIncrement(at, id, { metadata: { status: "completed" } });
      },
    );
    const first = await readProjectBoard(root, { now: NOW, cacheDir });
    expect(first.notDone).toBe(0);
    expect(first.cards[0]).toMatchObject({ status: "completed", source: { kind: "remote" } });
    // Reopened in the project folder, with its spec back, within seconds.
    await writeIncrement(root, id, {
      tasks: 3,
      ledger: doneLedger(2),
      metadata: { status: "active", reopened: [{ at: "2026-11-14T11:00:00.000Z" }] },
    });
    const second = await readProjectBoard(root, { now: NOW, cacheDir });
    expect(second.notDone).toBe(1);
    const card = second.cards.find((entry) => entry.incrementId === id);
    expect(card).toMatchObject({ status: "active", tasks: { total: 3 } });
    expect(card?.source).toBeUndefined();
  });

  it("shows the project folder's reviews once a linked reports folder becomes a real one", async () => {
    const id = "0001-unlinked-reports";
    const { root, cacheDir } = await behindProject(
      async (at) => {
        await writeIncrement(at, id, {
          tasks: 1,
          ledger: doneLedger(1),
          metadata: { status: "active" },
        });
      },
      async (at) => {
        const folder = await writeIncrement(at, id, { metadata: { status: "planned" } });
        await NodeFSP.mkdir(NodePath.join(folder, "archive", "reports"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(folder, "archive", "reports", "review-approved.md"),
          "<!-- specweave review: model=gpt-6.1-sol family=openai author=claude at=2026-11-13T12:00:00Z -->\n# Review\nVerdict: ship\n",
        );
        await NodeFSP.symlink(
          NodePath.join(folder, "archive", "reports"),
          NodePath.join(folder, "reports"),
        );
      },
    );
    expect((await cardOf(root, id, cacheDir))?.reviews).toBeUndefined();
    const folder = folderOf(root, id);
    await NodeFSP.rm(NodePath.join(folder, "reports"));
    await NodeFSP.rename(
      NodePath.join(folder, "archive", "reports"),
      NodePath.join(folder, "reports"),
    );
    expect((await cardOf(root, id, cacheDir))?.reviews?.map((review) => review.verdict)).toEqual([
      "ship",
    ]);
  });

  it("answers from the folders alone when Git fails, and runs Git only when the remote commit changes", async () => {
    const { root, cacheDir } = await behindProject(
      async (at) => {
        await writeIncrement(at, "0002-remote", { tasks: 1, ledger: [] });
      },
      async (at) => {
        await writeIncrement(at, "0001-local", { tasks: 1, ledger: [] });
      },
    );
    const failing: BoardGitRun = async () => ({ ok: false, stdout: Buffer.alloc(0) });
    const alone = await readProjectBoard(root, { now: NOW, cacheDir, git: failing });
    expect(alone.cards.map((card) => card.incrementId)).toEqual(["0001-local"]);
    expect(alone.behind).toBeUndefined();

    // A second repository, so the failed read above is not what is remembered.
    const again = await behindProject(async (at) => {
      await writeIncrement(at, "0005-counted", { tasks: 1, ledger: [] });
      await writeIncrement(at, "0006-counted", { tasks: 2, ledger: [] });
    });
    const calls: string[] = [];
    const { execFileSync } = await import("node:child_process");
    const counting: BoardGitRun = async (cwd, args, input) => {
      calls.push(args[0]!);
      try {
        const stdout = execFileSync("git", ["-C", cwd, ...args], {
          input: input ?? "",
          maxBuffer: 64 * 1_048_576,
        });
        return { ok: true, stdout };
      } catch {
        return { ok: false, stdout: Buffer.alloc(0) };
      }
    };
    const read = () =>
      readProjectBoard(again.root, { now: NOW, cacheDir: again.cacheDir, git: counting });
    const firstRead = await read();
    expect(firstRead.cards).toHaveLength(2);
    expect(firstRead.cards.every((card) => card.source?.kind === "remote")).toBe(true);
    expect(firstRead.cards.every((card) => card.specPath !== null)).toBe(true);
    // The listing, the metadata blobs, how far behind, and both shown copies at once.
    expect(calls.toSorted()).toEqual(["cat-file", "cat-file", "ls-tree", "rev-list"]);
    calls.length = 0;
    expect(await read()).toEqual(firstRead);
    expect(calls).toEqual([]);
  });
});
