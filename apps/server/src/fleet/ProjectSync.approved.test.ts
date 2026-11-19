// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * Which fetch a move goes by (1390), through the service a window calls: a
 * `run` moves a checkout only by the row and to the commit the fetch it names
 * showed, under Git's lock on HEAD and the branch it names, and says what it
 * found when the checkout is not where its own move left it.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@effect/vitest";
import {
  planProjectSync,
  type Project,
  ProjectId,
  PROJECT_SYNC_CHANGED_BRANCH_DETAIL,
  PROJECT_SYNC_CHANGED_HEAD_DETAIL,
  PROJECT_SYNC_FETCHED_UNREAD_DETAIL,
  PROJECT_SYNC_NO_FETCH_DETAIL,
  PROJECT_SYNC_PATH_UNREAD_DETAIL,
  projectSyncUpstreamMappingDetail,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import {
  cleanUp,
  commit,
  git,
  gitHooks,
  isolateGit,
  recordedGit,
  restoreGit,
  snapshot,
  twoMachines,
} from "../handoff/extrasTestKit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSync from "./ProjectSync.ts";

vi.mock("./folderTransfer/git.ts", async (importOriginal) => {
  const kit = await import("../handoff/extrasTestKit.ts");
  return kit.recordingGit(await importOriginal<typeof import("./folderTransfer/git.ts")>());
});

beforeAll(isolateGit);
afterAll(restoreGit);
afterEach(cleanUp);

const projectA = ProjectId.make("project-one");
const projectB = ProjectId.make("project-two");
const project = (id: ProjectId, workspaceRoot: string) =>
  ({ id, title: "App", workspaceRoot, workspaceSettings: {} }) as unknown as Project;
const syncLayer = (projects: ReadonlyArray<Project>) =>
  ProjectSync.layer.pipe(
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        snapshot: Effect.succeed({ projects, updatedAt: "2026-11-18T00:00:00.000Z" }),
      }),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
  );
const withSync = <A, E>(
  folder: string,
  body: (sync: ProjectSync.ProjectSync["Service"]) => Effect.Effect<A, E>,
  projects: ReadonlyArray<Project> = [project(projectA, folder)],
) =>
  Effect.gen(function* () {
    return yield* body(yield* ProjectSync.ProjectSync);
  }).pipe(Effect.provide(syncLayer(projects)));

const one = { projectId: projectA };
const root = [{ path: ".", otherBranch: null }];
/** Machine B one commit behind `origin`'s `main`; `publish` adds another commit there. */
function behind() {
  const f = twoMachines();
  const was = git(f.b, "rev-parse", "HEAD");
  let count = 1;
  const publish = () => {
    count += 1;
    const head = commit(f.a, "app.ts", `export const a = ${count};\n`);
    git(f.a, "push", "-q", "origin", "main");
    return head;
  };
  return { ...f, was, head: publish(), publish };
}
const outage = (f: { readonly remote: string }) => NodeFS.renameSync(f.remote, `${f.remote}.away`);
/** The commands of `verb` run in `cwd`, also behind `-c` settings. */
const ran = (verb: string, cwd: string) =>
  recordedGit().filter(
    (command) =>
      command.cwd === cwd &&
      (command.args[0] === verb || (command.args[0] === "-c" && command.args[2] === verb)),
  );
const syncRefs = (cwd: string) => git(cwd, "for-each-ref", "refs/specwithcode/sync/");

