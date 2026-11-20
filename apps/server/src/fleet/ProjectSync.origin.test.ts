// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * What a move says it did (1390): a move is claimed only once Git confirmed
 * the ref transaction and the branch reads at the target; a write whose result
 * could not be read says so; a refusal is said only once it was read that
 * nothing moved. And a fetch's failure in one repository is that one's alone.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
import {
  planProjectSync,
  PROJECT_SYNC_FETCHED_UNREAD_DETAIL,
  PROJECT_SYNC_STATE_UNREAD_DETAIL,
  PROJECT_SYNC_UNVERIFIED_DETAIL,
  type ProjectSyncStep,
} from "@specweave-studio/contracts";
import { vi } from "vite-plus/test";

import {
  cleanUp,
  commit,
  git,
  isolateGit,
  restoreGit,
  snapshot,
  twoMachines,
} from "../handoff/extrasTestKit.ts";
import { runGit } from "./folderTransfer/git.ts";
import { fetchAll, inParallel, runSync, type SyncContext, type SyncGit } from "./ProjectSync.ts";
import { type FetchRecord, newFetchRecord } from "./projectSyncRecord.ts";

beforeAll(isolateGit);
afterAll(restoreGit);
afterEach(() => {
  vi.restoreAllMocks();
  cleanUp();
});

const real: SyncGit = (cwd, args, options) => runGit(cwd, args, options);
/** A call's context. `origin` is the one fetch it goes by: a fetch fills it, a move reads it. */
const context = (
  origin: FetchRecord | undefined = newFetchRecord("project-test"),
  run: SyncGit = real,
  more: Partial<SyncContext> = {},
): SyncContext => ({
  git: run,
  inUse: async () => null,
  ...(origin === undefined ? {} : { fetched: origin }),
  ...more,
});
const at = (cwd: string) => [{ path: ".", cwd }];
const move = async (ctx: SyncContext, cwd: string) =>
  (
    await runSync(ctx, cwd, at(cwd), {
      fastForward: [{ path: ".", otherBranch: null }],
      clone: [],
    })
  )[0]!;
const say = (step: Pick<ProjectSyncStep, "action" | "reason">) => `${step.action}:${step.reason}`;
const isTree = (args: ReadonlyArray<string>) => args.includes("read-tree");

/** Machine B one commit behind `origin`'s `main`, which is at `head`. */
function behind() {
  const f = twoMachines();
  const was = git(f.b, "rev-parse", "HEAD");
  const head = commit(f.a, "app.ts", "export const a = 2;\n");
  git(f.a, "push", "-q", "origin", "main");
  return { ...f, was, head };
}

describe("project sync: a write that went through is never reported as refused (P2-29, D4-06)", () => {
  it("says the outcome could not be read when no read after the write answers", async () => {
    const f = behind();
    const ctx = context();
    await fetchAll(ctx, at(f.b));
    let written = false;
    const run: SyncGit = async (cwd, args, options) => {
      if (written && (args[0] === "symbolic-ref" || args[0] === "rev-parse"))
        throw new Error("git did not answer");
      const result = await real(cwd, args, options);
      if (isTree(args)) written = true;
      return result;
    };
    const step = await move({ ...ctx, git: run }, f.b);
    expect(step).toMatchObject({
      action: "fast-forward",
      reason: "behind",
      moved: 0,
      movedUnverified: true,
      downgraded: true,
      detail: PROJECT_SYNC_UNVERIFIED_DETAIL,
    });
    expect(PROJECT_SYNC_UNVERIFIED_DETAIL).toBe(
      "Git was asked to move this checkout forward, but the result could not be read. Check the checkout before working in it.",
    );
    // It did move: the result claimed neither that nor a refusal.
    expect(git(f.b, "rev-parse", "HEAD")).toBe(f.head);
  });

  it("reports a refusal only after reading that nothing moved", async () => {
    const f = behind();
    const ctx = context();
    await fetchAll(ctx, at(f.b));
    const before = snapshot(f.b);
    const run: SyncGit = (cwd, args, options) =>
      isTree(args)
        ? Promise.reject(new Error("git read-tree timed out"))
        : real(cwd, args, options);
    const step = await move({ ...ctx, git: run }, f.b);
    expect(step).toMatchObject({
      action: "none",
      reason: "refused",
      branch: "main",
      moved: 0,
      downgraded: true,
    });
    expect(step.detail).toContain("git read-tree timed out");
    expect(step.movedUnverified ?? false).toBe(false);
    expect(snapshot(f.b)).toEqual(before);
  });
});

