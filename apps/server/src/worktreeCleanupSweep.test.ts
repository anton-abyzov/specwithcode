import { describe, expect, it } from "@effect/vitest";
import {
  RunId,
  type OrchestrationV2ThreadShell,
  type ServerSettings,
  type TerminalSummary,
} from "@specweave-studio/contracts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  createWorktreeSet,
  resolveWorktreeSetRepositories,
  restoreWorktreeSet,
} from "./git/worktreeSetGit.ts";
import { storageCleanupActivityAt, storageCleanupThreadIdle } from "./worktreeCleanupSweep.ts";
import {
  at,
  baseSettings,
  DAY_MS,
  HOUR_MS,
  NOW_MS,
  OFF_PROJECT_ID,
  PROJECT_ID,
  shell,
  sweepFixture,
  sweepTest,
  testLayer,
} from "./worktreeCleanupSweep.testkit.ts";
import { readWorktreeSet, worktreeSetManifestPath } from "./worktreeSet.ts";

describe("a chat counts as quiet", () => {
  const chat = (overrides: Partial<OrchestrationV2ThreadShell>) =>
    shell({ worktreePath: "/worktrees/feature", ...overrides });

  it.each(["idle", "failed", "completed", "cancelled", "interrupted", "rolled_back"] as const)(
    "when its last run is %s",
    (status) => {
      expect(storageCleanupThreadIdle(chat({ status }), NOW_MS)).toBe(true);
    },
  );

  it.each(["waiting", "queued", "preparing", "starting", "running"] as const)(
    "never while it is %s",
    (status) => {
      expect(storageCleanupThreadIdle(chat({ status }), NOW_MS)).toBe(false);
    },
  );

  it("never with a run in progress, a run reading, a request, a background task or a queued turn", () => {
    expect(storageCleanupThreadIdle(chat({ activeRunId: RunId.make("run") }), NOW_MS)).toBe(false);
    expect(storageCleanupThreadIdle(chat({ activityRunStatus: "running" }), NOW_MS)).toBe(false);
    expect(
      storageCleanupThreadIdle(
        chat({ pendingRuntimeRequest: {} as OrchestrationV2ThreadShell["pendingRuntimeRequest"] }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      storageCleanupThreadIdle(
        chat({
          pendingBackgroundTasks: [
            {},
          ] as unknown as OrchestrationV2ThreadShell["pendingBackgroundTasks"],
        }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(storageCleanupThreadIdle(chat({ latestUserMessageAt: at(-1_000) }), NOW_MS)).toBe(false);
    // A chat with no folder has nothing to clean.
    expect(storageCleanupThreadIdle(shell(), NOW_MS)).toBe(false);
  });

  it("reads activity from runs and messages, not metadata refreshes", () => {
    const runTime = at(-3 * DAY_MS);
    expect(
      storageCleanupActivityAt(chat({ latestRunCompletedAt: runTime, updatedAt: at(0) })),
    ).toBe(DateTime.toEpochMillis(runTime));
  });
});

describe("the worktree sweep", () => {
  describe("finished folders", () => {
    sweepTest(
      "removes a folder a worker and its finished sub-chats share, and keeps one while a sub-chat works",
      () =>
        Effect.gen(function* () {
          const f = yield* sweepFixture;
          const done = yield* f.addWorktree("shared-done");
          yield* f.addChat({
            id: "worker-done",
            folder: done,
            branch: "shared-done",
            state: "settled",
          });
          // Sub-chats are open in their own right; their last runs ended.
          yield* f.addChat({
            id: "review-done",
            folder: done,
            branch: "shared-done",
            state: "open",
            parent: "worker-done",
            shell: { status: "completed", latestRunCompletedAt: at(-HOUR_MS) },
          });
          yield* f.addChat({
            id: "review-of-review",
            folder: done,
            branch: "shared-done",
            state: "open",
            parent: "review-done",
            shell: { status: "cancelled" },
          });
          const busy = yield* f.addWorktree("shared-busy");
          yield* f.addChat({
            id: "worker-busy",
            folder: busy,
            branch: "shared-busy",
            state: "archived",
          });
          yield* f.addChat({
            id: "review-busy",
            folder: busy,
            branch: "shared-busy",
            state: "open",
            parent: "worker-busy",
            run: "running",
            shell: { status: "running", activeRunId: RunId.make("run-busy") },
          });
          const waiting = yield* f.addWorktree("shared-waiting");
          yield* f.addChat({
            id: "worker-waiting",
            folder: waiting,
            branch: "shared-waiting",
            state: "settled",
          });
          yield* f.addChat({
            id: "review-waiting",
            folder: waiting,
            branch: "shared-waiting",
            state: "open",
            parent: "worker-waiting",
            run: "waiting",
            shell: { status: "waiting" },
          });

          const result = yield* f.sweep("apply");
          expect(f.reasons(result.items, [done, busy, waiting])).toEqual([
            "remove:resolved",
            "keep:running",
            "keep:running",
          ]);
          expect(f.itemOf(result.items, done)).toMatchObject({
            threadId: "worker-done",
            threadCount: 3,
          });
          expect(f.removed).toEqual([done]);
          expect(yield* f.fs.exists(done)).toBe(false);
          for (const kept of [busy, waiting]) expect(yield* f.fs.exists(kept)).toBe(true);
          // The branch stays so the chat gets its folder back when it resumes.
          expect((yield* f.run(f.repo, ["rev-parse", "--verify", "shared-done"])).exitCode).toBe(0);
        }),
    );

    sweepTest("removes an open chat's merged folder only after six quiet hours", () =>
      Effect.gen(function* () {
        const f = yield* sweepFixture;
        yield* TestClock.setTime(NOW_MS);
        const fiveHours = yield* f.addWorktree("open-5h");
        const sevenHours = yield* f.addWorktree("open-7h");
        for (const [folder, quietHours] of [
          [fiveHours, 5],
          [sevenHours, 7],
        ] as const)
          yield* f.addChat({
            id: `open-${quietHours}h`,
            folder,
            branch: `open-${quietHours}h`,
            state: "open",
            shell: {
              latestRunCompletedAt: at(-quietHours * HOUR_MS),
              // The pull request sync saw the merge.
              pullRequests: [
                { snapshot: { state: "merged" } },
              ] as unknown as OrchestrationV2ThreadShell["pullRequests"],
            },
          });
        const result = yield* f.sweep("apply");
        expect(f.reasons(result.items, [fiveHours, sevenHours])).toEqual([
          "keep:recent",
          "remove:merged",
        ]);
        expect(f.removed).toEqual([sevenHours]);

        // An hour later the other one has been quiet for six hours too.
        yield* TestClock.adjust("61 minutes");
        yield* f.sweep("apply");
        expect(f.removed).toEqual([sevenHours, fiveHours]);
      }),
    );

    sweepTest("asks the host once per branch head, however often sweeps and plans run", () =>
      Effect.gen(function* () {
        const f = yield* sweepFixture;
        yield* TestClock.setTime(NOW_MS);
        const folder = yield* f.addWorktree("open-quiet");
        yield* f.addChat({
          id: "open-quiet",
          folder,
          branch: "open-quiet",
          state: "open",
          shell: { latestRunCompletedAt: at(-7 * HOUR_MS) },
        });
        let asked = 0;
        let answer: "open" | "merged" = "open";
        f.hooks.pullRequest = () => {
          asked += 1;
          return answer;
        };
        const run = yield* f.sweeper;
        expect(f.reasons((yield* run("plan")).items, [folder])).toEqual(["keep:open"]);
        expect(asked).toBe(1);

        // Event sweeps and plans two minutes apart reuse the answer.
        for (let round = 0; round < 5; round += 1) {
          yield* TestClock.adjust("2 minutes");
          yield* run(round % 2 === 0 ? "apply" : "plan");
        }
        expect(asked).toBe(1);

        // The hourly sweep asks again and sees the merge.
        answer = "merged";
        yield* TestClock.adjust("50 minutes");
        expect(f.reasons((yield* run("apply")).items, [folder])).toEqual(["remove:merged"]);
        // Once for the first look, once for the look under the lease is not needed: the head is the same.
        expect(asked).toBe(2);
      }),
    );

    sweepTest(
      "asks the host again at once when the chat's own record says its pull request finished",
      () =>
        Effect.gen(function* () {
          const f = yield* sweepFixture;
          yield* TestClock.setTime(NOW_MS);
          const folder = yield* f.addWorktree("open-synced");
          const chat = {
            id: "open-synced",
            folder,
            branch: "open-synced",
            state: "open" as const,
            shell: { latestRunCompletedAt: at(-7 * HOUR_MS) },
          };
          yield* f.addChat(chat);
          let asked = 0;
          let answer: "open" | "merged" = "open";
          f.hooks.pullRequest = () => {
            asked += 1;
            return answer;
          };
          const run = yield* f.sweeper;
          yield* run("plan");
          expect(asked).toBe(1);

          // The pull request sync saw the merge two minutes later.
          answer = "merged";
          f.setShell("open-synced", {
            pullRequests: [
              { snapshot: { state: "merged" } },
            ] as unknown as OrchestrationV2ThreadShell["pullRequests"],
          });
          yield* TestClock.adjust("2 minutes");
          expect(f.reasons((yield* run("plan")).items, [folder])).toEqual(["remove:merged"]);
          expect(asked).toBe(2);
        }),
    );

    sweepTest("never remembers a host that gave no answer, and keeps the folder", () =>
      Effect.gen(function* () {
        const f = yield* sweepFixture;
        yield* TestClock.setTime(NOW_MS);
        const folder = yield* f.addWorktree("open-offline");
        yield* f.addChat({
          id: "open-offline",
          folder,
          branch: "open-offline",
          state: "open",
          shell: { latestRunCompletedAt: at(-7 * HOUR_MS) },
        });
        let asked = 0;
        f.hooks.pullRequest = () => {
          asked += 1;
          return "error";
        };
        const run = yield* f.sweeper;
        const first = yield* run("apply");
        expect(f.itemOf(first.items, folder)?.action).toBe("keep");
        yield* TestClock.adjust("2 minutes");
        const second = yield* run("apply");
        expect(f.itemOf(second.items, folder)?.action).toBe("keep");
        expect(asked).toBe(2);
        expect(yield* f.fs.exists(folder)).toBe(true);
      }),
    );

    sweepTest(
      "removes a resolved chat's pushed folder with its pull request still open, and keeps unpushed work",
      () =>
        Effect.gen(function* () {
          const f = yield* sweepFixture;
          f.hooks.pullRequest = () => "open";
          const pushed = yield* f.addWorktree("resolved-pushed");
          yield* f.commit(pushed, "pushed.txt");
          yield* f.run(pushed, ["push", "origin", "resolved-pushed"]);
          const unpushed = yield* f.addWorktree("resolved-unpushed");
          yield* f.commit(unpushed, "unpushed.txt");
          const open = yield* f.addWorktree("open-pushed");
          yield* f.commit(open, "open.txt");
          yield* f.run(open, ["push", "origin", "open-pushed"]);
          const off = yield* f.addWorktree("off-pushed");
          yield* f.run(off, ["push", "origin", "off-pushed"]);
          f.hooks.settings = {
            ...baseSettings,
            projectSettingsOverrides: {
              [OFF_PROJECT_ID]: { worktreeCleanup: { mode: "off" } },
            } as ServerSettings["projectSettingsOverrides"],
          };
          yield* f.addChat({
            id: "pushed",
            folder: pushed,
            branch: "resolved-pushed",
            state: "settled",
          });
          yield* f.addChat({
            id: "unpushed",
            folder: unpushed,
            branch: "resolved-unpushed",
            state: "archived",
          });
          yield* f.addChat({ id: "open", folder: open, branch: "open-pushed", state: "open" });
          yield* f.addChat({
            id: "off",
            folder: off,
            branch: "off-pushed",
            state: "settled",
            projectId: OFF_PROJECT_ID,
          });
          const result = yield* f.sweep("apply");
          expect(f.reasons(result.items, [pushed, unpushed, open, off])).toEqual([
            "remove:resolved",
            "keep:unpushed",
            "keep:open",
            "keep:no-rule",
          ]);
          expect(f.removed).toEqual([pushed]);

          // With the switch off, a resolved chat's folder waits for its pull request.
          f.hooks.settings = {
            ...baseSettings,
            storageCleanup: { ...baseSettings.storageCleanup, removeResolvedWorktrees: false },
          };
          const again = yield* f.addWorktree("resolved-switch-off");
          yield* f.addChat({
            id: "switch-off",
            folder: again,
            branch: "resolved-switch-off",
            state: "settled",
          });
          const plan = yield* f.sweep("plan");
          expect(f.reasons(plan.items, [again])).toEqual(["keep:no-rule"]);
        }),
    );

    sweepTest(
      "keeps a folder with a stash entry on its branch or a commit only its own history reaches",
      () =>
        Effect.gen(function* () {
          const f = yield* sweepFixture;
          const stashed = yield* f.addWorktree("stashed");
          yield* f.fs.writeFileString(f.path.join(stashed, "file.txt"), "stashed edit\n");
          yield* f.run(stashed, ["stash", "push", "-m", "keep this"]);
          const reflog = yield* f.addWorktree("reflog-only");
          yield* f.commit(reflog, "lost.txt");
          // The commit is now reachable only from this worktree's HEAD reflog.
          yield* f.run(reflog, ["reset", "--hard", "HEAD~1"]);
          const plain = yield* f.addWorktree("plain");
          yield* f.addChat({ id: "stashed", folder: stashed, branch: "stashed", state: "settled" });
          yield* f.addChat({
            id: "reflog",
            folder: reflog,
            branch: "reflog-only",
            state: "settled",
          });
          yield* f.addChat({ id: "plain", folder: plain, branch: "plain", state: "settled" });
          const result = yield* f.sweep("apply");
          expect(f.reasons(result.items, [stashed, reflog, plain])).toEqual([
            "keep:stash",
            "keep:unpushed",
            "remove:resolved",
          ]);
          expect(f.removed).toEqual([plain]);
        }),
    );

    sweepTest(
      "keeps a folder whose registration Git reused for another folder and runs no Git command in it",
      () =>
        Effect.gen(function* () {
          const f = yield* sweepFixture;
          const stale = f.path.join(f.worktreesRoot, "a", "work");
          yield* f.run(f.repo, ["worktree", "add", "-b", "first", stale]);
          // An outside script removed the registration and left the files.
          yield* f.fs.remove(f.path.join(f.repo, ".git", "worktrees", "work"), { recursive: true });
          // Git reuses the free id for the next worktree with the same folder name.
          const other = f.path.join(f.worktreesRoot, "b", "work");
          yield* f.run(f.repo, ["worktree", "add", "-b", "second", other]);
          yield* f.addChat({ id: "stale", folder: stale, branch: "first", state: "settled" });
          const result = yield* f.sweep("apply");
          expect(f.itemOf(result.items, stale)).toMatchObject({
            action: "keep",
            reason: "broken-registration",
          });
          expect(f.removed).toEqual([]);
          expect(f.touched.filter((cwd) => cwd.startsWith(stale))).toEqual([]);
          // The other chat's checkout and branch are untouched.
          expect(yield* f.fs.exists(f.path.join(other, "file.txt"))).toBe(true);
          expect((yield* f.run(other, ["branch", "--show-current"])).stdout.trim()).toBe("second");
        }),
    );

    sweepTest(
      "copies ignored media to evidence before removing a folder, and keeps one with a .env",
      () =>
        Effect.gen(function* () {
          const f = yield* sweepFixture;
          yield* f.fs.writeFileString(
            f.path.join(f.repo, ".git", "info", "exclude"),
            "*.png\n*.mp4\nshots/\n.env\nnode_modules/\n",
          );
          const media = yield* f.addWorktree("with-media");
          yield* f.fs.makeDirectory(f.path.join(media, "shots"));
          yield* f.fs.writeFileString(f.path.join(media, "shots", "before.png"), "png bytes");
          yield* f.fs.writeFileString(f.path.join(media, "demo.mp4"), "mp4 bytes, longer");
          yield* f.fs.makeDirectory(f.path.join(media, "node_modules", "dep"), { recursive: true });
          yield* f.fs.writeFileString(f.path.join(media, "node_modules", "dep", "logo.png"), "dep");
          const secret = yield* f.addWorktree("with-env");
          yield* f.fs.writeFileString(f.path.join(secret, ".env"), "TOKEN=x\n");
          yield* f.addChat({ id: "media", folder: media, branch: "with-media", state: "settled" });
          yield* f.addChat({ id: "secret", folder: secret, branch: "with-env", state: "settled" });
          yield* TestClock.setTime(NOW_MS);
          const result = yield* f.sweep("apply");
          expect(f.reasons(result.items, [media, secret])).toEqual([
            "remove:resolved",
            "keep:ignored-files",
          ]);
          expect(yield* f.fs.exists(media)).toBe(false);
          expect(yield* f.fs.readFileString(f.path.join(secret, ".env"))).toBe("TOKEN=x\n");
          const evidence = f.path.join(
            f.config.baseDir,
            "evidence",
            "removed-worktrees",
            "with-media-20260610-120000",
          );
          expect(yield* f.fs.readFileString(f.path.join(evidence, "shots", "before.png"))).toBe(
            "png bytes",
          );
          expect(yield* f.fs.readFileString(f.path.join(evidence, "demo.mp4"))).toBe(
            "mp4 bytes, longer",
          );
          // Dependency installs are rebuilt, not copied.
          expect(yield* f.fs.exists(f.path.join(evidence, "node_modules"))).toBe(false);
          const manifest = JSON.parse(
            yield* f.fs.readFileString(f.path.join(evidence, "manifest.json")),
          ) as {
            readonly folder: string;
            readonly files: ReadonlyArray<{ readonly path: string }>;
          };
          expect(manifest.folder).toBe(media);
          expect(manifest.files.map((file) => file.path).toSorted()).toEqual(
            ["demo.mp4", f.path.join("shots", "before.png")].toSorted(),
          );
        }),
    );

    sweepTest(
      "keeps a folder a process, terminal or session works in, and every folder when processes cannot be read",
      () =>
        Effect.gen(function* () {
          const f = yield* sweepFixture;
          const process = yield* f.addWorktree("process-inside");
          const terminal = yield* f.addWorktree("terminal-inside");
          const session = yield* f.addWorktree("session-inside");
          yield* f.addChat({
            id: "process",
            folder: process,
            branch: "process-inside",
            state: "settled",
          });
          yield* f.addChat({
            id: "terminal",
            folder: terminal,
            branch: "terminal-inside",
            state: "settled",
          });
          yield* f.addChat({
            id: "session",
            folder: session,
            branch: "session-inside",
            state: "settled",
          });
          f.hooks.processCwds = [f.path.join(process, "apps")];
          f.hooks.terminals = [
            {
              threadId: "someone-else",
              terminalId: "term-1",
              cwd: f.path.join(terminal, "src"),
              worktreePath: null,
              status: "running",
            } as unknown as TerminalSummary,
          ];
          yield* f.sql`INSERT INTO orchestration_v2_projection_provider_sessions VALUES (${JSON.stringify(
            { cwd: session },
          )}, 'running', 'other-thread')`;
          const result = yield* f.sweep("apply");
          expect(f.reasons(result.items, [process, terminal, session])).toEqual([
            "keep:in-use",
            "keep:in-use",
            "keep:in-use",
          ]);
          expect(f.removed).toEqual([]);

          f.hooks.processCwds = null;
          f.hooks.terminals = [];
          yield* f.sql`DELETE FROM orchestration_v2_projection_provider_sessions`;
          const unknown = yield* f.sweep("apply");
          expect(f.reasons(unknown.items, [process, terminal, session])).toEqual([
            "keep:unknown",
            "keep:unknown",
            "keep:unknown",
          ]);
          expect(f.removed).toEqual([]);
        }),
    );

    sweepTest(
      "plans without removing anything, and the sweep then removes what the plan listed",
      () =>
        Effect.gen(function* () {
          const f = yield* sweepFixture;
          const finished = yield* f.addWorktree("finished");
          yield* f.fs.writeFileString(f.path.join(finished, "big.bin"), "x".repeat(64 * 1024));
          yield* f.run(finished, ["add", "big.bin"]);
          yield* f.run(finished, ["commit", "-m", "big"]);
          yield* f.run(finished, ["push", "origin", "finished"]);
          const edited = yield* f.addWorktree("edited");
          yield* f.fs.writeFileString(f.path.join(edited, "file.txt"), "uncommitted\n");
          yield* f.addChat({
            id: "finished",
            folder: finished,
            branch: "finished",
            state: "archived",
          });
          yield* f.addChat({ id: "edited", folder: edited, branch: "edited", state: "settled" });
          // A chat whose folder is already gone has no row.
          yield* f.addChat({
            id: "gone",
            folder: f.path.join(f.worktreesRoot, "repo", "gone"),
            branch: "gone",
            state: "settled",
          });
          const plan = yield* f.sweep("plan");
          expect(f.removed).toEqual([]);
          for (const folder of [finished, edited]) expect(yield* f.fs.exists(folder)).toBe(true);
          expect(plan.items.map((item) => item.path)).toEqual([edited, finished]);
          // Its pull request merged, but its own commit is not on main: it goes as
          // resolved, since that commit is pushed.
          expect(f.reasons(plan.items, [finished, edited])).toEqual([
            "remove:resolved",
            "keep:changes",
          ]);
          expect(plan.complete).toBe(true);
          expect(f.itemOf(plan.items, finished)?.bytes).toBeGreaterThan(64 * 1024);
          expect(f.itemOf(plan.items, edited)?.detail).toContain("file");

          const result = yield* f.sweep("apply");
          expect(result.items.map((item) => [item.path, item.action, item.reason])).toEqual(
            plan.items.map((item) => [item.path, item.action, item.reason]),
          );
          expect(f.removed).toEqual(
            plan.items.filter((item) => item.action === "remove").map((item) => item.path),
          );
          expect(result.removed.map((entry) => entry.path)).toEqual([finished]);
        }),
    );

    sweepTest(
      "removes a two-repository folder member by member, deepest first, and a resumed chat gets both back",
      () =>
        Effect.gen(function* () {
          const f = yield* sweepFixture;
          const api = yield* f.makeRepo(f.path.join("repo", "repositories", "acme", "api"));
          yield* f.fs.writeFileString(
            f.path.join(f.repo, ".git", "info", "exclude"),
            "repositories/\n",
          );
          const members = yield* resolveWorktreeSetRepositories(
            f.repo,
            [],
            [".", "repositories/acme/api"],
          );
          const folder = f.path.join(f.worktreesRoot, "repo", "set-feature");
          yield* createWorktreeSet({
            folder,
            members,
            branch: "feature/set",
            projectRoot: f.repo,
            baseRef: "main",
            startFromOrigin: false,
            submodules: null,
          });
          const nested = f.path.join(folder, "repositories", "acme", "api");
          expect(yield* f.fs.readFileString(f.path.join(nested, "file.txt"))).toContain("api");
          yield* f.addChat({ id: "set", folder, branch: "feature/set", state: "settled" });

          const result = yield* f.sweep("apply");
          expect(f.reasons(result.items, [folder])).toEqual(["remove:resolved"]);
          expect(f.removed).toEqual([nested, folder]);
          expect(yield* f.fs.exists(folder)).toBe(false);
          // Branches and the manifest stay.
          const manifest = yield* readWorktreeSet(folder);
          expect(manifest?.members.map((member) => member.relativePath)).toEqual([
            "",
            f.path.join("repositories", "acme", "api"),
          ]);
          expect(yield* f.fs.exists(worktreeSetManifestPath(folder, f.path))).toBe(true);
          for (const repository of [f.repo, api])
            expect(
              (yield* f.run(repository, ["rev-parse", "--verify", "refs/heads/feature/set"]))
                .exitCode,
            ).toBe(0);

          const restored = yield* restoreWorktreeSet({
            folder,
            members: manifest!.members,
            branch: "feature/set",
          });
          expect(restored._tag).toBe("Restored");
          expect(yield* f.fs.readFileString(f.path.join(folder, "file.txt"))).toBe("repo\n");
          expect(yield* f.fs.readFileString(f.path.join(nested, "file.txt"))).toContain("api");
          expect((yield* f.run(nested, ["branch", "--show-current"])).stdout.trim()).toBe(
            "feature/set",
          );
        }),
    );

    sweepTest(
      "keeps a set folder whose member is registered with another repository than the manifest names",
      () =>
        Effect.gen(function* () {
          const f = yield* sweepFixture;
          const other = yield* f.makeRepo("other");
          const folder = f.path.join(f.worktreesRoot, "repo", "set-mixed");
          yield* createWorktreeSet({
            folder,
            members: yield* resolveWorktreeSetRepositories(f.repo, [], ["."]),
            branch: "feature/mixed",
            projectRoot: f.repo,
            baseRef: "main",
            startFromOrigin: false,
            submodules: null,
          });
          // The manifest names `other` for the folder's member; Git says `repo`.
          const manifestFile = worktreeSetManifestPath(folder, f.path);
          const text = yield* f.fs.readFileString(manifestFile);
          yield* f.fs.writeFileString(
            manifestFile,
            text.split(JSON.stringify(f.repo)).join(JSON.stringify(other)),
          );
          yield* f.addChat({ id: "mixed", folder, branch: "feature/mixed", state: "settled" });
          const result = yield* f.sweep("apply");
          expect(f.reasons(result.items, [folder])).toEqual(["keep:broken-registration"]);
          expect(f.removed).toEqual([]);
          expect(yield* f.fs.exists(folder)).toBe(true);
        }),
    );

    // Windows cannot list process working folders, so the sweep keeps every folder there.
    it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
      "reads this machine's processes and removes a finished folder no process works in",
      () =>
        Effect.gen(function* () {
          const f = yield* sweepFixture;
          f.hooks.processCwds = "system";
          const finished = yield* f.addWorktree("system-processes");
          yield* f.addChat({
            id: "system",
            folder: finished,
            branch: "system-processes",
            state: "settled",
          });
          const result = yield* f.sweep("apply");
          expect(f.reasons(result.items, [finished])).toEqual(["remove:resolved"]);
          expect(yield* f.fs.exists(finished)).toBe(false);
        }).pipe(Effect.provide(testLayer)),
    );

    sweepTest("removes a deleted chat's folder once its cleanup settled, and no other", () =>
      Effect.gen(function* () {
        const f = yield* sweepFixture;
        f.hooks.settings = {
          ...baseSettings,
          storageCleanup: { ...baseSettings.storageCleanup, worktreeOnDelete: true },
        };
        const payload = (id: string, folder: string, branch: string) =>
          JSON.stringify({
            id,
            projectId: PROJECT_ID,
            title: id,
            providerInstanceId: "codex",
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch,
            worktreePath: folder,
            activeProviderThreadId: null,
            lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
            forkedFrom: null,
            createdBy: "user",
            creationSource: "web",
            createdAt: "2026-05-10T12:00:00.000Z",
            updatedAt: "2026-06-09T12:00:00.000Z",
            archivedAt: null,
            deletedAt: "2026-06-09T12:00:00.000Z",
          });
        const deleted = Effect.fn("test.deleted")(function* (
          id: string,
          folder: string,
          branch: string,
          outbox: string,
        ) {
          yield* f.sql`INSERT INTO orchestration_v2_projection_threads VALUES (${id}, ${payload(
            id,
            folder,
            branch,
          )}, '2026-06-09T12:00:00.000Z', NULL)`;
          yield* f.sql`INSERT INTO orchestration_v2_effect_outbox VALUES (${id}, ${outbox})`;
        });
        const pending = yield* f.addWorktree("deleted-pending");
        yield* deleted("deleted-pending", pending, "deleted-pending", "pending");
        const settled = yield* f.addWorktree("deleted-settled");
        yield* deleted("deleted-settled", settled, "deleted-settled", "succeeded");
        // A live chat records the third folder too, so its deletion decides nothing.
        const shared = yield* f.addWorktree("deleted-shared");
        yield* deleted("deleted-shared", shared, "deleted-shared", "succeeded");
        yield* f.addChat({ id: "live", folder: shared, branch: "deleted-shared", state: "open" });
        f.hooks.pullRequest = () => null;

        const result = yield* f.sweep("apply");
        expect(f.reasons(result.items, [pending, settled, shared])).toEqual([
          "keep:running",
          "remove:deleted",
          "keep:open",
        ]);
        expect(f.itemOf(result.items, settled)).toMatchObject({
          threadId: "deleted-settled",
          threadCount: 1,
        });
        expect(f.removed).toEqual([settled]);
      }),
    );

    sweepTest("keeps a folder whose media could not be copied to evidence", () =>
      Effect.gen(function* () {
        const f = yield* sweepFixture;
        yield* f.fs.writeFileString(f.path.join(f.repo, ".git", "info", "exclude"), "*.png\n");
        const media = yield* f.addWorktree("copy-fails");
        yield* f.fs.writeFileString(f.path.join(media, "shot.png"), "png bytes");
        yield* f.addChat({
          id: "copy-fails",
          folder: media,
          branch: "copy-fails",
          state: "settled",
        });
        // The evidence folder cannot be made: a file has its name.
        yield* f.fs.makeDirectory(f.path.join(f.config.baseDir, "evidence"), { recursive: true });
        yield* f.fs.writeFileString(
          f.path.join(f.config.baseDir, "evidence", "removed-worktrees"),
          "",
        );
        const result = yield* f.sweep("apply");
        expect(f.reasons(result.items, [media])).toEqual(["keep:media"]);
        expect(f.removed).toEqual([]);
        expect(yield* f.fs.readFileString(f.path.join(media, "shot.png"))).toBe("png bytes");
      }),
    );
  });
});
