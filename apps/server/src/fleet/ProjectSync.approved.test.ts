// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * Which fetch a move goes by (1390), through the service a window calls: a
 * `run` moves a checkout only to the commit the fetch it names brought, and
 * says what it found when the checkout is not where its own move left it.
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
  PROJECT_SYNC_FETCH_STALE_DETAIL,
  PROJECT_SYNC_FETCHED_UNREAD_DETAIL,
  PROJECT_SYNC_NO_FETCH_DETAIL,
  PROJECT_SYNC_NOT_AS_FETCHED_DETAIL,
  PROJECT_SYNC_ORIGIN_MOVED_DETAIL,
  PROJECT_SYNC_PATH_UNREAD_DETAIL,
  projectSyncMergeOptionsDetail,
  projectSyncObservedDetail,
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
const ran = (verb: string, cwd: string) =>
  recordedGit().filter((command) => command.cwd === cwd && command.args[0] === verb);
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
        expect(ran("merge", f.b)).toEqual([]);
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
  it.effect("does not move the first window to what a second window fetched later", () => {
    const f = behind();
    return withSync(f.b, (sync) =>
      Effect.gen(function* () {
        const first = yield* sync.fetch(one);
        const newer = f.publish();
        const second = yield* sync.fetch(one);
        expect(second.fetchId).not.toBe(first.fetchId);
        expect(second.repositories[0]).toMatchObject({ behind: 2 });
        // The first window approved one commit; origin and this checkout know a newer one.
        const stale = yield* sync.run({
          ...one,
          fetchId: first.fetchId,
          fastForward: root,
          clone: [],
        });
        expect(stale.repositories[0]).toMatchObject({
          action: "none",
          reason: "refused",
          moved: 0,
          detail: PROJECT_SYNC_ORIGIN_MOVED_DETAIL,
        });
        expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
        const moved = yield* sync.run({
          ...one,
          fetchId: second.fetchId,
          fastForward: root,
          clone: [],
        });
        expect(moved.repositories[0]).toMatchObject({ action: "fast-forward", moved: 2 });
        expect(git(f.b, "rev-parse", "HEAD")).toBe(newer);
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

describe("project sync: the fetch is bound to where origin leads (P2-39)", () => {
  it.effect("does not go by a fetch once a rewrite sends origin's address elsewhere", () => {
    const f = behind();
    return withSync(f.b, (sync) =>
      Effect.gen(function* () {
        const fetched = yield* sync.fetch(one);
        // The address in the settings stays; a rewrite rule now leads it to another place,
        // which does not answer.
        git(f.b, "config", `url.${f.base}/elsewhere/.insteadOf`, `${f.base}/`);
        expect(git(f.b, "config", "--get", "remote.origin.url")).toBe(f.remote);
        const run = yield* sync.run({
          ...one,
          fetchId: fetched.fetchId,
          fastForward: root,
          clone: [],
        });
        expect(run.repositories[0]).toMatchObject({
          action: "none",
          reason: "refused",
          moved: 0,
          detail: PROJECT_SYNC_FETCH_STALE_DETAIL,
        });
        expect(PROJECT_SYNC_FETCH_STALE_DETAIL).toBe(
          "The checkout or origin's address changed since the fetch. Sync again.",
        );
        expect(ran("merge", f.b)).toEqual([]);
        expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
      }),
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

describe("project sync: only what the fetch itself brought (P2-42)", () => {
  it.effect("goes by the commit the fetch wrote, never one origin listed before it", () => {
    const f = behind();
    let published: string | null = null;
    // origin moves on between the moment it is first asked and the fetch.
    gitHooks.before = (command) => {
      if (command.cwd === f.b && command.args[0] === "fetch" && published === null)
        published = f.publish();
    };
    return withSync(f.b, (sync) =>
      Effect.gen(function* () {
        const fetched = yield* sync.fetch(one);
        gitHooks.before = null;
        expect(published).not.toBe(null);
        expect(git(f.b, "rev-parse", "refs/remotes/origin/main")).toBe(published);
        expect(fetched.repositories[0]).toMatchObject({ fetch: "ok", behind: 2 });
        expect(fetched.repositories[0]!.upstreamMoved ?? false).toBe(false);
        // Something puts the tracking ref back at the older commit; origin is then out of reach.
        git(f.b, "update-ref", "refs/remotes/origin/main", f.head);
        outage(f);
        const run = yield* sync.run({
          ...one,
          fetchId: fetched.fetchId,
          fastForward: root,
          clone: [],
        });
        expect(run.repositories[0]).toMatchObject({
          action: "none",
          reason: "refused",
          moved: 0,
          detail: PROJECT_SYNC_NOT_AS_FETCHED_DETAIL,
        });
        expect(ran("merge", f.b)).toEqual([]);
        expect(git(f.b, "rev-parse", "HEAD")).toBe(f.was);
      }),
    );
  });
});

describe("project sync: the last reads and the write (P2-43)", () => {
  it.effect("reads branch and commit after the slow status read, right before the merge", () => {
    const f = behind();
    return withSync(f.b, (sync) =>
      Effect.gen(function* () {
        const fetched = yield* sync.fetch(one);
        // The person switches to another clean branch at the same commit while the last
        // status walk runs, once every read that started before it has ended.
        let statuses = 0;
        let open = 0;
        let idle: (() => void) | null = null;
        const quick = (verb: string | undefined) => verb === "symbolic-ref" || verb === "rev-parse";
        gitHooks.before = async (command) => {
          if (command.cwd !== f.b) return;
          if (quick(command.args[0])) open += 1;
          if (command.args[0] !== "status") return;
          statuses += 1;
          if (statuses !== 2) return;
          if (open > 0)
            await new Promise<void>((resolve) => {
              idle = resolve;
            });
          git(f.b, "checkout", "-q", "-b", "other");
        };
        gitHooks.after = (command) => {
          if (command.cwd !== f.b || !quick(command.args[0])) return;
          open -= 1;
          if (open === 0) idle?.();
        };
        const run = yield* sync.run({
          ...one,
          fetchId: fetched.fetchId,
          fastForward: root,
          clone: [],
        });
        expect(statuses).toBeGreaterThanOrEqual(2);
        expect(run.repositories[0]).toMatchObject({
          action: "none",
          reason: "refused",
          moved: 0,
          detail: PROJECT_SYNC_CHANGED_BRANCH_DETAIL,
        });
        expect(ran("merge", f.b)).toEqual([]);
        expect(git(f.b, "rev-parse", "other")).toBe(f.was);
        expect(git(f.b, "rev-parse", "main")).toBe(f.was);
      }),
    );
  });

  /** B fetched and behind; `act` runs at the very entry of the merge command. */
  const atMergeEntry = (act: (f: ReturnType<typeof behind>) => void) => {
    const f = behind();
    return withSync(f.b, (sync) =>
      Effect.gen(function* () {
        const fetched = yield* sync.fetch(one);
        gitHooks.before = (command) => {
          if (command.cwd === f.b && command.args[0] === "merge") act(f);
        };
        const run = yield* sync.run({
          ...one,
          fetchId: fetched.fetchId,
          fastForward: root,
          clone: [],
        });
        expect(ran("merge", f.b)).toHaveLength(1);
        return { f, step: run.repositories[0]! };
      }),
    );
  };

  it.effect("does not call a move its own when another writer got the branch there first", () =>
    Effect.gen(function* () {
      const { f, step } = yield* atMergeEntry((f) => git(f.b, "merge", "-q", "--ff-only", f.head));
      expect(step).toMatchObject({
        action: "fast-forward",
        reason: "behind",
        branch: "main",
        moved: 0,
        downgraded: true,
        detail: projectSyncObservedDetail("main", f.head),
      });
      expect(step.detail).toBe(
        `The checkout changed while Sync was moving it, so Sync does not count this as its own move. It is on main at ${f.head.slice(0, 12)} now. Check it before working in it.`,
      );
      expect(git(f.b, "rev-parse", "HEAD")).toBe(f.head);
    }),
  );

  it.effect("reports the branch it finds when the checkout switched at the merge's entry", () =>
    Effect.gen(function* () {
      const { f, step } = yield* atMergeEntry((f) => git(f.b, "checkout", "-q", "-b", "other"));
      // Git moved the branch that was checked out by then: said as found, not as Sync's move.
      expect(step).toMatchObject({
        action: "fast-forward",
        branch: "other",
        moved: 0,
        downgraded: true,
        detail: projectSyncObservedDetail("other", f.head),
      });
      expect(git(f.b, "rev-parse", "main")).toBe(f.was);
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

  it.effect.each(["--squash", "--no-ff", "--no-commit --squash --autostash --stat"])(
    "moves forward and nothing else with %s in the branch's merge options",
    (options) =>
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

  it.effect.each(["-s ours", "--strategy=ours", "-X theirs", "--quiet", '"--squash"'])(
    "declines before any write with %s in the branch's merge options",
    (options) =>
      Effect.gen(function* () {
        const { f, before, step } = yield* withMergeOptions(options);
        expect(step).toMatchObject({
          action: "none",
          reason: "refused",
          moved: 0,
          downgraded: true,
          detail: projectSyncMergeOptionsDetail("main"),
        });
        expect(step.detail).toBe(
          "The branch main has merge options set in Git (branch.main.mergeOptions) that Sync cannot switch off, so it was not moved.",
        );
        expect(ran("merge", f.b)).toEqual([]);
        expect(snapshot(f.b)).toEqual(before);
      }),
  );
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
