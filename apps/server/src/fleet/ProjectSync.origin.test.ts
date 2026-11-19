// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * What Sync may move a checkout to (1390): the commit the one fetch a call goes
 * by brought for the branch, by object id. Never a branch by its name, never a
 * tracking ref read later, never what `origin` lists without a fetch, and never
 * a fetch of another checkout, another address or another project.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
import {
  planProjectSync,
  PROJECT_SYNC_CHANGED_BRANCH_DETAIL,
  PROJECT_SYNC_CHANGED_FILES_DETAIL,
  PROJECT_SYNC_CHANGED_HEAD_DETAIL,
  PROJECT_SYNC_CHANGED_UPSTREAM_DETAIL,
  PROJECT_SYNC_FETCH_KEPT_MS,
  PROJECT_SYNC_FETCH_STALE_DETAIL,
  PROJECT_SYNC_FETCHED_UNREAD_DETAIL,
  PROJECT_SYNC_FETCHES_KEPT,
  PROJECT_SYNC_MOVED_UNASKED_DETAIL,
  PROJECT_SYNC_NO_FETCH_DETAIL,
  PROJECT_SYNC_NOT_AS_FETCHED_DETAIL,
  PROJECT_SYNC_NOT_TRIED_DETAIL,
  PROJECT_SYNC_OFFLINE_UNSURE_DETAIL,
  PROJECT_SYNC_ORIGIN_MOVED_DETAIL,
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
  write,
} from "../handoff/extrasTestKit.ts";
import { runGit } from "./folderTransfer/git.ts";
import { fetchAll, inParallel, runSync, type SyncContext, type SyncGit } from "./ProjectSync.ts";
import {
  askBudget,
  askOrigin,
  checkoutIdentity,
  type FetchRecord,
  keepFetch,
  keptFetch,
  latestHeads,
  newFetchRecord,
  ORIGIN_ASK_MS,
  ORIGIN_ASK_TOTAL_MS,
} from "./projectSyncOrigin.ts";
import { MERGE_ARGS } from "./projectSyncRun.ts";

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

/** Machine B one commit behind `origin`'s `main`, which is at `head`. */
function behind() {
  const f = twoMachines();
  const was = git(f.b, "rev-parse", "HEAD");
  const head = commit(f.a, "app.ts", "export const a = 2;\n");
  git(f.a, "push", "-q", "origin", "main");
  return { ...f, was, head };
}
/** `origin` stops answering. Its address in the repository's settings stays as it is. */
const outage = (f: { readonly remote: string }) => NodeFS.renameSync(f.remote, `${f.remote}.away`);
/** A runner that notes every command and lets a test act right before one. */
function watching(before: (cwd: string, args: ReadonlyArray<string>) => void = () => undefined) {
  const commands: Array<{
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs: number | undefined;
  }> = [];
  const run: SyncGit = (cwd, args, options) => {
    commands.push({ cwd, args: [...args], timeoutMs: options?.timeoutMs });
    before(cwd, args);
    return real(cwd, args, options);
  };
  return { run, commands, ran: (verb: string) => commands.filter((c) => c.args[0] === verb) };
}
const asks = (w: ReturnType<typeof watching>) =>
  w.ran("ls-remote").filter((command) => command.args[1] === "--heads");

