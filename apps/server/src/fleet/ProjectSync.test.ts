// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";

import { planProjectSync, type ProjectSyncStep } from "@specweave-studio/contracts";

import { runGit } from "./folderTransfer/git.ts";
import {
  cloneRepository,
  fastForwardRepository,
  fetchAll,
  readRepositoryFacts,
  isLinkedWorktree,
  runSync,
  statusOf,
  sweepCloneLeftovers,
  type SyncContext,
  type SyncGit,
  syncRepositories,
  type SyncRepository,
  threadUsesCheckout,
} from "./ProjectSync.ts";

import { stagingFolder } from "../handoff/extrasTestKit.ts";

const temporary: Array<string> = [];
const saved: Record<string, string | undefined> = {};
const ISOLATED = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

beforeAll(() => {
  // The module under test runs Git with this process's environment.
  for (const [key, value] of Object.entries(ISOLATED)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
afterAll(() => {
  for (const key of Object.keys(ISOLATED)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});
afterEach(() => {
  process.env.GIT_CONFIG_GLOBAL = ISOLATED.GIT_CONFIG_GLOBAL;
  for (const folder of temporary.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});

const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Sync Test", "-c", "user.email=sync@example.invalid", "-C", cwd, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, ...ISOLATED, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();

const write = (folder: string, name: string, text: string) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(folder, name)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(folder, name), text);
};
const commit = (folder: string, name: string, text: string) => {
  write(folder, name, text);
  git(folder, "add", "--", name);
  git(folder, "commit", "-q", "-m", `change ${name}`);
  return git(folder, "rev-parse", "HEAD");
};

/** Every Git command the module ran in this file, as its arguments. */
const everyCommand: Array<ReadonlyArray<string>> = [];

function recording() {
  const commands: Array<ReadonlyArray<string>> = [];
  const run: SyncGit = (cwd, args, options) => {
    commands.push(args);
    everyCommand.push(args);
    return runGit(cwd, args, options);
  };
  return { run, commands };
}

const context = (run: SyncGit, inUse: SyncContext["inUse"] = async () => null): SyncContext => ({
  git: run,
  inUse,
});

/** A bare remote, a clone that publishes to it, and the project on two machines. */
function fixture() {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-project-sync-")),
  );
  temporary.push(base);
  const remote = NodePath.join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  const publisher = NodePath.join(base, "publisher");
  git(base, "clone", "-q", remote, publisher);
  git(publisher, "checkout", "-q", "-b", "main");
  // Nested repositories of a project are ignored by its root, as in an umbrella checkout.
  commit(publisher, ".gitignore", "ignored.log\nrepositories/\n");
  commit(publisher, "app.ts", "export const a = 1;\n");
  git(publisher, "push", "-q", "-u", "origin", "main");
  const a = NodePath.join(base, "a");
  const b = NodePath.join(base, "b");
  git(base, "clone", "-q", remote, a);
  git(base, "clone", "-q", remote, b);
  let published = 1;
  const publish = (name = "app.ts", text = `export const a = ${(published += 1)};\n`) => {
    const head = commit(publisher, name, text);
    git(publisher, "push", "-q", "origin", "HEAD");
    return head;
  };
  return { base, remote, publisher, a, b, publish };
}

/**
 * Gives the fixture's bare repositories an address another machine could use:
 * `https://sync.test/{name}.git` reads from `{base}/{name}.git` through the
 * module's own Git, for this test only.
 */
function addressable(base: string) {
  const config = NodePath.join(base, "gitconfig");
  NodeFS.writeFileSync(config, `[url "${base}/"]\n\tinsteadOf = https://sync.test/\n`);
  process.env.GIT_CONFIG_GLOBAL = config;
  return (name: string) => `https://sync.test/${name}.git`;
}

const root = (cwd: string): SyncRepository => ({ path: ".", cwd });

/** Everything Sync must leave alone in a repository it does not fast-forward. */
const snapshot = (cwd: string) => ({
  workingTree: git(cwd, "status", "--porcelain=v1", "--untracked-files=all", "--ignored"),
  index: git(cwd, "ls-files", "-s"),
  head: git(cwd, "rev-parse", "HEAD"),
  branch: git(cwd, "rev-parse", "--abbrev-ref", "HEAD"),
  branches: git(cwd, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
  stashes: git(cwd, "stash", "list"),
});
const remoteSnapshot = (remote: string) =>
  git(remote, "for-each-ref", "--format=%(refname) %(objectname)");

/** Fetches on both machines, plans machine A, then asks A to do what the plan says. */
async function sync(
  machine: string,
  other: string,
  options: { readonly inUse?: SyncContext["inUse"]; readonly force?: boolean } = {},
) {
  const { run, commands } = recording();
  const ctx = context(run, options.inUse);
  const here = await fetchAll(ctx, [root(machine)]);
  const there = await fetchAll(context(recording().run), [root(other)]);
  const plan = planProjectSync(here, there);
  const step = plan[0]!;
  const results = await runSync(ctx, machine, [root(machine)], {
    // `force` asks for a fast-forward the plan did not propose: the server must still refuse.
    fastForward:
      step.action === "fast-forward" || options.force === true
        ? [{ path: ".", otherBranch: there[0]?.branch ?? null }]
        : [],
    clone: [],
  });
  return { step, facts: here[0]!, result: results[0], commands };
}

const say = (step: Pick<ProjectSyncStep, "action" | "reason">) => `${step.action}:${step.reason}`;

describe("project sync on real repositories (1390 AC-11)", () => {
  it("row 1: clean and behind its upstream is fast-forwarded", async () => {
    const f = fixture();
    f.publish();
    const tip = f.publish();
    const other = snapshot(f.b);
    const remote = remoteSnapshot(f.remote);
    const { step, result } = await sync(f.a, f.b);
    expect(say(step)).toBe("fast-forward:behind");
    expect(result).toMatchObject({ action: "fast-forward", moved: 2, downgraded: false });
    expect(git(f.a, "rev-parse", "HEAD")).toBe(tip);
    expect(git(f.a, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(f.a, "status", "--porcelain")).toBe("");
    expect(git(f.a, "stash", "list")).toBe("");
    expect(git(f.a, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main");
    // The machine that was not asked to run is untouched, and nothing was pushed.
    expect(snapshot(f.b)).toEqual(other);
    expect(remoteSnapshot(f.remote)).toBe(remote);
  });

  it("row 2: up to date does nothing", async () => {
    const f = fixture();
    const before = snapshot(f.a);
    const remote = remoteSnapshot(f.remote);
    const { step, result } = await sync(f.a, f.b, { force: true });
    expect(say(step)).toBe("none:up-to-date");
    expect(result).toMatchObject({ action: "none", reason: "up-to-date", moved: 0 });
    expect(snapshot(f.a)).toEqual(before);
    expect(remoteSnapshot(f.remote)).toBe(remote);
  });

  it("row 3: commits not pushed stay where they are and are counted", async () => {
    const f = fixture();
    commit(f.a, "local.ts", "export const local = 1;\n");
    commit(f.a, "local.ts", "export const local = 2;\n");
    const before = snapshot(f.a);
    const remote = remoteSnapshot(f.remote);
    const { step, result } = await sync(f.a, f.b, { force: true });
    expect(say(step)).toBe("none:not-pushed");
    expect(step.ahead).toBe(2);
    expect(result).toMatchObject({ action: "none", reason: "not-pushed", moved: 0 });
    expect(snapshot(f.a)).toEqual(before);
    expect(remoteSnapshot(f.remote)).toBe(remote);
  });

  it("row 4: commits of its own and behind is fetched, not moved", async () => {
    const f = fixture();
    commit(f.a, "local.ts", "export const local = 1;\n");
    f.publish();
    f.publish();
    const before = snapshot(f.a);
    const remote = remoteSnapshot(f.remote);
    const { step, result } = await sync(f.a, f.b, { force: true });
    expect(say(step)).toBe("fetch:diverged");
    expect([step.ahead, step.behind]).toEqual([1, 2]);
    expect(result).toMatchObject({ action: "fetch", reason: "diverged", downgraded: true });
    expect(snapshot(f.a)).toEqual(before);
    expect(remoteSnapshot(f.remote)).toBe(remote);
  });

  it("row 5: uncommitted changes keep it from moving forward", async () => {
    const f = fixture();
    f.publish();
    write(f.a, "app.ts", "export const a = 'edited';\n");
    write(f.a, "new.ts", "export const fresh = true;\n");
    git(f.a, "add", "--", "new.ts");
    write(f.a, "untracked.txt", "notes\n");
    git(f.a, "stash", "push", "-q", "--", "app.ts");
    write(f.a, "app.ts", "export const a = 'edited again';\n");
    const before = snapshot(f.a);
    const remote = remoteSnapshot(f.remote);
    const { step, result } = await sync(f.a, f.b, { force: true });
    expect(say(step)).toBe("fetch:uncommitted");
    expect(step.uncommitted).toBe(3);
    expect(result).toMatchObject({ action: "fetch", reason: "uncommitted", downgraded: true });
    expect(before.stashes).not.toBe("");
    expect(snapshot(f.a)).toEqual(before);
    expect(remoteSnapshot(f.remote)).toBe(remote);
  });

  it("row 6: a running thread in this very checkout keeps it from moving", async () => {
    const f = fixture();
    f.publish();
    const before = snapshot(f.a);
    const remote = remoteSnapshot(f.remote);
    const inUse: SyncContext["inUse"] = async (checkout) =>
      checkout === f.a ? "Fix the login page" : null;
    const { step, result } = await sync(f.a, f.b, { inUse, force: true });
    expect(say(step)).toBe("fetch:in-use");
    expect(step.inUseBy).toBe("Fix the login page");
    expect(result).toMatchObject({ action: "fetch", reason: "in-use", downgraded: true });
    expect(snapshot(f.a)).toEqual(before);
    expect(remoteSnapshot(f.remote)).toBe(remote);
  });

  it("row 7: on another branch than the other machine, the fetch brings that branch and nothing is checked out", async () => {
    const f = fixture();
    git(f.a, "checkout", "-q", "-b", "feature");
    git(f.a, "push", "-q", "-u", "origin", "feature");
    const tip = f.publish();
    const before = snapshot(f.a);
    const remote = remoteSnapshot(f.remote);
    const { step, result } = await sync(f.a, f.b, { force: true });
    expect(say(step)).toBe("fetch:other-branch");
    expect([step.branch, step.otherBranch]).toEqual(["feature", "main"]);
    expect(result).toMatchObject({ action: "fetch", reason: "other-branch", downgraded: true });
    // The other machine's branch came with the fetch.
    expect(git(f.a, "rev-parse", "refs/remotes/origin/main")).toBe(tip);
    expect(snapshot(f.a)).toEqual(before);
    expect(remoteSnapshot(f.remote)).toBe(remote);
  });

  it("row 8: not on a branch is fetched, not moved", async () => {
    const f = fixture();
    git(f.a, "checkout", "-q", "--detach");
    f.publish();
    const before = snapshot(f.a);
    const remote = remoteSnapshot(f.remote);
    const { step, result } = await sync(f.a, f.b, { force: true });
    expect(say(step)).toBe("fetch:detached");
    expect(result).toMatchObject({ action: "fetch", reason: "detached", downgraded: true });
    expect(snapshot(f.a)).toEqual(before);
    expect(remoteSnapshot(f.remote)).toBe(remote);
  });

  it("row 9: a branch with no upstream does nothing", async () => {
    const f = fixture();
    git(f.a, "checkout", "-q", "-b", "scratch");
    git(f.b, "checkout", "-q", "-b", "scratch");
    commit(f.a, "scratch.ts", "export const scratch = 1;\n");
    f.publish();
    const before = snapshot(f.a);
    const remote = remoteSnapshot(f.remote);
    const { step, result } = await sync(f.a, f.b, { force: true });
    expect(say(step)).toBe("none:no-upstream");
    expect(result).toMatchObject({ action: "none", reason: "no-upstream", moved: 0 });
    expect(snapshot(f.a)).toEqual(before);
    expect(remoteSnapshot(f.remote)).toBe(remote);
  });

  it("row 10: a failed fetch is reported with Git's reason and the other repositories continue", async () => {
    const f = fixture();
    // A second repository of the project, nested in machine A's folder, whose remote is gone.
    const goneRemote = NodePath.join(f.base, "gone.git");
    git(f.base, "init", "-q", "--bare", "-b", "main", goneRemote);
    const nested = NodePath.join(f.a, "repositories", "gone");
    git(f.base, "clone", "-q", goneRemote, nested);
    git(nested, "checkout", "-q", "-b", "main");
    commit(nested, "x.ts", "export const x = 1;\n");
    git(nested, "push", "-q", "-u", "origin", "main");
    NodeFS.rmSync(goneRemote, { recursive: true, force: true });
    const tip = f.publish();
    const before = snapshot(nested);
    const remote = remoteSnapshot(f.remote);
    const { run } = recording();
    const ctx = context(run);
    const repositories = await syncRepositories(run, f.a, [".", "repositories/gone"]);
    const facts = await fetchAll(ctx, repositories);
    const plan = planProjectSync(facts, facts);
    expect(plan.map((step) => `${step.path} ${say(step)}`)).toEqual([
      ". fast-forward:behind",
      "repositories/gone none:fetch-failed",
    ]);
    expect(plan[1]!.detail).toMatch(/gone\.git/);
    const results = await runSync(ctx, f.a, repositories, {
      fastForward: [
        { path: ".", otherBranch: "main" },
        { path: "repositories/gone", otherBranch: "main" },
      ],
      clone: [],
    });
    expect(results.map((entry) => `${entry.path} ${entry.action}`)).toEqual([
      ". fast-forward",
      "repositories/gone none",
    ]);
    expect(git(f.a, "rev-parse", "HEAD")).toBe(tip);
    expect(snapshot(nested)).toEqual(before);
    expect(remoteSnapshot(f.remote)).toBe(remote);
  });

  it("row 11: a repository missing here that has a remote is cloned", async () => {
    const f = fixture();
    const libRemote = NodePath.join(f.base, "lib.git");
    git(f.base, "init", "-q", "--bare", "-b", "main", libRemote);
    const nestedOnB = NodePath.join(f.b, "repositories", "lib");
    git(f.base, "clone", "-q", libRemote, nestedOnB);
    git(nestedOnB, "checkout", "-q", "-b", "main");
    const tip = commit(nestedOnB, "lib.ts", "export const lib = 1;\n");
    git(nestedOnB, "push", "-q", "-u", "origin", "main");
    const address = addressable(f.base)("lib");
    git(nestedOnB, "remote", "set-url", "origin", address);
    const { run } = recording();
    const ctx = context(run);
    const here = await fetchAll(ctx, await syncRepositories(run, f.a, ["."]));
    const there = await fetchAll(ctx, await syncRepositories(run, f.b, [".", "repositories/lib"]));
    const plan = planProjectSync(here, there);
    expect(plan.map((step) => `${step.path} ${say(step)}`)).toEqual([
      ". none:up-to-date",
      "repositories/lib clone:missing",
    ]);
    const before = snapshot(f.a);
    const remote = remoteSnapshot(libRemote);
    const results = await runSync(ctx, f.a, [root(f.a)], {
      fastForward: [],
      clone: [{ path: "repositories/lib", remote: plan[1]!.remote! }],
    });
    expect(results[0]).toMatchObject({ action: "clone", reason: "missing", branch: "main" });
    const cloned = NodePath.join(f.a, "repositories", "lib");
    expect(git(cloned, "rev-parse", "HEAD")).toBe(tip);
    expect(git(cloned, "config", "--get", "remote.origin.url")).toBe(address);
    expect(git(cloned, "config", "--get-all", "remote.origin.fetch")).toBe(
      "+refs/heads/*:refs/remotes/origin/*",
    );
    // The project's own repository only gained an untracked folder.
    expect({ ...snapshot(f.a), workingTree: "" }).toEqual({ ...before, workingTree: "" });
    expect(remoteSnapshot(libRemote)).toBe(remote);
  });

  it("row 12: a repository missing here that has no remote is left to the full compare", async () => {
    const f = fixture();
    const localOnly = NodePath.join(f.b, "notes");
    git(f.base, "init", "-q", "-b", "main", localOnly);
    commit(localOnly, "notes.md", "# notes\n");
    const { run } = recording();
    const ctx = context(run);
    const before = snapshot(f.a);
    const remote = remoteSnapshot(f.remote);
    const here = await fetchAll(ctx, await syncRepositories(run, f.a, ["."]));
    const there = await fetchAll(ctx, await syncRepositories(run, f.b, [".", "notes"]));
    expect(there[1]).toMatchObject({ fetch: "no-remote", remote: null });
    const plan = planProjectSync(here, there);
    expect(`${plan[1]!.path} ${say(plan[1]!)}`).toBe("notes none:missing-no-remote");
    // The plan asks for nothing there, and a clone asked for anyway has no address to use.
    const results = await runSync(ctx, f.a, [root(f.a)], {
      fastForward: [],
      clone: [{ path: "notes", remote: "" }],
    });
    expect(results[0]).toMatchObject({ action: "none", reason: "refused" });
    expect(NodeFS.existsSync(NodePath.join(f.a, "notes"))).toBe(false);
    expect(snapshot(f.a)).toEqual(before);
    expect(remoteSnapshot(f.remote)).toBe(remote);
  });
});

describe("project sync: the plan is a proposal (1390 AC-10)", () => {
  async function planned(f: ReturnType<typeof fixture>, inUse?: SyncContext["inUse"]) {
    f.publish();
    const { run } = recording();
    const ctx = context(run, inUse);
    const facts = await fetchAll(ctx, [root(f.a)]);
    expect(say(planProjectSync(facts, facts)[0]!)).toBe("fast-forward:behind");
    return ctx;
  }
  const ask = { fastForward: [{ path: ".", otherBranch: "main" }], clone: [] };

  it("downgrades to fetch when the repository became dirty after the plan", async () => {
    const f = fixture();
    const ctx = await planned(f);
    write(f.a, "app.ts", "export const a = 'edited after the plan';\n");
    const before = snapshot(f.a);
    const [result] = await runSync(ctx, f.a, [root(f.a)], ask);
    expect(result).toMatchObject({
      action: "fetch",
      reason: "uncommitted",
      uncommitted: 1,
      downgraded: true,
      moved: 0,
    });
    expect(snapshot(f.a)).toEqual(before);
  });

  it("downgrades to fetch when a thread started working there after the plan", async () => {
    const f = fixture();
    let running = false;
    const ctx = await planned(f, async () => (running ? "Refactor billing" : null));
    running = true;
    const before = snapshot(f.a);
    const [result] = await runSync(ctx, f.a, [root(f.a)], ask);
    expect(result).toMatchObject({
      action: "fetch",
      reason: "in-use",
      inUseBy: "Refactor billing",
      downgraded: true,
    });
    expect(snapshot(f.a)).toEqual(before);
  });

  it("does not move a checkout that switched branch after the plan", async () => {
    const f = fixture();
    const ctx = await planned(f);
    git(f.a, "checkout", "-q", "-b", "elsewhere");
    const before = snapshot(f.a);
    const [result] = await runSync(ctx, f.a, [root(f.a)], ask);
    expect(result).toMatchObject({ action: "fetch", reason: "other-branch", downgraded: true });
    expect(snapshot(f.a)).toEqual(before);
  });

  it("never writes over an ignored file a fast-forward would replace", async () => {
    const f = fixture();
    write(f.a, "ignored.log", "local log\n");
    write(f.publisher, "ignored.log", "tracked upstream now\n");
    git(f.publisher, "add", "-f", "--", "ignored.log");
    git(f.publisher, "commit", "-q", "-m", "track the log");
    git(f.publisher, "push", "-q", "origin", "HEAD");
    const { run } = recording();
    const ctx = context(run);
    await fetchAll(ctx, [root(f.a)]);
    const before = snapshot(f.a);
    const [result] = await runSync(ctx, f.a, [root(f.a)], ask);
    expect(result).toMatchObject({ action: "fetch", reason: "refused", downgraded: true });
    expect(NodeFS.readFileSync(NodePath.join(f.a, "ignored.log"), "utf8")).toBe("local log\n");
    expect(snapshot(f.a)).toEqual(before);
  });
});

describe("project sync: worktrees (1390 AC-10, AC-11)", () => {
  it("does not list a linked worktree inside the project folder and never moves it", async () => {
    const f = fixture();
    const worktree = NodePath.join(f.a, "worktrees", "thread-1");
    git(f.a, "worktree", "add", "-q", "-b", "thread-1", worktree, "origin/main");
    git(worktree, "branch", "-q", "--set-upstream-to=origin/main");
    f.publish();
    const { run } = recording();
    expect(await isLinkedWorktree(run, worktree)).toBe(true);
    expect(await isLinkedWorktree(run, f.a)).toBe(false);
    const repositories = await syncRepositories(run, f.a, [".", "worktrees/thread-1"]);
    expect(repositories.map((repository) => repository.path)).toEqual(["."]);
    expect((await statusOf(run, repositories)).map((entry) => entry.path)).toEqual(["."]);
    const ctx = context(run);
    await fetchAll(ctx, repositories);
    const before = snapshot(worktree);
    // Asked for by name, both as an unlisted folder and as if it had been listed.
    const unlisted = await runSync(ctx, f.a, repositories, {
      fastForward: [{ path: "worktrees/thread-1", otherBranch: null }],
      clone: [],
    });
    expect(unlisted[0]).toMatchObject({ action: "none", reason: "refused", downgraded: true });
    const listed = await runSync(
      ctx,
      f.a,
      [...repositories, { path: "worktrees/thread-1", cwd: worktree }],
      { fastForward: [{ path: "worktrees/thread-1", otherBranch: null }], clone: [] },
    );
    expect(listed[0]).toMatchObject({ action: "none", reason: "refused", downgraded: true });
    expect(snapshot(worktree)).toEqual(before);
  });

  it("a thread running in its own worktree does not block the project's main checkout", async () => {
    const f = fixture();
    const worktree = NodePath.join(f.base, "threads", "thread-2");
    git(f.a, "worktree", "add", "-q", "-b", "thread-2", worktree, "origin/main");
    const tip = f.publish();
    const inUse: SyncContext["inUse"] = async (checkout) =>
      threadUsesCheckout({ threadFolder: worktree, threadCheckout: worktree, checkout })
        ? "Thread in a worktree"
        : null;
    const { step, result } = await sync(f.a, f.b, { inUse });
    expect(say(step)).toBe("fast-forward:behind");
    expect(result).toMatchObject({ action: "fast-forward", moved: 1 });
    expect(git(f.a, "rev-parse", "HEAD")).toBe(tip);
    expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("thread-2");
  });

  it("says which folders a thread works in", () => {
    const sep = NodePath.sep;
    const project = `${sep}p`;
    const nested = `${project}${sep}repositories${sep}app`;
    const uses = (threadFolder: string, threadCheckout: string | null, checkout: string) =>
      threadUsesCheckout({ threadFolder, threadCheckout, checkout });
    // In the very checkout, and in the project folder above a nested repository.
    expect(uses(project, project, project)).toBe(true);
    expect(uses(project, project, nested)).toBe(true);
    // In a subfolder that belongs to the checkout.
    expect(uses(`${project}${sep}docs`, project, project)).toBe(true);
    // In a nested repository or a worktree inside the folder: another checkout.
    expect(uses(nested, nested, project)).toBe(false);
    expect(uses(`${sep}threads${sep}t1`, `${sep}threads${sep}t1`, project)).toBe(false);
    expect(uses(`${project}-other`, `${project}-other`, project)).toBe(false);
  });
});

describe("project sync: clone (1390 AC-11)", () => {
  const ask = async (f: ReturnType<typeof fixture>, path: string, remote: string) =>
    cloneRepository(context(recording().run), f.a, { path, remote });

  it("clones into a remote named origin whatever this machine's Git settings name it", async () => {
    const f = fixture();
    const address = addressable(f.base)("remote");
    NodeFS.appendFileSync(
      process.env.GIT_CONFIG_GLOBAL!,
      '[clone]\n\tdefaultRemoteName = upstream\n[remote "origin"]\n\ttagOpt = --no-tags\n',
    );
    const result = await ask(f, "repositories/app", address);
    expect(result).toMatchObject({ action: "clone", reason: "missing", branch: "main" });
    const cloned = NodePath.join(f.a, "repositories", "app");
    expect(git(cloned, "remote")).toBe("origin");
    expect(git(cloned, "config", "--get-all", "remote.origin.fetch")).toBe(
      "+refs/heads/*:refs/remotes/origin/*",
    );
    expect(git(cloned, "config", "--local", "--list")).not.toContain("mirror");
  });

  it("does not clone from a folder or a file address of another machine (P2-07)", async () => {
    const f = fixture();
    for (const remote of [f.remote, `file://${f.remote}`]) {
      const result = await ask(f, "repositories/app", remote);
      expect(result, remote).toMatchObject({ action: "none", reason: "refused" });
    }
    expect(NodeFS.existsSync(NodePath.join(f.a, "repositories"))).toBe(false);
  });

  it("stops a cancelled clone and removes the folder it made (P2-09)", async () => {
    const f = fixture();
    // A server that accepts and never answers: the clone waits until it is stopped.
    const sockets: Array<NodeNet.Socket> = [];
    const server = NodeNet.createServer((socket) => sockets.push(socket));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as NodeNet.AddressInfo).port;
    const cancel = new AbortController();
    server.once("connection", () => cancel.abort());
    // An address another machine could use, read here from the server above.
    const config = NodePath.join(f.base, "slow.gitconfig");
    NodeFS.writeFileSync(
      config,
      `[url "git://127.0.0.1:${port}/"]\n\tinsteadOf = git://sync.test/\n`,
    );
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
      const { run, commands } = recording();
      const result = await cloneRepository({ ...context(run), signal: cancel.signal }, f.a, {
        path: "repositories/deep/slow",
        remote: "git://sync.test/acme/slow.git",
      });
      expect(result).toMatchObject({ action: "none", reason: "refused" });
      expect(commands.some((args) => args[0] === "clone")).toBe(true);
      // The folder and the folders made on the way to it are gone.
      expect(NodeFS.existsSync(NodePath.join(f.a, "repositories"))).toBe(false);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => server.close(done));
    }
  });

  it("refuses a folder that exists, a path outside the project and a remote with a credential", async () => {
    const f = fixture();
    const address = addressable(f.base)("remote");
    NodeFS.mkdirSync(NodePath.join(f.a, "taken"));
    write(f.a, "taken/keep.txt", "mine\n");
    for (const [path, remote] of [
      ["taken", address],
      [".", address],
      ["../outside", address],
      ["nested/.git/x", address],
      // Names a file system may read as `.git`.
      ["nested/.GIT", address],
      ["nested/.git.", address],
      ["nested/.g\u200cit", address],
      ["nested/GIT~1", address],
      ["fine", "https://user:secret@example.com/acme/app.git"],
      ["fine", "ext::sh -c touch%20/tmp/x"],
      ["fine", "--upload-pack=touch /tmp/x"],
    ] as const) {
      const result = await ask(f, path, remote);
      expect(result, `${path} ${remote}`).toMatchObject({ action: "none", reason: "refused" });
    }
    expect(NodeFS.readFileSync(NodePath.join(f.a, "taken", "keep.txt"), "utf8")).toBe("mine\n");
    expect(NodeFS.existsSync(NodePath.join(f.a, "fine"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(f.base, "outside"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(f.a, "nested"))).toBe(false);
  });

  it("refuses to clone through a link that leaves the project folder", async () => {
    const f = fixture();
    const outside = NodePath.join(f.base, "outside");
    NodeFS.mkdirSync(outside);
    NodeFS.symlinkSync(outside, NodePath.join(f.a, "linked"));
    const address = addressable(f.base)("remote");
    const result = await ask(f, "linked/repo", address);
    expect(result).toMatchObject({ action: "none", reason: "refused" });
    expect(NodeFS.readdirSync(outside)).toEqual([]);
    // Nor does it create a folder behind the link on the way to the refusal.
    const deeper = await ask(f, "linked/sub/repo", address);
    expect(deeper).toMatchObject({ action: "none", reason: "refused" });
    expect(NodeFS.readdirSync(outside)).toEqual([]);
    // A file on the way is no folder to clone into either.
    write(f.a, "plain.txt", "text\n");
    expect(await ask(f, "plain.txt/repo", address)).toMatchObject({ reason: "refused" });
  });

  it("leaves no folder behind when the clone fails", async () => {
    const f = fixture();
    const result = await ask(f, "repositories/none", addressable(f.base)("no-such"));
    expect(result).toMatchObject({ action: "none", reason: "refused" });
    expect(result.detail).toMatch(/no-such\.git/);
    expect(NodeFS.existsSync(NodePath.join(f.a, "repositories", "none"))).toBe(false);
  });
});

describe("project sync: status", () => {
  it("reports path, branch, head commit and clean or not, from local Git alone", async () => {
    const f = fixture();
    f.publish();
    const { run, commands } = recording();
    const head = git(f.a, "rev-parse", "HEAD");
    expect(await statusOf(run, [root(f.a)])).toEqual([
      { path: ".", branch: "main", head, clean: true },
    ]);
    write(f.a, "untracked.txt", "x\n");
    expect((await statusOf(run, [root(f.a)]))[0]).toEqual({
      path: ".",
      branch: "main",
      head,
      clean: false,
    });
    expect(commands.some((args) => args[0] === "fetch")).toBe(false);
    expect(git(f.a, "rev-parse", "refs/remotes/origin/main")).toBe(head);
  });
});

describe("project sync: the fetch never follows the repository's own settings (P2-01)", () => {
  /** Machine A with a commit only it holds on `feature`, checked out on a branch only it has. */
  function withLocalWork() {
    const f = fixture();
    git(f.publisher, "checkout", "-q", "-b", "feature");
    commit(f.publisher, "feature.ts", "export const feature = 1;\n");
    git(f.publisher, "push", "-q", "-u", "origin", "feature");
    git(f.publisher, "checkout", "-q", "main");
    git(f.a, "fetch", "-q", "origin");
    git(f.a, "checkout", "-q", "feature");
    const local = commit(f.a, "feature.ts", "export const feature = 'not pushed';\n");
    git(f.a, "checkout", "-q", "-b", "scratch", "main");
    git(f.a, "tag", "local-only");
    f.publish();
    return { ...f, local };
  }
  const refs = (cwd: string) =>
    git(cwd, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags");

  it("does not fetch a repository whose fetch settings write into its own branches", async () => {
    const f = withLocalWork();
    git(f.a, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*");
    const before = { refs: refs(f.a), state: snapshot(f.a) };
    const { run, commands } = recording();
    const here = await fetchAll(context(run), [root(f.a)]);
    expect(here[0]).toMatchObject({ fetch: "unusual-config" });
    expect(here[0]!.fetchError).toContain("+refs/heads/*:refs/heads/*");
    expect(commands.some((args) => args[0] === "fetch")).toBe(false);
    expect(git(f.a, "rev-parse", "refs/heads/feature")).toBe(f.local);
    expect({ refs: refs(f.a), state: snapshot(f.a) }).toEqual(before);
    const plan = planProjectSync(here, here);
    expect(say(plan[0]!)).toBe("none:fetch-config");
    // Asked to move anyway, it still does not fetch or merge.
    const results = await runSync(context(run), f.a, [root(f.a)], {
      fastForward: [{ path: ".", otherBranch: "scratch" }],
      clone: [],
    });
    expect(results[0]).toMatchObject({ reason: "fetch-config", moved: 0 });
    expect(commands.some((args) => args[0] === "fetch" || args[0] === "merge")).toBe(false);
    expect({ refs: refs(f.a), state: snapshot(f.a) }).toEqual(before);
  });

  it("does not fetch a mirror, or one whose extra fetch line writes outside refs/remotes", async () => {
    for (const set of [
      ["remote.origin.mirror", "true"],
      ["--add", "remote.origin.fetch", "+refs/pull/*/head:refs/heads/pr/*"],
      ["--add", "remote.origin.fetch", "refs/tags/*:refs/tags/*"],
    ]) {
      const f = withLocalWork();
      git(f.a, "config", ...set);
      const before = refs(f.a);
      const { run, commands } = recording();
      const here = await fetchAll(context(run), [root(f.a)]);
      expect(here[0]!.fetch, set.join(" ")).toBe("unusual-config");
      expect(commands.some((args) => args[0] === "fetch")).toBe(false);
      expect(refs(f.a)).toBe(before);
    }
  });

  it("deletes and moves no branch or tag under prune and tag settings, nor a rewritten address", async () => {
    const f = withLocalWork();
    // The remote loses a branch, moves a tag this machine also has, and gains a tag.
    git(f.publisher, "push", "-q", "origin", "--delete", "feature");
    git(f.a, "tag", "shared", "main");
    git(f.publisher, "tag", "shared");
    git(f.publisher, "tag", "v1");
    git(f.publisher, "push", "-q", "origin", "shared", "v1");
    for (const [key, value] of [
      ["fetch.prune", "true"],
      ["fetch.pruneTags", "true"],
      ["remote.origin.prune", "true"],
      ["remote.origin.pruneTags", "true"],
    ] as const)
      git(f.a, "config", key, value);
    const tracking = git(f.a, "rev-parse", "refs/remotes/origin/feature");
    const before = refs(f.a);
    const { run } = recording();
    const here = await fetchAll(context(run), [root(f.a)]);
    expect(here[0]).toMatchObject({ fetch: "ok" });
    // What was fetched arrived; nothing local was deleted or moved.
    expect(git(f.a, "rev-parse", "refs/remotes/origin/main")).toBe(
      git(f.publisher, "rev-parse", "main"),
    );
    expect(git(f.a, "rev-parse", "refs/remotes/origin/feature")).toBe(tracking);
    expect(git(f.a, "rev-parse", "refs/tags/shared")).toBe(git(f.a, "rev-parse", "main"));
    expect(
      refs(f.a)
        .split("\n")
        .filter((line) => !line.startsWith("refs/tags/v1 ")),
    ).toEqual(before.split("\n"));
    // Asked to bring every tag, Git still replaces none: the fetch may say so, nothing moves.
    git(f.a, "config", "remote.origin.tagOpt", "--tags");
    await fetchAll(context(run), [root(f.a)]);
    expect(git(f.a, "rev-parse", "refs/tags/shared")).toBe(git(f.a, "rev-parse", "main"));
    expect(git(f.a, "rev-parse", "refs/tags/local-only")).toBe(git(f.a, "rev-parse", "main"));
    expect(
      refs(f.a)
        .split("\n")
        .filter((line) => line.startsWith("refs/heads/")),
    ).toEqual(before.split("\n").filter((line) => line.startsWith("refs/heads/")));
    git(f.a, "config", "--unset", "remote.origin.tagOpt");
    // The address is rewritten to another repository: only refs/remotes can change.
    const other = NodePath.join(f.base, "other.git");
    git(f.base, "init", "-q", "--bare", "-b", "main", other);
    const elsewhere = NodePath.join(f.base, "elsewhere");
    git(f.base, "clone", "-q", other, elsewhere);
    git(elsewhere, "checkout", "-q", "-b", "scratch");
    commit(elsewhere, "other.ts", "export const other = 1;\n");
    git(elsewhere, "push", "-q", "origin", "scratch");
    const config = NodePath.join(f.base, "rewrite.gitconfig");
    NodeFS.writeFileSync(config, `[url "${other}"]\n\tinsteadOf = ${f.remote}\n`);
    process.env.GIT_CONFIG_GLOBAL = config;
    const state = { refs: refs(f.a), state: snapshot(f.a) };
    await fetchAll(context(run), [root(f.a)]);
    expect(git(f.a, "rev-parse", "refs/remotes/origin/scratch")).toBe(
      git(elsewhere, "rev-parse", "scratch"),
    );
    expect({ refs: refs(f.a), state: snapshot(f.a) }).toEqual(state);
  });
});

describe("project sync: what counts as clean and as a clone address", () => {
  it("treats an unfinished cherry-pick with no changed file as not clean (P2-06)", async () => {
    const f = fixture();
    // A cherry-pick of a change already there stops with nothing to commit.
    const head = git(f.a, "rev-parse", "HEAD");
    expect(() => git(f.a, "cherry-pick", head)).toThrow();
    expect(git(f.a, "status", "--porcelain=v1")).toBe("");
    expect(NodeFS.existsSync(NodePath.join(f.a, ".git", "CHERRY_PICK_HEAD"))).toBe(true);
    f.publish();
    const before = snapshot(f.a);
    const { step, result, commands } = await sync(f.a, f.b, { force: true });
    expect(say(step)).toBe("fetch:uncommitted");
    expect(step.uncommitted).toBeGreaterThan(0);
    expect(result).toMatchObject({ action: "fetch", reason: "uncommitted", moved: 0 });
    expect(commands.some((args) => args[0] === "merge")).toBe(false);
    expect(snapshot(f.a)).toEqual(before);
    expect((await statusOf(recording().run, [root(f.a)]))[0]).toMatchObject({ clean: false });
  });

  it("treats a cherry-pick of several commits that is part way through as not clean", async () => {
    const f = fixture();
    // Two commits to pick; the first conflicts, is resolved and committed, the second is pending.
    git(f.b, "checkout", "-q", "-b", "picks");
    const one = commit(f.b, "app.ts", "export const a = 'picked';\n");
    const two = commit(f.b, "second.ts", "export const second = 1;\n");
    git(f.b, "push", "-q", "origin", "picks");
    git(f.a, "fetch", "-q", "origin");
    commit(f.a, "app.ts", "export const a = 'mine';\n");
    git(f.a, "push", "-q", "origin", "main");
    expect(() => git(f.a, "cherry-pick", one, two)).toThrow();
    write(f.a, "app.ts", "export const a = 'resolved';\n");
    git(f.a, "add", "--", "app.ts");
    git(f.a, "commit", "-q", "--no-edit");
    git(f.a, "push", "-q", "origin", "main");
    expect(git(f.a, "status", "--porcelain=v1")).toBe("");
    expect(NodeFS.existsSync(NodePath.join(f.a, ".git", "CHERRY_PICK_HEAD"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(f.a, ".git", "sequencer"))).toBe(true);
    // The checkout is level with the remote and clean; the next push leaves it behind.
    git(f.publisher, "pull", "-q", "--ff-only", "origin", "main");
    f.publish("other.ts", "export const other = 1;\n");
    const before = snapshot(f.a);
    const { step, result, commands } = await sync(f.a, f.b, { force: true });
    expect(step.uncommitted).toBeGreaterThan(0);
    expect(result).toMatchObject({ moved: 0 });
    expect(commands.some((args) => args[0] === "merge")).toBe(false);
    expect(snapshot(f.a)).toEqual(before);
  });

  it("names no clone address for a folder or file origin (P2-07)", async () => {
    const f = fixture();
    const { run } = recording();
    const here = await fetchAll(context(run), [root(f.a)]);
    // The fixture's origin is a folder on this machine.
    expect(here[0]).toMatchObject({ fetch: "ok", remote: null });
    git(f.b, "remote", "set-url", "origin", `file://${f.remote}`);
    const nested = NodePath.join(f.b, "repositories", "lib");
    git(f.base, "clone", "-q", f.remote, nested);
    const there = await fetchAll(context(run), [
      root(f.b),
      { path: "repositories/lib", cwd: nested },
    ]);
    expect(there.map((facts) => facts.remote)).toEqual([null, null]);
    expect(say(planProjectSync(here, there)[1]!)).toBe("none:missing-no-remote");
    // An address another machine can use is named.
    git(nested, "remote", "set-url", "origin", addressable(f.base)("remote"));
    const again = await fetchAll(context(run), [{ path: "repositories/lib", cwd: nested }]);
    expect(again[0]).toMatchObject({ fetch: "ok", remote: "https://sync.test/remote.git" });
    expect(say(planProjectSync(here, again)[1]!)).toBe("clone:missing");
    // An address of this machine itself is none another machine can use.
    for (const local of [
      "https://localhost/acme/app.git",
      "https://127.0.0.1:3000/acme/app.git",
      "git://[::1]/acme/app.git",
      "ssh://git@LOCALHOST/acme/app.git",
      "git@localhost:acme/app.git",
      "127.0.0.1:acme/app.git",
    ]) {
      git(nested, "remote", "set-url", "origin", local);
      const facts = await readRepositoryFacts(
        context(run),
        { path: "repositories/lib", cwd: nested },
        { fetch: false },
      );
      expect(facts.remote, local).toBeNull();
      expect(
        await cloneRepository(context(run), f.a, { path: "repositories/local", remote: local }),
        local,
      ).toMatchObject({ action: "none", reason: "refused" });
    }
    expect(NodeFS.existsSync(NodePath.join(f.a, "repositories"))).toBe(false);
  });
});

describe("project sync: in use is read live (P2-02)", () => {
  it("does not move a checkout a thread started working in after the recheck's reads", async () => {
    const f = fixture();
    f.publish();
    const { run, commands } = recording();
    await fetchAll(context(run), [root(f.a)]);
    const before = snapshot(f.a);
    // Free when the facts are read, taken when asked again right before the merge.
    let asked = 0;
    const inUse = async () => ((asked += 1) === 1 ? null : "Started just now");
    const result = await fastForwardRepository(context(run, inUse), root(f.a), "main");
    expect(asked).toBe(2);
    expect(result).toMatchObject({
      action: "fetch",
      reason: "in-use",
      inUseBy: "Started just now",
      moved: 0,
      downgraded: true,
    });
    expect(commands.some((args) => args[0] === "merge")).toBe(false);
    expect(snapshot(f.a)).toEqual(before);
  });
});

describe("project sync: review round 2 follow-ups", () => {
  it("does not move a checkout forward to a local branch it follows (P2-10)", async () => {
    const f = fixture();
    // A stacked branch: main follows the local branch `base`, which is one commit on.
    git(f.a, "checkout", "-q", "-b", "base");
    commit(f.a, "base.ts", "export const base = 1;\n");
    git(f.a, "checkout", "-q", "main");
    git(f.a, "branch", "-q", "--set-upstream-to=base");
    expect(git(f.a, "config", "branch.main.remote")).toBe(".");
    const before = snapshot(f.a);
    const { step, facts, result, commands } = await sync(f.a, f.b, { force: true });
    expect(facts).toMatchObject({ upstream: null, otherUpstream: "base", behind: 0 });
    expect(say(step)).toBe("none:no-upstream");
    expect(step.detail).toContain("base");
    expect(result).toMatchObject({ action: "none", reason: "no-upstream", moved: 0 });
    expect(commands.some((args) => args[0] === "merge")).toBe(false);
    expect(snapshot(f.a)).toEqual(before);
  });

  it("does not move a checkout forward to a branch of another remote (P2-10)", async () => {
    const f = fixture();
    f.publish();
    git(f.a, "remote", "add", "second", f.remote);
    git(f.a, "fetch", "-q", "second");
    git(f.a, "branch", "-q", "--set-upstream-to=second/main");
    const before = snapshot(f.a);
    const { step, facts, result, commands } = await sync(f.a, f.b, { force: true });
    expect(facts).toMatchObject({ upstream: null, otherUpstream: "second/main" });
    expect(say(step)).toBe("none:no-upstream");
    expect(step.detail).toContain("second/main");
    expect(result).toMatchObject({ moved: 0 });
    expect(commands.some((args) => args[0] === "merge")).toBe(false);
    expect(snapshot(f.a)).toEqual(before);
  });

  it("moves forward to origin's commit by its hash, whatever the upstream's short name reads as (P2-10)", async () => {
    const f = fixture();
    const head = f.publish();
    // A local branch named like the upstream's short name must not be what is merged.
    git(f.a, "branch", "-q", "origin/main", "HEAD");
    const { step, facts, result, commands } = await sync(f.a, f.b);
    expect(facts).toMatchObject({ upstream: "origin/main", behind: 1 });
    expect(facts.otherUpstream ?? null).toBeNull();
    expect(say(step)).toBe("fast-forward:behind");
    expect(result).toMatchObject({ action: "fast-forward", moved: 1 });
    expect(commands.find((args) => args[0] === "merge")!.at(-1)).toBe(head);
    expect(git(f.a, "rev-parse", "HEAD")).toBe(head);
  });

  it("names no clone address for other spellings of this machine (P2-11)", async () => {
    const f = fixture();
    const { run } = recording();
    for (const local of [
      "git://127.1/acme/app.git",
      "git://2130706433/acme/app.git",
      "git://0x7f000001/acme/app.git",
      "git://0177.0.0.1/acme/app.git",
      "https://localhost./acme/app.git",
      "git://localhost./acme/app.git",
      "ssh://git@[::ffff:127.0.0.1]/acme/app.git",
      "git://[0:0:0:0:0:0:0:1]/acme/app.git",
      "git@127.1:acme/app.git",
      "git@localhost.:acme/app.git",
      "git://0/acme/app.git",
    ]) {
      git(f.a, "remote", "set-url", "origin", local);
      const facts = await readRepositoryFacts(context(run), root(f.a), { fetch: false });
      expect(facts.remote, local).toBeNull();
      expect(
        await cloneRepository(context(run), f.b, { path: "repositories/local", remote: local }),
        local,
      ).toMatchObject({ action: "none", reason: "refused" });
    }
    // Another machine's address still crosses, also one that only looks numeric in part.
    for (const far of ["git://10.0.0.7/acme/app.git", "git@build.local:acme/app.git"]) {
      git(f.a, "remote", "set-url", "origin", far);
      const facts = await readRepositoryFacts(context(run), root(f.a), { fetch: false });
      expect(facts.remote, far).toBe(far);
    }
  });

  it("keeps files that appear in the folder while a clone that fails is under way (P2-15)", async () => {
    const f = fixture();
    const target = NodePath.join(f.b, "repositories", "lib");
    const { run, commands } = recording();
    // The person makes the folder and puts a file in it while the clone runs; the clone fails.
    const failing: SyncGit = async (cwd, args, options) => {
      if (args[0] !== "clone") return run(cwd, args, options);
      commands.push(args);
      NodeFS.mkdirSync(target, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(target, "mine.txt"), "mine\n");
      return { code: 128, stdout: "", stderr: "fatal: the remote hung up" };
    };
    const result = await cloneRepository(context(failing), f.b, {
      path: "repositories/lib",
      remote: addressable(f.base)("remote"),
    });
    expect(result).toMatchObject({ action: "none", reason: "refused" });
    expect(NodeFS.readFileSync(NodePath.join(target, "mine.txt"), "utf8")).toBe("mine\n");
    // Nothing of the clone's own is left beside it.
    expect(NodeFS.readdirSync(NodePath.join(f.b, "repositories"))).toEqual(["lib"]);
    expect(NodeFS.readdirSync(target)).toEqual(["mine.txt"]);
  });

  it("does not put a finished clone over a folder that appeared meanwhile (P2-15)", async () => {
    const f = fixture();
    const target = NodePath.join(f.b, "repositories", "lib");
    const { run } = recording();
    const racing: SyncGit = async (cwd, args, options) => {
      const done = await run(cwd, args, options);
      if (args[0] === "clone") {
        NodeFS.mkdirSync(target, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(target, "mine.txt"), "mine\n");
      }
      return done;
    };
    const result = await cloneRepository(context(racing), f.b, {
      path: "repositories/lib",
      remote: addressable(f.base)("remote"),
    });
    expect(result).toMatchObject({ action: "none", reason: "refused" });
    expect(NodeFS.readdirSync(target)).toEqual(["mine.txt"]);
    expect(NodeFS.readdirSync(NodePath.join(f.b, "repositories"))).toEqual(["lib"]);
  });

  it("reads the mirror setting as Git does: any true value, also a bare key (P2-16)", async () => {
    for (const value of ["2", "yes", "on", null]) {
      const f = fixture();
      if (value === null)
        NodeFS.appendFileSync(
          NodePath.join(f.a, ".git", "config"),
          '[remote "origin"]\n\tmirror\n',
        );
      else git(f.a, "config", "remote.origin.mirror", value);
      const { run, commands } = recording();
      const here = await fetchAll(context(run), [root(f.a)]);
      expect(here[0]!.fetch, String(value)).toBe("unusual-config");
      expect(commands.some((args) => args[0] === "fetch")).toBe(false);
    }
    // A value Git cannot read as true or false is not taken for "no mirror".
    const odd = fixture();
    git(odd.a, "config", "remote.origin.mirror", "fetch");
    expect((await fetchAll(context(recording().run), [root(odd.a)]))[0]!.fetch).toBe(
      "unusual-config",
    );
    for (const value of ["false", "0", "off"]) {
      const f = fixture();
      git(f.a, "config", "remote.origin.mirror", value);
      expect((await fetchAll(context(recording().run), [root(f.a)]))[0]!.fetch, value).toBe("ok");
    }
  });

  it("counts a thread in a subfolder as at work when its checkout cannot be read (P2-18)", () => {
    const sep = NodePath.sep;
    const project = `${sep}p`;
    const uses = (threadFolder: string, threadCheckout: string | null) =>
      threadUsesCheckout({ threadFolder, threadCheckout, checkout: project });
    expect(uses(`${project}${sep}docs`, null)).toBe(true);
    // A folder beside the checkout is no part of it, read or not.
    expect(uses(`${project}-other`, null)).toBe(false);
    expect(uses(`${sep}threads${sep}t1`, null)).toBe(false);
  });
});

describe("project sync: review round 3 follow-ups", () => {
  it("never lists a clone's staging folder, or anything in it, as a repository (P2-19)", async () => {
    const f = fixture();
    stagingFolder(f.a, ".swc-clone-lib-Ab12Cd");
    stagingFolder(f.a, "repositories/.swc-clone-lib-Ab12Cd");
    const listed = await syncRepositories(recording().run, f.a, [
      ".",
      ".swc-clone-lib-Ab12Cd/clone",
      "repositories/.swc-clone-lib-Ab12Cd/clone",
      "repositories/.swc-clone-lib-Ab12Cd/clone/vendor/dep",
    ]);
    expect(listed.map((repository) => repository.path)).toEqual(["."]);
  });

  it("does not count a clone's staging folder as uncommitted work of the repository above (P2-19)", async () => {
    const f = fixture();
    for (const staging of [".swc-clone-lib-Ab12Cd", "packages/.swc-clone-ui-Zz99Zz"])
      stagingFolder(f.a, staging);
    const head = f.publish();
    const { step, facts, result } = await sync(f.a, f.b);
    expect(facts.uncommitted).toBe(0);
    expect(say(step)).toBe("fast-forward:behind");
    expect(result).toMatchObject({ action: "fast-forward", moved: 1 });
    expect(git(f.a, "rev-parse", "HEAD")).toBe(head);
    // Work of the person's own beside it still counts.
    write(f.a, "packages/mine.ts", "export const mine = 1;\n");
    f.publish();
    expect((await sync(f.a, f.b)).step).toMatchObject({ reason: "uncommitted", uncommitted: 1 });
  });

  it("removes a dead clone's folder and says which one it could not remove (P2-19)", async () => {
    const f = fixture();
    stagingFolder(f.a, ".swc-clone-lib-Ab12Cd");
    stagingFolder(f.a, "locked/.swc-clone-ui-Zz99Zz");
    write(f.a, "kept/.swc-clone-notes.txt", "a file of the person's own\n");
    NodeFS.mkdirSync(NodePath.join(f.a, "kept", "swc-clone-lib"));
    NodeFS.chmodSync(NodePath.join(f.a, "locked"), 0o555);
    try {
      const failed = await sweepCloneLeftovers(f.a, [
        ".swc-clone-lib-Ab12Cd",
        "locked/.swc-clone-ui-Zz99Zz",
        // Never anything that is not a staging folder inside the project, whatever is asked.
        "kept/.swc-clone-notes.txt",
        "kept/swc-clone-lib",
        "../outside/.swc-clone-x-Ab12Cd",
      ]);
      expect(NodeFS.existsSync(NodePath.join(f.a, ".swc-clone-lib-Ab12Cd"))).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(f.a, "kept", ".swc-clone-notes.txt"))).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(f.a, "kept", "swc-clone-lib"))).toBe(true);
      // Where this process may write into any folder (an administrator), nothing is left to report.
      if (NodeFS.existsSync(NodePath.join(f.a, "locked", ".swc-clone-ui-Zz99Zz")))
        expect(failed).toEqual(["locked/.swc-clone-ui-Zz99Zz"]);
    } finally {
      NodeFS.chmodSync(NodePath.join(f.a, "locked"), 0o755);
    }
  });

  /** Both machines on `feature`, machine A one commit behind it; then the branch goes from origin. */
  const deletedUpstream = () => {
    const f = fixture();
    git(f.publisher, "checkout", "-q", "-b", "feature");
    commit(f.publisher, "feature.ts", "export const feature = 1;\n");
    git(f.publisher, "push", "-q", "-u", "origin", "feature");
    for (const machine of [f.a, f.b]) {
      git(machine, "fetch", "-q", "origin");
      git(machine, "checkout", "-q", "feature");
    }
    commit(f.publisher, "feature.ts", "export const feature = 2;\n");
    git(f.publisher, "push", "-q", "origin", "feature");
    git(f.a, "fetch", "-q", "origin");
    return f;
  };

  it("does not move a checkout forward to a branch that is gone from origin (P2-20)", async () => {
    const f = deletedUpstream();
    git(f.publisher, "push", "-q", "origin", "--delete", "feature");
    const before = snapshot(f.a);
    const { step, facts, result, commands } = await sync(f.a, f.b, { force: true });
    // The fetch does not prune: the tracking ref still reads one commit behind.
    expect(facts).toMatchObject({ upstream: "origin/feature", behind: 1, upstreamGone: true });
    expect(say(step)).toBe("none:no-upstream");
    expect(step.detail).toBe("The branch origin/feature is no longer on origin.");
    expect(result).toMatchObject({ action: "none", reason: "no-upstream", moved: 0 });
    expect(commands.some((args) => args[0] === "merge")).toBe(false);
    expect(snapshot(f.a)).toEqual(before);
  });

  it("asks origin once more before the move: a branch deleted after the fetch stays (P2-20)", async () => {
    const f = deletedUpstream();
    const { run, commands } = recording();
    const here = await fetchAll(context(run), [root(f.a)]);
    expect(here[0]!.upstreamGone ?? false).toBe(false);
    expect(say(planProjectSync(here, [])[0]!)).toBe("fast-forward:behind");
    git(f.publisher, "push", "-q", "origin", "--delete", "feature");
    const before = snapshot(f.a);
    const results = await runSync(context(run), f.a, [root(f.a)], {
      fastForward: [{ path: ".", otherBranch: null }],
      clone: [],
    });
    expect(results[0]).toMatchObject({
      action: "none",
      reason: "no-upstream",
      detail: "The branch origin/feature is no longer on origin.",
      moved: 0,
      downgraded: true,
    });
    expect(commands.some((args) => args[0] === "merge")).toBe(false);
    expect(snapshot(f.a)).toEqual(before);
  });

  it("keeps an empty folder that appears at the target of a finished clone (P2-21)", async () => {
    const f = fixture();
    const target = NodePath.join(f.b, "repositories", "lib");
    const { run } = recording();
    const racing: SyncGit = async (cwd, args, options) => {
      const done = await run(cwd, args, options);
      if (args[0] === "clone") NodeFS.mkdirSync(target, { recursive: true });
      return done;
    };
    const identity = () => NodeFS.statSync(target).ino;
    const result = await cloneRepository(context(racing), f.b, {
      path: "repositories/lib",
      remote: addressable(f.base)("remote"),
    });
    expect(result).toMatchObject({ action: "none", reason: "refused" });
    expect(NodeFS.readdirSync(target)).toEqual([]);
    expect(identity()).toBeGreaterThan(0);
    expect(NodeFS.readdirSync(NodePath.join(f.b, "repositories"))).toEqual(["lib"]);
  });
});

describe("project sync: review round 4 follow-ups", () => {
  it("leaves a folder with a staging name and no mark alone, and counts it (P2-23)", async () => {
    const f = fixture();
    // A person's own clone, in a folder they named this way. Nothing marks it as Sync's.
    const mine = stagingFolder(f.a, ".swc-clone-mine-Ab12Cd", { mark: false });
    const listed = await syncRepositories(recording().run, f.a, [
      ".",
      ".swc-clone-mine-Ab12Cd/clone",
    ]);
    expect(listed.map((repository) => repository.path)).toEqual([
      ".",
      ".swc-clone-mine-Ab12Cd/clone",
    ]);
    expect(
      await sweepCloneLeftovers(f.a, [".swc-clone-mine-Ab12Cd", ".swc-clone-mine-Ab12Cd/clone"]),
    ).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(mine, "clone", "half.ts"))).toBe(true);
    // It is work of the repository above it, like any other untracked folder.
    f.publish();
    const { step, result } = await sync(f.a, f.b, { force: true });
    expect(step).toMatchObject({ action: "fetch", reason: "uncommitted", uncommitted: 1 });
    expect(result).toMatchObject({ moved: 0 });
    // A mark that is not this module's own text does not make it one either.
    NodeFS.writeFileSync(NodePath.join(mine, "swc-clone-staging"), "mine\n");
    expect(await sweepCloneLeftovers(f.a, [".swc-clone-mine-Ab12Cd"])).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(mine, "clone", "half.ts"))).toBe(true);
  });
});

