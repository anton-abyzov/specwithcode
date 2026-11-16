import { describe, expect } from "@effect/vitest";
import type { OrchestrationV2ThreadShell, TerminalSummary } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { createWorktreeSet, resolveWorktreeSetRepositories } from "./git/worktreeSetGit.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { reflogOnlyCommits } from "./worktreeCleanupSweep.ts";
import { at, HOUR_MS, NOW_MS, sweepFixture, sweepTest } from "./worktreeCleanupSweep.testkit.ts";
import { worktreeSetManifestPath } from "./worktreeSet.ts";

type Fixture = Effect.Success<typeof sweepFixture>;

/** A worktree set of `repo` (the folder) and `repo/repositories/acme/api` (nested). */
const makeSet = Effect.fn("test.makeSet")(function* (f: Fixture, name: string) {
  yield* f.makeRepo(f.path.join("repo", "repositories", "acme", "api"));
  yield* f.fs.writeFileString(f.path.join(f.repo, ".git", "info", "exclude"), "repositories/\n");
  const folder = f.path.join(f.worktreesRoot, "repo", name);
  yield* createWorktreeSet({
    folder,
    members: yield* resolveWorktreeSetRepositories(f.repo, [], [".", "repositories/acme/api"]),
    branch: `feature/${name}`,
    projectRoot: f.repo,
    baseRef: "main",
    startFromOrigin: false,
    submodules: null,
  });
  return { folder, nested: f.path.join(folder, "repositories", "acme", "api") };
});

/** A set of `repo` alone, whose manifest then lists one more member of `repo`. */
const setWithExtraMember = Effect.fn("test.setWithExtraMember")(function* (
  f: Fixture,
  name: string,
  relativePath: string,
) {
  const folder = f.path.join(f.worktreesRoot, "repo", name);
  yield* createWorktreeSet({
    folder,
    members: yield* resolveWorktreeSetRepositories(f.repo, [], ["."]),
    branch: `feature/${name}`,
    projectRoot: f.repo,
    baseRef: "main",
    startFromOrigin: false,
    submodules: null,
  });
  const manifestFile = worktreeSetManifestPath(folder, f.path);
  const manifest = JSON.parse(yield* f.fs.readFileString(manifestFile)) as {
    members: Array<{ repository: string; relativePath: string }>;
  };
  manifest.members.push({ repository: f.repo, relativePath });
  yield* f.fs.writeFileString(manifestFile, JSON.stringify(manifest));
  return folder;
});

/** Runs `step` on the given settings read only (1 is the first look under the lease). */
const onRead = <E>(f: Fixture, nth: number, step: Effect.Effect<void, E>) => {
  let reads = 0;
  f.hooks.onSettingsRead = () => {
    reads += 1;
    return reads === nth ? step.pipe(Effect.orDie) : Effect.void;
  };
};