describe("project sync: the move goes to what its fetch brought (P2-28)", () => {
  it("moves by the fetch when origin stops answering, its address unchanged", async () => {
    const f = behind();
    const ctx = context();
    const here = await fetchAll(ctx, at(f.b));
    expect(here[0]).toMatchObject({ fetch: "ok", behind: 1 });
    outage(f);
    const step = await move(ctx, f.b);
    expect(step).toMatchObject({
      action: "fast-forward",
      reason: "behind",
      moved: 1,
      downgraded: false,
      detail: PROJECT_SYNC_MOVED_UNASKED_DETAIL,
    });
    expect(git(f.b, "rev-parse", "HEAD")).toBe(f.head);
    expect(git(f.b, "config", "--get", "remote.origin.url")).toBe(f.remote);
  });

  it("moves nothing without a fetch to go by, whatever origin and the tracking ref say", async () => {
    const f = behind();
    git(f.b, "fetch", "-q", "origin");
    const before = snapshot(f.b);
    const w = watching();
    for (const ctx of [context(undefined, w.run), context(newFetchRecord("project-test"), w.run)])
      expect(await move(ctx, f.b)).toMatchObject({
        action: "none",
        reason: "refused",
        moved: 0,
        downgraded: true,
        detail: PROJECT_SYNC_NO_FETCH_DETAIL,
      });
    expect(w.ran("merge")).toEqual([]);
    expect(asks(w)).toEqual([]);
    expect(snapshot(f.b)).toEqual(before);
  });

  it("does not move to the old tip after a force-push that kept the branch's name", async () => {
    const f = behind();
    const ctx = context();
    await fetchAll(ctx, at(f.b));
    // origin's main is replaced by another commit; the name stays.
    git(f.a, "commit", "-q", "--amend", "-m", "rewritten");
    git(f.a, "push", "-q", "--force", "origin", "main");
    const w = watching();
    const step = await move({ ...ctx, git: w.run }, f.b);
    expect(step).toMatchObject({
      action: "none",
      reason: "refused",
      moved: 0,
      downgraded: true,
      detail: PROJECT_SYNC_ORIGIN_MOVED_DETAIL,
    });
    expect(PROJECT_SYNC_ORIGIN_MOVED_DETAIL).toBe(
      "origin's branch moved since the fetch. Sync again.",
    );
    expect(w.ran("merge")).toEqual([]);
    expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
    // What was learned stays learned: offline, the old tip is not moved to either.
    outage(f);
    expect(await move(ctx, f.b)).toMatchObject({
      action: "none",
      reason: "refused",
      detail: PROJECT_SYNC_ORIGIN_MOVED_DETAIL,
    });
    expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
  });

  it("holds what one window learned of a rewrite against another window's older fetch", async () => {
    const f = behind();
    const first = context(newFetchRecord("project-rewritten"));
    const second = context(newFetchRecord("project-rewritten"));
    for (const ctx of [first, second]) {
      await fetchAll(ctx, at(f.b));
      keepFetch(ctx.fetched!);
    }
    git(f.a, "commit", "-q", "--amend", "-m", "rewritten");
    git(f.a, "push", "-q", "--force", "origin", "main");
    // The first window asks and learns of it. The second, with no connection, has only
    // its own fetch of the old tip, and is not moved to it.
    expect(await move(first, f.b)).toMatchObject({ detail: PROJECT_SYNC_ORIGIN_MOVED_DETAIL });
    outage(f);
    const w = watching();
    expect(await move({ ...second, git: w.run }, f.b)).toMatchObject({
      action: "none",
      reason: "refused",
      moved: 0,
      detail: PROJECT_SYNC_ORIGIN_MOVED_DETAIL,
    });
    expect(w.ran("merge")).toEqual([]);
    expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
  });

  it("does not move to a commit somebody else's fetch brought after this Sync's", async () => {
    const f = behind();
    const ctx = context();
    await fetchAll(ctx, at(f.b));
    // The person fetches a newer commit themselves: the tracking ref is past the fetch.
    commit(f.a, "app.ts", "export const a = 3;\n");
    git(f.a, "push", "-q", "origin", "main");
    git(f.b, "fetch", "-q", "origin");
    const w = watching();
    const step = await move({ ...ctx, git: w.run }, f.b);
    expect(step).toMatchObject({
      action: "none",
      reason: "refused",
      moved: 0,
      downgraded: true,
      detail: PROJECT_SYNC_NOT_AS_FETCHED_DETAIL,
    });
    expect(PROJECT_SYNC_NOT_AS_FETCHED_DETAIL).toBe(
      "This checkout's copy of origin's branch is not at the commit this Sync fetched. Sync again.",
    );
    expect(w.ran("merge")).toEqual([]);
    expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
    // A new Sync fetch plans it again, and it moves.
    const next = context();
    const again = await fetchAll(next, at(f.b));
    expect(say(planProjectSync(again, [])[0]!)).toBe("fast-forward:behind");
    expect(await move(next, f.b)).toMatchObject({ action: "fast-forward", moved: 2, detail: null });
  });

  it("plans nothing on a tracking ref that is not where its fetch left it", async () => {
    const f = behind();
    const ctx = context();
    // Something moves the tracking ref right after Sync's fetch wrote it.
    const run: SyncGit = async (cwd, args, options) => {
      const result = await real(cwd, args, options);
      if (args[0] === "fetch") git(f.b, "update-ref", "refs/remotes/origin/main", f.was);
      return result;
    };
    const here = await fetchAll({ ...ctx, git: run }, at(f.b));
    // Counted against what the fetch brought, not against the ref.
    expect(here[0]).toMatchObject({
      fetch: "ok",
      upstream: "origin/main",
      behind: 1,
      upstreamMoved: true,
    });
    const step = planProjectSync(here, [])[0]!;
    expect(say(step)).toBe("none:refused");
    expect(step.detail).toBe(PROJECT_SYNC_NOT_AS_FETCHED_DETAIL);
  });

  it("never hands a fetch to a clone made again at the same path", async () => {
    const f = behind();
    const ctx = context();
    await fetchAll(ctx, at(f.b));
    // The folder is removed and cloned again: same path, same origin, same branch, same commit.
    NodeFS.rmSync(f.b, { recursive: true, force: true });
    git(f.base, "clone", "-q", f.remote, f.b);
    git(f.b, "reset", "-q", "--hard", f.was);
    expect(git(f.b, "rev-parse", "refs/remotes/origin/main")).toBe(f.head);
    // Also with origin answering: the fetch was not of this checkout.
    for (const offline of [false, true]) {
      if (offline) outage(f);
      expect(await move(ctx, f.b)).toMatchObject({
        action: "none",
        reason: "refused",
        moved: 0,
        detail: offline ? PROJECT_SYNC_NO_FETCH_DETAIL : PROJECT_SYNC_FETCH_STALE_DETAIL,
      });
    }
    expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
  });

  it("never goes by a fetch across a changed origin address", async () => {
    const f = behind();
    const ctx = context();
    await fetchAll(ctx, at(f.b));
    // Another origin with the very same branch and commit.
    const copy = NodePath.join(f.base, "elsewhere.git");
    git(f.base, "clone", "-q", "--bare", f.remote, copy);
    git(f.b, "remote", "set-url", "origin", copy);
    expect(await move(ctx, f.b)).toMatchObject({
      action: "none",
      reason: "refused",
      moved: 0,
      detail: PROJECT_SYNC_FETCH_STALE_DETAIL,
    });
    expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
  });

  it("does not go by a fetch offline where the file system keeps no time of creation", async () => {
    const f = behind();
    const identity = await checkoutIdentity(real, f.b, async () => ({
      dev: 1n,
      ino: 2n,
      birthtimeNs: 0n,
      isDirectory: () => true,
    }));
    expect(identity).toMatchObject({ identity: "1:2:0", sure: false });
    expect(await checkoutIdentity(real, f.b)).toMatchObject({ checkout: f.b });
    const ctx = context();
    await fetchAll(ctx, at(f.b));
    // The same fetch, on a file system that could not tell this checkout from a later one.
    const record = ctx.fetched!.repositories.get(f.b)!;
    ctx.fetched!.repositories.set(f.b, { ...record, sure: false });
    NodeFS.renameSync(f.remote, `${f.remote}.away`);
    expect(await move(ctx, f.b)).toMatchObject({
      action: "none",
      reason: "refused",
      moved: 0,
      detail: PROJECT_SYNC_OFFLINE_UNSURE_DETAIL,
    });
    expect(PROJECT_SYNC_OFFLINE_UNSURE_DETAIL).toBe(
      "origin could not be reached, and this checkout cannot be told from one made again in its place. Sync again when origin can be reached.",
    );
    expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
    // With origin answering, the ask stands in for the certainty, and it moves.
    NodeFS.renameSync(`${f.remote}.away`, f.remote);
    expect(await move(ctx, f.b)).toMatchObject({ action: "fast-forward", moved: 1, detail: null });
  });

  it("keeps a fetch for an hour, the newest 32, and to its own project", () => {
    expect([PROJECT_SYNC_FETCH_KEPT_MS, PROJECT_SYNC_FETCHES_KEPT]).toEqual([3_600_000, 32]);
    const first = newFetchRecord("project-kept");
    keepFetch(first);
    expect(keptFetch("project-kept", first.id)).toBe(first);
    expect(keptFetch("project-other", first.id)).toBeUndefined();
    expect(keptFetch("project-kept", undefined)).toBeUndefined();
    expect(keptFetch("project-kept", "no-such-fetch")).toBeUndefined();
    // Past its hour it is gone, and stays gone.
    expect(keptFetch("project-kept", first.id, first.atMs + 3_600_001)).toBeUndefined();
    expect(keptFetch("project-kept", first.id)).toBeUndefined();
    const many = Array.from({ length: 33 }, () => newFetchRecord("project-kept"));
    for (const record of many) keepFetch(record);
    expect(keptFetch("project-kept", many[0]!.id)).toBeUndefined();
    expect(keptFetch("project-kept", many[1]!.id)).toBe(many[1]);
    expect(keptFetch("project-kept", many[32]!.id)).toBe(many[32]);
    expect(latestHeads("project-kept", "/nowhere")).toBeUndefined();
  });
});