describe("project sync: a move needs the fetch it names (P2-38)", () => {
  it.effect("moves nothing on a person's own fetch, also when origin agrees with it", () => {
    const f = behind();
    // The server was restarted, or never fetched here: the tracking ref is the person's doing.
    git(f.b, "fetch", "-q", "origin");
    return withSync(f.b, (sync) =>
      Effect.gen(function* () {
        const before = snapshot(f.b);
        const run = yield* sync.run({ ...one, fastForward: root, clone: [] });
        expect(run.repositories[0]).toMatchObject({
          action: "none",
          reason: "refused",
          moved: 0,
          downgraded: true,
          detail: PROJECT_SYNC_NO_FETCH_DETAIL,
        });
        expect(PROJECT_SYNC_NO_FETCH_DETAIL).toBe(
          "Sync has no fetch of its own to go by for this checkout. Sync again.",
        );
        // A fetch id the server does not keep is no better.
        const unknown = yield* sync.run({
          ...one,
          fetchId: "00000000-0000-4000-8000-000000000000",
          fastForward: root,
          clone: [],
        });
        expect(unknown.repositories[0]).toMatchObject({
          action: "none",
          reason: "refused",
          detail: PROJECT_SYNC_NO_FETCH_DETAIL,
        });
        expect(snapshot(f.b)).toEqual(before);
        expect(ran("read-tree", f.b)).toEqual([]);
        // With its own fetch named, it moves.
        const fetched = yield* sync.fetch(one);
        expect(typeof fetched.fetchId).toBe("string");
        const moved = yield* sync.run({
          ...one,
          fetchId: fetched.fetchId,
          fastForward: root,
          clone: [],
        });
        expect(moved.repositories[0]).toMatchObject({
          action: "fast-forward",
          moved: 1,
          detail: null,
        });
        expect(git(f.b, "rev-parse", "HEAD")).toBe(f.head);
      }),
    );
  });

  it.effect("fetches in one network step and leaves no ref of its own behind", () => {
    const f = behind();
    return withSync(f.b, (sync) =>
      Effect.gen(function* () {
        const fetched = yield* sync.fetch(one);
        expect(fetched.repositories[0]).toMatchObject({ fetch: "ok", behind: 1 });
        expect(
          ran("ls-remote", f.b).filter((command) => !command.args.includes("--get-url")),
        ).toEqual([]);
        expect(ran("fetch", f.b)).toHaveLength(1);
        // The machine's answer says it moves only by a guarded fast-forward (D4-07).
        expect(fetched.guardedFastForward).toBe(true);
        expect(syncRefs(f.b)).toBe("");
        // A fetch that fails leaves none either, and gives no fetch to go by.
        outage(f);
        const failed = yield* sync.fetch(one);
        expect(failed.repositories[0]).toMatchObject({ fetch: "failed" });
        expect(syncRefs(f.b)).toBe("");
        const run = yield* sync.run({
          ...one,
          fetchId: failed.fetchId,
          fastForward: root,
          clone: [],
        });
        expect(run.repositories[0]).toMatchObject({ action: "none", moved: 0 });
        expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
      }),
    );
  });
});

describe("project sync: each window moves by its own fetch (P2-40)", () => {
  it.effect("moves the first window only to the commit it approved, never a later fetch's", () => {
    const f = behind();
    return withSync(f.b, (sync) =>
      Effect.gen(function* () {
        const first = yield* sync.fetch(one);
        const newer = f.publish();
        const second = yield* sync.fetch(one);
        expect(second.fetchId).not.toBe(first.fetchId);
        expect(first.repositories[0]).toMatchObject({ behind: 1, upstreamCommit: f.head });
        expect(second.repositories[0]).toMatchObject({ behind: 2, upstreamCommit: newer });
        // The first window approved one commit: it moves there, though origin and this
        // checkout know a newer one.
        const firstRun = yield* sync.run({
          ...one,
          fetchId: first.fetchId,
          fastForward: root,
          clone: [],
        });
        expect(firstRun.repositories[0]).toMatchObject({ action: "fast-forward", moved: 1 });
        expect(git(f.b, "rev-parse", "HEAD")).toBe(f.head);
        // The second window's row no longer matches the checkout: it declines.
        const secondRun = yield* sync.run({
          ...one,
          fetchId: second.fetchId,
          fastForward: root,
          clone: [],
        });
        expect(secondRun.repositories[0]).toMatchObject({
          action: "none",
          reason: "refused",
          moved: 0,
          detail: PROJECT_SYNC_CHANGED_HEAD_DETAIL,
        });
        expect(git(f.b, "rev-parse", "HEAD")).toBe(f.head);
      }),
    );
  });

  it.effect("keeps one project's fetch from another project on the same checkout", () => {
    const f = behind();
    return withSync(
      f.b,
      (sync) =>
        Effect.gen(function* () {
          const fetched = yield* sync.fetch(one);
          const other = yield* sync.run({
            projectId: projectB,
            fetchId: fetched.fetchId,
            fastForward: root,
            clone: [],
          });
          expect(other.repositories[0]).toMatchObject({
            action: "none",
            reason: "refused",
            detail: PROJECT_SYNC_NO_FETCH_DETAIL,
          });
          expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
          const own = yield* sync.run({
            ...one,
            fetchId: fetched.fetchId,
            fastForward: root,
            clone: [],
          });
          expect(own.repositories[0]).toMatchObject({ action: "fast-forward", moved: 1 });
        }),
      [project(projectA, f.b), project(projectB, f.b)],
    );
  });
});

