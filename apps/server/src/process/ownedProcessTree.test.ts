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

  it("never signals the CLI's group id on a later try once nobody it saw is in it", async () => {
    // The CLI exited; a tool stayed in its group and survived SIGKILL (stuck in the kernel).
    const stuck = [posix(202, 1, 200, "stuck tool")];
    const { host, calls } = fakeHost("linux", [stuck, stuck, stuck]);
    const tree = new OwnedProcessTree(root(200, false), host);
    expect((await tree.end(1_000)).survivors).toBe(1);
    expect(calls).toEqual(["SIGTERM -200", "SIGKILL -200"]);
    // Still the same tool: the retry signals the group again.
    calls.length = 0;
    await tree.end(1_000);
    expect(calls).toEqual(["SIGTERM -200", "SIGKILL -200"]);
    // The tool ended unseen and the id went to another job's group: left alone.
    calls.length = 0;
    const reused = fakeHost("linux", [[posix(300, 1, 200, "another job")]]);
    Object.assign(host, { readProcessList: reused.host.readProcessList });
    expect(await tree.end(1_000)).toEqual({ found: 0, survivors: 0, unknown: false });
    expect(calls).toEqual([]);
  });

  it("holds back a later try on the CLI's group when the table cannot be read", async () => {
    const stuck = [posix(202, 1, 200, "stuck tool")];
    const { host, calls } = fakeHost("linux", [stuck, stuck, null]);
    const tree = new OwnedProcessTree(root(200, false), host);
    await tree.end(1_000);
    calls.length = 0;
    // The first read of this try fails: nothing ties the group to the CLI any more.
    const tables = [null];
    Object.assign(host, { readProcessList: async () => tables[0] ?? undefined });
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
  });

  it("kills the tree on Windows and reads again until it is gone", async () => {
    const t = (n: number) => 1_000_000n + BigInt(n) * 10n;
    const running = [win(200, 100, t(10)), win(201, 200, t(11))];
    const { host, calls } = fakeHost("win32", [running, [win(201, 200, t(11))], []]);
    expect(await new OwnedProcessTree(root(200, true), host).end()).toEqual({
      found: 2,
      survivors: 0,
      unknown: false,
    });
    expect(calls).toEqual(["kill 200,201", "kill 201"]);
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