describe("the worktree sweep keeps what it cannot prove safe", () => {
  sweepTest("removes members without force and keeps what Git leaves behind", () =>
    Effect.gen(function* () {
      const f = yield* sweepFixture;
      const { folder, nested } = yield* makeSet(f, "set-plain");
      yield* f.addChat({ id: "set", folder, branch: "feature/set-plain", state: "settled" });
      const result = yield* f.sweep("apply");
      expect(f.reasons(result.items, [folder])).toEqual(["remove:resolved"]);
      expect(f.removed).toEqual([nested, folder]);
      expect(f.removeCalls).toHaveLength(2);
      for (const input of f.removeCalls) {
        expect(input.force === undefined || input.force === false).toBe(true);
        expect(input.keepLeftBehind).toBe(true);
      }
    }),
  );

  sweepTest("keeps a set whose member is a symbolic link to another chat's worktree", () =>
    Effect.gen(function* () {
      const f = yield* sweepFixture;
      const victim = yield* f.addWorktree("victim-linked");
      yield* f.addChat({ id: "victim", folder: victim, branch: "victim-linked", state: "open" });
      const folder = yield* setWithExtraMember(f, "set-linked", "linked");
      yield* f.fs.symlink(victim, f.path.join(folder, "linked"));
      yield* f.addChat({ id: "set", folder, branch: "feature/set-linked", state: "settled" });
      const result = yield* f.sweep("apply");
      expect(f.reasons(result.items, [folder])).toEqual(["keep:broken-registration"]);
      expect(f.removed).toEqual([]);
      expect(yield* f.fs.exists(f.path.join(victim, "file.txt"))).toBe(true);
    }),
  );

  sweepTest("keeps a set whose manifest names a member outside its folder", () =>
    Effect.gen(function* () {
      const f = yield* sweepFixture;
      const victim = yield* f.addWorktree("victim-outside");
      yield* f.addChat({ id: "victim", folder: victim, branch: "victim-outside", state: "open" });
      const folder = yield* setWithExtraMember(f, "set-climbs", "../victim-outside");
      yield* f.addChat({ id: "set", folder, branch: "feature/set-climbs", state: "settled" });
      const result = yield* f.sweep("apply");
      expect(f.reasons(result.items, [folder])).toEqual(["keep:broken-registration"]);
      expect(f.removed).toEqual([]);
      expect(yield* f.fs.exists(f.path.join(victim, "file.txt"))).toBe(true);
    }),
  );

  sweepTest("keeps a folder when a repository appears in node_modules before removal", () =>
    Effect.gen(function* () {
      const f = yield* sweepFixture;
      yield* f.fs.writeFileString(
        f.path.join(f.repo, ".git", "info", "exclude"),
        "node_modules/\n",
      );
      const folder = yield* f.addWorktree("late-clone");
      yield* f.fs.makeDirectory(f.path.join(folder, "node_modules", "dep"), { recursive: true });
      yield* f.fs.writeFileString(f.path.join(folder, "node_modules", "dep", "index.js"), "1\n");
      yield* f.addChat({ id: "late", folder, branch: "late-clone", state: "settled" });
      const clone = f.path.join(folder, "node_modules", "cloned");
      onRead(
        f,
        1,
        Effect.gen(function* () {
          yield* f.fs.makeDirectory(clone);
          yield* f.run(clone, ["init", "-b", "main"]);
          yield* f.fs.writeFileString(f.path.join(clone, "only-here.txt"), "work\n");
          yield* f.run(clone, ["add", "."]);
          yield* f.run(clone, [
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.invalid",
            "commit",
            "-m",
            "only here",
          ]);
        }),
      );
      const result = yield* f.sweep("apply");
      expect(f.itemOf(result.items, folder)?.action).toBe("keep");
      expect(f.removed).toEqual([]);
      expect(yield* f.fs.exists(f.path.join(clone, "only-here.txt"))).toBe(true);
    }),
  );

  sweepTest("keeps a folder that changed while its media was copied, and no evidence", () =>
    Effect.gen(function* () {
      const f = yield* sweepFixture;
      yield* f.fs.writeFileString(f.path.join(f.repo, ".git", "info", "exclude"), "*.png\n.env\n");
      const folder = yield* f.addWorktree("copy-race");
      yield* f.fs.writeFileString(f.path.join(folder, "shot.png"), "png bytes");
      yield* f.addChat({ id: "race", folder, branch: "copy-race", state: "settled" });
      // The second look is the one right after the copy.
      onRead(f, 2, f.fs.writeFileString(f.path.join(folder, ".env"), "TOKEN=x\n"));
      const result = yield* f.sweep("apply");
      expect(f.reasons(result.items, [folder])).toEqual(["keep:unknown"]);
      expect(f.itemOf(result.items, folder)?.detail).toContain("media was copied");
      expect(f.removed).toEqual([]);
      expect(yield* f.fs.readFileString(f.path.join(folder, ".env"))).toBe("TOKEN=x\n");
      const evidence = f.path.join(f.config.baseDir, "evidence", "removed-worktrees");
      const left = (yield* f.fs.exists(evidence)) ? yield* f.fs.readDirectory(evidence) : [];
      expect(left).toEqual([]);
    }),
  );

  sweepTest("keeps a resolved chat's folder while a fork of it is open there", () =>
    Effect.gen(function* () {
      const f = yield* sweepFixture;
      f.hooks.pullRequest = () => "open";
      const folder = yield* f.addWorktree("forked");
      yield* f.addChat({ id: "parent", folder, branch: "forked", state: "settled" });
      yield* f.addChat({
        id: "fork",
        folder,
        branch: "forked",
        state: "open",
        parent: "parent",
        fork: true,
      });
      const result = yield* f.sweep("apply");
      expect(f.reasons(result.items, [folder])).toEqual(["keep:open"]);
      expect(f.removed).toEqual([]);
    }),
  );

  sweepTest("removes an archived chat's finished folder", () =>
    Effect.gen(function* () {
      const f = yield* sweepFixture;
      const folder = yield* f.addWorktree("archived-done");
      yield* f.addChat({ id: "archived", folder, branch: "archived-done", state: "archived" });
      const result = yield* f.sweep("apply");
      expect(f.reasons(result.items, [folder])).toEqual(["remove:resolved"]);
      expect(yield* f.fs.exists(folder)).toBe(false);
    }),
  );

  sweepTest("keeps a folder with more media files than are copied automatically", () =>
    Effect.gen(function* () {
      const f = yield* sweepFixture;
      yield* f.fs.writeFileString(f.path.join(f.repo, ".git", "info", "exclude"), "shots/\n");
      const folder = yield* f.addWorktree("many-shots");
      yield* f.fs.makeDirectory(f.path.join(folder, "shots"));
      for (let index = 0; index < 2_001; index += 1)
        yield* f.fs.writeFileString(f.path.join(folder, "shots", `shot-${index}.png`), "png");
      yield* f.addChat({ id: "many", folder, branch: "many-shots", state: "settled" });
      const result = yield* f.sweep("apply");
      expect(f.reasons(result.items, [folder])).toEqual(["keep:media"]);
      expect(f.removed).toEqual([]);
    }),
  );

  sweepTest("keeps a folder with a checked-out submodule", () =>
    Effect.gen(function* () {
      const f = yield* sweepFixture;
      const sub = yield* f.makeRepo("sub");
      const folder = yield* f.addWorktree("with-submodule");
      yield* f.run(folder, ["-c", "protocol.file.allow=always", "submodule", "add", sub, "sub"]);
      yield* f.run(folder, ["commit", "-m", "submodule"]);
      yield* f.run(folder, ["push", "origin", "with-submodule"]);
      yield* f.addChat({ id: "sub", folder, branch: "with-submodule", state: "settled" });
      const result = yield* f.sweep("apply");
      expect(f.reasons(result.items, [folder])).toEqual(["keep:nested-work"]);
      expect(f.removed).toEqual([]);
      expect(yield* f.fs.exists(f.path.join(folder, "sub", "file.txt"))).toBe(true);
    }),
  );

  sweepTest("stops between members when the folder's use changes, and says so", () =>
    Effect.gen(function* () {
      const f = yield* sweepFixture;
      const { folder, nested } = yield* makeSet(f, "set-reused");
      yield* f.addChat({ id: "set", folder, branch: "feature/set-reused", state: "settled" });
      // Reads: 1 the look under the lease, 2 before the nested member, 3 before the folder.
      onRead(
        f,
        3,
        Effect.sync(() => {
          f.hooks.terminals = [
            {
              threadId: "someone",
              terminalId: "term-1",
              cwd: folder,
              worktreePath: null,
              status: "running",
            } as unknown as TerminalSummary,
          ];
        }),
      );
      const result = yield* f.sweep("apply");
      expect(f.reasons(result.items, [folder])).toEqual(["keep:unknown"]);
      expect(f.itemOf(result.items, folder)?.detail).toContain(
        "It changed, or its use did, right before removal after 1 of its worktrees",
      );
      expect(f.removed).toEqual([nested]);
      expect(result.removed).toEqual([]);
      expect(yield* f.fs.exists(f.path.join(folder, "file.txt"))).toBe(true);
    }),
  );

  sweepTest("stops when a file appears in a member while an earlier one is removed", () =>
    Effect.gen(function* () {
      const f = yield* sweepFixture;
      const { folder, nested } = yield* makeSet(f, "set-late-file");
      yield* f.fs.writeFileString(
        f.path.join(f.repo, ".git", "info", "exclude"),
        "repositories/\n.env\n",
      );
      yield* f.addChat({ id: "set", folder, branch: "feature/set-late-file", state: "settled" });
      // Reads: 1 the look under the lease, 2 before the nested member, 3 before the folder.
      // Git would delete the ignored file without asking.
      onRead(f, 3, f.fs.writeFileString(f.path.join(folder, ".env"), "TOKEN=only-here\n"));
      const result = yield* f.sweep("apply");
      expect(f.reasons(result.items, [folder])).toEqual(["keep:unknown"]);
      expect(f.itemOf(result.items, folder)?.detail).toContain("after 1 of its worktrees");
      expect(f.removed).toEqual([nested]);
      expect(yield* f.fs.readFileString(f.path.join(folder, ".env"))).toBe("TOKEN=only-here\n");
    }),
  );

  sweepTest("keeps an open chat's folder when its closed pull request is open again", () =>
    Effect.gen(function* () {
      const f = yield* sweepFixture;
      yield* TestClock.setTime(NOW_MS);
      const folder = yield* f.addWorktree("reopened");
      yield* f.commit(folder, "work.txt");
      yield* f.run(folder, ["push", "origin", "reopened"]);
      yield* f.addChat({
        id: "reopened",
        folder,
        branch: "reopened",
        state: "open",
        shell: { latestRunCompletedAt: at(-7 * HOUR_MS) },
      });
      const answers: Array<"closed" | "open"> = ["closed", "open"];
      let asked = 0;
      f.hooks.pullRequest = () => answers[Math.min(asked++, answers.length - 1)]!;
      const result = yield* f.sweep("apply");
      expect(asked).toBe(2);
      expect(f.itemOf(result.items, folder)?.action).toBe("keep");
      expect(f.removed).toEqual([]);
      expect(yield* f.fs.exists(folder)).toBe(true);
    }),
  );

  sweepTest("plans without fetching, and fetches the default branch before removing", () =>
    Effect.gen(function* () {
      const f = yield* sweepFixture;
      yield* TestClock.setTime(NOW_MS);
      const folder = yield* f.addWorktree("merged-open");
      yield* f.commit(folder, "merged.txt");
      yield* f.run(folder, ["push", "origin", "merged-open"]);
      yield* f.addChat({
        id: "merged",
        folder,
        branch: "merged-open",
        state: "open",
        shell: {
          latestRunCompletedAt: at(-7 * HOUR_MS),
          pullRequests: [
            { snapshot: { state: "merged" } },
          ] as unknown as OrchestrationV2ThreadShell["pullRequests"],
        },
      });
      yield* f.sweep("plan");
      expect(f.gitCalls).toContain("resolveDefaultBranchName");
      expect(f.gitCalls).not.toContain("fetchRemoteTrackingBranch");
      yield* f.sweep("apply");
      expect(f.gitCalls).toContain("fetchRemoteTrackingBranch");
    }),
  );

  sweepTest("leaves the registration of a worktree whose folder is missing", () =>
    Effect.gen(function* () {
      const f = yield* sweepFixture;
      // A worktree on a drive that is not mounted looks the same to Git.
      const unmounted = yield* f.addWorktree("unmounted");
      yield* f.fs.remove(unmounted, { recursive: true });
      const folder = yield* f.addWorktree("finished-beside");
      yield* f.addChat({ id: "beside", folder, branch: "finished-beside", state: "settled" });
      const result = yield* f.sweep("apply");
      expect(f.reasons(result.items, [folder])).toEqual(["remove:resolved"]);
      expect(yield* f.fs.exists(f.path.join(f.repo, ".git", "worktrees", "unmounted"))).toBe(true);
    }),
  );

  sweepTest("does not count media copied to evidence as space freed", () =>
    Effect.gen(function* () {
      const f = yield* sweepFixture;
      yield* f.fs.writeFileString(f.path.join(f.repo, ".git", "info", "exclude"), "*.png\n");
      const folder = yield* f.addWorktree("big-shot");
      yield* f.fs.writeFileString(f.path.join(folder, "shot.png"), "x".repeat(256 * 1024));
      yield* f.addChat({ id: "big", folder, branch: "big-shot", state: "settled" });
      const plan = yield* f.sweep("plan");
      expect(f.reasons(plan.items, [folder])).toEqual(["remove:resolved"]);
      const bytes = f.itemOf(plan.items, folder)?.bytes;
      expect(bytes).not.toBeNull();
      expect(bytes!).toBeLessThan(64 * 1024);
    }),
  );

  sweepTest("counts a detached HEAD's own commits when its reflog is empty", () =>
    Effect.gen(function* () {
      const f = yield* sweepFixture;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const clean = yield* f.addWorktree("reflog-clean");
      expect(yield* reflogOnlyCommits(git, clean)).toBe(0);
      const detached = yield* f.addWorktree("reflog-detached");
      yield* f.run(detached, ["checkout", "--detach"]);
      yield* f.commit(detached, "detached.txt");
      const log = (yield* f.run(detached, ["rev-parse", "--git-path", "logs/HEAD"])).stdout.trim();
      yield* f.fs.writeFileString(f.path.resolve(detached, log), "");
      expect(yield* reflogOnlyCommits(git, detached)).toBe(1);
    }),
  );
});
