// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * What a Sync call answers when something goes wrong on the way (1390): a
 * repository that fails is its own result and the others keep theirs, a state
 * that could not be read is said so, and a branch gone from `origin` is never
 * "Up to date".
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest";
import {
  planProjectSync,
  planProjectSyncRepository,
  PROJECT_SYNC_FETCHED_UNREAD_DETAIL,
  PROJECT_SYNC_STATE_UNREAD_DETAIL,
  type ProjectSyncRepositoryFacts,
  type ProjectSyncStep,
} from "@specweave-studio/contracts";

import {
  cleanUp,
  commit,
  git,
  isolateGit,
  restoreGit,
  snapshot,
  stagingFolder,
  twoMachines,
  write,
} from "../handoff/extrasTestKit.ts";
import { runGit } from "./folderTransfer/git.ts";
import { fetchAll, runSync, type SyncContext, type SyncGit } from "./ProjectSync.ts";
import { inventoryRepository } from "./ProjectSyncExtras.ts";
import { newFetchRecord } from "./projectSyncRecord.ts";

beforeAll(isolateGit);
afterAll(restoreGit);
afterEach(cleanUp);

const real: SyncGit = (cwd, args, options) => runGit(cwd, args, options);
/** This test's fetch, as one fetch call's record. */
let fetched = newFetchRecord("project-test");
beforeEach(() => {
  fetched = newFetchRecord("project-test");
});
const context = (run: SyncGit = real): SyncContext => ({
  git: run,
  inUse: async () => null,
  fetched,
});
const say = (step: Pick<ProjectSyncStep, "action" | "reason">) => `${step.action}:${step.reason}`;

/** Three checkouts of one remote as the repositories of a project, each one commit behind. */
function threeBehind() {
  const f = twoMachines();
  const folders = ["one", "two", "three"].map((name) => {
    const cwd = NodePath.join(f.base, "project", name);
    NodeFS.mkdirSync(NodePath.dirname(cwd), { recursive: true });
    git(f.base, "clone", "-q", f.remote, cwd);
    return { path: name, cwd: NodeFS.realpathSync(cwd) };
  });
  const head = commit(f.a, "app.ts", "export const a = 2;\n");
  git(f.a, "push", "-q", "origin", "main");
  return { ...f, root: NodeFS.realpathSync(NodePath.join(f.base, "project")), folders, head };
}

