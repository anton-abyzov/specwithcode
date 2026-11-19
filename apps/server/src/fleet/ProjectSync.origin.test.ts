// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * What Sync may move a checkout to (1390): the commit `origin` listed for the
 * branch to this Sync's fetch, by object id. Never a branch by its name, never
 * a tracking ref read later, and never a record of another checkout, another
 * address or another project.
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
  PROJECT_SYNC_MOVED_UNASKED_DETAIL,
  PROJECT_SYNC_NOT_AS_FETCHED_DETAIL,
  PROJECT_SYNC_NOT_LISTED_DETAIL,
  PROJECT_SYNC_ORIGIN_MOVED_DETAIL,
  PROJECT_SYNC_REFUSED_UNASKED_DETAIL,
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
  listOrigin,
  ORIGIN_ASK_MS,
  originHost,
  type OriginRecords,
  originRecordsOf,
} from "./projectSyncOrigin.ts";

beforeAll(isolateGit);
afterAll(restoreGit);
afterEach(() => {
  vi.restoreAllMocks();
  cleanUp();
});

const real: SyncGit = (cwd, args, options) => runGit(cwd, args, options);
const context = (
  origin: OriginRecords = new Map(),
  run: SyncGit = real,
  more: Partial<SyncContext> = {},
): SyncContext => ({ git: run, inUse: async () => null, origin, ...more });
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

describe("project sync: the move goes to what origin listed to this fetch (P2-28)", () => {
  it("moves by the fetch's record when origin stops answering, its address unchanged", async () => {
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
    // The mismatch dropped the record: offline, the old tip is not moved to either.
    outage(f);
    expect(await move(ctx, f.b)).toMatchObject({
      action: "none",
      reason: "refused",
      detail: PROJECT_SYNC_REFUSED_UNASKED_DETAIL,
    });
    expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
  });

  it("does not move to a commit somebody else's fetch brought after this Sync's", async () => {
    const f = behind();
    const ctx = context();
    await fetchAll(ctx, at(f.b));
    // The person fetches a newer commit themselves: the tracking ref is past the record.
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
    const again = await fetchAll(ctx, at(f.b));
    expect(say(planProjectSync(again, [])[0]!)).toBe("fast-forward:behind");
    expect(await move(ctx, f.b)).toMatchObject({ action: "fast-forward", moved: 2, detail: null });
  });

  it("plans nothing on a tracking ref that is not where origin listed the branch", async () => {
    const f = behind();
    const ctx = context();
    // Somebody's fetch runs between origin's list and Sync's own fetch ending: here, the
    // tracking ref is put somewhere else right after Sync's fetch.
    const w = watching();
    const run: SyncGit = async (cwd, args, options) => {
      const result = await w.run(cwd, args, options);
      if (args[0] === "fetch") git(f.b, "update-ref", "refs/remotes/origin/main", f.was);
      return result;
    };
    const here = await fetchAll({ ...ctx, git: run }, at(f.b));
    expect(here[0]).toMatchObject({ fetch: "ok", upstream: "origin/main", upstreamMoved: true });
    const step = planProjectSync(here, [])[0]!;
    expect(say(step)).toBe("none:refused");
    expect(step.detail).toBe(PROJECT_SYNC_NOT_AS_FETCHED_DETAIL);
  });

  it("never hands a record to a clone made again at the same path", async () => {
    const f = behind();
    const ctx = context();
    await fetchAll(ctx, at(f.b));
    // The folder is removed and cloned again: same path, same origin, same branch, same commit.
    NodeFS.rmSync(f.b, { recursive: true, force: true });
    git(f.base, "clone", "-q", f.remote, f.b);
    git(f.b, "reset", "-q", "--hard", f.was);
    expect(git(f.b, "rev-parse", "refs/remotes/origin/main")).toBe(f.head);
    outage(f);
    expect(await move(ctx, f.b)).toMatchObject({
      action: "none",
      reason: "refused",
      moved: 0,
      detail: PROJECT_SYNC_REFUSED_UNASKED_DETAIL,
    });
    expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
  });

  it("never hands a record on across a changed origin address", async () => {
    const f = behind();
    const ctx = context();
    await fetchAll(ctx, at(f.b));
    // Another origin with the very same branch and commit, and no connection to it.
    git(f.b, "remote", "set-url", "origin", NodePath.join(f.base, "elsewhere.git"));
    expect(await move(ctx, f.b)).toMatchObject({
      action: "none",
      reason: "refused",
      moved: 0,
      detail: PROJECT_SYNC_REFUSED_UNASKED_DETAIL,
    });
    expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
  });

  it("keeps each project's records to itself, also on one checkout", async () => {
    const f = behind();
    const first = originRecordsOf("project-one");
    const second = originRecordsOf("project-two");
    expect(second).not.toBe(first);
    expect(originRecordsOf("project-one")).toBe(first);
    await fetchAll(context(first), at(f.b));
    expect(first.size).toBe(1);
    expect(second.size).toBe(0);
    outage(f);
    // The other project has not fetched: it goes by nothing the first one learned.
    expect(await move(context(second), f.b)).toMatchObject({
      action: "none",
      reason: "refused",
      detail: PROJECT_SYNC_REFUSED_UNASKED_DETAIL,
    });
    expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
    expect(await move(context(first), f.b)).toMatchObject({ action: "fast-forward", moved: 1 });
    first.clear();
  });
});

