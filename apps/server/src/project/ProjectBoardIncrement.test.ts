// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { problemText, readProjectBoardIncrement } from "./ProjectBoardIncrement.ts";

const roots: string[] = [];
const NOW = Date.parse("2026-11-14T12:00:00Z");
const MINUTE = 60_000;
let tick = 0;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function temp(prefix: string): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function project(): Promise<string> {
  const root = await temp("project-board-increment-");
  await NodeFSP.mkdir(NodePath.join(root, ".specweave", "increments"), { recursive: true });
  return root;
}

const SPEC = `# Board view

## Problem

The **board** hides why work is \`stuck\`. See [the design](https://example.com/design).

- Blocked cards look like active ones.

\`\`\`
## Not a heading inside code
\`\`\`

## Acceptance criteria
- [ ] AC-01: The view shows blockers

## Tasks
### T-01 Contract
- AC: AC-01 | Files: a.ts | Test: true
### T-02 Reader
- AC: AC-01 | Files: b.ts | Test: true
### T-03 View
- AC: AC-01 | Files: c.ts | Test: true
### T-04 Docs
- AC: AC-01 | Files: d.md | Test: true
`;

const at = (offsetMinutes: number) => new Date(NOW + offsetMinutes * MINUTE).toISOString();
const event = (task: string, kind: string, extra: Record<string, string> = {}) =>
  JSON.stringify({ t: task, e: kind, by: "agent@host-a", at: at(-10), ...extra });

async function increment(
  root: string,
  id: string,
  input: {
    status?: string;
    spec?: string | null;
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
      title: `Title of ${id}`,
      updated: "2026-11-01T00:00:00.000Z",
      ...input.metadata,
    }),
  );
  if (input.spec !== null) {
    await NodeFSP.writeFile(NodePath.join(folder, "spec.md"), input.spec ?? SPEC);
  }
  if (input.ledger !== undefined) {
    await NodeFSP.writeFile(NodePath.join(folder, "ledger.jsonl"), `${input.ledger.join("\n")}\n`);
  }
  return folder;
}

/** Writes a file and moves its mtime forward, so the change shows even within one clock tick. */
async function rewrite(file: string, content: string) {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  await NodeFSP.writeFile(file, content);
  tick += 1;
  const time = new Date(NOW + tick * 1_000);
  await NodeFSP.utimes(file, time, time);
}

const LEDGER = [
  event("T-01", "claim", { at: at(-60) }),
  event("T-01", "done", { at: at(-50), evidence: "abc1234" }),
  event("T-02", "block", { note: "waiting for the contract review" }),
  event("T-03", "claim", { by: "agent@host-b" }),
];