describe("project sync: one repository's failure is its own result (P2-25)", () => {
  it("keeps the results of the repositories that moved when Git fails on another", async () => {
    const f = threeBehind();
    const [one, two, three] = f.folders as [
      (typeof f.folders)[0],
      (typeof f.folders)[0],
      (typeof f.folders)[0],
    ];
    await fetchAll(context(), f.folders);
    // Git does not come back on the second repository's tree write, under the lock.
    const failing: SyncGit = (cwd, args, options) => {
      if (cwd === two.cwd && args.includes("read-tree"))
        return Promise.reject(new Error("git read-tree timed out"));
      return real(cwd, args, options);
    };
    const results = await runSync(context(failing), f.root, f.folders, {
      fastForward: f.folders.map((folder) => ({ path: folder.path, otherBranch: null })),
      clone: [],
    });
    expect(results.map((result) => `${result.path} ${say(result)} ${result.moved}`)).toEqual([
      "one fast-forward:behind 1",
      "two none:refused 0",
      "three fast-forward:behind 1",
    ]);
    // Read after the failure: neither the branch nor a file moved there, so it is a refusal,
    // with Git's words.
    expect(results[1]).toMatchObject({ downgraded: true, branch: "main" });
    expect(results[1]!.detail).toContain("git read-tree timed out");
    expect(results[1]!.movedUnverified ?? false).toBe(false);
    expect(git(two.cwd, "rev-parse", "HEAD")).not.toBe(f.head);
    expect(git(one.cwd, "rev-parse", "HEAD")).toBe(f.head);
    expect(git(three.cwd, "rev-parse", "HEAD")).toBe(f.head);
  });

  it("keeps the other clones' results when one clone's step fails", async () => {
    const f = twoMachines();
    const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(f.base, "project-")));
    git(root, "init", "-q", "-b", "main");
    const config = NodePath.join(f.base, "gitconfig");
    NodeFS.writeFileSync(config, `[url "${f.base}/"]\n\tinsteadOf = https://sync.test/\n`);
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
      // The first clone's Git is cut off; the second one's runs.
      const failing: SyncGit = (cwd, args, options) =>
        args[0] === "clone" && cwd.includes(".swc-clone-first-")
          ? Promise.reject(new Error("git clone was cut off"))
          : real(cwd, args, options);
      const failingAfter: SyncGit = (cwd, args, options) =>
        args[0] === "symbolic-ref" && cwd.endsWith(`${NodePath.sep}second`)
          ? Promise.reject(new Error("git did not answer"))
          : failing(cwd, args, options);
      const remote = "https://sync.test/remote.git";
      const results = await runSync(context(failingAfter), root, [], {
        fastForward: [],
        clone: [
          { path: "first", remote },
          { path: "second", remote },
          { path: "third", remote },
        ],
      });
      expect(results.map((result) => `${result.path} ${say(result)}`)).toEqual([
        "first none:refused",
        // In its place before the read failed: a clone that was made, its branch not known.
        "second clone:missing",
        "third clone:missing",
      ]);
      expect(results[1]).toMatchObject({ branch: null, detail: null, downgraded: false });
      expect(NodeFS.existsSync(NodePath.join(root, "first"))).toBe(false);
      expect(git(NodePath.join(root, "second"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(NodeFS.readdirSync(root).filter((name) => name.startsWith(".swc-clone-"))).toEqual([]);
      expect(NodeFS.existsSync(NodePath.join(root, "third", ".git"))).toBe(true);
    } finally {
      process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    }
  });
});

describe("project sync: a state that could not be read (P2-26)", () => {
  it("holds the checkout and says so, with no count of files nobody saw", async () => {
    const f = twoMachines();
    const head = commit(f.a, "app.ts", "export const a = 2;\n");
    git(f.a, "push", "-q", "origin", "main");
    const before = snapshot(f.b);
    const blind: SyncGit = async (cwd, args, options) =>
      args[0] === "status"
        ? { code: 128, stdout: "", stderr: "fatal: unable to read the index" }
        : real(cwd, args, options);
    const here = await fetchAll(context(blind), [{ path: ".", cwd: f.b }]);
    expect(here[0]).toMatchObject({ behind: 1, uncommitted: 0, stateUnread: true });
    const step = planProjectSync(here, [])[0]!;
    expect(say(step)).toBe("fetch:uncommitted");
    expect(step).toMatchObject({ uncommitted: 0, detail: PROJECT_SYNC_FETCHED_UNREAD_DETAIL });
    expect(PROJECT_SYNC_FETCHED_UNREAD_DETAIL).toBe(
      "Fetched, but its state could not be read, so it was not moved.",
    );
    // Asked to move it anyway, the server holds it for the same reason.
    const results = await runSync(context(blind), f.b, [{ path: ".", cwd: f.b }], {
      fastForward: [{ path: ".", otherBranch: null }],
      clone: [],
    });
    expect(results[0]).toMatchObject({
      action: "fetch",
      reason: "uncommitted",
      uncommitted: 0,
      moved: 0,
      downgraded: true,
      detail: PROJECT_SYNC_FETCHED_UNREAD_DETAIL,
    });
    expect(snapshot(f.b)).toEqual(before);
    // Readable again, it still does not move by that fetch: its row was unread.
    const still = await runSync(context(), f.b, [{ path: ".", cwd: f.b }], {
      fastForward: [{ path: ".", otherBranch: null }],
      clone: [],
    });
    expect(still[0]).toMatchObject({ moved: 0, downgraded: true });
    expect(snapshot(f.b)).toEqual(before);
    // A new fetch that reads it moves it.
    fetched = newFetchRecord("project-test");
    await fetchAll(context(), [{ path: ".", cwd: f.b }]);
    const moved = await runSync(context(), f.b, [{ path: ".", cwd: f.b }], {
      fastForward: [{ path: ".", otherBranch: null }],
      clone: [],
    });
    expect(moved[0]).toMatchObject({ action: "fast-forward", moved: 1, detail: null });
    expect(git(f.b, "rev-parse", "HEAD")).toBe(head);
  });
});

