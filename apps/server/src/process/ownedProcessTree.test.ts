// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- spawns a real process tree and waits on wall-clock time for it to end.
import { describe, expect, it } from "vite-plus/test";

import {
  type OwnedRoot,
  type ProcessEntry,
  type TreeHost,
  OwnedProcessTree,
  filetimeFromEpochMs,
  parsePosixProcessList,
  parseWindowsProcessList,
  posixEscapees,
  readProcessList,
  spawnOwnedProcess,
  stillRunning,
  windowsKillScript,
  windowsTree,
} from "./ownedProcessTree.ts";

const win = (pid: number, ppid: number, started: bigint, command = `p${pid}`): ProcessEntry => ({
  pid,
  ppid,
  pgid: null,
  started: started.toString(),
  command,
});
const posix = (pid: number, ppid: number, pgid: number, command = `p${pid}`): ProcessEntry => ({
  pid,
  ppid,
  pgid,
  started: `t${pid}`,
  command,
});
const root = (pid: number, alive: boolean, spawnedAt = 0): OwnedRoot => ({
  pid,
  spawnedAt,
  alive: () => alive,
});

describe("process lists", () => {
  it("reads ps output with groups, start times and spaces in command lines", () => {
    expect(
      parsePosixProcessList(
        "  100     1   100 Thu Nov 19 12:03:08 2026 node server.mjs\n" +
          "  200   100   200 Thu Nov  9 02:03:08 2026 claude --session-id=abc x\n" +
          "garbage\n",
      ),
    ).toEqual([
      {
        pid: 100,
        ppid: 1,
        pgid: 100,
        started: "Thu Nov 19 12:03:08 2026",
        command: "node server.mjs",
      },
      {
        pid: 200,
        ppid: 100,
        pgid: 200,
        started: "Thu Nov 9 02:03:08 2026",
        command: "claude --session-id=abc x",
      },
    ]);
  });

  it("keeps Windows creation times exact, at microseconds, and drops unreadable rows", () => {
    expect(
      parseWindowsProcessList(
        '[{"ProcessId":10,"ParentProcessId":4,"Start":"133780123456789017","CommandLine":"claude.exe"},' +
          '{"ProcessId":11,"ParentProcessId":4,"Start":null,"CommandLine":null},{"ProcessId":"x"}]',
      ),
    ).toEqual([
      { pid: 10, ppid: 4, pgid: null, started: "133780123456789010", command: "claude.exe" },
      { pid: 11, ppid: 4, pgid: null, started: "", command: "" },
    ]);
    // A failed or partial read is not an empty table.
    expect(parseWindowsProcessList("not json")).toBeUndefined();
    expect(parseWindowsProcessList("")).toBeUndefined();
    // One row comes as a bare object; a row without a parent is dropped. (A read whose
    // rows lack the server itself is refused by readProcessList.)
    expect(parseWindowsProcessList('{"ProcessId":10}')).toEqual([]);
  });
});

describe("windowsTree", () => {
  const t = (n: number) => 1_000_000n + BigInt(n) * 10n;

  it("takes the live CLI and what it started, each created after its parent", () => {
    const table = [
      win(4, 0, t(0), "System"),
      win(50, 4, t(1), "unrelated helper"),
      win(200, 100, t(10), "claude.exe"),
      win(201, 200, t(11), "bash -c npm test"),
      win(202, 201, t(12), "node vitest"),
    ];
    expect(windowsTree(table, root(200, true), 100).map((k) => k.entry.pid)).toEqual([
      200, 201, 202,
    ]);
  });

  it("never takes a process older than the pid it names as parent", () => {
    // 300 outlived its creator; Windows later gave that creator's pid to a tool of the CLI.
    const table = [
      win(200, 100, t(10), "claude.exe"),
      win(201, 200, t(11), "bash"),
      win(300, 201, t(5), "unrelated helper"),
    ];
    expect(windowsTree(table, root(200, true), 100).map((k) => k.entry.pid)).toEqual([200, 201]);
  });

  it("keeps a remembered tool of the exited CLI, but not children of a newer process with its pid", () => {
    const spawnedAt = 1_800_000_000_000;
    const created = BigInt(filetimeFromEpochMs(spawnedAt)) + 10n;
    // The CLI and its tool, read while the CLI ran.
    const remembered = new Map([
      [200, { entry: win(200, 100, created, "claude.exe"), created }],
      [201, { entry: win(201, 200, created + 50n, "bash"), created: created + 50n }],
    ]);
    const table = [
      // The CLI exited; its tool still runs.
      win(201, 200, created + 50n, "bash -c npm run dev"),
      // Windows gave pid 200 to a newer process, which started a child of its own.
      win(200, 1, created + 100n, "newer process"),
      win(210, 200, created + 200n, "newer process's child"),
    ];
    expect(
      windowsTree(table, root(200, false, spawnedAt), 100, remembered).map((k) => k.entry.pid),
    ).toEqual([201]);
  });

  it("never takes a child of a pid owner that came and went after the CLI exited", () => {
    const spawnedAt = 1_800_000_000_000;
    const created = BigInt(filetimeFromEpochMs(spawnedAt)) + 10n;
    const remembered = new Map([[200, { entry: win(200, 100, created, "claude.exe"), created }]]);
    // The CLI exited, a later owner of pid 200 started 201 and exited too: 201 names
    // 200 as parent and is newer than the CLI, yet nothing ties it to the CLI.
    const table = [win(201, 200, created + 500n, "later owner's child")];
    expect(windowsTree(table, root(200, false, spawnedAt), 100, remembered)).toEqual([]);
  });

  it("takes nothing below an exited CLI whose creation time was never read", () => {
    // 300 was started by an earlier owner of pid 200, half a second before the spawn.
    const spawnedAt = 1_800_000_000_000;
    const table = [win(300, 200, BigInt(filetimeFromEpochMs(spawnedAt - 500)), "old helper")];
    expect(windowsTree(table, root(200, false, spawnedAt), 100)).toEqual([]);
  });

  it("finds what an exited tool started, from an earlier reading", () => {
    const first = [
      win(200, 100, t(10), "claude.exe"),
      win(201, 200, t(11), "bash"),
      win(202, 201, t(12), "node server"),
    ];
    const remembered = new Map(
      windowsTree(first, root(200, true), 100).map((k) => [k.entry.pid, k]),
    );
    // bash and the CLI exited; node is an orphan whose parent is no longer listed.
    const later = [win(202, 201, t(12), "node server")];
    expect(windowsTree(later, root(200, false), 100, remembered).map((k) => k.entry.pid)).toEqual([
      202,
    ]);
  });

  it("never lists the server", () => {
    const table = [win(200, 100, t(10)), win(100, 200, t(20), "server")];
    expect(windowsTree(table, root(200, true), 100).map((k) => k.entry.pid)).toEqual([200]);
  });

  it("kills only by pid and creation time together", () => {
    const script = windowsKillScript([win(201, 200, t(11)), { ...win(9, 1, 0n), started: "" }]);
    // One flat string per process, so a single entry is never unrolled into two.
    expect(script).toContain("foreach ($i in @('201:1000110')) {");
    expect(script).toContain("-eq [long]$f[1]");
    expect(script).not.toContain("'9:");
  });
});