describe("project sync: a deletion it learned of takes the record with it (P2-30)", () => {
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
    const ctx = context();
    const here = await fetchAll(ctx, at(f.b));
    expect(here[0]).toMatchObject({ upstream: "origin/feature", behind: 1 });
    // Deleted on origin after the fetch; the move asks, and learns it.
    git(f.a, "push", "-q", "origin", "--delete", "feature");
    expect(await move(ctx, f.b)).toMatchObject({
      action: "none",
      reason: "no-upstream",
      moved: 0,
      detail: "The branch origin/feature is no longer on origin.",
    });
    // Tried again with no connection: the deleted branch's tip is not moved to.
    outage(f);
    const w = watching();
    expect(await move({ ...ctx, git: w.run }, f.b)).toMatchObject({
      action: "none",
      reason: "refused",
      moved: 0,
      detail: PROJECT_SYNC_REFUSED_UNASKED_DETAIL,
    });
    expect(w.ran("merge")).toEqual([]);
    expect(git(f.b, "rev-parse", "HEAD")).toBe(was);
  });
});

describe("project sync: how long it may wait on origin (P2-36)", () => {
  it("asks origin once per repository per fetch, for all branches, under ten seconds", async () => {
    const f = behind();
    git(f.b, "branch", "-q", "--track", "second", "origin/main");
    const w = watching();
    await fetchAll(context(new Map(), w.run), at(f.b));
    const asks = w.ran("ls-remote");
    expect(asks.map((ask) => ask.args)).toEqual([["ls-remote", "--heads", "origin"]]);
    expect(asks[0]!.timeoutMs).toBeLessThanOrEqual(ORIGIN_ASK_MS);
    expect(ORIGIN_ASK_MS).toBe(10_000);
    // The move asks once more, for its one branch, under the same limit.
    await move(context(new Map(), w.run), f.b);
    const again = w.ran("ls-remote").slice(1);
    expect(again.map((ask) => ask.args)).toEqual([
      ["ls-remote", "--heads", "origin", "refs/heads/main"],
    ]);
    expect(again[0]!.timeoutMs).toBeLessThanOrEqual(ORIGIN_ASK_MS);
  });

  it("does not ask a host again in a call once one ask of it did not come back", async () => {
    const budget = askBudget();
    const asked: Array<string> = [];
    const hangs: SyncGit = async (cwd) => {
      asked.push(cwd);
      if (cwd.startsWith("/down/")) throw new Error("git ls-remote timed out");
      // An error Git answers with is an answer: the host is there.
      return { code: 128, stdout: "", stderr: "fatal: repository not found" };
    };
    const ask = (cwd: string, host: string) => listOrigin(hangs, cwd, { budget, host });
    expect(await ask("/up/1", "up.example")).toEqual({
      ok: false,
      reason: "fatal: repository not found",
    });
    expect(await ask("/down/1", "down.example")).toEqual({ ok: false, reason: null });
    expect(await ask("/down/2", "down.example")).toEqual({ ok: false, reason: null });
    expect(await ask("/up/2", "up.example")).toMatchObject({ ok: false });
    expect(asked).toEqual(["/up/1", "/down/1", "/up/2"]);
    expect(budget.next("down.example")).toBe(0);
    expect(budget.next("up.example")).toBe(10_000);
    // The host is the address's host, or the whole address of a folder.
    expect([
      originHost("git@GitHub.com:owner/one.git"),
      originHost("https://github.com/owner/two.git"),
      originHost("ssh://git@host.example:2222/owner/three.git"),
      originHost("/srv/git/one.git"),
      originHost("/srv/git/two.git"),
    ]).toEqual([
      "github.com",
      "github.com",
      originHost("ssh://git@host.example:2222/owner/four.git"),
      "/srv/git/one.git",
      "/srv/git/two.git",
    ]);
  });

  it("fetches the repositories whose origin answers when another host is silent", async () => {
    const f = behind();
    // Five checkouts on a host that never answers come first, then the one that is fine.
    const down = Array.from({ length: 5 }, (_, index) => {
      const cwd = NodePath.join(f.base, `down-${index}`);
      git(f.base, "clone", "-q", f.remote, cwd);
      git(cwd, "remote", "set-url", "origin", `https://down.invalid/owner/r${index}.git`);
      return { path: `down-${index}`, cwd };
    });
    const w = watching();
    const run: SyncGit = (cwd, args, options) =>
      args[0] === "ls-remote" && cwd.includes("down-")
        ? (w.commands.push({ cwd, args: [...args], timeoutMs: options?.timeoutMs }),
          Promise.reject(new Error("git ls-remote timed out")))
        : w.run(cwd, args, options);
    const here = await fetchAll(context(new Map(), run, { asks: askBudget() }), [
      ...down,
      { path: "b", cwd: f.b },
    ]);
    // At most one round of four on the silent host (those under way when the first one
    // failed); the rest of it is not asked, and none of it is fetched.
    const silent = w.ran("ls-remote").filter((ask) => ask.cwd.includes("down-")).length;
    expect(silent).toBeGreaterThanOrEqual(1);
    expect(silent).toBeLessThanOrEqual(4);
    expect(w.ran("fetch").map((fetch) => fetch.cwd)).toEqual([f.b]);
    expect(here.slice(0, 5).map((facts) => `${facts.fetch} ${facts.fetchError}`)).toEqual(
      Array.from({ length: 5 }, () => `failed ${PROJECT_SYNC_NOT_LISTED_DETAIL}`),
    );
    expect(here[5]).toMatchObject({ path: "b", fetch: "ok", behind: 1, fetchError: null });
  });

  it("thirty repositories whose origin never answers hold a fetch for 10 s of asks, and fetch nothing", async () => {
    // A clock the asks move. The asks under way wait together: when their limit is up the
    // clock is ten seconds on, and each of them has failed.
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const ran: Array<{ readonly verb: string; readonly timeoutMs: number | undefined }> = [];
    const waiting: Array<() => void> = [];
    // Four asks run at a time: when the fourth waits, their limit is up for all of them.
    const timeOut = () => {
      if (waiting.length < 4) return;
      clock += 10_000;
      for (const fail of waiting.splice(0)) fail();
    };
    const silent: SyncGit = (_cwd, args, options) => {
      ran.push({ verb: args[0]!, timeoutMs: options?.timeoutMs });
      if (args[0] === "ls-remote")
        return new Promise((_resolve, reject) => {
          waiting.push(() => reject(new Error("git ls-remote timed out")));
          timeOut();
        });
      return Promise.resolve(
        args.join(" ") === "config --get-all remote.origin.url"
          ? { code: 0, stdout: "https://example.invalid/r.git\n", stderr: "" }
          : { code: 1, stdout: "", stderr: "" },
      );
    };
    const repositories = Array.from({ length: 30 }, (_, index) => ({
      path: `r${index}`,
      cwd: `/nowhere/r${index}`,
    }));
    const here = await fetchAll(context(new Map(), silent, { asks: askBudget() }), repositories);
    const asks = ran.filter((command) => command.verb === "ls-remote");
    // One round of four, ten seconds: the host is silent, and no further ask of it follows.
    expect(asks).toHaveLength(4);
    expect(asks.every((ask) => ask.timeoutMs === 10_000)).toBe(true);
    expect(clock - 1_000_000).toBe(10_000);
    expect(ran.some((command) => command.verb === "fetch")).toBe(false);
    expect(here.map((facts) => facts.fetch)).toEqual(Array.from({ length: 30 }, () => "failed"));
    expect(here[0]!.fetchError).toBe(PROJECT_SYNC_NOT_LISTED_DETAIL);
    expect(here[29]!.fetchError).toBe(PROJECT_SYNC_NOT_LISTED_DETAIL);
    expect(PROJECT_SYNC_NOT_LISTED_DETAIL).toBe(
      "origin did not list its branches in time, so nothing was fetched. Sync again.",
    );
  });

  /** Five checkouts of one origin as a project's repositories, each one commit behind, fetched. */
  const fiveBehind = async () => {
    const f = twoMachines();
    const folders = ["one", "two", "three", "four", "five"].map((name) => {
      const cwd = NodePath.join(f.base, "project", name);
      NodeFS.mkdirSync(NodePath.dirname(cwd), { recursive: true });
      git(f.base, "clone", "-q", f.remote, cwd);
      return { path: name, cwd: NodeFS.realpathSync(cwd) };
    });
    const was = git(f.a, "rev-parse", "HEAD");
    const head = commit(f.a, "app.ts", "export const a = 2;\n");
    git(f.a, "push", "-q", "origin", "main");
    const origin: OriginRecords = new Map();
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

  it("five moves with their one origin silent ask once, then go by their records", async () => {
    const f = await fiveBehind();
    let asks = 0;
    const silent: SyncGit = async (cwd, args, options) => {
      if (args[0] !== "ls-remote") return real(cwd, args, options);
      asks += 1;
      expect(options?.timeoutMs).toBe(10_000);
      throw new Error("git ls-remote timed out");
    };
    const results = await f.moveAll(silent);
    expect(asks).toBe(1);
    expect(results.map((result) => `${result.path} ${say(result)} ${result.moved}`)).toEqual(
      f.folders.map((folder) => `${folder.path} fast-forward:behind 1`),
    );
    expect(results.every((result) => result.detail === PROJECT_SYNC_MOVED_UNASKED_DETAIL)).toBe(
      true,
    );
    for (const folder of f.folders) expect(git(folder.cwd, "rev-parse", "HEAD")).toBe(f.head);
  });

  it("asks for every move while origin answers, however slowly, and so sees a force-push", async () => {
    const f = await fiveBehind();
    git(f.a, "commit", "-q", "--amend", "-m", "rewritten");
    git(f.a, "push", "-q", "--force", "origin", "main");
    // Every answer takes just under the limit of one ask.
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    let asks = 0;
    const slow: SyncGit = async (cwd, args, options) => {
      const result = await real(cwd, args, options);
      if (args[0] === "ls-remote") {
        asks += 1;
        clock += 9_900;
      }
      return result;
    };
    const results = await f.moveAll(slow);
    expect(asks).toBe(5);
    expect(results.map((result) => `${result.path} ${say(result)} ${result.detail}`)).toEqual(
      f.folders.map((folder) => `${folder.path} none:refused ${PROJECT_SYNC_ORIGIN_MOVED_DETAIL}`),
    );
    for (const folder of f.folders) expect(git(folder.cwd, "rev-parse", "HEAD")).toBe(f.was);
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
      if (args[0] === "ls-remote" && !acted) {
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
    expect(merges[0]!.args.slice(0, 6)).toEqual([
      "merge",
      "--ff-only",
      "--no-edit",
      "--no-autostash",
      "--no-overwrite-ignore",
      "--quiet",
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
    const here = await fetchAll(context(new Map(), run), folders);
    expect(here.map((facts) => facts.path)).toEqual(["a", "b"]);
    expect(here[0]).toMatchObject({ fetch: "ok", behind: 0 });
    expect(here[0]!.stateUnread ?? false).toBe(false);
    expect(here[1]).toMatchObject({ fetch: "ok", behind: 1, uncommitted: 0, stateUnread: true });
    expect(say(planProjectSync(here, [])[1]!)).toBe("fetch:uncommitted");
    // Asked to move it anyway, it is held for the same reason, not "refused".
    expect(await move(context(new Map(), run), f.b)).toMatchObject({
      action: "fetch",
      reason: "uncommitted",
      moved: 0,
    });
  });

  it("keeps the other repositories' facts when Git fails on one outside its status", async () => {
    const f = behind();
    const folders = [
      { path: "a", cwd: f.a },
      { path: "b", cwd: f.b },
    ];
    const run: SyncGit = (cwd, args, options) =>
      cwd === f.a && args[0] === "symbolic-ref"
        ? Promise.reject(new Error("git symbolic-ref timed out"))
        : real(cwd, args, options);
    const here = await fetchAll(context(new Map(), run), folders);
    expect(here[0]).toMatchObject({
      path: "a",
      fetch: "failed",
      fetchError: "Git did not finish: git symbolic-ref timed out",
      stateUnread: true,
    });
    expect(say(planProjectSync(here, [])[0]!)).toBe("none:fetch-failed");
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
