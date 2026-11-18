// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";

import { planProjectSync, type ProjectSyncStep } from "@specweave-studio/contracts";

import { runGit } from "./folderTransfer/git.ts";
import {
  cloneRepository,
  fetchAll,
  isLinkedWorktree,
  runSync,
  statusOf,
  type SyncContext,
  type SyncGit,
  syncRepositories,
  type SyncRepository,
  threadUsesCheckout,
} from "./ProjectSync.ts";

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
    expect(git(cloned, "remote", "get-url", "origin")).toBe(libRemote);
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
    const here = await fetchAll(ctx, await syncRepositories(run, f.a, ["."]));
    const there = await fetchAll(ctx, await syncRepositories(run, f.b, [".", "notes"]));
    expect(there[1]).toMatchObject({ fetch: "no-remote", remote: null });
    const plan = planProjectSync(here, there);
    expect(`${plan[1]!.path} ${say(plan[1]!)}`).toBe("notes none:missing-no-remote");
    expect(NodeFS.existsSync(NodePath.join(f.a, "notes"))).toBe(false);
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

  it("refuses a folder that exists, a path outside the project and a remote with a credential", async () => {
    const f = fixture();
    NodeFS.mkdirSync(NodePath.join(f.a, "taken"));
    write(f.a, "taken/keep.txt", "mine\n");
    for (const [path, remote] of [
      ["taken", f.remote],
      [".", f.remote],
      ["../outside", f.remote],
      ["nested/.git/x", f.remote],
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
  });

  it("refuses to clone through a link that leaves the project folder", async () => {
    const f = fixture();
    const outside = NodePath.join(f.base, "outside");
    NodeFS.mkdirSync(outside);
    NodeFS.symlinkSync(outside, NodePath.join(f.a, "linked"));
    const result = await ask(f, "linked/repo", f.remote);
    expect(result).toMatchObject({ action: "none", reason: "refused" });
    expect(NodeFS.readdirSync(outside)).toEqual([]);
  });

  it("leaves no folder behind when the clone fails", async () => {
    const f = fixture();
    const result = await ask(f, "repositories/none", NodePath.join(f.base, "no-such.git"));
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

describe("project sync: the Git commands it runs (1390 AC-11)", () => {
  // Runs last: every test above recorded what the module ran.
  it("never runs a command that resets, rebases, stashes, switches, deletes, pushes or commits", () => {
    expect(everyCommand.length).toBeGreaterThan(100);
    const READS = new Set(["remote", "symbolic-ref", "rev-parse", "rev-list", "status"]);
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
      if (args[0] === "fetch") expect(args).toEqual(["fetch", "--quiet", "origin"]);
      if (args[0] === "merge") {
        expect(args.slice(0, 5)).toEqual([
          "merge",
          "--ff-only",
          "--no-edit",
          "--no-overwrite-ignore",
          "--quiet",
        ]);
        expect(args[5]).toMatch(/^[0-9a-f]{40}$/);
        expect(args).toHaveLength(6);
      }
      if (args[0] === "clone") expect(args.slice(0, 3)).toEqual(["clone", "--quiet", "--"]);
      if (args[0] === "remote") expect(args).toEqual(["remote", "get-url", "origin"]);
      // No read is told to write: no `-d`, `--delete`, `--force` or `-f` anywhere.
      expect(
        args.filter((arg) => /^(-d|-D|-f|--delete|--force|--hard|--prune)$/.test(arg)),
      ).toEqual([]);
    }
  });
});
