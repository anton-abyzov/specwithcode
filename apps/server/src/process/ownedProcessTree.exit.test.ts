import { describe, expect, it } from "vite-plus/test";

import { OwnedProcessTree, type ProcessEntry, type TreeHost } from "./ownedProcessTree.ts";

// Stop's pre-close readings around the moment the CLI exits, over fake process tables.
const entry = (pid: number, ppid: number, pgid: number, second: number): ProcessEntry => ({
  pid,
  ppid,
  pgid,
  started: `Thu Nov 19 18:20:0${second} 2026`,
  command: String(pid),
});
const cli = entry(200, 100, 200, 0);
const launcher = entry(201, 200, 200, 1);
const tool = entry(202, 201, 200, 2);
const movedTool = { ...tool, ppid: 1, pgid: tool.pid };
const helper = entry(203, tool.pid, tool.pid, 3);

function fixture(platform: "darwin" | "linux") {
  let rootAlive = true;
  let clock = 0;
  let table: ProcessEntry[] = [];
  let completeRead: (() => void) | undefined;
  const signals: Array<[number, NodeJS.Signals]> = [];
  const host: TreeHost = {
    platform,
    selfPid: 100,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    readProcessList: async () => {
      await Promise.resolve();
      const snapshot = table;
      completeRead?.();
      completeRead = undefined;
      return snapshot;
    },
    killVerified: async () => expect.fail("not a Windows host"),
    signal: (pid, action) => {
      if (action === 0) {
        if (!table.some((row) => row.pgid === -pid)) {
          throw Object.assign(new Error("no group"), { code: "ESRCH" });
        }
        return;
      }
      signals.push([pid, action]);
      table = table.filter((row) => (pid < 0 ? row.pgid !== -pid : row.pid !== pid));
    },
  };
  const tree = new OwnedProcessTree(
    {
      pid: cli.pid,
      spawnedAt: 0,
      alive: () => rootAlive,
      exitedAt: () => (rootAlive ? null : 0),
      exitedAtEpochMs: () => (rootAlive ? null : Date.parse("Thu Nov 19 18:22:00 2026 GMT")),
    },
    host,
  );
  return {
    tree,
    signals,
    current: () => table,
    sample(rows: ProcessEntry[]) {
      table = rows;
    },
    close(rows: ProcessEntry[]) {
      rootAlive = false;
      table = rows;
    },
    afterCapture(callback: () => void) {
      completeRead = callback;
    },
  };
}

describe.each(["darwin", "linux"] as const)(
  "Stop reads a tool that left the group (%s)",
  (platform) => {
    it(`kills an orphan sampled beneath a previously seen group member`, async () => {
      const f = fixture(platform);
      f.sample([cli, launcher, tool]);
      expect(await f.tree.remember(1_000, true)).toBe(true);
      f.sample([cli, movedTool, helper]);
      expect(await f.tree.remember(1_000, true)).toBe(true);
      f.close([{ ...helper, ppid: 1 }]);
      const result = await f.tree.end();
      expect({ result, signals: f.signals, remaining: f.current() }).toEqual({
        result: { found: 1, survivors: 0, unknown: false },
        signals: [[helper.pid, "SIGTERM"]],
        remaining: [],
      });
    });

    it(`cleans up a tool listed in a successful read returned after CLI exit`, async () => {
      const f = fixture(platform);
      f.sample([cli]);
      expect(await f.tree.remember(1_000, true)).toBe(true);
      const child = { ...movedTool, ppid: cli.pid };
      f.sample([cli, child]);
      f.afterCapture(() => f.close([movedTool]));
      await f.tree.remember(1_000, true);
      const result = await f.tree.end();
      expect({ signals: f.signals, remaining: f.current() }).toEqual({
        signals: [[child.pid, "SIGTERM"]],
        remaining: [],
      });
    });
  },
);