describe("project sync: a failure in one repository of a fetch (P2-32)", () => {
  it("takes a status that never came back for a state that could not be read", async () => {
    const f = behind();
    const folders = [
      { path: "a", cwd: f.a },
      { path: "b", cwd: f.b },
    ];
    const run: SyncGit = (cwd, args, options) =>
      cwd === f.b && args[0] === "status"
        ? Promise.reject(new Error("git status timed out"))
        : real(cwd, args, options);
    const here = await fetchAll(context(newFetchRecord("project-test"), run), folders);
    expect(here.map((facts) => facts.path)).toEqual(["a", "b"]);
    expect(here[0]).toMatchObject({ fetch: "ok", behind: 0 });
    expect(here[0]!.stateUnread ?? false).toBe(false);
    expect(here[1]).toMatchObject({ fetch: "ok", behind: 1, uncommitted: 0, stateUnread: true });
    expect(say(planProjectSync(here, [])[1]!)).toBe("fetch:uncommitted");
  });

  it("keeps the other repositories' facts, and its own fetch, when a read after the fetch fails", async () => {
    const f = behind();
    const folders = [
      { path: "a", cwd: f.a },
      { path: "b", cwd: f.b },
    ];
    const run: SyncGit = (cwd, args, options) =>
      cwd === f.a && args[0] === "symbolic-ref"
        ? Promise.reject(new Error("git symbolic-ref timed out"))
        : real(cwd, args, options);
    const here = await fetchAll(context(newFetchRecord("project-test"), run), folders);
    // The fetch went through: said as that, with the read that failed as its own sentence.
    expect(here[0]).toMatchObject({
      path: "a",
      fetch: "ok",
      fetchError: null,
      stateUnread: true,
      unreadDetail: PROJECT_SYNC_FETCHED_UNREAD_DETAIL,
    });
    expect(say(planProjectSync(here, [])[0]!)).toBe("fetch:uncommitted");
    expect(here[1]).toMatchObject({ path: "b", fetch: "ok", behind: 1 });
  });

  it("reports a fetch whose settings could not be read as not run and unread, and keeps the others (D4-06)", async () => {
    const f = behind();
    const folders = [
      { path: "a", cwd: f.a },
      { path: "b", cwd: f.b },
    ];
    const run: SyncGit = (cwd, args, options) =>
      cwd === f.a && args[0] === "config"
        ? Promise.reject(new Error("git config timed out"))
        : real(cwd, args, options);
    const ctx = context(newFetchRecord("project-test"), run);
    const here = await fetchAll(ctx, folders);
    expect(here[0]).toMatchObject({
      path: "a",
      fetch: "not-run",
      fetchError: null,
      stateUnread: true,
      unreadDetail: PROJECT_SYNC_STATE_UNREAD_DETAIL,
    });
    expect(planProjectSync(here, [])[0]).toMatchObject({
      action: "none",
      reason: "uncommitted",
      detail: PROJECT_SYNC_STATE_UNREAD_DETAIL,
    });
    // Its fetch wrote no row: nothing of it can move by this fetch.
    expect(ctx.fetched!.rows.has("a")).toBe(false);
    expect(here[1]).toMatchObject({ path: "b", fetch: "ok", behind: 1 });
  });

  it("ends only when every worker it started has ended, and starts no more after a failure", async () => {
    let running = 0;
    const started: Array<number> = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = inParallel(
      Array.from({ length: 12 }, (_, index) => index),
      async (index) => {
        started.push(index);
        running += 1;
        try {
          if (index === 0) throw new Error("first failed");
          await gate;
          return index;
        } finally {
          running -= 1;
        }
      },
    );
    let ended: string | null = null;
    const watched = work.then(
      () => {
        ended = "resolved";
      },
      (cause: unknown) => {
        ended = `${(cause as Error).message} with ${running} still running`;
      },
    );
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    // The first worker has failed; three others are still at work, and the call has not ended.
    expect(running).toBe(3);
    expect(ended).toBe(null);
    release();
    await watched;
    expect(ended).toBe("first failed with 0 still running");
    expect(started).toEqual([0, 1, 2, 3]);
  });
});