describe("project sync: a deletion it learned of holds for every fetch (P2-30)", () => {
  it("does not move offline to the tip of a branch it saw deleted", async () => {
    const f = twoMachines();
    git(f.a, "checkout", "-q", "-b", "feature");
    commit(f.a, "feature.ts", "export const feature = 1;\n");
    git(f.a, "push", "-q", "-u", "origin", "feature");
    git(f.b, "fetch", "-q", "origin");
    git(f.b, "checkout", "-q", "feature");
    const was = git(f.b, "rev-parse", "HEAD");
    commit(f.a, "feature.ts", "export const feature = 2;\n");
    git(f.a, "push", "-q", "origin", "feature");
    // Two windows fetched; both fetches are kept.
    const first = context(newFetchRecord("project-gone"));
    const second = context(newFetchRecord("project-gone"));
    for (const ctx of [first, second]) {
      const here = await fetchAll(ctx, at(f.b));
      expect(here[0]).toMatchObject({ upstream: "origin/feature", behind: 1 });
      keepFetch(ctx.fetched!);
    }
    // Deleted on origin after the fetches; the first window's move asks, and learns it.
    git(f.a, "push", "-q", "origin", "--delete", "feature");
    const gone = {
      action: "none",
      reason: "no-upstream",
      moved: 0,
      detail: "The branch origin/feature is no longer on origin.",
    };
    expect(await move(first, f.b)).toMatchObject(gone);
    // Tried again with no connection, by either window: the deleted tip is not moved to.
    outage(f);
    const w = watching();
    expect(await move({ ...first, git: w.run }, f.b)).toMatchObject(gone);
    expect(await move({ ...second, git: w.run }, f.b)).toMatchObject(gone);
    expect(w.ran("merge")).toEqual([]);
    expect(git(f.b, "rev-parse", "HEAD")).toBe(was);
  });
});

