import * as NodeEvents from "node:events";

import { describe, expect, it } from "vite-plus/test";

import {
  type ConsoleListHelper,
  getConsoleProcessList,
  installConsoleProcessListLookup,
} from "./nodePtyConsoleList.ts";

// Exercises Studio's replacement for node-pty's Windows console-list lookup.
// A fake helper stands in for the forked conpty_console_list_agent on every platform.
const SHELL_PID = 4242;

function fakeFork(driveHelper: (helper: NodeEvents.EventEmitter) => void) {
  const forked: Array<number> = [];
  let killed = 0;
  const fork = (innerPid: number): ConsoleListHelper => {
    forked.push(innerPid);
    const helper = Object.assign(new NodeEvents.EventEmitter(), {
      kill: () => {
        killed += 1;
        return true;
      },
    });
    queueMicrotask(() => driveHelper(helper));
    return helper;
  };
  return { fork, forked, killed: () => killed };
}

describe("node-pty console process list lookup", () => {
  it("returns the helper's list when it replies and then closes", async () => {
    const { fork, forked } = fakeFork((helper) => {
      helper.emit("message", { consoleProcessList: [SHELL_PID, 5001, 5002] });
      helper.emit("exit", 0, null);
      helper.emit("close", 0, null);
    });
    expect(await getConsoleProcessList(SHELL_PID, fork)).toEqual([SHELL_PID, 5001, 5002]);
    expect(forked).toEqual([SHELL_PID]);
  });

  it("keeps waiting for the reply when exit arrives before the IPC message", async () => {
    const { fork } = fakeFork((helper) => {
      helper.emit("exit", 0, null);
      helper.emit("message", { consoleProcessList: [SHELL_PID, 5001] });
      helper.emit("close", 0, null);
    });
    expect(await getConsoleProcessList(SHELL_PID, fork)).toEqual([SHELL_PID, 5001]);
  });

  it("ignores replies without a process list", async () => {
    const { fork } = fakeFork((helper) => {
      helper.emit("message", null);
      helper.emit("message", { consoleProcessList: "nope" });
      helper.emit("message", { consoleProcessList: [SHELL_PID, 5003] });
      helper.emit("close", 0, null);
    });
    expect(await getConsoleProcessList(SHELL_PID, fork)).toEqual([SHELL_PID, 5003]);
  });

  it("falls back to the shell PID when the helper closes without replying", async () => {
    const { fork } = fakeFork((helper) => {
      helper.emit("exit", 1, null);
      helper.emit("close", 1, null);
    });
    // Settles on close: with a timeout far past the test's own, waiting for it would fail.
    expect(await getConsoleProcessList(SHELL_PID, fork, 600_000)).toEqual([SHELL_PID]);
  });

  it("falls back to the shell PID when the helper fails to spawn", async () => {
    const { fork } = fakeFork((helper) => {
      helper.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    });
    expect(await getConsoleProcessList(SHELL_PID, fork)).toEqual([SHELL_PID]);
  });

  it("falls back to the shell PID when fork throws", async () => {
    const fork = (): ConsoleListHelper => {
      throw new Error("fork failed");
    };
    expect(await getConsoleProcessList(SHELL_PID, fork)).toEqual([SHELL_PID]);
  });

  it("kills a silent helper and falls back after the timeout", async () => {
    const { fork, killed } = fakeFork(() => {});
    expect(await getConsoleProcessList(SHELL_PID, fork, 20)).toEqual([SHELL_PID]);
    expect(killed()).toBe(1);
  });

  it("returns no processes before the shell has a PID", async () => {
    const { fork, forked } = fakeFork(() => {});
    expect(await getConsoleProcessList(0, fork)).toEqual([]);
    expect(forked).toEqual([]);
  });

  it("replaces the lookup on a node-pty process's agent and reads the PID at kill time", async () => {
    const upstream = () => Promise.reject(new Error("upstream lookup must not run"));
    const agent = { _innerPid: 0, _getConsoleProcessList: upstream };
    const { fork, forked } = fakeFork((helper) => {
      helper.emit("message", { consoleProcessList: [SHELL_PID, 6001] });
      helper.emit("close", 0, null);
    });
    expect(installConsoleProcessListLookup({ _agent: agent }, fork)).toBe(true);
    agent._innerPid = SHELL_PID;
    expect(await agent._getConsoleProcessList()).toEqual([SHELL_PID, 6001]);
    expect(forked).toEqual([SHELL_PID]);
  });

  it("leaves processes without a Windows agent alone", () => {
    const { fork } = fakeFork(() => {});
    expect(installConsoleProcessListLookup({}, fork)).toBe(false);
    expect(installConsoleProcessListLookup({ _agent: {} }, fork)).toBe(false);
  });
});
