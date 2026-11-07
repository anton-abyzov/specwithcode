// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - pure rules over fixed times and paths.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { StorageHomeUsage } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as EffectVitest from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import { withWarningSize } from "./guard.ts";
import {
  abnormalGrowth,
  homeUsageDue,
  homeUsageLayout,
  homeUsageLevel,
  homeUsageReport,
  HOME_USAGE_INTERVAL_MS,
} from "./measure.ts";
import { listProcessCwds, parseLsofCwds } from "./processCwds.ts";
import { decideScratchRetention, runScratchRetention } from "./scratchRetention.ts";
import type { WalkChild, WalkResult } from "./walkTree.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const SCRATCH = "/Users/me/.specwithcode/m4/scratch";
const GB = 1e9;

const child = (name: string, ageDays: number | null, bytes = 1000): WalkChild => ({
  name,
  kind: "directory",
  bytes,
  newestMs: ageDays === null ? null : NOW - ageDays * DAY,
});

const walk = (parts: Record<string, number>, complete = true): WalkResult => ({
  totalBytes: Object.values(parts).reduce((sum, bytes) => sum + bytes, 0),
  parts: Object.entries(parts).map(([key, bytes]) => ({
    key,
    bytes,
    checkouts: key === "worktrees" ? 17 : 0,
    children: [],
  })),
  entries: 1,
  otherDevice: 0,
  unreadable: 0,
  complete,
  stopped: complete ? null : "deadline",
});

const report = (
  parts: Record<string, number>,
  warnAboveGb: number | null,
  previous = null as StorageHomeUsage | null,
) =>
  homeUsageReport({
    root: "/Users/me/.specwithcode",
    walk: walk(parts),
    warnAboveGb,
    previous,
    checkedAt: "2026-11-03T12:00:00.000Z",
  });

describe("home usage warning", () => {
  it("warns once the total passes the size in settings", () => {
    expect(report({ worktrees: 30 * GB, other: 19 * GB }, 50).level).toBe("ok");
    const large = report({ worktrees: 102 * GB, database: 23 * GB, backups: 21 * GB }, 50);
    expect(large.level).toBe("large");
    expect(large.warnAboveBytes).toBe(50 * GB);
    expect(large.parts.map((part) => part.key)).toEqual(["worktrees", "database", "backups"]);
    expect(large.worktreeCount).toBe(17);
    expect(report({ worktrees: 500 * GB }, null).level).toBe("ok");
  });

  it("flags a part that grew abnormally since the measurement before", () => {
    const before = report({ scratch: 4 * GB, worktrees: 20 * GB }, 500);
    const after = report({ scratch: 16 * GB, worktrees: 25 * GB }, 500, before);
    expect(after.level).toBe("growing");
    expect(after.parts.find((part) => part.key === "scratch")?.grewBytes).toBe(12 * GB);
    expect(after.parts.find((part) => part.key === "worktrees")?.grewBytes).toBeUndefined();
    // Growth below 10 GB, or below half of what was there, is normal.
    expect(
      abnormalGrowth([{ key: "worktrees", bytes: 108 * GB }], report({ worktrees: 100 * GB }, null))
        .size,
    ).toBe(0);
    expect(
      abnormalGrowth([{ key: "scratch", bytes: 9 * GB }], report({ scratch: 1 * GB }, null)).size,
    ).toBe(0);
    expect(homeUsageLevel(60 * GB, 50 * GB, 1)).toBe("large");
  });

  it("applies a new warning size to the last measurement", () => {
    const usage = report({ worktrees: 60 * GB }, 50);
    expect(usage.level).toBe("large");
    expect(withWarningSize(usage, 50)).toBe(usage);
    expect(withWarningSize(usage, 100).level).toBe("ok");
    expect(withWarningSize(usage, null).warnAboveBytes).toBeNull();
  });

  it("measures every six hours at most", () => {
    expect(homeUsageDue(null, NOW)).toBe(true);
    expect(homeUsageDue(NOW - HOME_USAGE_INTERVAL_MS + 1, NOW)).toBe(false);
    expect(homeUsageDue(NOW - HOME_USAGE_INTERVAL_MS, NOW)).toBe(true);
    expect(homeUsageDue(NOW + DAY, NOW)).toBe(true);
    expect(homeUsageDue(Number.NaN, NOW)).toBe(true);
  });
});