describe("project sync: how long it may wait on origin (P2-36, P2-44)", () => {
  it("fetches in one network step, and asks once for its one branch before a move", async () => {
    const f = behind();
    git(f.b, "branch", "-q", "--track", "second", "origin/main");
    const w = watching();
    const ctx = context(undefined, w.run, { fetched: newFetchRecord("project-test") });
    await fetchAll(ctx, at(f.b));
    expect(asks(w)).toEqual([]);
    expect(w.ran("fetch")).toHaveLength(1);
    expect(w.ran("fetch")[0]!.timeoutMs).toBe(300_000);
    expect([...ctx.fetched!.repositories.get(f.b)!.heads.keys()]).toEqual(["refs/heads/main"]);
    expect(git(f.b, "for-each-ref", "refs/specwithcode/")).toBe("");
    await move(ctx, f.b);
    expect(asks(w).map((ask) => ask.args)).toEqual([
      ["ls-remote", "--heads", "origin", "refs/heads/main"],
    ]);
    expect(asks(w)[0]!.timeoutMs).toBe(ORIGIN_ASK_MS);
    expect([ORIGIN_ASK_MS, ORIGIN_ASK_TOTAL_MS]).toEqual([10_000, 60_000]);
  });

  it("stops asking when a run's time for asks is used up", async () => {
    const budget = askBudget();
    expect(budget.next()).toBe(10_000);
    budget.spend(59_999);
    expect(budget.next()).toBe(10_000);
    budget.spend(1);
    expect(budget.next()).toBe(0);
    let asked = 0;
    const never: SyncGit = async () => {
      asked += 1;
      return { code: 0, stdout: "", stderr: "" };
    };
    expect(await askOrigin(never, "/nowhere", "refs/heads/main", { budget })).toEqual({
      kind: "not-tried",
    });
    expect(asked).toBe(0);
    // Git answering with an error is not a list, and a list without the branch is an answer.
    const failing: SyncGit = async () => ({ code: 128, stdout: "", stderr: "fatal: no" });
    expect(await askOrigin(failing, "/nowhere", "refs/heads/main")).toEqual({
      kind: "unreachable",
    });
    expect(await askOrigin(never, "/nowhere", "refs/heads/main")).toEqual({
      kind: "answered",
      tip: undefined,
    });
  });

  /** Checkouts of one origin as a project's repositories, each one commit behind, fetched. */
  const manyBehind = async (count: number) => {
    const f = twoMachines();
    const folders = Array.from({ length: count }, (_, index) => {
      const cwd = NodePath.join(f.base, "project", `r${index}`);
      NodeFS.mkdirSync(NodePath.dirname(cwd), { recursive: true });
      git(f.base, "clone", "-q", f.remote, cwd);
      return { path: `r${index}`, cwd: NodeFS.realpathSync(cwd) };
    });
    const was = git(f.a, "rev-parse", "HEAD");
    const head = commit(f.a, "app.ts", "export const a = 2;\n");
    git(f.a, "push", "-q", "origin", "main");
    const origin = newFetchRecord("project-test");
    await fetchAll(context(origin), folders);
    const moveAll = (run: SyncGit) =>
      runSync(
        context(origin, run, { asks: askBudget() }),
        NodePath.join(f.base, "project"),
        folders,
        {
          fastForward: folders.map((folder) => ({ path: folder.path, otherBranch: null })),
          clone: [],
        },
      );
    return { ...f, folders, was, head, moveAll };
  };

  it("with origin silent, moves by the fetch while its time lasts and does not try the rest", async () => {
    const f = await manyBehind(8);
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    let asked = 0;
    const silent: SyncGit = async (cwd, args, options) => {
      if (args[0] !== "ls-remote" || args[1] !== "--heads") return real(cwd, args, options);
      asked += 1;
      expect(options?.timeoutMs).toBe(10_000);
      clock += options?.timeoutMs ?? 0;
      throw new Error("git ls-remote timed out");
    };
    const results = await f.moveAll(silent);
    // Six asks of ten seconds use up the minute. Those six were tried, found out of reach,
    // and moved by what the fetch brought; the last two were never asked, and stay.
    expect(asked).toBe(6);
    expect(clock - 1_000_000).toBe(60_000);
    expect(results.map((result) => `${say(result)} ${result.moved} ${result.detail}`)).toEqual([
      ...Array.from(
        { length: 6 },
        () => `fast-forward:behind 1 ${PROJECT_SYNC_MOVED_UNASKED_DETAIL}`,
      ),
      ...Array.from({ length: 2 }, () => `none:refused 0 ${PROJECT_SYNC_NOT_TRIED_DETAIL}`),
    ]);
    expect(PROJECT_SYNC_NOT_TRIED_DETAIL).toBe(
      "Not tried: the time for asking origin ran out before this checkout's turn. Sync again.",
    );
    expect(f.folders.map((folder) => git(folder.cwd, "rev-parse", "HEAD"))).toEqual([
      ...Array.from({ length: 6 }, () => f.head),
      ...Array.from({ length: 2 }, () => f.was),
    ]);
  });

  it("asks for the next repository after one ask failed, and so learns what changed there", async () => {
    const f = await manyBehind(3);
    // The branch is rewritten on origin after the fetch.
    git(f.a, "commit", "-q", "--amend", "-m", "rewritten");
    git(f.a, "push", "-q", "--force", "origin", "main");
    let asked = 0;
    const firstFails: SyncGit = async (cwd, args, options) => {
      if (args[0] !== "ls-remote" || args[1] !== "--heads") return real(cwd, args, options);
      asked += 1;
      if (asked === 1) throw new Error("git ls-remote timed out");
      return real(cwd, args, options);
    };
    const results = await f.moveAll(firstFails);
    // The first was out of reach and went by its fetch. The failure closed nothing: the
    // second and the third were each asked all the same, on the same host and
    // repository, and each found the branch moved.
    expect(asked).toBe(3);
    expect(results.map((result) => `${say(result)} ${result.detail}`)).toEqual([
      `fast-forward:behind ${PROJECT_SYNC_MOVED_UNASKED_DETAIL}`,
      `none:refused ${PROJECT_SYNC_ORIGIN_MOVED_DETAIL}`,
      `none:refused ${PROJECT_SYNC_ORIGIN_MOVED_DETAIL}`,
    ]);
    expect(f.folders.map((folder) => git(folder.cwd, "rev-parse", "HEAD"))).toEqual([
      f.head,
      f.was,
      f.was,
    ]);
  });
});