describe("project sync: the upstream's branch on origin, not its name here (P2-41)", () => {
  it.effect(
    "does not move a branch that follows another branch of origin under a local name",
    () => {
      const f = twoMachines();
      // origin has `release` and `stable`, at different commits.
      git(f.a, "checkout", "-q", "-b", "release");
      const released = commit(f.a, "release.ts", "export const release = 1;\n");
      git(f.a, "push", "-q", "-u", "origin", "release");
      git(f.a, "checkout", "-q", "-b", "stable", "main");
      git(f.a, "push", "-q", "-u", "origin", "stable");
      // Here, `work` follows origin's `release`, which this checkout keeps as `origin/stable`.
      git(f.b, "config", "remote.origin.fetch", "+refs/heads/release:refs/remotes/origin/stable");
      git(f.b, "fetch", "-q", "origin");
      git(f.b, "checkout", "-q", "-b", "work", "main");
      git(f.b, "config", "branch.work.remote", "origin");
      git(f.b, "config", "branch.work.merge", "refs/heads/release");
      expect(git(f.b, "rev-parse", "work@{upstream}")).toBe(released);
      // origin's `stable` moves on, where `release` does not.
      git(f.a, "checkout", "-q", "stable");
      const stable = commit(f.a, "stable.ts", "export const stable = 1;\n");
      git(f.a, "push", "-q", "origin", "stable");
      const was = git(f.b, "rev-parse", "HEAD");
      return withSync(f.b, (sync) =>
        Effect.gen(function* () {
          const fetched = yield* sync.fetch(one);
          const detail = projectSyncUpstreamMappingDetail("origin/stable", "release");
          expect(detail).toBe(
            "The branch follows release of origin through origin/stable, a mapping Sync does not move by.",
          );
          expect(fetched.repositories[0]).toMatchObject({
            upstream: null,
            upstreamUnusual: detail,
          });
          const step = planProjectSync(fetched.repositories, [])[0]!;
          expect(step).toMatchObject({ action: "none", reason: "no-upstream", detail });
          const run = yield* sync.run({
            ...one,
            fetchId: fetched.fetchId,
            fastForward: root,
            clone: [],
          });
          expect(run.repositories[0]).toMatchObject({ action: "none", moved: 0, detail });
          expect(git(f.b, "rev-parse", "HEAD")).toBe(was);
          expect(git(f.b, "rev-parse", "HEAD")).not.toBe(stable);
        }),
      );
    },
  );
});