// oxlint-disable-next-line studio/no-global-process-runtime -- picks which tests run; no Effect runtime yet.
describe.skipIf(process.platform === "win32")("homeUsageLayout", () => {
  const paths = (baseDir: string) => ({
    baseDir,
    stateDir: NodePath.join(baseDir, "userdata"),
    worktreesDir: NodePath.join(baseDir, "worktrees"),
    logsDir: NodePath.join(baseDir, "userdata", "logs"),
    userHome: "/Users/me",
  });

  it("measures the whole app folder with every part inside it", () => {
    const layout = homeUsageLayout(paths("/Users/me/.specwithcode/m4"))!;
    expect(layout.root).toBe("/Users/me/.specwithcode");
    expect(Object.fromEntries(layout.parts.map((part) => [part.key, part.paths]))).toEqual({
      worktrees: ["/Users/me/.specwithcode/m4/worktrees"],
      database: [
        "/Users/me/.specwithcode/m4/userdata/statev2.sqlite",
        "/Users/me/.specwithcode/m4/userdata/statev2.sqlite-wal",
        "/Users/me/.specwithcode/m4/userdata/statev2.sqlite-shm",
      ],
      logs: ["/Users/me/.specwithcode/m4/userdata/logs"],
      scratch: ["/Users/me/.specwithcode/m4/scratch"],
      evidence: ["/Users/me/.specwithcode/m4/evidence"],
      backups: ["/Users/me/.specwithcode/backups"],
      release: ["/Users/me/.specwithcode/release.noindex"],
    });
    // Small parts and scratch first: worktrees cannot use up the shared entry limit before them.
    expect(layout.parts.map((part) => part.key)).toEqual([
      "database",
      "logs",
      "scratch",
      "evidence",
      "backups",
      "release",
      "worktrees",
    ]);
  });

  it("never measures the user's home, an ancestor of it or a root", () => {
    expect(homeUsageLayout(paths("/Users/me"))).toBeNull();
    expect(homeUsageLayout(paths("/Users"))).toBeNull();
    expect(homeUsageLayout(paths("/"))).toBeNull();
    // A custom base folder is measured alone, without siblings.
    const custom = homeUsageLayout(paths("/Volumes/Data/studio"))!;
    expect(custom.root).toBe("/Volumes/Data/studio");
    expect(custom.parts.find((part) => part.key === "backups")?.paths).toEqual([]);
    // Parts outside the root (a custom worktrees folder) are left out.
    const outside = homeUsageLayout({
      ...paths("/Users/me/.specwithcode/m4"),
      worktreesDir: "/Volumes/Fast/worktrees",
    })!;
    expect(outside.parts.find((part) => part.key === "worktrees")?.paths).toEqual([]);
  });
});

