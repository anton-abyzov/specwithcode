// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - builds a real app folder in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerSettings, StorageHomeUsage } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as EffectVitest from "@effect/vitest";
import { afterEach, describe, expect } from "vite-plus/test";

import { HOME_USAGE_STATE_FILE, makeHomeUsageGuard } from "./guard.ts";

const temps: Array<string> = [];
afterEach(() => {
  for (const dir of temps.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;

const settings = (homeSizeWarningGb: number | null, scratchAfterDays: number | null = 14) =>
  ({ storageCleanup: { homeSizeWarningGb, scratchAfterDays } }) as unknown as ServerSettings;

/** `<tmp>/.specwithcode/m4` with a scratch folder holding an old probe and a fresh one. */
function appFolder() {
  const user = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "guard-")));
  temps.push(user);
  const home = NodePath.join(user, ".specwithcode");
  const baseDir = NodePath.join(home, "m4");
  const stateDir = NodePath.join(baseDir, "userdata");
  const scratch = NodePath.join(baseDir, "scratch");
  for (const dir of [stateDir, NodePath.join(baseDir, "worktrees", "repo"), scratch])
    NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(baseDir, "worktrees", "repo", ".git"), "gitdir: x");
  NodeFS.writeFileSync(NodePath.join(stateDir, "statev2.sqlite"), Buffer.alloc(8192));
  NodeFS.mkdirSync(NodePath.join(home, "backups"));
  NodeFS.writeFileSync(NodePath.join(home, "backups", "copy"), Buffer.alloc(16384));
  for (const name of ["old-probe", "fresh-run", "chat-thread"]) {
    NodeFS.mkdirSync(NodePath.join(scratch, name));
    NodeFS.writeFileSync(NodePath.join(scratch, name, "out.log"), "x");
  }
  return { user, home, baseDir, stateDir, scratch };
}

const build = (
  folder: ReturnType<typeof appFolder>,
  published: Array<StorageHomeUsage>,
  owned: ReadonlySet<string>,
) =>
  makeHomeUsageGuard({
    baseDir: folder.baseDir,
    stateDir: folder.stateDir,
    worktreesDir: NodePath.join(folder.baseDir, "worktrees"),
    logsDir: NodePath.join(folder.stateDir, "logs"),
    foldCase: false,
    userHome: folder.user,
    publish: (usage) => Effect.sync(() => void published.push(usage)),
    processCwds: Effect.succeed([]),
    isOwned: (path) => Effect.succeed(owned.has(NodePath.basename(path))),
    guardRemoval: (_path, effect) => effect,
  });

describe("home usage guard", () => {
  EffectVitest.it.effect(
    "measures, warns, records the result and removes only unowned old scratch folders",
    () =>
      Effect.gen(function* () {
        const folder = appFolder();
        const published: Array<StorageHomeUsage> = [];
        // The walk reads ages from ctime too, which tests cannot set back: judge
        // from three weeks ahead instead, with the fresh run dated at that point.
        const later = Date.now() + 21 * DAY;
        const future = new Date(later);
        NodeFS.utimesSync(NodePath.join(folder.scratch, "fresh-run", "out.log"), future, future);
        yield* Effect.gen(function* () {
          const guard = yield* build(folder, published, new Set(["chat-thread"]));
          yield* guard.run(settings(1e-5), later);
        }).pipe(Effect.provide(NodeServices.layer));
        expect(published).toHaveLength(1);
        const usage = published[0]!;
        expect(usage.path).toBe(folder.home);
        expect(usage.level).toBe("large");
        expect(usage.worktreeCount).toBe(1);
        expect(usage.parts.map((part) => part.key)).toEqual(
          expect.arrayContaining(["backups", "database", "scratch", "worktrees"]),
        );
        expect(NodeFS.readdirSync(folder.scratch).toSorted()).toEqual(["chat-thread", "fresh-run"]);
        const state = JSON.parse(
          NodeFS.readFileSync(NodePath.join(folder.stateDir, HOME_USAGE_STATE_FILE), "utf8"),
        );
        expect(state.usage.checkedAt).toBe(usage.checkedAt);
      }),
  );

  EffectVitest.it.effect(
    "waits six hours between walks, restores the last one and applies a new warning size",
    () =>
      Effect.gen(function* () {
        const folder = appFolder();
        const published: Array<StorageHomeUsage> = [];
        const now = Date.now();
        yield* Effect.gen(function* () {
          const first = yield* build(folder, published, new Set());
          yield* first.run(settings(null, null), now);
          yield* first.run(settings(null, null), now + 60_000);
          expect(published).toHaveLength(1);
          expect(published[0]!.level).toBe("ok");
          // A smaller warning size takes effect without walking again.
          yield* first.run(settings(1, null), now + 120_000);
          expect(published).toHaveLength(2);
          expect(published[1]!.checkedAt).toBe(published[0]!.checkedAt);
          expect(published[1]!.warnAboveBytes).toBe(1e9);
          // A restart shows the recorded measurement without a walk.
          const restarted = yield* build(folder, published, new Set());
          yield* restarted.restore;
          expect(published).toHaveLength(3);
          expect(published[2]!.warnAboveBytes).toBe(1e9);
        }).pipe(Effect.provide(NodeServices.layer));
        // Retention off: nothing was removed.
        expect(NodeFS.readdirSync(folder.scratch)).toHaveLength(3);
      }),
  );
});
