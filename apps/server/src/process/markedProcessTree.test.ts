// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- spawns a real process tree and waits on wall-clock time for it to end.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";

import {
  type MarkedTreeHost,
  type ProcessEntry,
  claudeSessionFlags,
  endSnapshotSurvivors,
  markedProcessTree,
  parsePosixProcessList,
  parseWindowsProcessList,
  snapshotMarkedTree,
  stillRunning,
} from "./markedProcessTree.ts";

const entry = (pid: number, ppid: number, command: string, started = `t${pid}`): ProcessEntry => ({
  pid,
  ppid,
  started,
  command,
});

const table: ProcessEntry[] = [
  entry(100, 1, "node server.mjs"),
  entry(200, 100, "claude --output-format stream-json --session-id=abc"),
  entry(201, 200, "bash -c npm test"),
  entry(202, 201, "node vitest"),
  // A command line that could not be read is never a target.
  entry(203, 200, ""),
  entry(300, 100, "claude --resume=other"),
  // Another session's tool that merely mentions the id.
  entry(301, 300, "bash -c grep --session-id=abc log.txt"),
  // Not below the server: a CLI someone started in a terminal.
  entry(400, 1, "claude --session-id=abc"),
];
const flags = claudeSessionFlags("abc");

describe("process lists", () => {
  it("reads ps output with start times and spaces in command lines", () => {
    expect(
      parsePosixProcessList(
        "  100     1 Thu Nov 19 12:03:08 2026 node server.mjs\n" +
          "  200   100 Thu Nov  9 02:03:08 2026 claude --session-id=abc x\n" +
          "garbage\n",
      ),
    ).toEqual([
      { pid: 100, ppid: 1, started: "Thu Nov 19 12:03:08 2026", command: "node server.mjs" },
      {
        pid: 200,
        ppid: 100,
        started: "Thu Nov 9 02:03:08 2026",
        command: "claude --session-id=abc x",
      },
    ]);
  });

  it("reads PowerShell JSON, one row or many, with hidden command lines", () => {
    expect(
      parseWindowsProcessList(
        '{"ProcessId":4,"ParentProcessId":0,"Start":null,"CommandLine":null}',
      ),
    ).toEqual([{ pid: 4, ppid: 0, started: "", command: "" }]);
    expect(
      parseWindowsProcessList(
        '[{"ProcessId":10,"ParentProcessId":4,"Start":133000000000000000,"CommandLine":"C:\\\\claude.exe \\"--resume=abc\\""},{"ProcessId":"x"}]',
      ),
    ).toEqual([
      { pid: 10, ppid: 4, started: "133000000000000000", command: 'C:\\claude.exe "--resume=abc"' },
    ]);
    expect(parseWindowsProcessList("not json")).toEqual([]);
  });
});

describe("markedProcessTree", () => {
  it("takes the server's own child carrying the session flag, with what it started", () => {
    expect(markedProcessTree(table, 100, flags).map((row) => row.pid)).toEqual([200, 201, 202]);
    expect(
      markedProcessTree(table, 100, claudeSessionFlags("other")).map((row) => row.pid),
    ).toEqual([300, 301]);
  });

  it("matches a quoted Windows argument", () => {
    expect(
      markedProcessTree([entry(10, 4, 'C:\\claude.exe "--resume=abc"')], 4, flags).map(
        (row) => row.pid,
      ),
    ).toEqual([10]);
  });

  it("never takes a grandchild, a partial match or an ambiguous pair for the CLI", () => {
    // Only a tool below another CLI carries the flag.
    expect(markedProcessTree(table.slice(5), 100, flags)).toEqual([]);
    expect(markedProcessTree([entry(10, 4, "claude --session-id=abcd")], 4, flags)).toEqual([]);
    expect(
      markedProcessTree(
        [entry(10, 4, "claude --session-id=abc"), entry(11, 4, "claude --resume=abc")],
        4,
        flags,
      ),
    ).toEqual([]);
    expect(markedProcessTree(table, 100, [])).toEqual([]);
  });

  it("never lists the server, even from a corrupt table", () => {
    expect(
      markedProcessTree(
        [entry(5, 6, "claude --session-id=abc"), entry(6, 5, "node server.mjs")],
        6,
        flags,
      ).map((row) => row.pid),
    ).toEqual([5]);
  });

  it("treats a pid that started again, or now runs another command, as gone", () => {
    const snapshot = [entry(201, 200, "bash -c npm test"), entry(202, 201, "node vitest")];
    expect(
      stillRunning(snapshot, [
        // Same pid and command line, but a new process.
        entry(201, 1, "bash -c npm test", "later"),
        entry(202, 1, "node vitest"),
      ]).map((row) => row.pid),
    ).toEqual([202]);
    expect(stillRunning([entry(9, 1, "", "")], [entry(9, 1, "", "")])).toEqual([]);
  });
});