describe("project sync: a branch gone from origin with nothing behind (P2-27)", () => {
  /** Machine A on `feature`, level with origin; then the branch is deleted on origin. */
  const levelThenGone = () => {
    const f = twoMachines();
    git(f.a, "checkout", "-q", "-b", "feature");
    commit(f.a, "feature.ts", "export const feature = 1;\n");
    git(f.a, "push", "-q", "-u", "origin", "feature");
    git(f.b, "push", "-q", "origin", "--delete", "feature");
    return f;
  };

  it("is not up to date: it has no upstream on origin any more", async () => {
    const f = levelThenGone();
    const here = await fetchAll(context(), [{ path: ".", cwd: f.a }]);
    expect(here[0]).toMatchObject({
      upstream: "origin/feature",
      ahead: 0,
      behind: 0,
      upstreamGone: true,
    });
    const step = planProjectSync(here, [])[0]!;
    expect(say(step)).toBe("none:no-upstream");
    expect(step.detail).toBe("The branch origin/feature is no longer on origin.");
  });

  it("still lists a level branch's own commits as an extra", async () => {
    const f = levelThenGone();
    const own = commit(f.a, "feature.ts", "export const feature = 'mine';\n");
    const here = await fetchAll(context(), [{ path: ".", cwd: f.a }]);
    // Nothing was brought to count against: the inventory lists the commits.
    expect(here[0]).toMatchObject({ behind: 0, upstreamGone: true });
    expect(say(planProjectSync(here, [])[0]!)).toBe("none:no-upstream");
    const extras = await inventoryRepository({ path: ".", cwd: f.a });
    expect(extras.notPushed).toEqual([{ branch: "feature", head: own, commits: 1 }]);
  });

  it("leaves a branch origin still has as up to date", async () => {
    const f = twoMachines();
    const here = await fetchAll(context(), [{ path: ".", cwd: f.a }]);
    expect(here[0]!.upstreamGone ?? false).toBe(false);
    expect(say(planProjectSync(here, [])[0]!)).toBe("none:up-to-date");
  });
});