describe("readProjectBoardIncrement", () => {
  it("answers a full increment with its open tasks, blockers and problem", async () => {
    const root = await project();
    await increment(root, "0001-board", { ledger: LEDGER });
    const result = await readProjectBoardIncrement(root, { incrementId: "0001-board", now: NOW });
    if (result === null || result === "invalid") throw new Error("expected an increment");
    expect(result.card.incrementId).toBe("0001-board");
    expect(result.card.title).toBe("Title of 0001-board");
    expect(result.problem).toBe(
      "The board hides why work is stuck. See the design.\n\nBlocked cards look like active ones.",
    );
    expect(result.readable).toBe(true);
    expect(result.tasks.map((task) => task.id)).toEqual(["T-02", "T-03", "T-04"]);
    expect(result.doneTasks).toBe(1);
    expect(result.blockers).toEqual([
      {
        taskId: "T-02",
        title: "Reader",
        note: "waiting for the contract review",
        by: "agent@host-a",
        at: at(-10),
        leased: true,
      },
    ]);
    expect(result.tasks.find((task) => task.id === "T-03")).toMatchObject({
      status: "claimed",
      owner: "agent@host-b",
      leased: true,
    });
    expect(result.criteria.map((criterion) => criterion.id)).toEqual(["AC-01"]);
    expect(result.abandoned).toBe(false);
    expect(result.abandonedReason).toBeNull();
    expect(result.closedAt).toBeNull();
    expect(result.reports).toEqual([]);

    const all = await readProjectBoardIncrement(root, {
      incrementId: "0001-board",
      includeDone: true,
      now: NOW,
    });
    if (all === null || all === "invalid") throw new Error("expected an increment");
    expect(all.tasks.map((task) => task.id)).toEqual(["T-01", "T-02", "T-03", "T-04"]);
    expect(all.doneTasks).toBe(1);
  });

  it("gives a paused increment's card its reason", async () => {
    const root = await project();
    await increment(root, "0002-paused", {
      status: "paused",
      metadata: { pausedReason: "Waiting on design" },
    });
    const result = await readProjectBoardIncrement(root, { incrementId: "0002-paused", now: NOW });
    if (result === null || result === "invalid") throw new Error("expected an increment");
    expect(result.card.pausedReason).toBe("Waiting on design");
  });

  it("cuts a long problem at a word boundary and strips markdown", () => {
    const words = Array.from({ length: 400 }, (_, index) => `**word${index}**`).join(" ");
    const text = problemText(`# T\n\n## Problem\n\n${words}\n\n## Tasks\n`);
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(1_200);
    expect(text!.endsWith("…")).toBe(true);
    expect(text).not.toContain("*");
    expect(text!.slice(0, -1)).toMatch(/word\d+$/u);
    expect(problemText("# T\n\n## Problem\n\n## Tasks\n")).toBeNull();
    expect(problemText("# T\n\n## Tasks\n")).toBeNull();
  });

  it("answers without a spec, and for a spec with no tasks", async () => {
    const root = await project();
    await increment(root, "0003-nospec", { spec: null });
    const bare = await readProjectBoardIncrement(root, { incrementId: "0003-nospec", now: NOW });
    if (bare === null || bare === "invalid") throw new Error("expected an increment");
    expect(bare.problem).toBeNull();
    expect(bare.tasks).toEqual([]);
    expect(bare.readable).toBe(false);
    expect(bare.card.specPath).toBeNull();

    await increment(root, "0004-notasks", { spec: "# Plan\n\n## Problem\n\nOnly words.\n" });
    const plain = await readProjectBoardIncrement(root, { incrementId: "0004-notasks", now: NOW });
    if (plain === null || plain === "invalid") throw new Error("expected an increment");
    expect(plain.problem).toBe("Only words.");
    expect(plain.tasks).toEqual([]);
    expect(plain.doneTasks).toBe(0);
    expect(plain.readable).toBe(false);
    expect(plain.card.specPath).not.toBeNull();
  });

  it("serves an unchanged increment from cache and rereads after any signed file changes", async () => {
    const root = await project();
    const folder = await increment(root, "0005-cache", { ledger: LEDGER });
    const read = () => readProjectBoardIncrement(root, { incrementId: "0005-cache", now: NOW });
    const first = await read();
    expect(await read()).toBe(first);

    await rewrite(
      NodePath.join(folder, "metadata.json"),
      JSON.stringify({ status: "active", title: "Renamed" }),
    );
    const renamed = await read();
    expect(renamed).not.toBe(first);
    expect(renamed !== null && renamed !== "invalid" && renamed.card.title).toBe("Renamed");

    await rewrite(
      NodePath.join(folder, "reports", "verify.json"),
      JSON.stringify({ ok: true, ranAt: at(-1) }),
    );
    const verified = await read();
    expect(verified !== null && verified !== "invalid" && verified.verify).toEqual({
      ok: true,
      ranAt: at(-1),
    });
    expect(
      verified !== null && verified !== "invalid" && verified.reports.map((report) => report.name),
    ).toEqual(["verify.json"]);

    await rewrite(
      NodePath.join(folder, "reports", "reviews", "review-1.md"),
      "# Review\nVerdict: ship\n",
    );
    const reviewed = await read();
    expect(reviewed !== null && reviewed !== "invalid" && reviewed.review?.latest?.verdict).toBe(
      "ship",
    );
    await rewrite(
      NodePath.join(folder, "reports", "reviews", "review-1.md"),
      "# Review\nVerdict: fix first\n",
    );
    const rereviewed = await read();
    expect(
      rereviewed !== null && rereviewed !== "invalid" && rereviewed.review?.latest?.verdict,
    ).toBe("fix first");

    await rewrite(
      NodePath.join(folder, "ledger.jsonl"),
      `${[...LEDGER, event("T-04", "done", { evidence: "def5678" })].join("\n")}\n`,
    );
    const ledgered = await read();
    expect(ledgered !== null && ledgered !== "invalid" && ledgered.doneTasks).toBe(2);

    await rewrite(
      NodePath.join(folder, "spec.md"),
      SPEC.replace("The **board** hides", "The board now hides"),
    );
    const respecced = await read();
    expect(respecced !== null && respecced !== "invalid" && respecced.problem).toMatch(
      /^The board now hides/u,
    );
    expect(await read()).toBe(respecced);
  });

  it("rereads after the project config or a legacy tasks.md changes", async () => {
    const root = await project();
    const folder = await increment(root, "0014-config", { ledger: LEDGER });
    const read = () => readProjectBoardIncrement(root, { incrementId: "0014-config", now: NOW });
    const first = await read();
    if (first === null || first === "invalid") throw new Error("expected an increment");
    expect(first.review).toBeNull();

    await rewrite(
      NodePath.join(root, ".specweave", "config.json"),
      JSON.stringify({ review: { policy: { reviewer: "openai", required: true } } }),
    );
    const policed = await read();
    if (policed === null || policed === "invalid") throw new Error("expected an increment");
    expect(policed).not.toBe(first);
    expect(policed.review?.policy).toMatchObject({ family: "openai", required: true });

    await rewrite(
      NodePath.join(folder, "tasks.md"),
      "# Tasks\n\n### T-01 Only task\n- AC: AC-01 | Files: a.ts | Test: true\n",
    );
    const legacy = await read();
    if (legacy === null || legacy === "invalid") throw new Error("expected an increment");
    expect(legacy.doneTasks).toBe(1);
    expect(legacy.tasks).toEqual([]);
  });

  it("answers without a review when the project config is linked out of the planning root", async () => {
    const root = await project();
    await increment(root, "0015-linked-config");
    const outside = await temp("project-board-outside-config-");
    const config = NodePath.join(outside, "config.json");
    await NodeFSP.writeFile(
      config,
      JSON.stringify({ review: { policy: { reviewer: "openai", depth: "deep", required: true } } }),
    );
    await NodeFSP.symlink(config, NodePath.join(root, ".specweave", "config.json"));
    const result = await readProjectBoardIncrement(root, {
      incrementId: "0015-linked-config",
      now: NOW,
    });
    // The outside policy never reaches the answer, and the increment still opens.
    expect(JSON.stringify(result)).not.toContain("openai");
    expect(result).toMatchObject({ review: null, card: { incrementId: "0015-linked-config" } });
  });

  it("drops a claim's lease after two hours although no file changed", async () => {
    const root = await project();
    await increment(root, "0006-lease", { ledger: LEDGER });
    const read = (now: number) =>
      readProjectBoardIncrement(root, { incrementId: "0006-lease", now });
    const fresh = await read(NOW);
    if (fresh === null || fresh === "invalid") throw new Error("expected an increment");
    expect(fresh.tasks.find((task) => task.id === "T-03")).toMatchObject({
      status: "claimed",
      leased: true,
    });
    const later = await read(NOW + 2 * 60 * MINUTE + MINUTE);
    if (later === null || later === "invalid") throw new Error("expected an increment");
    expect(later).not.toBe(fresh);
    expect(later.tasks.find((task) => task.id === "T-03")).toMatchObject({
      status: "stale",
      leased: false,
    });
    expect(later.blockers[0]?.leased).toBe(false);
    expect(fresh.card.tasks.active).toBe(1);
    expect(later.card.tasks.active).toBe(0);
  });

  it("answers null once the increment folder is removed", async () => {
    const root = await project();
    const folder = await increment(root, "0007-gone");
    expect(await readProjectBoardIncrement(root, { incrementId: "0007-gone", now: NOW })).not.toBe(
      null,
    );
    await NodeFSP.rm(folder, { recursive: true });
    expect(await readProjectBoardIncrement(root, { incrementId: "0007-gone", now: NOW })).toBe(
      null,
    );
    expect(await readProjectBoardIncrement(root, { incrementId: "0099-never", now: NOW })).toBe(
      null,
    );
  });

  it("refuses names and links that lead outside the planning root", async () => {
    const root = await project();
    await increment(root, "0001-a");
    const outside = await temp("project-board-outside-");
    const secret = NodePath.join(outside, "0008-secret");
    await NodeFSP.mkdir(NodePath.join(secret, "reports"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(secret, "metadata.json"),
      JSON.stringify({ status: "active", title: "OUTSIDE SECRET" }),
    );
    await NodeFSP.writeFile(
      NodePath.join(secret, "spec.md"),
      "# OUTSIDE SECRET\n\n## Problem\n\nOUTSIDE SECRET\n",
    );
    await NodeFSP.writeFile(NodePath.join(secret, "reports", "outside.md"), "OUTSIDE SECRET");
    await NodeFSP.symlink(secret, NodePath.join(root, ".specweave", "increments", "0008-secret"));

    for (const incrementId of [
      "../outside",
      "0001-a/../../x",
      secret,
      "0001-a\u0000",
      "0008-secret",
    ]) {
      expect(await readProjectBoardIncrement(root, { incrementId, now: NOW })).toBe("invalid");
    }

    // Links inside a real increment folder never pull outside content in either.
    const folder = await increment(root, "0009-links", { spec: null });
    await NodeFSP.symlink(NodePath.join(secret, "spec.md"), NodePath.join(folder, "spec.md"));
    const linked = await readProjectBoardIncrement(root, { incrementId: "0009-links", now: NOW });
    if (linked === null || linked === "invalid") throw new Error("expected an increment");
    expect(JSON.stringify(linked)).not.toContain("OUTSIDE SECRET");
    expect(linked.problem).toBeNull();
    expect(linked.reports).toEqual([]);
    await NodeFSP.symlink(NodePath.join(secret, "reports"), NodePath.join(folder, "reports"));

    // A review record linked out of the folder would be read by the review
    // reader, so that increment is refused, as is a linked reports folder.
    await NodeFSP.mkdir(NodePath.join(secret, "reviews"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(secret, "review.md"), "OUTSIDE SECRET\nVerdict: ship\n");
    await NodeFSP.writeFile(
      NodePath.join(secret, "reviews", "review-1.md"),
      "OUTSIDE SECRET\nVerdict: ship\n",
    );
    expect(await readProjectBoardIncrement(root, { incrementId: "0009-links", now: NOW })).toBe(
      "invalid",
    );
    const records = await increment(root, "0012-records");
    await NodeFSP.mkdir(NodePath.join(records, "reports"), { recursive: true });
    await NodeFSP.symlink(
      NodePath.join(secret, "review.md"),
      NodePath.join(records, "reports", "review.md"),
    );
    expect(await readProjectBoardIncrement(root, { incrementId: "0012-records", now: NOW })).toBe(
      "invalid",
    );
    const runs = await increment(root, "0013-runs");
    await NodeFSP.mkdir(NodePath.join(runs, "reports"), { recursive: true });
    await NodeFSP.symlink(
      NodePath.join(secret, "reviews"),
      NodePath.join(runs, "reports", "reviews"),
    );
    expect(await readProjectBoardIncrement(root, { incrementId: "0013-runs", now: NOW })).toBe(
      "invalid",
    );
  });

  it("still answers an abandoned increment, with its reason and closing time", async () => {
    const root = await project();
    await increment(root, "0010-dropped", {
      status: "abandoned",
      metadata: {
        abandonedReason: "  Replaced by the board view  ",
        abandonedAt: "2026-11-10T09:00:00.000Z",
      },
    });
    const result = await readProjectBoardIncrement(root, {
      incrementId: "0010-dropped",
      now: NOW,
    });
    if (result === null || result === "invalid") throw new Error("expected an increment");
    expect(result.abandoned).toBe(true);
    expect(result.abandonedReason).toBe("Replaced by the board view");
    expect(result.closedAt).toBe("2026-11-10T09:00:00.000Z");
    expect(result.card.incrementId).toBe("0010-dropped");
  });

  it("lists report files newest first without dotfiles or folders", async () => {
    const root = await project();
    const folder = await increment(root, "0011-reports");
    await rewrite(NodePath.join(folder, "reports", "older.md"), "a");
    await rewrite(NodePath.join(folder, "reports", "newer.md"), "b");
    await rewrite(NodePath.join(folder, "reports", ".hidden"), "c");
    await rewrite(NodePath.join(folder, "reports", "reviews", "review-x.md"), "d");
    const result = await readProjectBoardIncrement(root, {
      incrementId: "0011-reports",
      now: NOW,
    });
    if (result === null || result === "invalid") throw new Error("expected an increment");
    expect(result.reports).toEqual([
      { name: "newer.md", path: NodePath.join(folder, "reports", "newer.md") },
      { name: "older.md", path: NodePath.join(folder, "reports", "older.md") },
    ]);
  });
});
