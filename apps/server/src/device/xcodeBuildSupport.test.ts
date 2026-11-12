import { describe, expect, it } from "vite-plus/test";

import { type DeveloperToolRunner, runDeveloperTool } from "./iosSimulatorSupport.ts";
import { XCODEBUILD_TIMEOUT_MS, makeXcodeBuildCheck } from "./xcodeBuildSupport.ts";

/** Answers like the tools would, and records what was run instead of running it. */
const fakeTools = (answers: { readonly selected?: string; readonly xcodebuild: boolean }) => {
  const calls: Array<{ command: string; args: ReadonlyArray<string>; timeoutMs?: number }> = [];
  const run: DeveloperToolRunner = async (command, args, timeoutMs) => {
    calls.push({ command, args, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    if (command === "xcode-select")
      return answers.selected === undefined
        ? { ok: false, stdout: "" }
        : { ok: true, stdout: `${answers.selected}\n` };
    return { ok: answers.xcodebuild, stdout: answers.xcodebuild ? "Xcode 26.1\n" : "" };
  };
  return { calls, run };
};

describe("makeXcodeBuildCheck", () => {
  it("is yes when the selected Xcode's xcodebuild -version exits 0", async () => {
    const tools = fakeTools({
      selected: "/Applications/Xcode.app/Contents/Developer",
      xcodebuild: true,
    });
    expect(await makeXcodeBuildCheck({ os: "darwin", run: tools.run })()).toBe(true);
    expect(tools.calls.map((call) => [call.command, call.args])).toEqual([
      ["xcode-select", ["-p"]],
      ["/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild", ["-version"]],
    ]);
    expect(tools.calls[1]!.timeoutMs).toBe(XCODEBUILD_TIMEOUT_MS);
    expect(XCODEBUILD_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
  });

  it("is no when xcodebuild exits non-zero, as with Command Line Tools alone", async () => {
    const tools = fakeTools({ selected: "/Library/Developer/CommandLineTools", xcodebuild: false });
    expect(await makeXcodeBuildCheck({ os: "darwin", run: tools.run })()).toBe(false);
    const nothingSelected = fakeTools({ xcodebuild: true });
    expect(await makeXcodeBuildCheck({ os: "darwin", run: nothingSelected.run })()).toBe(false);
    expect(nothingSelected.calls).toHaveLength(1);
  });

  it("is unknown, not no, when xcodebuild does not answer in time", async () => {
    const timedOut: DeveloperToolRunner = async (command) =>
      command === "xcode-select"
        ? { ok: true, stdout: "/Applications/Xcode.app/Contents/Developer\n" }
        : { ok: false, stdout: "", timedOut: true };
    expect(await makeXcodeBuildCheck({ os: "darwin", run: timedOut })()).toBeUndefined();
    // A stand-in that hangs, stopped by the runner's own time limit.
    const run: DeveloperToolRunner = (command) =>
      command === "xcode-select"
        ? Promise.resolve({ ok: true, stdout: "/Applications/Xcode.app/Contents/Developer\n" })
        : runDeveloperTool(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], 100);
    expect(await makeXcodeBuildCheck({ os: "darwin", run })()).toBeUndefined();
  });

  it("is no when a stand-in exits non-zero through the real runner", async () => {
    const run: DeveloperToolRunner = (command) =>
      command === "xcode-select"
        ? Promise.resolve({ ok: true, stdout: "/Applications/Xcode.app/Contents/Developer\n" })
        : runDeveloperTool(process.execPath, ["-e", "process.exit(1)"], 5_000);
    expect(await makeXcodeBuildCheck({ os: "darwin", run })()).toBe(false);
  });

  it("is no without running anything on a machine that is not a Mac", async () => {
    for (const os of ["linux", "win32"]) {
      const tools = fakeTools({ selected: "/opt/xcode", xcodebuild: true });
      expect(await makeXcodeBuildCheck({ os, run: tools.run })()).toBe(false);
      expect(tools.calls).toEqual([]);
    }
  });
});
