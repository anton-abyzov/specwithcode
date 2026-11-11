import { describe, expect, it } from "vite-plus/test";

import { quitApp } from "./app-quit.ts";

/** The proof's `until` without the clock: a bounded number of polls, the last answer in the error. */
const until =
  (polls: number) =>
  async (what: string, _timeoutMs: number, read: () => boolean | Promise<boolean>) => {
    let last: unknown;
    for (let poll = 0; poll < polls; poll++) {
      try {
        last = await read();
        if (last) return last;
      } catch (error) {
        last = String(error);
      }
    }
    throw new Error(`Timed out waiting for ${what}. Last: ${String(last)}`);
  };

describe("quitApp", () => {
  it("signals a process once, however long it takes to exit", async () => {
    const signals: Array<number> = [];
    // Still shutting down for three polls: a second SIGTERM here would kill Electron outright.
    const pids = [3990, 3990, 3990, null];
    await quitApp({
      appPid: () => pids.shift() ?? null,
      leftovers: () => [],
      signal: (pid) => signals.push(pid),
      until: until(10),
    });
    expect(signals).toEqual([3990]);
  });

  it("signals the process an update relaunched into", async () => {
    const signals: Array<number> = [];
    const pids = [3990, 3990, 4514, 4514, null];
    await quitApp({
      appPid: () => pids.shift() ?? null,
      leftovers: () => [],
      signal: (pid) => signals.push(pid),
      until: until(10),
    });
    expect(signals).toEqual([3990, 4514]);
  });

  it("waits for the app's backend to exit after the app", async () => {
    const left = [["4746 (backend)"], ["4746 (backend)"], []];
    await quitApp({
      appPid: () => null,
      leftovers: () => left.shift() ?? [],
      signal: () => undefined,
      until: until(10),
    });
    expect(left).toEqual([]);
  });

  it("fails naming a backend that outlived the app", async () => {
    await expect(
      quitApp({
        appPid: () => null,
        leftovers: () => ["4746 (/opt/SpecWithCode/specweave-studio-desktop bin.mjs)"],
        signal: () => undefined,
        until: until(3),
      }),
    ).rejects.toThrow(
      "the app quit and left 4746 (/opt/SpecWithCode/specweave-studio-desktop bin.mjs) running",
    );
  });
});
