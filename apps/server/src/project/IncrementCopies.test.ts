// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { rankCopies, type BoardGitRun, type CopyRank } from "./IncrementCopies.ts";
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
    expect(firstRead.cards[0]).toMatchObject({ source: { kind: "remote" } });
    // The listing, the metadata blobs, how far behind, and the one shown copy.
    expect(calls.toSorted()).toEqual(["cat-file", "cat-file", "ls-tree", "rev-list"]);
    calls.length = 0;
    expect(await read()).toEqual(firstRead);
    expect(calls).toEqual([]);
  });
});
