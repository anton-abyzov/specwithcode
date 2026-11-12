// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - one test waits on a real recursive file watch.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  type SearchRefreshClock,
  isIgnoredSearchEvent,
  makeSearchRefresh,
  watchSearchRoot,
  watchedSearchRootCount,
} from "./WorkspaceSearchRefresh.ts";

/** A clock the test moves by hand; timers fire in due order as time passes. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { readonly at: number; readonly run: () => void }>();
  const clock: SearchRefreshClock = {
    now: () => now,
    setTimeout: (run, delayMs) => {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, run });
      return id;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .toSorted(([, left], [, right]) => left.at - right.at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].run();
    }
    now = target;
  };
  return { clock, advance, pendingTimers: () => timers.size };
}

/** A rescan the test finishes by hand. */
function manualRescan() {
  const finishers: Array<() => void> = [];
  let started = 0;
  return {
    rescan: () => {
      started += 1;
      return new Promise<void>((resolve) => finishers.push(resolve));
    },
    started: () => started,
    finish: async () => {
      finishers.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("isIgnoredSearchEvent", () => {
  it("drops changes under folders that never change search results", () => {
    for (const path of [
      ".git/index",
      ".git",
      "node_modules/pkg/index.js",
      "apps/web/node_modules/.vite/deps/a.js",
      "repositories/org/repo/.git/HEAD",
      "scratch/review-clone/src/a.ts",
      "scratch",
      ".artifacts/run/report.html",
      "apps\\web\\node_modules\\x.js",
    ]) {
      expect(isIgnoredSearchEvent(path), path).toBe(true);
    }
  });

  it("keeps changes to sources, nested repositories included", () => {
    for (const path of [
      "src/index.ts",
      "repositories/org/repo/src/index.ts",
      "apps/web/src/scratch/notes.ts",
      "docs/.artifacts/a.md",
      ".gitignore",
      ".github/workflows/ci.yml",
      "",
    ]) {
      expect(isIgnoredSearchEvent(path), path).toBe(false);
    }
  });
});

describe("makeSearchRefresh", () => {
  it("rescans once for a burst of 200 changes in one second", async () => {
    const { clock, advance } = fakeClock();
    const scan = manualRescan();
    const refresh = makeSearchRefresh({ rescan: scan.rescan, clock });

    for (let index = 0; index < 200; index += 1) {
      refresh.notify(`src/file-${index}.ts`);
      advance(5);
    }
    expect(scan.started()).toBe(0);
    advance(1_994);
    expect(scan.started()).toBe(0);
    advance(1);
    expect(scan.started()).toBe(1);
    await scan.finish();
    advance(60_000);
    expect(scan.started()).toBe(1);
    refresh.dispose();
  });

  it("does nothing without changes and nothing for ignored changes", () => {
    const { clock, advance, pendingTimers } = fakeClock();
    const scan = manualRescan();
    const refresh = makeSearchRefresh({ rescan: scan.rescan, clock });

    advance(3_600_000);
    for (let index = 0; index < 200; index += 1) {
      refresh.notify(".git/index.lock");
      refresh.notify(`node_modules/pkg/file-${index}.js`);
      refresh.notify(`scratch/clone/file-${index}.ts`);
    }
    advance(3_600_000);
    expect(scan.started()).toBe(0);
    expect(pendingTimers()).toBe(0);
    refresh.dispose();
  });

  it("keeps a floor between rescans while changes never pause", async () => {
    const { clock, advance } = fakeClock();
    const scan = manualRescan();
    const refresh = makeSearchRefresh({ rescan: scan.rescan, clock });

    // One change every second for 60 seconds; each rescan ends at once.
    for (let second = 0; second < 60; second += 1) {
      refresh.notify("src/busy.ts");
      advance(1_000);
      if (scan.started() > 0) await scan.finish();
    }
    // The first starts 10 s after the first change, the rest 10 s apart.
    expect(scan.started()).toBeGreaterThanOrEqual(4);
    expect(scan.started()).toBeLessThanOrEqual(6);
    refresh.dispose();
  });

  it("never runs two rescans at once and picks up changes made during one", async () => {
    const { clock, advance } = fakeClock();
    const scan = manualRescan();
    const refresh = makeSearchRefresh({ rescan: scan.rescan, clock });

    refresh.notify("src/a.ts");
    advance(2_000);
    expect(scan.started()).toBe(1);
    refresh.notify("src/b.ts");
    refresh.notify("src/c.ts");
    advance(100);
    expect(scan.started()).toBe(1);
    await scan.finish();
    advance(9_999);
    expect(scan.started()).toBe(1);
    advance(1);
    expect(scan.started()).toBe(2);
    await scan.finish();
    refresh.dispose();
  });

  it("holds the next rescan back after a slow one", async () => {
    const { clock, advance } = fakeClock();
    const scan = manualRescan();
    const refresh = makeSearchRefresh({ rescan: scan.rescan, clock });

    refresh.notify("src/a.ts");
    advance(2_000);
    advance(3_000);
    await scan.finish();
    // The rescan took 3 s, so the next waits 60 s, not 10.
    refresh.notify("src/b.ts");
    advance(59_999);
    expect(scan.started()).toBe(1);
    advance(1);
    expect(scan.started()).toBe(2);
    refresh.dispose();
  });

  it("survives a failed rescan and stops when disposed", async () => {
    const { clock, advance, pendingTimers } = fakeClock();
    let started = 0;
    const refresh = makeSearchRefresh({
      rescan: () => {
        started += 1;
        return started === 1 ? Promise.reject(new Error("worker lost")) : Promise.resolve();
      },
      clock,
    });

    refresh.notify(null);
    advance(2_000);
    expect(started).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    refresh.notify("src/a.ts");
    advance(10_000);
    expect(started).toBe(2);
    await Promise.resolve();
    await Promise.resolve();

    refresh.notify("src/b.ts");
    refresh.dispose();
    expect(pendingTimers()).toBe(0);
    refresh.notify("src/c.ts");
    advance(60_000);
    expect(started).toBe(2);
  });
});

describe("watchSearchRoot", () => {
  it("shares one watch per root and releases it with the last index", async () => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "search-refresh-watch-")),
    );
    try {
      const before = watchedSearchRootCount();
      const seen: Array<string | null> = [];
      const stopFirst = watchSearchRoot(root, (path) => seen.push(path));
      const stopSecond = watchSearchRoot(root, () => undefined);
      expect(watchedSearchRootCount()).toBe(before + 1);

      NodeFS.writeFileSync(NodePath.join(root, "new-file.ts"), "export {};\n");
      const deadline = Date.now() + 10_000;
      while (!seen.some((path) => path?.endsWith("new-file.ts")) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(seen.some((path) => path?.endsWith("new-file.ts"))).toBe(true);

      stopFirst();
      expect(watchedSearchRootCount()).toBe(before + 1);
      stopSecond();
      stopSecond();
      expect(watchedSearchRootCount()).toBe(before);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives a root that cannot be watched a no-op stop", () => {
    const before = watchedSearchRootCount();
    const stop = watchSearchRoot(
      NodePath.join(NodeOS.tmpdir(), "search-refresh-missing-root"),
      () => {
        throw new Error("never called");
      },
    );
    stop();
    expect(watchedSearchRootCount()).toBe(before);
  });
});