describe("project sync: the Git commands it runs (1390 AC-11)", () => {
  // Runs last: every test above recorded what the module ran.
  it("never runs a command that resets, rebases, stashes, switches, deletes, pushes or commits", () => {
    expect(everyCommand.length).toBeGreaterThan(100);
    const READS = new Set([
      "config",
      "symbolic-ref",
      "rev-parse",
      "rev-list",
      "status",
      "ls-remote",
      "ls-files",
    ]);
    const WRITES = new Set(["fetch", "merge", "clone"]);
    const verbs = new Set(everyCommand.map((args) => args[0]!));
    expect([...verbs].filter((verb) => !READS.has(verb) && !WRITES.has(verb))).toEqual([]);
    for (const verb of WRITES) expect(verbs.has(verb), verb).toBe(true);
    for (const forbidden of [
      "reset",
      "rebase",
      "stash",
      "checkout",
      "switch",
      "branch",
      "push",
      "commit",
      "pull",
      "clean",
      "restore",
      "update-ref",
      "worktree",
      "cherry-pick",
      "revert",
      "add",
      "rm",
      "tag",
      "gc",
      "prune",
    ])
      expect(verbs.has(forbidden), forbidden).toBe(false);
    for (const args of everyCommand) {
      // The fetch names its own destinations: never the repository's configured ones.
      if (args[0] === "fetch")
        expect(args).toEqual([
          "fetch",
          "--quiet",
          "--no-prune",
          "--no-prune-tags",
          "--no-recurse-submodules",
          "--refmap=",
          "origin",
          "+refs/heads/*:refs/remotes/origin/*",
        ]);
      if (args[0] === "merge") {
        expect(args.slice(0, 6)).toEqual([
          "merge",
          "--ff-only",
          "--no-edit",
          "--no-autostash",
          "--no-overwrite-ignore",
          "--quiet",
        ]);
        expect(args[6]).toMatch(/^[0-9a-f]{40}$/);
        expect(args).toHaveLength(7);
      }
      if (args[0] === "clone")
        expect(args.slice(0, 6)).toEqual([
          "clone",
          "--quiet",
          "--origin",
          "origin",
          "--no-recurse-submodules",
          "--",
        ]);
      // Settings are only read.
      if (args[0] === "config") {
        expect(args.slice(0, 2)).toEqual(["config", "--get-all"]);
        expect(
          args.length === 3 || (args.length === 4 && args[2] === "--bool"),
          args.join(" "),
        ).toBe(true);
      }
      // No read is told to write: no `-d`, `--delete`, `--force` or `-f` anywhere.
      expect(
        args.filter((arg) => /^(-d|-D|-f|--delete|--force|--hard|--prune)$/.test(arg)),
      ).toEqual([]);
    }
  });
});
