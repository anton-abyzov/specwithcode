// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * What a Sync call answers when something goes wrong on the way (1390): a
 * repository that fails is its own result and the others keep theirs, a state
 * that could not be read is said so, and a branch gone from `origin` is never
 * "Up to date".
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
import {
  planProjectSync,
  PROJECT_SYNC_STATE_UNREAD_DETAIL,
  type ProjectSyncStep,
} from "@specweave-studio/contracts";

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
import { fetchAll, runSync, type SyncContext, type SyncGit } from "./ProjectSync.ts";
import { inventoryRepository } from "./ProjectSyncExtras.ts";

beforeAll(isolateGit);
afterAll(restoreGit);
afterEach(cleanUp);

const real: SyncGit = (cwd, args, options) => runGit(cwd, args, options);
const context = (run: SyncGit = real): SyncContext => ({ git: run, inUse: async () => null });
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
    // Git does not come back on the second repository's merge.
    const failing: SyncGit = (cwd, args, options) => {
      if (cwd === two.cwd && args[0] === "merge")
        return Promise.reject(new Error("git merge timed out"));
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
    expect(results[1]).toMatchObject({ downgraded: true, branch: null });
    expect(results[1]!.detail).toContain("git merge timed out");
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
        "second none:refused",
        "third clone:missing",
      ]);
      expect(results[1]!.detail).toContain("git did not answer");
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
    expect(step).toMatchObject({ uncommitted: 0, detail: PROJECT_SYNC_STATE_UNREAD_DETAIL });
    expect(PROJECT_SYNC_STATE_UNREAD_DETAIL).toBe(
      "Its state could not be read, so it was not moved.",
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
      detail: PROJECT_SYNC_STATE_UNREAD_DETAIL,
    });
    expect(snapshot(f.b)).toEqual(before);
    // Readable again, it moves.
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
    expect(here[0]).toMatchObject({ ahead: 1, behind: 0, upstreamGone: true });
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