describe("project sync: the checkout is read again right before the merge (P2-33)", () => {
  /** B behind after its fetch; `during` runs while the move asks origin. */
  const whileAsking = async (during: (f: ReturnType<typeof behind>) => void) => {
    const f = behind();
    const ctx = context();
    await fetchAll(ctx, at(f.b));
    let acted = false;
    const w = watching((_cwd, args) => {
      if (args[0] === "ls-remote" && args[1] === "--heads" && !acted) {
        acted = true;
        during(f);
      }
    });
    const step = await move({ ...ctx, git: w.run }, f.b);
    expect(acted).toBe(true);
    return { f, step, merges: w.ran("merge") };
  };

  it("declines when the checkout switched to another branch meanwhile", async () => {
    const { f, step, merges } = await whileAsking((f) => git(f.b, "checkout", "-q", "-b", "other"));
    expect(step).toMatchObject({
      action: "none",
      reason: "refused",
      moved: 0,
      downgraded: true,
      detail: PROJECT_SYNC_CHANGED_BRANCH_DETAIL,
    });
    expect(merges).toEqual([]);
    expect(git(f.b, "rev-parse", "other")).toBe(f.was);
    expect(git(f.b, "rev-parse", "main")).toBe(f.was);
  });

  it("declines when a file changed meanwhile", async () => {
    const { f, step, merges } = await whileAsking((f) => write(f.b, ".gitignore", "mine\n"));
    expect(step).toMatchObject({
      action: "fetch",
      reason: "uncommitted",
      uncommitted: 1,
      moved: 0,
      downgraded: true,
      detail: PROJECT_SYNC_CHANGED_FILES_DETAIL,
    });
    expect(merges).toEqual([]);
    expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
    expect(NodeFS.readFileSync(NodePath.join(f.b, ".gitignore"), "utf8")).toBe("mine\n");
  });

  it("declines when the checkout's commit changed meanwhile", async () => {
    const { f, step, merges } = await whileAsking((f) =>
      commit(f.b, "mine.ts", "export const mine = 1;\n"),
    );
    expect(step).toMatchObject({
      action: "none",
      reason: "refused",
      moved: 0,
      detail: PROJECT_SYNC_CHANGED_HEAD_DETAIL,
    });
    expect(merges).toEqual([]);
    expect(git(f.b, "rev-parse", "HEAD")).not.toBe(f.head);
  });

  it("declines when the branch's upstream changed meanwhile", async () => {
    const { f, step, merges } = await whileAsking((f) => {
      git(f.b, "branch", "-q", "base", f.was);
      git(f.b, "branch", "-q", "--set-upstream-to=base", "main");
    });
    expect(step).toMatchObject({
      action: "none",
      reason: "refused",
      moved: 0,
      detail: PROJECT_SYNC_CHANGED_UPSTREAM_DETAIL,
    });
    expect(merges).toEqual([]);
    expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
  });

  it("says each of these in its own sentence, and never stashes for the merge", async () => {
    expect([
      PROJECT_SYNC_CHANGED_BRANCH_DETAIL,
      PROJECT_SYNC_CHANGED_HEAD_DETAIL,
      PROJECT_SYNC_CHANGED_UPSTREAM_DETAIL,
      PROJECT_SYNC_CHANGED_FILES_DETAIL,
    ]).toEqual([
      "The checkout switched to another branch while Sync asked origin, so it was not moved.",
      "The checkout's commit changed while Sync asked origin, so it was not moved.",
      "The branch's upstream changed while Sync asked origin, so it was not moved.",
      "Files changed in the checkout while Sync asked origin, so it was not moved.",
    ]);
    const { step, merges } = await whileAsking(() => undefined);
    expect(step).toMatchObject({ action: "fast-forward", moved: 1 });
    expect(merges[0]!.args.slice(0, -1)).toEqual(MERGE_ARGS);
    expect(MERGE_ARGS).toEqual([
      "merge",
      "--ff-only",
      "--no-squash",
      "--commit",
      "--no-edit",
      "--no-autostash",
      "--no-verify",
      "--no-verify-signatures",
      "--no-signoff",
      "--no-log",
      "--no-stat",
      "--no-progress",
      "--no-overwrite-ignore",
    ]);
  });
});