describe("project sync: the work on a branch that just went from origin (P2-31)", () => {
  /** Machine A on `feature` with one commit of its own, pushed; level with origin. */
  const level = () => {
    const f = twoMachines();
    git(f.a, "checkout", "-q", "-b", "feature");
    const head = commit(f.a, "feature.ts", "export const feature = 1;\n");
    git(f.a, "push", "-q", "-u", "origin", "feature");
    return { ...f, head };
  };
  /** A fetch of its own, and what it brought for the checkout. */
  const fetchedAt = async (cwd: string) => {
    const record = newFetchRecord("project-test");
    const here = await fetchAll({ ...context(), fetched: record }, [{ path: ".", cwd }]);
    return { origin: record.rows.get("."), facts: here[0]! };
  };

  it("offers a branch that was level when it was deleted, with no further commit", async () => {
    const f = level();
    git(f.b, "push", "-q", "origin", "--delete", "feature");
    const { origin, facts } = await fetchedAt(f.a);
    expect(facts).toMatchObject({ ahead: 0, behind: 0, upstreamGone: true });
    // The tracking ref still says "level": counted against it, the commit is nobody's.
    expect(git(f.a, "rev-parse", "refs/remotes/origin/feature")).toBe(f.head);
    const extras = await inventoryRepository({ path: ".", cwd: f.a }, origin);
    expect(extras.onlyHere).toEqual([{ branch: "feature", head: f.head, commits: 1 }]);
    expect(extras.notPushed).toEqual([]);
  });

  it("still lists a deleted branch whose commits are all on a branch origin has, with none of its own", async () => {
    const f = level();
    // Merged on origin, then deleted there.
    git(f.b, "fetch", "-q", "origin");
    git(f.b, "merge", "-q", "--ff-only", "origin/feature");
    git(f.b, "push", "-q", "origin", "main");
    git(f.b, "push", "-q", "origin", "--delete", "feature");
    const { origin, facts } = await fetchedAt(f.a);
    expect(facts).toMatchObject({ upstreamGone: true });
    // The branch exists only here now: named as that, like one that was never published.
    const extras = await inventoryRepository({ path: ".", cwd: f.a }, origin);
    expect(extras.onlyHere).toEqual([{ branch: "feature", head: f.head, commits: 0 }]);
    expect(extras.notPushed).toEqual([]);
    git(f.a, "branch", "-q", "never-published", "main");
    const again = await inventoryRepository({ path: ".", cwd: f.a }, origin);
    expect(again.onlyHere.map((extra) => `${extra.branch} ${extra.commits}`)).toEqual([
      "feature 0",
      "never-published 0",
    ]);
  });

  it("keeps a deleted branch's own commits however many branches origin has (P2-45)", async () => {
    const f = level();
    git(f.b, "push", "-q", "origin", "--delete", "feature");
    const { origin } = await fetchedAt(f.a);
    // origin with 2,500 branches, as a fetch of it would have brought them.
    const many = new Map(origin!.originHeads);
    const main = origin!.originHeads.get("refs/heads/main")!;
    for (let index = 0; index < 2500; index += 1) many.set(`refs/heads/topic-${index}`, main);
    // One of them at a commit this checkout does not have yet.
    many.set("refs/heads/not-here-yet", "1".repeat(40));
    const extras = await inventoryRepository(
      { path: ".", cwd: f.a },
      { ...origin!, originHeads: many },
    );
    expect(extras.onlyHere).toEqual([{ branch: "feature", head: f.head, commits: 1 }]);
  });

  it("counts a branch origin still has as before", async () => {
    const f = level();
    const own = commit(f.a, "feature.ts", "export const feature = 'mine';\n");
    const { origin } = await fetchedAt(f.a);
    const extras = await inventoryRepository({ path: ".", cwd: f.a }, origin);
    expect(extras.notPushed).toEqual([{ branch: "feature", head: own, commits: 1 }]);
    expect(extras.onlyHere).toEqual([]);
  });
});

describe("project sync: a clone's staging folder in the list of extras (P2-34)", () => {
  it("is not counted when its name is one Git writes in quotes", async () => {
    const f = twoMachines();
    stagingFolder(f.a, ".swc-clone-caf\u00e9 \u043b\u0438\u0431-Ab12Cd", { repository: false });
    // A person's own file with such a name is still theirs.
    write(f.a, "caf\u00e9 notes.txt", "mine\n");
    const extras = await inventoryRepository({ path: ".", cwd: f.a });
    expect(extras.untrackedFiles).toBe(1);
    expect(extras.changedFiles).toBe(0);
  });

  it("counts a renamed file once", async () => {
    const f = twoMachines();
    git(f.a, "mv", "app.ts", "moved app.ts");
    const extras = await inventoryRepository({ path: ".", cwd: f.a });
    expect(extras).toMatchObject({ changedFiles: 1, untrackedFiles: 0 });
  });

  it("counts a file renamed without being staged once", async () => {
    const f = twoMachines();
    NodeFS.renameSync(NodePath.join(f.a, "app.ts"), NodePath.join(f.a, "moved app.ts"));
    git(f.a, "add", "-N", "moved app.ts");
    // The rename is in the second column: nothing is staged.
    expect(git(f.a, "status", "--porcelain=v1", "--branch")).toContain("\n R app.ts -> ");
    const extras = await inventoryRepository({ path: ".", cwd: f.a });
    expect(extras).toMatchObject({ changedFiles: 1, untrackedFiles: 0 });
    const here = await fetchAll(context(), [{ path: ".", cwd: f.a }]);
    expect(here[0]).toMatchObject({ uncommitted: 1 });
  });

  it("lists no ignored secret that lies in a staging folder", async () => {
    const f = twoMachines();
    commit(f.a, ".gitignore", "ignored.log\n.env\n");
    const staging = stagingFolder(f.a, ".swc-clone-lib-Ab12Cd", { repository: false });
    write(staging, "clone/.env", "API_KEY=abc\n");
    // The person's own, in a folder that only has such a name, and at the top.
    const mine = stagingFolder(f.a, ".swc-clone-mine-Ab12Cd", { mark: false, repository: false });
    write(mine, "clone/.env", "API_KEY=abc\n");
    write(f.a, ".env", "API_KEY=abc\n");
    const extras = await inventoryRepository({ path: ".", cwd: f.a });
    expect(
      extras.leftOut.filter((file) => file.path.endsWith(".env")).map((file) => file.path),
    ).toEqual([".env", ".swc-clone-mine-Ab12Cd/clone/.env"]);
  });
});