describe.each(["darwin", "linux"] as const)("Stop around a CLI exit mid-read (%s)", (platform) => {
  it(`retains a child visible under a known group member in a rootless sample`, async () => {
    const f = fixture(platform);
    f.sample([cli, launcher, tool]);
    expect(await f.tree.remember(1_000, true)).toBe(true);
    // The read is issued while the CLI is alive. By capture, the CLI and launcher
    // have exited. The previously attributed tool and its current child are visible.
    const read = f.tree.remember(1_000, true);
    f.close([movedTool, helper]);
    f.afterCapture(() => f.sample([{ ...helper, ppid: 1 }]));
    await read;
    const result = await f.tree.end();
    expect({ signals: f.signals, remaining: f.current() }).toEqual({
      signals: [[helper.pid, "SIGTERM"]],
      remaining: [],
    });
  });

  it(`a rootless read keeps a detached child of a known tool still in the group`, async () => {
    const f = fixture(platform);
    f.sample([cli, launcher, tool]);
    expect(await f.tree.remember(1_000, true)).toBe(true);
    const read = f.tree.remember(1_000, true);
    // The CLI and launcher have exited. The known tool is still in the original group;
    // its child already runs outside it.
    const detachedHelper = { ...helper, pgid: helper.pid };
    f.close([{ ...tool, ppid: 1 }, detachedHelper]);
    f.afterCapture(() => f.sample([{ ...detachedHelper, ppid: 1 }]));
    await read;
    await f.tree.end();
    expect(f.signals).toEqual([[helper.pid, "SIGTERM"]]);
    expect(f.current()).toEqual([]);
  });

  it(`a later remember after exit preserves a successful capture of the exiting CLI`, async () => {
    const f = fixture(platform);
    f.sample([cli, { ...movedTool, ppid: cli.pid }]);
    f.afterCapture(() => f.close([movedTool]));
    expect(await f.tree.remember(1_000, true)).toBe(true);
    // Claude's active Stop does another required read after the parallel interrupt.
    await f.tree.remember(1_000, true);
    const first = await f.tree.end();
    const retry = await f.tree.end();
    expect({ first, retry, remaining: f.current() }).toEqual({
      first: { found: 1, survivors: 0, unknown: false },
      retry: { found: 0, survivors: 0, unknown: false },
      remaining: [],
    });
  });
});

describe.each(["darwin", "linux"] as const)("Stop without the CLI's start (%s)", (platform) => {
  it(`without a cached root identity, Stop cannot admit a replacement group after five seconds`, async () => {
    const exitEpoch = Date.parse(`${cli.started} GMT`) + 30_000;
    let clock = 0;
    let alive = true;
    let table: ProcessEntry[] = [];
    const signals: Array<[number, NodeJS.Signals]> = [];
    const replacement = [
      { ...cli, command: "unrelated", started: "Thu Nov 19 18:19:36 2026" },
      {
        ...launcher,
        command: "unrelated worker",
        started: "Thu Nov 19 18:19:37 2026",
      },
    ];
    const host: TreeHost = {
      platform,
      selfPid: 100,
      now: () => clock,
      epochNow: () => (alive ? exitEpoch : exitEpoch - 52_000),
      sleep: async (ms) => {
        clock += ms;
      },
      readProcessList: async () => {
        await Promise.resolve();
        return table;
      },
      killVerified: async () => expect.fail("not a Windows host"),
      signal: (pid, action) => {
        if (action === 0) {
          if (!table.some((row) => row.pgid === -pid)) {
            throw Object.assign(new Error("no group"), { code: "ESRCH" });
          }
          return;
        }
        signals.push([pid, action]);
        table = table.filter((row) => (pid < 0 ? row.pgid !== -pid : row.pid !== pid));
      },
    };
    const tree = new OwnedProcessTree(
      {
        pid: cli.pid,
        spawnedAt: -100,
        alive: () => alive,
        exitedAt: () => (alive ? null : 0),
        exitedAtEpochMs: () => (alive ? null : exitEpoch),
      },
      host,
    );

    const pending = tree.remember(10_000, true);
    // No root identity was recorded before the CLI exited. The clock was set
    // back afterwards. The first snapshot is finally taken after PGID reuse.
    alive = false;
    clock = 6_000;
    table = replacement;
    const remembered = await pending;
    const result = await tree.end();
    expect({ unknown: result.unknown, signals }).toEqual({ unknown: true, signals: [] });
  });
});
