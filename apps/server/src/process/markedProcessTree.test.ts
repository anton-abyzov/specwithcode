// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- spawns a real process tree and waits on wall-clock time for it to end.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";

import {
  type MarkedTreeHost,
  type ProcessEntry,
  endSnapshotSurvivors,
  markedProcessTree,
  parsePosixProcessList,
  parseWindowsProcessList,
  snapshotMarkedTree,
  stillRunning,
} from "./markedProcessTree.ts";

const table: ProcessEntry[] = [
  { pid: 100, ppid: 1, command: "node server.mjs" },
  { pid: 200, ppid: 100, command: "claude --output-format stream-json --session-id=abc" },
  { pid: 201, ppid: 200, command: "bash -c npm test" },
  { pid: 202, ppid: 201, command: "node vitest" },
  { pid: 300, ppid: 100, command: "claude --resume=other" },
  { pid: 301, ppid: 300, command: "bash -c sleep 100" },
  // Not below the server: a CLI someone started in a terminal.
  { pid: 400, ppid: 1, command: "claude --session-id=abc" },
];

describe("process lists", () => {
  it("reads ps output with spaces in command lines", () => {
    expect(
      parsePosixProcessList("  100     1 node server.mjs\n  200   100 claude --session-id=abc x\n"),
    ).toEqual([
      { pid: 100, ppid: 1, command: "node server.mjs" },
      { pid: 200, ppid: 100, command: "claude --session-id=abc x" },
    ]);
  });

  it("reads PowerShell JSON, one row or many, with hidden command lines", () => {
    expect(
      parseWindowsProcessList('{"ProcessId":4,"ParentProcessId":0,"CommandLine":null}'),
    ).toEqual([{ pid: 4, ppid: 0, command: "" }]);
    expect(
      parseWindowsProcessList(
        '[{"ProcessId":10,"ParentProcessId":4,"CommandLine":"C:\\\\claude.exe --resume=abc"},{"ProcessId":"x"}]',
      ),
    ).toEqual([{ pid: 10, ppid: 4, command: "C:\\claude.exe --resume=abc" }]);
    expect(parseWindowsProcessList("not json")).toEqual([]);
  });
});

describe("markedProcessTree", () => {
  it("finds the CLI below the server by its marker, with everything it started", () => {
    expect(markedProcessTree(table, 100, "abc").map((entry) => entry.pid)).toEqual([200, 201, 202]);
    expect(markedProcessTree(table, 100, "other").map((entry) => entry.pid)).toEqual([300, 301]);
  });

  it("finds nothing for an unknown or empty marker", () => {
    expect(markedProcessTree(table, 100, "missing")).toEqual([]);
    expect(markedProcessTree(table, 100, "")).toEqual([]);
  });

  it("survives a cycle in a corrupt table", () => {
    expect(
      markedProcessTree(
        [
          { pid: 5, ppid: 6, command: "a marker" },
          { pid: 6, ppid: 5, command: "b" },
        ],
        6,
        "marker",
      ).map((entry) => entry.pid),
    ).toEqual([5]);
  });

  it("treats a pid that now runs another command as gone", () => {
    expect(
      stillRunning(table.slice(1, 3), [
        { pid: 200, ppid: 100, command: "something else" },
        { pid: 201, ppid: 1, command: "bash -c npm test" },
      ]).map((entry) => entry.pid),
    ).toEqual([201]);
  });
});

function fakeHost(platform: NodeJS.Platform, tables: ProcessEntry[][]) {
  const calls: string[] = [];
  const host: MarkedTreeHost = {
    platform,
    ancestorPid: 100,
    readProcessList: async () => tables.shift(),
    signal: (pid, signal) => {
      calls.push(`${signal} ${pid}`);
    },
    taskkillTree: async (pid) => {
      calls.push(`taskkill /T ${pid}`);
    },
    sleep: async () => {},
  };
  return { host, calls };
}

describe("endSnapshotSurvivors", () => {
  const snapshot = markedProcessTree(table, 100, "abc");
  // The SDK ended the CLI; its tools were reparented and still run.
  const afterClose = [
    { pid: 201, ppid: 1, command: "bash -c npm test" },
    { pid: 202, ppid: 201, command: "node vitest" },
  ];

  it("ends each survivor's tree with taskkill on Windows", async () => {
    const { host, calls } = fakeHost("win32", [afterClose]);
    expect(await endSnapshotSurvivors(snapshot, host)).toBe(2);
    expect(calls).toEqual(["taskkill /T 201", "taskkill /T 202"]);
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
    const unreadable = fakeHost("win32", []);
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
    const marker = `marked-tree-test-${randomUUID()}`;
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
        marker,
      ],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let toolPid = 0;
    try {
      toolPid = await new Promise<number>((resolve, reject) => {
        let text = "";
        parent.stdout!.on("data", (chunk: Buffer) => {
          text += chunk.toString();
          const line = text.split("\n")[0]!;
          if (text.includes("\n")) resolve(Number(line.trim()));
        });
        parent.once("exit", () => reject(new Error("stand-in CLI exited early")));
      });
      expect(alive(toolPid)).toBe(true);

      const snapshot = await snapshotMarkedTree(marker);
      expect(snapshot.map((entry) => entry.pid)).toEqual(
        expect.arrayContaining([parent.pid, toolPid]),
      );

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