describe("project sync: only what the fetch itself brought (P2-42, P3-04)", () => {
  it.effect("goes by the commit the fetch wrote, whatever the tracking ref says after", () => {
    const f = behind();
    let published: string | null = null;
    // origin moves on between the moment the fetch starts and the moment it reads origin.
    gitHooks.before = (command) => {
      if (command.cwd === f.b && command.args[0] === "fetch" && published === null)
        published = f.publish();
    };
    return withSync(f.b, (sync) =>
      Effect.gen(function* () {
        const fetched = yield* sync.fetch(one);
        gitHooks.before = null;
        expect(published).not.toBe(null);
        expect(fetched.repositories[0]).toMatchObject({
          fetch: "ok",
          behind: 2,
          upstreamCommit: published,
        });
        // Something puts the tracking ref back at the older commit; origin is then out of
        // reach. Neither is gone by: the fetch's own output named the commit.
        git(f.b, "update-ref", "refs/remotes/origin/main", f.head);
        outage(f);
        const run = yield* sync.run({
          ...one,
          fetchId: fetched.fetchId,
          fastForward: root,
          clone: [],
        });
        expect(run.repositories[0]).toMatchObject({ action: "fast-forward", moved: 2 });
        expect(git(f.b, "rev-parse", "HEAD")).toBe(published);
      }),
    );
  });
});

