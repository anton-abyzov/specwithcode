// @effect-diagnostics globalDate:off - fixed clock for the report.
import { describe, expect, it } from "vite-plus/test";

import {
  checkPrivacyAccess,
  outerAppBundle,
  readAncestorExecutables,
  resolveAgentHost,
  type ProbeAnswer,
} from "./privacyAccess.ts";

const now = () => new Date("2026-11-18T12:00:00.000Z");
const answers =
  (byPath: Record<string, ProbeAnswer>, fallback: ProbeAnswer = "missing") =>
  async (path: string) =>
    byPath[path] ?? fallback;
const SAFARI = "/Users/u/Library/Safari";
const TCC = "/Users/u/Library/Application Support/com.apple.TCC";

describe("resolveAgentHost", () => {
  it("names the app when the service runs inside SpecWithCode.app", () => {
    expect(
      resolveAgentHost("/Applications/SpecWithCode.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper", []),
    ).toEqual({ kind: "app", path: "/Applications/SpecWithCode.app", name: "SpecWithCode" });
  });

  it("names the app when an ancestor is the app", () => {
    expect(
      resolveAgentHost("/usr/local/bin/node", [
        "/Applications/SpecWithCode.app/Contents/MacOS/SpecWithCode",
        "/sbin/launchd",
      ]).kind,
    ).toBe("app");
  });

  it("names the service's own executable under launchd", () => {
    expect(resolveAgentHost("/Users/u/.nvm/versions/node/v22.20.0/bin/node", ["/sbin/launchd"])).toEqual({
      kind: "executable",
      path: "/Users/u/.nvm/versions/node/v22.20.0/bin/node",
      name: "node",
    });
  });

  it("finds the outermost bundle only", () => {
    expect(outerAppBundle("/A.app/Contents/B.app/Contents/MacOS/b")).toBe("/A.app");
    expect(outerAppBundle("/usr/bin/node")).toBeNull();
  });
});

describe("readAncestorExecutables", () => {
  it("walks ps output up to launchd", () => {
    const table: Record<number, string> = {
      40: "30 /bin/zsh",
      30: "1 /Applications/SpecWithCode.app/Contents/MacOS/SpecWithCode",
    };
    expect(readAncestorExecutables(40, (pid) => table[pid] ?? null)).toEqual([
      "/bin/zsh",
      "/Applications/SpecWithCode.app/Contents/MacOS/SpecWithCode",
    ]);
  });
});

describe("checkPrivacyAccess", () => {
  const base = { platform: "darwin" as const, homeDir: "/Users/u", execPath: "/opt/node", ancestors: () => [], now };

  it("is not applicable off macOS", async () => {
    for (const platform of ["linux", "win32"] as const) {
      expect(await checkPrivacyAccess({ platform, now })).toEqual({
        checkedAt: "2026-11-18T12:00:00.000Z",
        fullDiskAccess: "not-applicable",
        agentHost: null,
        runningAgentsNeedRestart: false,
      });
    }
  });

  it("reports not-allowed when macOS refuses the child", async () => {
    const result = await checkPrivacyAccess({
      ...base,
      inChild: answers({ [TCC]: "denied" }),
      inProcess: answers({ [TCC]: "denied" }),
    });
    expect(result.fullDiskAccess).toBe("not-allowed");
    expect(result.agentHost?.path).toBe("/opt/node");
  });

  it("reports allowed, and a restart for running agents when only the child has it", async () => {
    const result = await checkPrivacyAccess({
      ...base,
      inChild: answers({ [TCC]: "allowed" }),
      inProcess: answers({ [TCC]: "denied" }),
    });
    expect(result.fullDiskAccess).toBe("allowed");
    expect(result.runningAgentsNeedRestart).toBe(true);
  });

  it("falls back to the next protected folder when one is missing", async () => {
    const result = await checkPrivacyAccess({
      ...base,
      inChild: answers({ [TCC]: "missing", [SAFARI]: "allowed" }),
      inProcess: answers({ [SAFARI]: "allowed" }),
    });
    expect(result).toMatchObject({ fullDiskAccess: "allowed", runningAgentsNeedRestart: false });
  });

  it("asks the TCC folder first, so an App Data grant on Safari cannot pass for Full Disk Access", async () => {
    const result = await checkPrivacyAccess({
      ...base,
      inChild: answers({ [TCC]: "denied", [SAFARI]: "allowed" }),
      inProcess: answers({ [TCC]: "denied" }),
    });
    expect(result.fullDiskAccess).toBe("not-allowed");
  });

  it("tries the next folder when one probe fails", async () => {
    const result = await checkPrivacyAccess({
      ...base,
      inChild: answers({ [TCC]: "failed", [SAFARI]: "denied" }),
      inProcess: answers({}),
    });
    expect(result.fullDiskAccess).toBe("not-allowed");
  });

  it("is unknown when the probe fails or nothing exists", async () => {
    expect((await checkPrivacyAccess({ ...base, inChild: answers({}, "failed") })).fullDiskAccess).toBe(
      "unknown",
    );
    expect((await checkPrivacyAccess({ ...base, inChild: answers({}) })).fullDiskAccess).toBe("unknown");
  });
});