describe("project sync: a merge that went through is never reported as refused (P2-29)", () => {
  /** B behind after its fetch; Git stops answering the reads `failing` picks, after the merge. */
  const readsFailAfterMerge = async (failing: (reads: number) => boolean) => {
    const f = behind();
    const ctx = context();
    await fetchAll(ctx, at(f.b));
    let merged = false;
    let reads = 0;
    const run: SyncGit = async (cwd, args, options) => {
      if (merged && (args[0] === "symbolic-ref" || args[0] === "rev-parse")) {
        reads += 1;
        if (failing(reads)) throw new Error("git did not answer");
      }
      const result = await real(cwd, args, options);
      if (args[0] === "merge") merged = true;
      return result;
    };
    return { f, step: await move({ ...ctx, git: run }, f.b) };
  };

  it("reports the move when the first read after it failed and the next one saw it", async () => {
    const { f, step } = await readsFailAfterMerge((reads) => reads <= 2);
    expect(step).toMatchObject({
      action: "fast-forward",
      reason: "behind",
      moved: 1,
      downgraded: false,
    });
    expect(git(f.b, "rev-parse", "HEAD")).toBe(f.head);
  });

  it("says the outcome could not be read when no read after the merge answers", async () => {
    const { f, step } = await readsFailAfterMerge(() => true);
    expect(step).toMatchObject({
      action: "fast-forward",
      reason: "behind",
      moved: 0,
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
      args[0] === "merge"
        ? Promise.reject(new Error("git merge timed out"))
        : real(cwd, args, options);
    const step = await move({ ...ctx, git: run }, f.b);
    expect(step).toMatchObject({
      action: "fetch",
      reason: "refused",
      branch: "main",
      moved: 0,
      downgraded: true,
      detail: "Git did not finish: git merge timed out",
    });
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
    // Asked to move it anyway, it is held for the same reason, not "refused".
    expect(await move(context(newFetchRecord("project-test"), run), f.b)).toMatchObject({
      action: "fetch",
      reason: "uncommitted",
      moved: 0,
    });
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

  it("reports a fetch that never ran as failed, with Git's words, and keeps the others", async () => {
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
      fetch: "failed",
      fetchError: "Git did not finish: git config timed out",
      stateUnread: true,
    });
    expect(say(planProjectSync(here, [])[0]!)).toBe("none:fetch-failed");
    expect(ctx.fetched!.repositories.has(f.a)).toBe(false);
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