describe("project sync: the last reads and the write (P2-43)", () => {
  it.effect(
    "a switch during the last status walk, under the lock, fails and the move goes on",
    () => {
      const f = behind();
      return withSync(f.b, (sync) =>
        Effect.gen(function* () {
          const fetched = yield* sync.fetch(one);
          // The person switches to another branch while the last status walk runs: by then
          // Git holds HEAD and the branch for the move.
          const statuses: Array<string> = [];
          let attempt = "not tried";
          gitHooks.before = (command) => {
            if (command.cwd !== f.b || command.args[0] !== "status") return;
            statuses.push(command.args[0]);
            if (statuses.length !== 2) return;
            try {
              git(f.b, "checkout", "-q", "-b", "other");
              attempt = "ok";
            } catch {
              attempt = "failed";
            }
          };
          const run = yield* sync.run({
            ...one,
            fetchId: fetched.fetchId,
            fastForward: root,
            clone: [],
          });
          expect(statuses).toHaveLength(2);
          expect(attempt).toBe("failed");
          expect(run.repositories[0]).toMatchObject({ action: "fast-forward", moved: 1 });
          expect(git(f.b, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
          expect(git(f.b, "rev-parse", "main")).toBe(f.head);
        }),
      );
    },
  );

  /** B fetched and behind; `act` runs at the very entry of the command `verb`. */
  const atEntry = (verb: string, act: (f: ReturnType<typeof behind>) => void) => {
    const f = behind();
    return withSync(f.b, (sync) =>
      Effect.gen(function* () {
        const fetched = yield* sync.fetch(one);
        let done = false;
        gitHooks.before = (command) => {
          if (done || command.cwd !== f.b) return;
          if (command.args[0] === verb || (command.args[0] === "-c" && command.args[2] === verb)) {
            done = true;
            act(f);
          }
        };
        const run = yield* sync.run({
          ...one,
          fetchId: fetched.fetchId,
          fastForward: root,
          clone: [],
        });
        return { f, step: run.repositories[0]! };
      }),
    );
  };
  /** Runs Git by hand as a person would; its exit is what the test reads. */
  const tries = (cwd: string, ...args: Array<string>) => {
    try {
      git(cwd, ...args);
      return "ok";
    } catch {
      return "failed";
    }
  };

  it.effect(
    "switched to another branch at the same commit just before the lock: both branches keep their tips (P3-02)",
    () =>
      Effect.gen(function* () {
        // The last read before the transaction is prepared: the checkout of another
        // worktree list. HEAD then names `other`, whose tip is the recorded commit too,
        // so Git's own old-value check passes; the branch check under the lock does not.
        let other = "";
        const { f, step } = yield* atEntry("worktree", (f) => {
          git(f.b, "checkout", "-q", "-b", "other");
          other = git(f.b, "rev-parse", "other");
        });
        expect(other).toBe(f.was);
        expect(step).toMatchObject({
          action: "none",
          reason: "refused",
          moved: 0,
          detail: PROJECT_SYNC_CHANGED_BRANCH_DETAIL,
        });
        expect(git(f.b, "rev-parse", "other")).toBe(f.was);
        expect(git(f.b, "rev-parse", "main")).toBe(f.was);
        expect(git(f.b, "symbolic-ref", "HEAD")).toBe("refs/heads/other");
        expect(ran("read-tree", f.b)).toEqual([]);
      }),
  );

  it.effect(
    "holds HEAD and the branch while the files move: a switch or commit then fails (P3-02)",
    () =>
      Effect.gen(function* () {
        const attempts: Array<string> = [];
        const { f, step } = yield* atEntry("read-tree", (f) => {
          attempts.push(tries(f.b, "checkout", "-q", "-b", "other"));
          attempts.push(tries(f.b, "commit", "-q", "--allow-empty", "-m", "racing"));
          attempts.push(tries(f.b, "update-ref", "refs/heads/main", f.head));
        });
        // HEAD.lock and the branch's lock are Git's own: every writer that needs them fails.
        expect(attempts).toEqual(["failed", "failed", "failed"]);
        expect(step).toMatchObject({ action: "fast-forward", moved: 1, downgraded: false });
        expect(git(f.b, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
        expect(git(f.b, "rev-parse", "main")).toBe(f.head);
        // `checkout -b` made its branch before it failed on HEAD: that branch keeps its tip.
        expect(git(f.b, "rev-parse", "other")).toBe(f.was);
        expect(git(f.b, "status", "--porcelain=v1")).toBe("");
      }),
  );
});

describe("project sync: Git settings cannot turn the move into something else (P2-46)", () => {
  const withMergeOptions = (options: string) => {
    const f = behind();
    git(f.b, "config", "branch.main.mergeOptions", options);
    return withSync(f.b, (sync) =>
      Effect.gen(function* () {
        const fetched = yield* sync.fetch(one);
        const before = snapshot(f.b);
        const run = yield* sync.run({
          ...one,
          fetchId: fetched.fetchId,
          fastForward: root,
          clone: [],
        });
        return { f, before, step: run.repositories[0]! };
      }),
    );
  };

  // No merge runs at all: merge settings have nothing to act on.
  it.effect.each([
    "--squash",
    "--no-ff",
    "--no-commit --squash --autostash --stat",
    "-s ours",
    "-X theirs",
  ])("moves forward and nothing else with %s in the branch's merge options", (options) =>
    Effect.gen(function* () {
      const { f, step } = yield* withMergeOptions(options);
      expect(step).toMatchObject({ action: "fast-forward", moved: 1, downgraded: false });
      expect(git(f.b, "rev-parse", "HEAD")).toBe(f.head);
      // No merge commit, nothing staged, nothing changed in the files.
      expect(git(f.b, "rev-list", "--count", "--merges", "HEAD")).toBe("0");
      expect(git(f.b, "status", "--porcelain=v1")).toBe("");
      expect(NodeFS.readFileSync(NodePath.join(f.b, "app.ts"), "utf8")).toBe(
        "export const a = 2;\n",
      );
    }),
  );

  it.effect("runs none of the checkout's hooks, in the fetch or in the move", () => {
    const f = behind();
    const fired = NodePath.join(f.base, "fired");
    for (const hook of [
      "post-merge",
      "reference-transaction",
      "post-checkout",
      "pre-merge-commit",
    ]) {
      const file = NodePath.join(f.b, ".git", "hooks", hook);
      NodeFS.writeFileSync(file, `#!/bin/sh\necho ${hook} >> "${fired}"\n`);
      NodeFS.chmodSync(file, 0o755);
    }
    // The hooks are live: Git run by hand fires them.
    git(f.b, "update-ref", "refs/heads/probe", f.was);
    expect(NodeFS.readFileSync(fired, "utf8")).toContain("reference-transaction");
    NodeFS.rmSync(fired);
    return withSync(f.b, (sync) =>
      Effect.gen(function* () {
        const fetched = yield* sync.fetch(one);
        const run = yield* sync.run({
          ...one,
          fetchId: fetched.fetchId,
          fastForward: root,
          clone: [],
        });
        expect(run.repositories[0]).toMatchObject({ action: "fast-forward", moved: 1 });
        expect(git(f.b, "rev-parse", "HEAD")).toBe(f.head);
        expect(NodeFS.existsSync(fired)).toBe(false);
      }),
    );
  });
});

describe("project sync: a fetch that went through stays a fetch that went through (P2-47)", () => {
  it.effect("says fetched, but not read, when Git stops answering after the fetch", () => {
    const f = behind();
    let fetched = false;
    gitHooks.before = (command) => {
      if (command.cwd !== f.b) return;
      if (fetched && command.args[0] === "symbolic-ref") throw new Error("git did not answer");
    };
    gitHooks.after = (command) => {
      if (command.cwd === f.b && command.args[0] === "fetch") fetched = true;
    };
    return withSync(f.b, (sync) =>
      Effect.gen(function* () {
        const answer = yield* sync.fetch(one);
        expect(answer.repositories[0]).toMatchObject({
          path: ".",
          fetch: "ok",
          fetchError: null,
          stateUnread: true,
          unreadDetail: PROJECT_SYNC_FETCHED_UNREAD_DETAIL,
        });
        expect(PROJECT_SYNC_FETCHED_UNREAD_DETAIL).toBe(
          "Fetched, but its state could not be read, so it was not moved.",
        );
        expect(git(f.b, "rev-parse", "refs/remotes/origin/main")).toBe(f.head);
        expect(planProjectSync(answer.repositories, [])[0]).toMatchObject({
          action: "fetch",
          reason: "uncommitted",
          detail: PROJECT_SYNC_FETCHED_UNREAD_DETAIL,
        });
      }),
    );
  });
});

describe("project sync: a nested folder that cannot be read (P2-48)", () => {
  it.effect("skips that folder, says so, and still answers for the others", () => {
    const f = behind();
    // Kept out of the root's own state without a commit of its own.
    NodeFS.appendFileSync(NodePath.join(f.b, ".git", "info", "exclude"), "repositories/\n");
    const nested = NodePath.join(f.b, "repositories", "lib");
    git(f.base, "clone", "-q", f.remote, nested);
    git(nested, "reset", "-q", "--hard", f.was);
    const nestedReal = NodeFS.realpathSync(nested);
    // Git never answers whether the nested folder is a thread's worktree.
    gitHooks.before = (command) => {
      if (command.cwd === nestedReal && command.args.includes("--git-common-dir"))
        throw new Error("git rev-parse timed out");
    };
    return withSync(f.b, (sync) =>
      Effect.gen(function* () {
        const status = yield* sync.status(one);
        expect(status.repositories.map((entry) => entry.path)).toEqual([".", "repositories/lib"]);
        const fetched = yield* sync.fetch(one);
        expect(fetched.repositories.map((entry) => `${entry.path} ${entry.fetch}`)).toEqual([
          ". ok",
          "repositories/lib not-run",
        ]);
        expect(fetched.repositories[1]).toMatchObject({
          stateUnread: true,
          unreadDetail: PROJECT_SYNC_PATH_UNREAD_DETAIL,
        });
        expect(PROJECT_SYNC_PATH_UNREAD_DETAIL).toBe(
          "This folder could not be read, so Sync skipped it.",
        );
        expect(ran("fetch", nestedReal)).toEqual([]);
        expect(planProjectSync(fetched.repositories, [])[1]).toMatchObject({
          action: "none",
          reason: "uncommitted",
          detail: PROJECT_SYNC_PATH_UNREAD_DETAIL,
        });
        // Asked to move it anyway, it is left alone; the root still moves.
        const run = yield* sync.run({
          ...one,
          fetchId: fetched.fetchId,
          fastForward: [
            { path: "repositories/lib", otherBranch: null },
            { path: ".", otherBranch: null },
          ],
          clone: [],
        });
        expect(run.repositories[0]).toMatchObject({
          path: "repositories/lib",
          action: "none",
          moved: 0,
          detail: PROJECT_SYNC_PATH_UNREAD_DETAIL,
        });
        expect(git(nested, "rev-parse", "HEAD")).toBe(f.was);
        expect(run.repositories[1]).toMatchObject({ path: ".", action: "fast-forward" });
      }),
    );
  });
});
