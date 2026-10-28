// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
    readFileSync: vi.fn(actual.readFileSync),
    readlinkSync: vi.fn(actual.readlinkSync),
  };
});

import { makePosixProcessTreeController } from "./AcpSessionRuntime.ts";

afterEach(() => vi.mocked(NodeFS.readdirSync).mockReset());

describe("Linux ACP process snapshots", () => {
  it("keeps live identities when another proc entry disappears during enumeration", () => {
    vi.mocked(NodeFS.readdirSync).mockImplementation(((path, options) => {
      expect(path).toBe("/proc");
      // Node's Dirent fallback lstat can throw before per-PID reads run.
      if (options) throw Object.assign(new Error("PID exited during lstat"), { code: "ENOENT" });
      return ["123", "124", "self", "123junk"];
    }) as typeof NodeFS.readdirSync);
    vi.mocked(NodeFS.readFileSync).mockImplementation(((path) => {
      if (path === "/proc/123/stat")
        return `123 (agent) S 1 123 123 ${Array(15).fill("0").join(" ")} 99`;
      throw Object.assign(new Error("PID exited before stat read"), { code: "ENOENT" });
    }) as typeof NodeFS.readFileSync);
    vi.mocked(NodeFS.readlinkSync).mockReturnValue("/bin/agent");

    expect(makePosixProcessTreeController("linux").snapshot()).toEqual([
      {
        pid: 123,
        ppid: 1,
        pgid: 123,
        sid: 123,
        startTime: "99",
        state: "S",
        executable: "/bin/agent",
      },
    ]);
    expect(NodeFS.readdirSync).toHaveBeenCalledWith("/proc");
    expect(NodeFS.readFileSync).toHaveBeenCalledTimes(2);
  });
});