describe("scratch retention", () => {
  const decide = (children: Array<WalkChild>, cwds: Array<string> = [], afterDays = 14) =>
    Object.fromEntries(
      decideScratchRetention({
        scratchRoots: [SCRATCH],
        children,
        processCwds: cwds,
        afterDays,
        now: NOW,
        foldCase: false,
        join: NodePath.posix.join,
      }).map((decision) => [decision.name, decision.action]),
    );

  it("removes only folders unchanged for the retention period", () => {
    expect(
      decide([
        child("2026-10-01-probe", 33),
        child("2026-11-02-run", 1),
        child("exactly", 14),
        child("unmeasured", null),
        { ...child("link", 90), kind: "symlink" },
        { ...child("file.log", 90), kind: "file" },
      ]),
    ).toEqual({
      "2026-10-01-probe": "remove",
      "2026-11-02-run": "keep",
      exactly: "remove",
      unmeasured: "keep",
      link: "keep",
      "file.log": "keep",
    });
    // Below a week, nothing goes whatever the setting says.
    expect(decide([child("old", 30)], [], 3)).toEqual({ old: "keep" });
  });

  it("keeps a folder a running process works in, but not for a process in scratch itself", () => {
    expect(
      decide(
        [child("busy", 40), child("idle", 40)],
        [`${SCRATCH}/busy/deep/dir`, SCRATCH, "/Users/me"],
      ),
    ).toEqual({ busy: "keep", idle: "remove" });
  });

  const runRetention = (input: {
    readonly children: Array<WalkChild>;
    readonly fresh?: Array<WalkChild>;
    readonly owned?: ReadonlySet<string>;
    readonly cwds?: Array<Array<string> | null>;
  }) => {
    const removed: Array<string> = [];
    const ownerChecks: Array<string> = [];
    const cwdReads = [...(input.cwds ?? [[], []])];
    return runScratchRetention({
      scratchRoots: [SCRATCH],
      children: input.children,
      afterDays: 14,
      now: Effect.succeed(NOW),
      foldCase: false,
      join: NodePath.posix.join,
      processCwds: Effect.sync(() => (cwdReads.length > 1 ? cwdReads.shift()! : cwdReads[0]!)),
      measureChildren: (names) =>
        Effect.succeed(
          (input.fresh ?? input.children).filter((entry) => names.includes(entry.name)),
        ),
      isOwned: (path) =>
        Effect.sync(() => {
          ownerChecks.push(path);
          return input.owned?.has(path) ?? false;
        }),
      remove: (path) => Effect.sync(() => void removed.push(path)),
    }).pipe(Effect.map((result) => ({ result, removed, ownerChecks })));
  };

  EffectVitest.it.effect("removes unowned old folders and reports their size", () =>
    Effect.gen(function* () {
      const { result, removed } = yield* runRetention({
        children: [child("old", 30, 6.6e9), child("new", 2)],
      });
      expect(removed).toEqual([`${SCRATCH}/old`]);
      expect(result).toEqual([{ name: "old", path: `${SCRATCH}/old`, bytes: 6.6e9 }]);
    }),
  );

  EffectVitest.it.effect("keeps folders a thread, session or project owns", () =>
    Effect.gen(function* () {
      const { removed, ownerChecks } = yield* runRetention({
        children: [child("chat-thread", 60), child("probe", 60)],
        owned: new Set([`${SCRATCH}/chat-thread`]),
      });
      expect(removed).toEqual([`${SCRATCH}/probe`]);
      // Checked before measuring again and right before removal.
      expect(ownerChecks.filter((path) => path.endsWith("probe"))).toHaveLength(2);
    }),
  );

  EffectVitest.it.effect("keeps a folder that changed or gained a process since the walk", () =>
    Effect.gen(function* () {
      const changed = yield* runRetention({
        children: [child("a", 30), child("b", 30)],
        fresh: [child("a", 0), child("b", 30)],
      });
      expect(changed.removed).toEqual([`${SCRATCH}/b`]);
      const entered = yield* runRetention({
        children: [child("a", 30)],
        cwds: [[], [`${SCRATCH}/a`]],
      });
      expect(entered.removed).toEqual([]);
    }),
  );

  EffectVitest.it.effect("removes nothing when running processes cannot be listed", () =>
    Effect.gen(function* () {
      const { removed, ownerChecks } = yield* runRetention({
        children: [child("old", 90)],
        cwds: [null],
      });
      expect(removed).toEqual([]);
      expect(ownerChecks).toEqual([]);
    }),
  );

  EffectVitest.it.effect(
    "reads running processes' folders from /proc and knows none on Windows",
    () =>
      Effect.gen(function* () {
        const proc = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "proc-"));
        try {
          NodeFS.mkdirSync(NodePath.join(proc, "123"));
          const cwd = NodePath.resolve("/work/scratch/probe");
          NodeFS.symlinkSync(cwd, NodePath.join(proc, "123", "cwd"));
          NodeFS.mkdirSync(NodePath.join(proc, "self-status"));
          expect(yield* listProcessCwds("linux", { procRoot: proc })).toEqual([cwd]);
          expect(yield* listProcessCwds("win32")).toBeNull();
        } finally {
          NodeFS.rmSync(proc, { recursive: true, force: true });
        }
      }),
  );

  // lsof is a macOS adapter; the executable fixture needs POSIX shebang support.
  describe.skipIf(process.platform === "win32")("POSIX lsof execution", () => {
    EffectVitest.it.effect("treats a failed lsof as unknown, even with partial output", () =>
      Effect.gen(function* () {
        const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lsof-"));
        try {
          const fake = (name: string, exit: number) => {
            const file = NodePath.join(bin, name);
            NodeFS.writeFileSync(
              file,
              `#!/bin/sh\nprintf 'p1\\nfcwd\\nn/work/a\\n'\nexit ${exit}\n`,
            );
            NodeFS.chmodSync(file, 0o755);
            return file;
          };
          expect(
            yield* listProcessCwds("darwin", { uid: 501, lsofCommand: fake("ok", 0) }),
          ).toEqual(["/work/a"]);
          expect(
            yield* listProcessCwds("darwin", { uid: 501, lsofCommand: fake("partial", 1) }),
          ).toBeNull();
        } finally {
          NodeFS.rmSync(bin, { recursive: true, force: true });
        }
      }),
    );
  });

  it("reads lsof cwd output", () => {
    expect(
      parseLsofCwds(
        "p1\nfcwd\nn/Users/me\np2\nfcwd\nn/Users/me/.specwithcode/m4/scratch/a b\np3\n",
      ),
    ).toEqual(["/Users/me", "/Users/me/.specwithcode/m4/scratch/a b"]);
  });
});