function fakeHost(
  platform: NodeJS.Platform,
  tables: Array<ReadonlyArray<ProcessEntry> | undefined>,
) {
  const calls: string[] = [];
  const host: MarkedTreeHost = {
    platform,
    ancestorPid: 100,
    readProcessList: async () => tables.shift(),
    signal: (pid, signal) => {
      calls.push(`${signal} ${pid}`);
    },
    taskkill: async (pid, tree) => {
      calls.push(`taskkill${tree ? " /T" : ""} ${pid}`);
    },
    sleep: async () => {},
  };
  return { host, calls };
}

describe("endSnapshotSurvivors", () => {
  const snapshot = markedProcessTree(table, 100, flags);
  // The SDK ended the CLI; its tools were reparented and still run.
  const afterClose = [entry(201, 1, "bash -c npm test"), entry(202, 201, "node vitest")];

  it("ends each orphan on Windows on its own, checking it again right before", async () => {
    const reused = [entry(201, 1, "bash -c npm test"), entry(202, 9, "node vitest", "reused")];
    const { host, calls } = fakeHost("win32", [afterClose, afterClose, reused]);
    expect(await endSnapshotSurvivors(snapshot, host)).toBe(2);
    expect(calls).toEqual(["taskkill 201"]);
  });

  it("ends the CLI's whole tree on Windows while the CLI is still the same process", async () => {
    const running = table.slice(1, 4);
    const { host, calls } = fakeHost("win32", [running, [], []]);
    expect(await endSnapshotSurvivors(snapshot, host)).toBe(3);
    expect(calls).toEqual(["taskkill /T 200"]);
  });

  it("sends SIGTERM, then SIGKILL to what ignored it, on macOS and Linux", async () => {
    const { host, calls } = fakeHost("linux", [afterClose, [afterClose[1]!]]);
    expect(await endSnapshotSurvivors(snapshot, host)).toBe(2);
    expect(calls).toEqual(["SIGTERM 201", "SIGTERM 202", "SIGKILL 202"]);
  });

  it("does nothing when everything stopped or the table cannot be read", async () => {
    const stopped = fakeHost("darwin", [[]]);
    expect(await endSnapshotSurvivors(snapshot, stopped.host)).toBe(0);
    expect(stopped.calls).toEqual([]);
    const unreadable = fakeHost("win32", [undefined]);
    expect(await endSnapshotSurvivors(snapshot, unreadable.host)).toBe(0);
    expect(unreadable.calls).toEqual([]);
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
  it("ends the tool process a killed CLI left running", async () => {
    const sessionId = randomUUID();
    // Stands in for the CLI: it starts a long-running tool, reports its pid and waits.
    const parent = spawn(
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          "process.stdout.write(String(tool.pid) + '\\n');",
          "setInterval(() => {}, 1000);",
        ].join(" "),
        // After `--`, node hands the flag to the script instead of reading it as its own.
        "--",
        `--session-id=${sessionId}`,
      ],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let toolPid = 0;
    try {
      toolPid = await new Promise<number>((resolve, reject) => {
        let text = "";
        parent.stdout!.on("data", (chunk: Buffer) => {
          text += chunk.toString();
          if (text.includes("\n")) resolve(Number(text.split("\n")[0]!.trim()));
        });
        parent.once("exit", () => reject(new Error("stand-in CLI exited early")));
      });
      expect(alive(toolPid)).toBe(true);

      const snapshot = await snapshotMarkedTree(claudeSessionFlags(sessionId));
      expect(snapshot.map((row) => row.pid)).toEqual(expect.arrayContaining([parent.pid, toolPid]));

      // The SDK ends the CLI alone: TerminateProcess on Windows, a signal elsewhere.
      const exited = new Promise((resolve) => parent.once("exit", resolve));
      parent.kill("SIGKILL");
      await exited;
      expect(alive(toolPid)).toBe(true);

      expect(await endSnapshotSurvivors(snapshot)).toBeGreaterThanOrEqual(1);
      expect(await until(() => !alive(toolPid), 10_000)).toBe(true);
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
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
