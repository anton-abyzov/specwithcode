// @effect-diagnostics nodeBuiltinImport:off -- Spawns a real child process to read its state.
import * as NodeChildProcess from "node:child_process";

import { describe, expect, it } from "@effect/vitest";

import { isExitingProcessState, isProcessExiting, readProcessState } from "./processExitState.ts";

describe("isExitingProcessState", () => {
  it("counts exiting and zombie states as exiting", () => {
    for (const state of ["?E", "E", "SE", "Z", "Z+", "Zs", "  Z", " ?E ", "X", "x"]) {
      expect(isExitingProcessState(state), state).toBe(true);
    }
  });

  it("keeps running, sleeping, stopped and traced states as running", () => {
    for (const state of ["S", "Ss", "S+", "R+", "  Ss", "I", "U", "D", "T", "SX", "Rs<", "SNs"]) {
      expect(isExitingProcessState(state), state).toBe(false);
    }
  });
});

describe("isProcessExiting", () => {
  it("is false when the state cannot be read", () => {
    expect(isProcessExiting(123, () => null)).toBe(false);
  });

  it("follows the state the reader returns", () => {
    expect(isProcessExiting(123, () => "?E")).toBe(true);
    expect(isProcessExiting(123, () => "Ss")).toBe(false);
  });
});

// oxlint-disable-next-line studio/no-global-process-runtime -- `ps` and /proc exist only on the real host.
describe.skipIf(process.platform === "win32")("readProcessState", () => {
  it("reads a running state for a live child process", async () => {
    const child = NodeChildProcess.spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
      stdio: "ignore",
    });
    try {
      const pid = child.pid;
      expect(pid).toBeTypeOf("number");
      const state = readProcessState(pid as number);
      expect(state).not.toBeNull();
      expect(isExitingProcessState(state as string)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });

  it("returns null for a pid that does not exist", () => {
    expect(readProcessState(2 ** 22 + 12_345)).toBeNull();
  });
});