describe("project sync: a level checkout whose state could not be read (P2-37)", () => {
  const facts = (change: Partial<ProjectSyncRepositoryFacts>): ProjectSyncRepositoryFacts => ({
    path: ".",
    branch: "main",
    head: "a".repeat(40),
    upstream: "origin/main",
    otherUpstream: null,
    ahead: 0,
    behind: 0,
    uncommitted: 0,
    inUseBy: null,
    remote: null,
    fetch: "ok",
    fetchError: null,
    ...change,
  });
  const plan = (change: Partial<ProjectSyncRepositoryFacts>) => {
    const step = planProjectSyncRepository(facts(change), null);
    return `${say(step)} ${step.detail}`;
  };

  it("puts the unread sentence first, whatever the counts say (D4-06)", () => {
    expect(plan({ stateUnread: true })).toBe(
      `fetch:uncommitted ${PROJECT_SYNC_STATE_UNREAD_DETAIL}`,
    );
    expect(plan({ ahead: 2, stateUnread: true })).toBe(
      `fetch:uncommitted ${PROJECT_SYNC_STATE_UNREAD_DETAIL}`,
    );
    expect(plan({ behind: 1, stateUnread: true })).toBe(
      `fetch:uncommitted ${PROJECT_SYNC_STATE_UNREAD_DETAIL}`,
    );
    expect(plan({ behind: 1, unreadDetail: PROJECT_SYNC_FETCHED_UNREAD_DETAIL })).toBe(
      `fetch:uncommitted ${PROJECT_SYNC_FETCHED_UNREAD_DETAIL}`,
    );
  });

  it("says nothing when the state was read, or the fact is absent", () => {
    expect(plan({})).toBe("none:up-to-date null");
    expect(plan({ ahead: 2 })).toBe("none:not-pushed null");
    expect(plan({ stateUnread: false })).toBe("none:up-to-date null");
    expect(plan({ ahead: 2, stateUnread: false })).toBe("none:not-pushed null");
  });

  it("reaches the plan from a real checkout Git could not read", async () => {
    const f = twoMachines();
    const blind: SyncGit = async (cwd, args, options) =>
      args[0] === "status"
        ? { code: 128, stdout: "", stderr: "fatal: unable to read the index" }
        : real(cwd, args, options);
    const here = await fetchAll(context(blind), [{ path: ".", cwd: f.a }]);
    expect(here[0]).toMatchObject({ behind: 0, ahead: 0, stateUnread: true });
    expect(planProjectSync(here, [])[0]).toMatchObject({
      action: "fetch",
      reason: "uncommitted",
      detail: PROJECT_SYNC_FETCHED_UNREAD_DETAIL,
    });
  });
});
