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
    expect(parseWindowsProcessList("not json")).toEqual([]);
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

  it("finds orphans of the exited CLI, but not children of a newer process with its pid", () => {
    const spawnedAt = 1_800_000_000_000;
    const created = BigInt(filetimeFromEpochMs(spawnedAt)) + 10n;
    const table = [
      // The CLI exited; its tool still runs and still names it as parent.
      win(201, 200, created + 50n, "bash -c npm run dev"),
      // Windows gave pid 200 to a newer process, which started a child of its own.
      win(200, 1, created + 100n, "newer process"),
      win(210, 200, created + 200n, "newer process's child"),
    ];
    expect(windowsTree(table, root(200, false, spawnedAt), 100).map((k) => k.entry.pid)).toEqual([
      201,
    ]);
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
    expect(script).toContain("foreach ($i in @(@(201,1000110))) {");
    expect(script).toContain("-eq [long]$i[1]");
    expect(script).not.toContain("@(9,");
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

  it("checks identity against a fresh read", () => {
    const snapshot = [posix(202, 1, 202), posix(203, 202, 202)];
    expect(
      stillRunning(snapshot, [{ ...posix(202, 1, 202), started: "later" }, posix(203, 1, 202)]).map(
        (e) => e.pid,
      ),
    ).toEqual([203]);
  });
});

function fakeHost(platform: NodeJS.Platform, tables: Array<ReadonlyArray<ProcessEntry>>) {
  const calls: string[] = [];
  let groupAlive = true;
  let clock = 0;
  const host: TreeHost = {
    platform,
    selfPid: 100,
    readProcessList: async () => (tables.length > 1 ? tables.shift() : tables[0]),
    signal: (pid, signal) => {
      if (signal === 0) {
        if (pid < 0 && groupAlive) return;
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      calls.push(`${signal} ${pid}`);
    },
    killVerified: async (entries) => {
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
    expect(result).toEqual({ found: 2, survivors: 1 });
    endGroup();
    expect(await new OwnedProcessTree(root(200, false), host).end(4_000)).toEqual({
      found: 2,
      survivors: 0,
    });
  });

  it("does nothing when the CLI left nothing behind", async () => {
    const { host, calls, endGroup } = fakeHost("darwin", [[]]);
    endGroup();
    expect(await new OwnedProcessTree(root(200, false), host).end()).toEqual({
      found: 0,
      survivors: 0,
    });
    expect(calls).toEqual([]);
  });

  it("never signals group 0 when the spawn gave no pid", async () => {
    const { host, calls } = fakeHost("linux", [[posix(5, 1, 0)]]);
    expect(await new OwnedProcessTree(root(0, false), host).end()).toEqual({
      found: 0,
      survivors: 0,
    });
    expect(calls).toEqual([]);
  });

  it("kills the tree on Windows and reads again until it is gone", async () => {
    const t = (n: number) => 1_000_000n + BigInt(n) * 10n;
    const running = [win(200, 100, t(10)), win(201, 200, t(11))];
    const { host, calls } = fakeHost("win32", [running, [win(201, 200, t(11))], []]);
    expect(await new OwnedProcessTree(root(200, true), host).end()).toEqual({
      found: 2,
      survivors: 0,
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
  it("ends the tool process the spawned CLI left running when it was killed alone", async () => {
    const abort = new AbortController();
    // Stands in for the CLI: it starts a long-running tool, reports its pid and waits.
    const { child, tree } = spawnOwnedProcess({
      command: process.execPath,
      args: [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
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

      // The SDK ends the CLI alone: TerminateProcess on Windows, a signal elsewhere.
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
      const leftBehind = alive(toolPid);

      const result = await tree.end();
      // Where the OS had not ended the tool with the CLI, the tree end found it.
      if (leftBehind) expect(result.found).toBeGreaterThanOrEqual(1);
      expect(result.survivors).toBe(0);
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