describe("posixEscapees", () => {
  it("finds tools that left the CLI's group, below the group or the live CLI", () => {
    const table = [
      posix(200, 100, 200, "claude"),
      posix(201, 200, 200, "bash"),
      posix(202, 201, 202, "setsid dev server"),
      posix(203, 202, 202, "its worker"),
      posix(300, 100, 300, "another CLI"),
    ];
    expect(posixEscapees(table, root(200, true), 100).map((e) => e.pid)).toEqual([202, 203]);
  });

  it("checks identity against a fresh read by pid and start time, through an exec", () => {
    const snapshot = [posix(202, 1, 202), posix(203, 202, 202)];
    expect(
      stillRunning(snapshot, [
        { ...posix(202, 1, 202), started: "later" },
        { ...posix(203, 1, 202), command: "exec'd into node" },
      ]).map((e) => e.pid),
    ).toEqual([203]);
  });
});

function fakeHost(platform: NodeJS.Platform, tables: Array<ReadonlyArray<ProcessEntry> | null>) {
  const calls: string[] = [];
  let groupAlive = true;
  let clock = 0;
  const host: TreeHost = {
    platform,
    selfPid: 100,
    readProcessList: async () => {
      const table = tables.length > 1 ? tables.shift() : tables[0];
      return table === null ? undefined : table;
    },
    signal: (pid, signal) => {
      if (signal === 0) {
        if (pid < 0 && groupAlive) return;
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      calls.push(`${signal} ${pid}`);
    },
    killVerified: async (entries, _timeoutMs) => {
      calls.push(`kill ${entries.map((e) => e.pid).join(",")}`);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return {
    host,
    calls,
    endGroup: () => {
      groupAlive = false;
    },
  };
}

describe("OwnedProcessTree.end", () => {
  it("signals the CLI's whole group on macOS and Linux, then SIGKILL when it ignores SIGTERM", async () => {
    const group = [posix(200, 100, 200), posix(201, 200, 200)];
    const { host, calls, endGroup } = fakeHost("linux", [group]);
    const tree = new OwnedProcessTree(root(200, true), host);
    const ending = tree.end(4_000);
    const result = await ending;
    expect(calls).toEqual(["SIGTERM -200", "SIGKILL -200"]);
    expect(result).toEqual({ found: 2, survivors: 1, unknown: false });
    endGroup();
    expect(await new OwnedProcessTree(root(200, false), host).end(4_000)).toEqual({
      found: 2,
      survivors: 0,
      unknown: false,
    });
  });

  it("does nothing when the CLI left nothing behind", async () => {
    const { host, calls, endGroup } = fakeHost("darwin", [[]]);
    endGroup();
    expect(await new OwnedProcessTree(root(200, false), host).end()).toEqual({
      found: 0,
      survivors: 0,
      unknown: false,
    });
    expect(calls).toEqual([]);
  });

  it("says it cannot tell when the process table cannot be read", async () => {
    const posixHost = fakeHost("linux", [null]);
    posixHost.endGroup();
    expect(await new OwnedProcessTree(root(200, false), posixHost.host).end()).toEqual({
      found: 0,
      survivors: 0,
      unknown: true,
    });
    const windowsHost = fakeHost("win32", [null]);
    expect(await new OwnedProcessTree(root(200, true), windowsHost.host).end()).toEqual({
      found: 0,
      survivors: 0,
      unknown: true,
    });
    expect(windowsHost.calls).toEqual([]);
  });

  it("runs one end at a time and keeps every step inside one deadline", async () => {
    const t = (n: number) => 1_000_000n + BigInt(n) * 10n;
    const running = [win(200, 100, t(10)), win(201, 200, t(11))];
    const { host, calls } = fakeHost("win32", [running]);
    const tree = new OwnedProcessTree(root(200, true), host);
    const [first, second] = await Promise.all([tree.end(1_000), tree.end(1_000)]);
    expect(second).toBe(first);
    // The tree never dies here: kills repeat only until the deadline, then it reports them.
    expect(first.survivors).toBe(2);
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it("never signals group 0 when the spawn gave no pid", async () => {
    const { host, calls } = fakeHost("linux", [[posix(5, 1, 0)]]);
    expect(await new OwnedProcessTree(root(0, false), host).end()).toEqual({
      found: 0,
      survivors: 0,
      unknown: false,
    });
    expect(calls).toEqual([]);
  });

  it("never acts on the CLI's group id, or what it starts, once another job leads it", async () => {
    let cliRuns = true;
    const cli = posix(200, 100, 200, "claude");
    // A tool in the CLI's group survives SIGKILL (stuck in the kernel).
    const stuck = posix(202, 1, 200, "stuck tool");
    const { host, calls } = fakeHost("linux", [[cli, stuck], [stuck]]);
    const tree = new OwnedProcessTree({ pid: 200, spawnedAt: 0, alive: () => cliRuns }, host);
    expect((await tree.end(1_000)).survivors).toBe(1);
    expect(calls).toEqual(["SIGTERM -200", "SIGKILL -200"]);
    cliRuns = false;
    // Still the same tool: the retry signals the group again.
    calls.length = 0;
    await tree.end(1_000);
    expect(calls).toEqual(["SIGTERM -200", "SIGKILL -200"]);
    // The tool ended unseen and a new process with the CLI's pid leads group 200 now,
    // with a child in a group of its own: neither is touched.
    calls.length = 0;
    const later = [
      { ...posix(200, 1, 200, "another job"), started: "later" },
      posix(302, 200, 302, "its child"),
    ];
    Object.assign(host, { readProcessList: async () => later });
    expect(await tree.end(1_000)).toEqual({ found: 0, survivors: 0, unknown: false });
    expect(calls).toEqual([]);
  });

  it("neither signals nor gives up a later group it cannot tie to the CLI", async () => {
    // The first end could not read the table, so it never saw who was in the group.
    const { host, calls } = fakeHost("linux", [null]);
    const tree = new OwnedProcessTree(root(200, false), host);
    expect(await tree.end(1_000)).toMatchObject({ survivors: 1, unknown: true });
    calls.length = 0;
    // A later end sees the group occupied by someone it cannot place: it stays unconfirmed.
    Object.assign(host, { readProcessList: async () => [posix(202, 1, 200, "member")] });
    expect(await tree.end(1_000)).toMatchObject({ unknown: true });
    expect(calls).toEqual([]);
  });

  it("never signals a reaped CLI's group without a table to tie it to the CLI", async () => {
    const { host, calls } = fakeHost("linux", [null]);
    // The table cannot be read and the CLI was reaped: its group id may lead another job.
    const exitedAt = Date.UTC(2026, 10, 19, 12);
    const tree = new OwnedProcessTree(
      { ...root(200, false), exitedAtEpochMs: () => exitedAt },
      host,
    );
    expect(await tree.end(1_000)).toMatchObject({ unknown: true });
    expect(calls).toEqual([]);
  });

  it.each([
    ["a member started before the exit, a minute after it", false],
    ["a member seen while the CLI ran, a minute after the exit", true],
  ] as const)("signals a reaped CLI's group only on proof: %s", async (_, rememberedFirst) => {
    const exitedAt = Date.UTC(2026, 10, 19, 12);
    const member = {
      ...posix(202, 200, 200, "member"),
      started: new Date(exitedAt - 5_000).toString(),
    };
    let rootAlive = true;
    let live = [posix(200, 100, 200, "claude"), member];
    const calls: string[] = [];
    let clock = 0;
    const host: TreeHost = {
      platform: "darwin",
      selfPid: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      epochNow: () => exitedAt + 60_000,
      readProcessList: async () => live,
      signal: (pid, action) => {
        if (action !== 0) calls.push(`${action} ${pid}`);
        if (!live.some((entry) => entry.pgid === -pid)) {
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        }
        if (action === "SIGTERM") live = [];
      },
      killVerified: async () => {},
    };
    const tree = new OwnedProcessTree(
      {
        pid: 200,
        spawnedAt: 0,
        alive: () => rootAlive,
        exitedAtEpochMs: () => (rootAlive ? null : exitedAt),
      },
      host,
    );
    // Stop reads the group right before it closes the CLI.
    if (rememberedFirst) expect(await tree.remember(1_000, true)).toBe(true);
    rootAlive = false;
    live = [member];
    // A minute on, a start time alone no longer proves the id is still the CLI's group.
    const result = await tree.end(1_000);
    if (rememberedFirst) {
      expect(result).toEqual({ found: 1, survivors: 0, unknown: false });
      expect(calls).toEqual(["SIGTERM -200"]);
    } else {
      expect(result).toMatchObject({ unknown: true });
      expect(calls).toEqual([]);
    }
  });

  it.each(["darwin", "linux"] as const)(
    "never signals another job's group seen only by a worker started after the exit (%s)",
    async (platform) => {
      const exitedAt = Date.UTC(2026, 10, 19, 12);
      // The new job's leader exited; its worker, started a minute after the CLI exited,
      // still holds the group.
      const worker = {
        ...posix(205, 1, 200, "other job"),
        started: new Date(exitedAt + 60_000).toString(),
      };
      const signals: string[] = [];
      let clock = 0;
      const host: TreeHost = {
        platform,
        selfPid: 100,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        readProcessList: async () => [worker],
        signal: (pid, action) => {
          signals.push(`${action} ${pid}`);
        },
        killVerified: async () => {},
      };
      const tree = new OwnedProcessTree(
        { ...root(200, false), exitedAtEpochMs: () => exitedAt },
        host,
      );
      expect(await tree.end()).toMatchObject({ unknown: true });
      expect(signals).toEqual([]);
    },
  );

  it("follows a group member that leaves the group when it gets SIGTERM", async () => {
    let table: ProcessEntry[] = [posix(200, 100, 200, "claude"), posix(202, 200, 200, "tool")];
    let groupAlive = true;
    const calls: string[] = [];
    let clock = 0;
    const host: TreeHost = {
      platform: "linux",
      selfPid: 100,
      readProcessList: async () => table,
      signal: (pid, signal) => {
        if (signal === 0) {
          if (pid === -200 && groupAlive) return;
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        }
        calls.push(`${signal} ${pid}`);
        // The CLI ends; its tool calls setsid() and keeps running as itself.
        if (pid === -200 && signal === "SIGTERM") {
          groupAlive = false;
          table = [{ ...posix(202, 1, 202, "tool"), started: "t202" }];
        }
        if (pid === 202 && signal === "SIGKILL") table = [];
      },
      killVerified: async () => {},
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    };
    const tree = new OwnedProcessTree(root(200, false), host);
    expect(await tree.end(2_000)).toEqual({ found: 2, survivors: 0, unknown: false });
    expect(calls).toEqual(["SIGTERM -200", "SIGKILL 202"]);
  });

  it("still ends a member that left the group when the read after SIGTERM failed", async () => {
    let table: Array<ProcessEntry> | undefined = [
      posix(200, 100, 200, "claude"),
      posix(202, 200, 200, "tool"),
    ];
    let groupAlive = true;
    const calls: string[] = [];
    let clock = 0;
    const host: TreeHost = {
      platform: "darwin",
      selfPid: 100,
      readProcessList: async () => table,
      signal: (pid, signal) => {
        if (signal === 0) {
          if (pid === -200 && groupAlive) return;
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        }
        calls.push(`${signal} ${pid}`);
        if (pid === -200 && signal === "SIGTERM") {
          // The tool calls setsid() and the next read fails.
          groupAlive = false;
          table = undefined;
        }
        if (pid === 202 && signal === "SIGKILL") table = [];
      },
      killVerified: async () => {},
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    };
    const tree = new OwnedProcessTree(root(200, false), host);
    expect((await tree.end(1_000)).unknown).toBe(true);
    // The retry reads again, finds the same tool in its own group and ends it. What the
    // tool may have started while the table could not be read stays unknown.
    table = [posix(202, 1, 202, "tool")];
    expect(await tree.end(2_000)).toMatchObject({ survivors: 0, unknown: true });
    expect(calls).toContain("SIGKILL 202");
  });

  it("keeps what a Windows reading saw under the CLI when the CLI exits before it returns", async () => {
    const t = (n: number) => 1_000_000n + BigInt(n) * 10n;
    const cli = win(200, 100, t(10), "claude.exe");
    const tool = win(201, 200, t(11), "npm run build");
    let running = true;
    const fake = fakeHost("win32", [[cli], [cli, tool], [tool], []]);
    const read = fake.host.readProcessList;
    const tree = new OwnedProcessTree({ pid: 200, spawnedAt: 0, alive: () => running }, fake.host);
    expect(await tree.remember()).toBe(true);
    // The CLI exits after the reading captured it and the tool, before the rows come back.
    Object.assign(fake.host, {
      readProcessList: async (ms: number) => {
        const table = await read(ms);
        running = false;
        return table;
      },
    });
    expect(await tree.remember(1_000, true)).toBe(true);
    Object.assign(fake.host, { readProcessList: read });
    expect(await tree.end()).toEqual({ found: 1, survivors: 0, unknown: false });
    expect(fake.calls).toEqual(["kill 201"]);
  });

  it("keeps the first Windows reading that caught the CLI, though it exited before it returned", async () => {
    const spawned = 1_800_000_000_000;
    const created = BigInt(filetimeFromEpochMs(spawned)) + 10n;
    const cli = win(200, 100, created, "claude.exe");
    const tool = win(201, 200, created + 10n, "npm run build");
    let exitedAt: number | null = null;
    const fake = fakeHost("win32", [[cli, tool], [tool], []]);
    const read = fake.host.readProcessList;
    const tree = new OwnedProcessTree(
      { pid: 200, spawnedAt: 0, alive: () => exitedAt === null, exitedAtEpochMs: () => exitedAt },
      fake.host,
    );
    // No earlier reading knew the CLI; it exits as this one comes back.
    Object.assign(fake.host, {
      readProcessList: async (ms: number) => {
        const table = await read(ms);
        exitedAt = spawned + 5_000;
        return table;
      },
    });
    expect(await tree.remember(1_000, true)).toBe(true);
    Object.assign(fake.host, { readProcessList: read });
    expect(await tree.end()).toEqual({ found: 1, survivors: 0, unknown: false });
    expect(fake.calls).toEqual(["kill 201"]);
  });

  it("never takes a process created after the CLI exited for the CLI", async () => {
    const exitedAt = 1_800_000_000_000;
    // pid 200 belongs to a newer process, created after the CLI exited.
    const later = win(200, 1, BigInt(filetimeFromEpochMs(exitedAt + 50)), "newer");
    const child = win(201, 200, BigInt(filetimeFromEpochMs(exitedAt + 60)), "its child");
    const fake = fakeHost("win32", [[later, child]]);
    const tree = new OwnedProcessTree(
      { pid: 200, spawnedAt: 0, alive: () => false, exitedAtEpochMs: () => exitedAt },
      fake.host,
    );
    expect(await tree.remember(1_000, true)).toBe(false);
    expect((await tree.end()).found).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it("stays unconfirmed when a Windows child of the tree is listed without its start", async () => {
    const t = (n: number) => 1_000_000n + BigInt(n) * 10n;
    const cli = win(200, 100, t(10), "claude.exe");
    const blank = { ...win(201, 200, 0n, "tool"), started: "" };
    let running = true;
    const fake = fakeHost("win32", [[cli, blank], [win(201, 200, t(11), "tool")]]);
    const tree = new OwnedProcessTree({ pid: 200, spawnedAt: 0, alive: () => running }, fake.host);
    // The reading before the close cannot place the tool, so it does not count.
    expect(await tree.remember(1_000, true)).toBe(false);
    running = false;
    // Its row reads well now, but its parent is gone: the end is not confirmed.
    expect((await tree.end()).unknown).toBe(true);
  });

  it("holds back a later try on the CLI's group when the table cannot be read", async () => {
    const stuck = [posix(202, 1, 200, "stuck tool")];
    const { host, calls } = fakeHost("linux", [stuck, stuck, null]);
    const tree = new OwnedProcessTree(root(200, false), host);
    await tree.end(1_000);
    calls.length = 0;
    Object.assign(host, { readProcessList: async () => undefined });
    expect((await tree.end(1_000)).unknown).toBe(true);
    expect(calls).toEqual([]);
  });

  it("stays unconfirmed when the reading right before Stop closed the CLI failed", async () => {
    const t = (n: number) => 1_000_000n + BigInt(n) * 10n;
    const cli = [win(200, 100, t(10), "claude.exe")];
    // Read at spawn, then the reading before the close fails, then the CLI is gone.
    const closing = (tables: Array<ReadonlyArray<ProcessEntry> | null>) => {
      let running = true;
      const fake = fakeHost("win32", tables);
      const tree = new OwnedProcessTree(
        { pid: 200, spawnedAt: 0, alive: () => running },
        fake.host,
      );
      return { tree, close: () => (running = false) };
    };
    const failed = closing([cli, null, []]);
    expect(await failed.tree.remember()).toBe(true);
    expect(await failed.tree.remember(1_000, true)).toBe(false);
    failed.close();
    expect(await failed.tree.end()).toEqual({ found: 0, survivors: 0, unknown: true });
    // The same end with a good reading before the close is confirmed.
    const good = closing([cli, cli, []]);
    await good.tree.remember();
    expect(await good.tree.remember(1_000, true)).toBe(true);
    good.close();
    expect(await good.tree.end()).toEqual({ found: 0, survivors: 0, unknown: false });
    // A reading that lists other processes but not the running CLI covers nothing.
    const partial = closing([cli, [win(201, 200, t(11), "tool")], []]);
    await partial.tree.remember();
    expect(await partial.tree.remember(1_000, true)).toBe(false);
    partial.close();
    expect((await partial.tree.end()).unknown).toBe(true);
  });

  it("kills the tree on Windows and reads again until it is gone", async () => {
    const t = (n: number) => 1_000_000n + BigInt(n) * 10n;
    const running = [win(200, 100, t(10)), win(201, 200, t(11))];
    const { host, calls } = fakeHost("win32", [running, [win(201, 200, t(11))], []]);
    // The CLI runs until the first kill.
    const cli = { pid: 200, spawnedAt: 0, alive: () => calls.length === 0 };
    expect(await new OwnedProcessTree(cli, host).end()).toEqual({
      found: 2,
      survivors: 0,
      unknown: false,
    });
    expect(calls).toEqual(["kill 200,201", "kill 201"]);
  });

  it("keeps a Windows Stop confirmed when a second reading comes after the CLI exited", async () => {
    const at = (ms: number) => BigInt(filetimeFromEpochMs(ms));
    const server = win(100, 1, at(1_000));
    const cli = win(200, 100, at(2_000));
    const tool = win(201, 200, at(3_000));
    let exitedAt: number | null = null;
    let toolAlive = true;
    let reads = 0;
    const kills: number[] = [];
    const host: TreeHost = {
      platform: "win32",
      selfPid: 100,
      readProcessList: async () => {
        const rows = [server, ...(exitedAt === null ? [cli] : []), ...(toolAlive ? [tool] : [])];
        // The CLI exits while the first reading is out.
        if (reads++ === 0) exitedAt = 4_000;
        return rows;
      },
      signal: () => {
        throw new Error("no POSIX signal on Windows");
      },
      killVerified: async (entries) => {
        for (const entry of entries) {
          kills.push(entry.pid);
          if (entry.pid === 201) toolAlive = false;
        }
      },
      sleep: async () => {},
      now: () => 0,
    };
    const tree = new OwnedProcessTree(
      { pid: 200, spawnedAt: 0, alive: () => exitedAt === null, exitedAtEpochMs: () => exitedAt },
      host,
    );
    expect(await tree.remember(10_000, true)).toBe(true);
    // The active Stop reads again right before the close; the exited CLI is no longer listed.
    expect(await tree.remember(10_000, true)).toBe(false);
    expect(await tree.end()).toEqual({ found: 1, survivors: 0, unknown: false });
    expect(kills).toEqual([201]);
  });

  it("still holds a Windows Stop when the CLI exited between a reading and the next", async () => {
    const at = (ms: number) => BigInt(filetimeFromEpochMs(ms));
    const cli = win(200, 100, at(2_000));
    let alive = true;
    const fake = fakeHost("win32", [[cli], []]);
    const tree = new OwnedProcessTree(
      { pid: 200, spawnedAt: 0, alive: () => alive, exitedAtEpochMs: () => (alive ? null : 4_000) },
      fake.host,
    );
    // This reading came back while the CLI ran: a tool it started after is not covered.
    expect(await tree.remember(1_000, true)).toBe(true);
    alive = false;
    expect(await tree.remember(1_000, true)).toBe(false);
    expect((await tree.end()).unknown).toBe(true);
  });

  it("ends a helper that a known POSIX tool starts on SIGTERM before the tool dies", async () => {
    const started = "Thu Nov 19 12:03:08 2026";
    const entry = (pid: number, ppid: number, pgid: number): ProcessEntry => ({
      pid,
      ppid,
      pgid,
      started,
      command: `p${pid}`,
    });
    let cliAlive = true;
    let toolAlive = true;
    let helperAlive = false;
    let clock = 0;
    const signals: string[] = [];
    const host: TreeHost = {
      platform: "darwin",
      selfPid: 100,
      readProcessList: async () => [
        ...(cliAlive ? [entry(200, 100, 200)] : []),
        ...(toolAlive ? [entry(201, cliAlive ? 200 : 1, 201)] : []),
        ...(helperAlive ? [entry(202, toolAlive ? 201 : 1, 201)] : []),
      ],
      signal: (pid, signal) => {
        if (signal === 0) {
          if (pid === -200 && cliAlive) return;
          throw Object.assign(new Error("No such process"), { code: "ESRCH" });
        }
        signals.push(`${signal} ${pid}`);
        if (pid === -200 && signal === "SIGTERM") cliAlive = false;
        // The tool's SIGTERM handler starts a helper, and the tool itself hangs.
        if (pid === 201 && signal === "SIGTERM") helperAlive = true;
        if (pid === 201 && signal === "SIGKILL") toolAlive = false;
        if (pid === 202) helperAlive = false;
      },
      killVerified: async () => {
        throw new Error("no Windows kill on POSIX");
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    };
    const tree = new OwnedProcessTree({ pid: 200, spawnedAt: 0, alive: () => cliAlive }, host);
    const result = await tree.end();
    expect(helperAlive).toBe(false);
    expect(signals).toContain("SIGKILL 202");
    expect(result).toEqual({ found: 2, survivors: 0, unknown: false });
  });

  it("ends a detached helper that a POSIX group member starts on SIGTERM", async () => {
    const started = "Thu Nov 19 12:03:08 2026";
    const entry = (pid: number, ppid: number, pgid: number): ProcessEntry => ({
      pid,
      ppid,
      pgid,
      started,
      command: `p${pid}`,
    });
    let clock = 0;
    let toolAlive = true;
    let helperAlive = false;
    const signals: string[] = [];
    const host: TreeHost = {
      platform: "darwin",
      selfPid: 100,
      readProcessList: async () => [
        ...(toolAlive ? [entry(201, 1, 200)] : []),
        ...(helperAlive ? [entry(202, toolAlive ? 201 : 1, 202)] : []),
      ],
      signal: (pid, signal) => {
        if (signal === 0) {
          if (pid === -200 && toolAlive) return;
          throw Object.assign(new Error("No such process"), { code: "ESRCH" });
        }
        signals.push(`${signal} ${pid}`);
        // The tool's SIGTERM handler starts a helper in a session of its own, then hangs.
        if (pid === -200 && signal === "SIGTERM") helperAlive = true;
        if (pid === -200 && signal === "SIGKILL") toolAlive = false;
        if (pid === 202) helperAlive = false;
      },
      killVerified: async () => {
        throw new Error("no Windows kill on POSIX");
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    };
    const tree = new OwnedProcessTree({ pid: 200, spawnedAt: 0, alive: () => false }, host);
    const result = await tree.end();
    expect(helperAlive).toBe(false);
    expect(signals).toContain("SIGKILL 202");
    expect(result.survivors).toBe(0);
    expect(result.unknown).toBe(false);
  });

  it("remembers a Windows survivor its last reading found, for the retry", async () => {
    let clock = 0;
    let read = 0;
    const kills: number[][] = [];
    const at = (pid: number) => BigInt(filetimeFromEpochMs(pid * 10));
    const cli = win(200, 100, at(200));
    const tool = win(201, 200, at(201));
    const helper = win(202, 201, at(202));
    const host: TreeHost = {
      platform: "win32",
      selfPid: 100,
      readProcessList: async () => {
        const tables = [[cli, tool], [tool], [tool, helper], [helper]];
        return tables[read++] ?? (kills.some((pids) => pids.includes(202)) ? [] : [helper]);
      },
      signal: () => {
        throw new Error("no POSIX signal on Windows");
      },
      killVerified: async (entries, timeoutMs) => {
        kills.push(entries.map((entry) => entry.pid));
        // The kill takes the whole budget; the tool exits only after the last reading.
        clock += timeoutMs;
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    };
    let alive = true;
    const tree = new OwnedProcessTree({ pid: 200, spawnedAt: 0, alive: () => alive }, host);
    expect(await tree.remember(10_000, true)).toBe(true);
    alive = false;
    expect(await tree.end()).toEqual({ found: 1, survivors: 2, unknown: false });
    // The tool is gone by the retry; its helper is still known, and is ended.
    expect(await tree.end()).toEqual({ found: 1, survivors: 0, unknown: false });
    expect(kills).toEqual([[201], [202]]);
  });

  describe("POSIX Stop while the group winds down", () => {
    const group = 200;
    const entry = (
      pid: number,
      ppid: number,
      pgid: number,
      started = "original",
    ): ProcessEntry => ({
      pid,
      ppid,
      pgid,
      started,
      command: `p${pid}`,
    });
    const fixture = (
      read: (time: number) => ProcessEntry[] | undefined,
      live: (pid: number) => boolean,
      apply: (pid: number, signal: NodeJS.Signals) => void,
    ) => {
      let time = 0;
      const signals: string[] = [];
      const host: TreeHost = {
        platform: "darwin",
        selfPid: 100,
        readProcessList: async () => read(time),
        signal: (pid, signal) => {
          if (signal === 0) {
            if (live(pid)) return;
            throw Object.assign(new Error("No such process"), { code: "ESRCH" });
          }
          signals.push(`${signal} ${pid}`);
          apply(pid, signal);
        },
        killVerified: async () => {
          throw new Error("no Windows kill on POSIX");
        },
        sleep: async (ms) => {
          time += ms;
        },
        now: () => time,
      };
      return {
        tree: new OwnedProcessTree({ pid: group, spawnedAt: 0, alive: () => false }, host),
        signals,
        now: () => time,
      };
    };

    it.each(["parent exits during grace", "escalation read fails"] as const)(
      "ends a detached helper a member starts on SIGTERM (%s)",
      async (variant) => {
        let peer = true;
        let helper = false;
        let parentExitAt = Infinity;
        const f = fixture(
          (now) => {
            if (variant === "escalation read fails" && now >= 4_000 && peer) return undefined;
            return [
              ...(now < parentExitAt ? [entry(201, 1, group)] : []),
              ...(peer ? [entry(203, 1, group)] : []),
              ...(helper ? [entry(202, now < parentExitAt ? 201 : 1, 202)] : []),
            ];
          },
          (pid) => pid === -group && (peer || f.now() < parentExitAt),
          (pid, signal) => {
            if (pid === -group && signal === "SIGTERM") {
              helper = true;
              if (variant === "parent exits during grace") parentExitAt = 2_000;
            }
            if (pid === -group && signal === "SIGKILL") {
              peer = false;
              parentExitAt = Math.min(parentExitAt, f.now());
            }
            if (pid === 202) helper = false;
          },
        );
        const result = await f.tree.end();
        expect(helper).toBe(false);
        expect(f.signals).toContain("SIGKILL 202");
        expect(result.survivors).toBe(0);
      },
    );

    const member = (pid: number, ppid = 1, pgid = group, started = `t${pid}`) =>
      entry(pid, ppid, pgid, started);

    it("ends a member it saw join the group during grace once it leaves the group", async () => {
      let table = [member(201)];
      let signalled = false;
      const f = fixture(
        (now) => {
          if (table.length === 0) return table;
          if (signalled && now >= 200 && now < 800) table = [member(201), member(202, 201)];
          if (signalled && now >= 800 && now < 1_000) table = [member(202)];
          if (signalled && now >= 1_000) table = [member(202, 1, 202)];
          return table;
        },
        (pid) => pid === -group && table.some((row) => row.pgid === group),
        (pid, signal) => {
          if (pid === -group && signal === "SIGTERM") signalled = true;
          if (pid === 202 && signal === "SIGKILL") table = [];
        },
      );
      const result = await f.tree.end();
      expect(f.signals).toContain("SIGKILL 202");
      expect(table).toEqual([]);
      expect(result).toEqual({ found: 1, survivors: 0, unknown: false });
    });

    it("keeps a Stop unconfirmed on retry once a wind-down reading failed", async () => {
      let table = [member(201)];
      let killedGroup = false;
      const f = fixture(
        (now) => {
          if (now === 4_000 && !killedGroup) {
            table = [member(201), member(202, 201, 202)];
            return undefined;
          }
          return table;
        },
        (pid) => pid === -group && table.some((row) => row.pgid === group),
        (pid, signal) => {
          if (pid === -group && signal === "SIGKILL") {
            killedGroup = true;
            table = [member(202, 1, 202)];
          }
        },
      );
      expect((await f.tree.end()).unknown).toBe(true);
      // The helper now names no parent: a retry cannot prove the tree gone.
      expect((await f.tree.end()).unknown).toBe(true);
    });

    it("never signals the group on a retry after its escalation reading failed", async () => {
      let table = [member(201)];
      let onRetry = false;
      let retryStartedAt = -1;
      let failed = false;
      const f = fixture(
        (now) => {
          if (onRetry && !failed && retryStartedAt >= 0 && now === retryStartedAt + 4_000) {
            failed = true;
            // The last original member exited and the id now leads another job.
            table = [member(200, 1, group, "replacement")];
            return undefined;
          }
          return table;
        },
        (pid) => pid === -group && table.some((row) => row.pgid === group),
        (pid, signal) => {
          if (onRetry && pid === -group && signal === "SIGTERM") retryStartedAt = f.now();
        },
      );
      expect(await f.tree.end()).toEqual({ found: 1, survivors: 1, unknown: false });
      onRetry = true;
      const before = f.signals.length;
      const retry = await f.tree.end();
      expect(f.signals.slice(before)).toEqual(["SIGTERM -200"]);
      expect(retry.unknown).toBe(true);
    });

    it("never signals a group whose id was recycled during a retry, nor its child", async () => {
      const original = entry(201, 1, group);
      const unrelated = entry(group, 1, group, "reused");
      const child = entry(211, group, 211, "reused");
      let table = [original];
      let attempt = 1;
      let reads = 0;
      const f = fixture(
        () => {
          if (attempt === 2 && ++reads === 2) table = [unrelated, child];
          return table;
        },
        (pid) => pid === -group && table.some((row) => row.pgid === group),
        () => {},
      );
      expect(await f.tree.end(1_000)).toEqual({ found: 1, survivors: 1, unknown: false });
      attempt = 2;
      const before = f.signals.length;
      const retry = await f.tree.end(1_000);
      const sent = f.signals.slice(before);
      expect(sent).not.toContain("SIGKILL 211");
      expect(sent).not.toContain("SIGTERM 211");
      expect(sent).not.toContain("SIGKILL -200");
      expect(retry.unknown).toBe(true);
    });
  });
});

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function until(check: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

describe("OwnedProcessTree.end after a lost parent", () => {
  const rootPid = 200;
  const processRow = (pid: number, ppid = 1, pgid = rootPid): ProcessEntry => ({
    pid,
    ppid,
    pgid,
    started: `start-${pid}`,
    command: `tool-${pid}`,
  });
  const windowsRow = (pid: number, ppid: number, created: number): ProcessEntry => ({
    ...processRow(pid, ppid),
    pgid: null,
    started: filetimeFromEpochMs(created),
  });
  const fake = (platform: "darwin" | "win32") => {
    let now = 0;
    let rootAlive = platform === "win32";
    let rootExit: number | null = null;
    let table: ProcessEntry[] = [];
    const signals: string[] = [];
    const kills: number[] = [];
    let read = (): ProcessEntry[] | undefined => table;
    let signal = (_pid: number, _signal: NodeJS.Signals) => {};
    const host: TreeHost = {
      platform,
      selfPid: 100,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      readProcessList: async () => read(),
      signal: (pid, action) => {
        if (action === 0) {
          if (!table.some((row) => row.pgid === rootPid)) {
            throw Object.assign(new Error("No such process"), { code: "ESRCH" });
          }
          return;
        }
        signals.push(`${action} ${pid}`);
        signal(pid, action);
      },
      killVerified: async (entries) => {
        const killed = new Set(entries.map((row) => row.pid));
        kills.push(...killed);
        table = table.filter((row) => !killed.has(row.pid));
      },
    };
    const tree = new OwnedProcessTree(
      { pid: rootPid, spawnedAt: 0, alive: () => rootAlive, exitedAtEpochMs: () => rootExit },
      host,
    );
    return {
      tree,
      signals,
      kills,
      now: () => now,
      setTable: (rows: ProcessEntry[]) => {
        table = rows;
      },
      getTable: () => table,
      setRead: (fn: typeof read) => {
        read = fn;
      },
      onSignal: (fn: typeof signal) => {
        signal = fn;
      },
      exitRootAt: (timestamp: number) => {
        rootAlive = false;
        rootExit = timestamp;
      },
    };
  };

  it("keeps a Windows Stop unconfirmed while a child of an exited known tool runs", async () => {
    const f = fake("win32");
    const server = windowsRow(100, 1, 1000);
    const cli = windowsRow(200, 100, 2000);
    const tool = windowsRow(201, 200, 3000);
    const worker = windowsRow(202, 201, 4000);
    f.setTable([server, cli, tool]);
    expect(await f.tree.remember()).toBe(true);
    // The known tool starts a worker and exits before Stop.
    f.setTable([server, cli, worker]);
    expect(await f.tree.remember(15_000, true)).toBe(false);
    f.setTable([server, worker]);
    f.exitRootAt(5_000);
    expect((await f.tree.end()).unknown).toBe(true);
    // A pid alone never authorizes a kill.
    expect(f.kills).toEqual([]);
  });

  it("keeps doubt on a Windows worker whose launcher, itself in doubt, exits", async () => {
    const f = fake("win32");
    const server = windowsRow(100, 1, 1_000);
    const cli = windowsRow(200, 100, 2_000);
    const tool = windowsRow(201, 200, 3_000);
    const launcher = windowsRow(202, 201, 4_000);
    const worker = windowsRow(203, 202, 4_100);
    f.setTable([server, cli, tool]);
    expect(await f.tree.remember()).toBe(true);
    // The known tool exited; its launcher and the launcher's worker run.
    f.setTable([server, cli, launcher, worker]);
    expect(await f.tree.remember(15_000, true)).toBe(false);
    // The launcher exits too; the worker still runs.
    f.setTable([server, cli, worker]);
    expect(await f.tree.remember(15_000, true)).toBe(false);
    f.setTable([server, worker]);
    f.exitRootAt(6_000);
    expect((await f.tree.end()).unknown).toBe(true);
    expect(f.kills).toEqual([]);
  });

  it("ends a child a verified member left behind in a group no longer provably the CLI's", async () => {
    const f = fake("darwin");
    const member = processRow(201);
    const youngMember = processRow(202, 201);
    const leaver = { ...member, pgid: member.pid };
    const escapedWorker = { ...youngMember, ppid: 1, pgid: youngMember.pid };
    f.setTable([member]);
    let reads = 0;
    f.setRead(() => {
      // Then the parent exits and its child leaves the group, reparented.
      if (++reads === 3 && f.getTable().some((row) => row.pid === 202)) {
        f.setTable([escapedWorker]);
      }
      return f.getTable();
    });
    f.onSignal((pid, action) => {
      // The member forks a child in the group on SIGTERM, then leaves the group itself.
      if (pid === -rootPid && action === "SIGTERM") f.setTable([leaver, youngMember]);
      if (pid === 202) f.setTable(f.getTable().filter((row) => row.pid !== 202));
    });
    const first = await f.tree.end();
    expect(f.signals.some((signal) => signal.endsWith(" 202"))).toBe(true);
    expect(f.getTable().some((row) => row.pid === 202)).toBe(false);
    expect(first.unknown).toBe(true);
    expect((await f.tree.end()).unknown).toBe(true);
  });

  it("keeps doubt on every descendant of a live process already in doubt, across retries", async () => {
    const f = fake("win32");
    const server = windowsRow(100, 1, 1_000);
    const cli = windowsRow(200, 100, 2_000);
    const known = windowsRow(201, 200, 3_000);
    const launcher = windowsRow(202, 201, 4_000);
    const held = windowsRow(203, 202, 4_100);
    const relay = windowsRow(204, 203, 5_000);
    const survivor = windowsRow(205, 204, 5_100);
    f.setTable([server, cli, known]);
    expect(await f.tree.remember()).toBe(true);
    expect(await f.tree.remember(15_000, true)).toBe(true);
    f.exitRootAt(3_500);
    const ends = [];
    for (const rows of [[launcher, held], [held], [held, relay, survivor], [survivor]]) {
      f.setTable([server, ...rows]);
      ends.push(await f.tree.end());
    }
    expect(ends.map((end) => end.unknown)).toEqual([true, true, true, true]);
    expect(f.kills).toEqual([]);
  });

  it("keeps a POSIX Stop unconfirmed once a retry met a group with no member it knew", async () => {
    const f = fake("darwin");
    const tool = processRow(201);
    const worker = processRow(202);
    // The group SIGKILL is refused, so the tool survives the first end.
    f.onSignal((pid, action) => {
      if (action === "SIGKILL" && pid === -rootPid) {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      }
    });
    f.setTable([tool]);
    expect(await f.tree.end()).toMatchObject({ survivors: 1 });
    // The tool started a worker in the group and exited.
    f.setTable([worker]);
    expect((await f.tree.end()).unknown).toBe(true);
    // The worker then left the group.
    f.setTable([{ ...worker, pgid: worker.pid }]);
    expect((await f.tree.end()).unknown).toBe(true);
  });

  it("never takes a POSIX group it may not signal for an empty one", async () => {
    const member: ProcessEntry = {
      pid: 201,
      ppid: 1,
      pgid: 200,
      started: "Thu Nov 19 17:00:00 2026",
      command: "elevated helper",
    };
    let clock = 0;
    const host: TreeHost = {
      platform: "darwin",
      selfPid: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      readProcessList: async () => [member],
      signal: () => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      },
      killVerified: async () => {
        throw new Error("no Windows kill on POSIX");
      },
    };
    const tree = new OwnedProcessTree({ pid: 200, spawnedAt: 0, alive: () => false }, host);
    expect((await tree.end()).unknown).toBe(true);
    expect((await tree.end()).unknown).toBe(true);
  });

  it("keeps doubt on a Windows worker whose parent pid now names another of the tree", async () => {
    const f = fake("win32");
    const server = windowsRow(100, 1, 1_000);
    const cli = windowsRow(200, 100, 2_000);
    const oldParent = windowsRow(201, 200, 3_000);
    const sibling = windowsRow(202, 200, 3_200);
    const worker = windowsRow(203, 201, 4_000);
    const replacement = windowsRow(201, 202, 5_000);
    f.setTable([server, cli, oldParent, sibling]);
    expect(await f.tree.remember(15_000, true)).toBe(true);
    f.exitRootAt(3_600);
    // The old 201 started a worker and exited; 202 started a new process given pid 201.
    f.setTable([server, sibling, replacement, worker]);
    expect((await f.tree.end()).unknown).toBe(true);
    expect(f.kills).not.toContain(203);
  });

  it("keeps doubt on what a doubtful process started once its pid names another", async () => {
    const f = fake("win32");
    const server = windowsRow(100, 1, 1000);
    const cli = windowsRow(200, 100, 2000);
    const original = windowsRow(201, 200, 3000);
    const sibling = windowsRow(202, 200, 3200);
    const doubtful = windowsRow(203, 201, 4000);
    const worker = windowsRow(204, 203, 4500);
    const replacement = windowsRow(203, 202, 5000);
    f.setTable([server, cli, original, sibling]);
    expect(await f.tree.remember(15000, true)).toBe(true);
    f.exitRootAt(3600);
    f.setTable([server, sibling, doubtful]);
    // 203 is in doubt: a child of the known 201, which exited.
    expect((await f.tree.end(400)).unknown).toBe(true);
    // The doubtful 203 started 204 and exited; 202 started another process given pid 203.
    f.setTable([server, sibling, replacement, worker]);
    expect((await f.tree.end(400)).unknown).toBe(true);
    expect(f.kills).not.toContain(204);
  });

  it("keeps a POSIX Stop unconfirmed after meeting a group it may not signal", async () => {
    const original = processRow(201);
    const worker = processRow(202);
    const tables = [[original], [worker], [{ ...worker, pgid: worker.pid }]];
    let reads = 0;
    let clock = 0;
    const host: TreeHost = {
      platform: "darwin",
      selfPid: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      readProcessList: async () => tables[Math.min(reads++, tables.length - 1)]!,
      signal: () => {
        if (reads === 1) return;
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      },
      killVerified: async () => {
        throw new Error("no Windows kill on POSIX");
      },
    };
    const tree = new OwnedProcessTree({ pid: rootPid, spawnedAt: 0, alive: () => false }, host);
    // 201 starts 202 in the group on SIGTERM and exits; 202 cannot be signalled.
    expect((await tree.end()).unknown).toBe(true);
    // 202 then moves to a group of its own.
    expect((await tree.end()).unknown).toBe(true);
  });

  it.each([false, true])(
    "keeps doubt on a Windows worker whose start appears or goes missing (missing first: %s)",
    async (firstMissing) => {
      const f = fake("win32");
      const server = windowsRow(100, 1, 1000);
      const cli = windowsRow(200, 100, 2000);
      const tool = windowsRow(201, 200, 3000);
      const launcher = windowsRow(202, 201, 4000);
      const worker = windowsRow(203, 202, 5000);
      const withoutStart = { ...worker, started: "" };
      const before = firstMissing ? withoutStart : worker;
      const after = firstMissing ? worker : withoutStart;
      f.setTable([server, cli, tool]);
      expect(await f.tree.remember(15000, true)).toBe(true);
      f.exitRootAt(3500);
      const ends = [];
      for (const rows of [[launcher, before], [before], [after]]) {
        f.setTable([server, ...rows]);
        ends.push(await f.tree.end(400));
      }
      expect(ends.map((end) => end.unknown)).toEqual([true, true, true]);
      expect(f.kills).toEqual([]);
    },
  );

  it("keeps doubt when a group member it never saw leaves before the group probe", async () => {
    const tool = processRow(201);
    const worker = processRow(202);
    const moved = { ...worker, pgid: 202 };
    const tables = [[tool], [worker], [moved]];
    let reads = 0;
    let clock = 0;
    let live = tables[0]!;
    const host: TreeHost = {
      platform: "darwin",
      selfPid: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      readProcessList: async () => {
        const sample = tables[Math.min(reads++, tables.length - 1)]!;
        // The worker is listed in the group, then leaves it before the probe.
        if (reads === 2) live = [moved];
        return sample;
      },
      signal: (pid, action) => {
        if (!live.some((entry) => entry.pgid === -pid)) {
          throw Object.assign(new Error("no such process group"), { code: "ESRCH" });
        }
        if (action === "SIGTERM") live = [worker];
      },
      killVerified: async () => {
        throw new Error("no Windows kill on POSIX");
      },
    };
    const tree = new OwnedProcessTree({ pid: rootPid, spawnedAt: 0, alive: () => false }, host);
    expect((await tree.end()).unknown).toBe(true);
    expect((await tree.end()).unknown).toBe(true);
  });

  it("keeps doubt on a Windows worker whose launcher's pid is reused after a missing start", async () => {
    const f = fake("win32");
    const server = windowsRow(100, 1, 1000);
    const cli = windowsRow(200, 100, 2000);
    const tool = windowsRow(201, 200, 3000);
    const launcher = { ...windowsRow(202, 201, 4000), started: "" };
    const replacement = windowsRow(202, 100, 6000);
    const worker = windowsRow(203, 202, 5000);
    f.setTable([server, cli, tool]);
    expect(await f.tree.remember(15000, true)).toBe(true);
    expect(await f.tree.remember(15000, true)).toBe(true);
    f.exitRootAt(3500);
    const ends = [];
    for (const rows of [[launcher], [replacement, worker], [worker], [worker]]) {
      f.setTable([server, ...rows]);
      ends.push(await f.tree.end(400));
    }
    expect(ends.map((end) => end.unknown)).toEqual([true, true, true, true]);
    expect(f.kills).toEqual([]);
  });

  it.each(["darwin", "linux"] as const)(
    "never signals another job's group that leads with the reaped CLI's pid (%s)",
    async (platform) => {
      const exitedAt = Date.UTC(2026, 10, 19, 12);
      // The new job's leader started a minute after the CLI exited.
      const leader = { ...processRow(rootPid), started: new Date(exitedAt + 60_000).toString() };
      let live = true;
      const signals: Array<[number, NodeJS.Signals | 0]> = [];
      let clock = 0;
      const host: TreeHost = {
        platform,
        selfPid: 100,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        readProcessList: async () => (live ? [leader] : []),
        signal: (pid, action) => {
          signals.push([pid, action]);
          if (!live) throw Object.assign(new Error("no such group"), { code: "ESRCH" });
          if (action === "SIGTERM") live = false;
        },
        killVerified: async () => {
          throw new Error("no Windows kill on POSIX");
        },
      };
      const tree = new OwnedProcessTree(
        { pid: rootPid, spawnedAt: 0, alive: () => false, exitedAtEpochMs: () => exitedAt },
        host,
      );
      expect(await tree.end()).toEqual({ found: 0, survivors: 0, unknown: false });
      expect(signals).toEqual([]);
      expect(live).toBe(true);
    },
  );

  it("still signals the CLI's group when a reading from before its exit lists it", async () => {
    const f = fake("darwin");
    const exitedAt = Date.now() - 100;
    // `ps` caught the CLI in the second it exited; Node reaped it just now.
    const cli = { ...processRow(rootPid), started: new Date(exitedAt).toString() };
    const tool = processRow(201, rootPid);
    f.setTable([cli, tool]);
    f.exitRootAt(exitedAt + 900);
    f.onSignal((pid, action) => {
      if (pid === -rootPid && action === "SIGTERM") f.setTable([]);
    });
    expect(await f.tree.end()).toEqual({ found: 2, survivors: 0, unknown: false });
    expect(f.signals).toEqual([`SIGTERM -${rootPid}`]);
  });

  it("keeps a POSIX Stop unconfirmed on retry after its first reading failed", async () => {
    const f = fake("darwin");
    const member = processRow(201);
    const worker = processRow(202, 201, 202);
    f.setTable([member, worker]);
    let reads = 0;
    f.setRead(() => (++reads === 1 ? undefined : f.getTable()));
    f.onSignal((pid, action) => {
      if (pid === -rootPid && action === "SIGTERM") f.setTable([{ ...worker, ppid: 1 }]);
    });
    expect((await f.tree.end()).unknown).toBe(true);
    expect((await f.tree.end()).unknown).toBe(true);
  });

  it("ends the worker of a member that left the group, seen before signalling escapees", async () => {
    const f = fake("darwin");
    const member = processRow(201);
    const escapee = processRow(210, 201, 210);
    const worker = processRow(202, 201, 202);
    f.setTable([member, escapee]);
    let reads = 0;
    f.setRead(() => {
      if (++reads === 3) f.setTable(f.getTable().filter((row) => row.pid === 202));
      return f.getTable().map((row) => (row.pid === 202 && reads >= 3 ? { ...row, ppid: 1 } : row));
    });
    f.onSignal((pid, action) => {
      if (pid === -rootPid && action === "SIGTERM") {
        f.setTable([{ ...member, pgid: 201 }, escapee, worker]);
      }
      if (pid === 202) f.setTable(f.getTable().filter((row) => row.pid !== 202));
    });
    await f.tree.end();
    expect(f.signals).toContain("SIGTERM 202");
    expect(f.getTable().some((row) => row.pid === 202)).toBe(false);
  });

  it("keeps a POSIX Stop unconfirmed on retry after the escapee reading failed", async () => {
    const f = fake("darwin");
    const member = processRow(201);
    const escapee = processRow(210, 201, 210);
    const worker = processRow(202, 210, 202);
    f.setTable([member, escapee]);
    let failed = false;
    f.setRead(() => {
      if (f.now() >= 4_000 && !failed) {
        failed = true;
        f.setTable([escapee, worker]);
        return undefined;
      }
      if (failed) f.setTable([{ ...worker, ppid: 1 }]);
      return f.getTable();
    });
    f.onSignal((pid, action) => {
      if (pid === -rootPid && action === "SIGTERM") f.setTable([{ ...escapee, ppid: 1 }]);
    });
    expect((await f.tree.end()).unknown).toBe(true);
    expect((await f.tree.end()).unknown).toBe(true);
  });
});

describe("on this machine", () => {
  it("reads the process table with a fractional budget", async () => {
    const table = await readProcessList(process.platform, 14_999.75);
    expect(table?.some((entry) => entry.pid === process.pid)).toBe(true);
  }, 30_000);

  it("ends the tool process the spawned CLI left running when it was killed alone", async () => {
    const abort = new AbortController();
    // Stands in for the CLI: it starts a long-running tool, reports its pid and waits.
    const { child, tree, stderrTail } = spawnOwnedProcess({
      command: process.execPath,
      args: [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          "process.stderr.write('started');",
          "process.stdout.write(String(tool.pid) + '\\n');",
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
      env: { ...process.env },
      signal: abort.signal,
    });
    let toolPid = 0;
    try {
      toolPid = await new Promise<number>((resolve, reject) => {
        let text = "";
        child.stdout!.on("data", (chunk: Buffer) => {
          text += chunk.toString();
          if (text.includes("\n")) resolve(Number(text.split("\n")[0]!.trim()));
        });
        child.once("exit", () => reject(new Error("stand-in CLI exited early")));
      });
      expect(alive(toolPid)).toBe(true);
      await tree.remember();
      expect(await until(() => stderrTail() === "started", 5_000)).toBe(true);

      // The SDK ends the CLI alone: TerminateProcess on Windows, a signal elsewhere.
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
      const leftBehind = alive(toolPid);

      const result = await tree.end();
      // Where the OS had not ended the tool with the CLI, the tree end found it.
      if (leftBehind) expect(result.found).toBeGreaterThanOrEqual(1);
      // The real reads ran (a fractional budget once kept them from starting).
      expect(result).toMatchObject({ survivors: 0, unknown: false });
      expect(await until(() => !alive(toolPid), 10_000)).toBe(true);
    } finally {
      abort.abort();
      if (toolPid > 0 && alive(toolPid)) {
        try {
          process.kill(toolPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  }, 60_000);
});
