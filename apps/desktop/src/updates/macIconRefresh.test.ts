// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fixtures write a fake app bundle and user data folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fixtures write a fake app bundle and user data folder.
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  DOCK_RESTART_PROMPT,
  ICON_REFRESH_FILE,
  parseIconRefreshRecord,
  planIconRefresh,
  refreshMacIconAfterUpdate,
  type IconRefreshTools,
} from "./macIconRefresh.ts";

const EXEC = "/Applications/SpecWithCode.app/Contents/MacOS/SpecWithCode";
const base = {
  platform: "darwin" as NodeJS.Platform,
  isPackaged: true,
  execPath: EXEC,
  appVersion: "1.0.345",
  iconStamp: "Assets.car:new",
  hadPriorLaunch: true,
};

describe("planIconRefresh", () => {
  it("skips off macOS, unpackaged and temporary copies", () => {
    expect(planIconRefresh({ ...base, platform: "linux", previous: null }).kind).toBe("skip");
    expect(planIconRefresh({ ...base, isPackaged: false, previous: null }).kind).toBe("skip");
    expect(
      planIconRefresh({
        ...base,
        execPath: "/Volumes/SpecWithCode/SpecWithCode.app/Contents/MacOS/SpecWithCode",
        previous: null,
      }),
    ).toEqual({ kind: "skip", reason: "temporary-copy" });
  });

  it("runs once per version", () => {
    expect(
      planIconRefresh({ ...base, previous: { version: "1.0.345", iconStamp: "Assets.car:new" } }),
    ).toEqual({ kind: "skip", reason: "same-version" });
  });

  it("re-registers after an update and offers a Dock reload only when the icon changed", () => {
    expect(
      planIconRefresh({ ...base, previous: { version: "1.0.344", iconStamp: "Assets.car:new" } }),
    ).toEqual({
      kind: "refresh",
      bundle: "/Applications/SpecWithCode.app",
      offerDockRestart: false,
    });
    expect(
      planIconRefresh({ ...base, previous: { version: "1.0.341", iconStamp: "icon.icns:old" } }),
    ).toMatchObject({ kind: "refresh", offerDockRestart: true });
  });

  it("offers the reload on the first launch after updating from a version without the record", () => {
    expect(planIconRefresh({ ...base, previous: null })).toMatchObject({
      kind: "refresh",
      offerDockRestart: true,
    });
    // A new install has nothing cached to replace.
    expect(planIconRefresh({ ...base, previous: null, hadPriorLaunch: false })).toMatchObject({
      kind: "refresh",
      offerDockRestart: false,
    });
  });
});

describe("parseIconRefreshRecord", () => {
  it("reads a saved record and rejects junk", () => {
    expect(parseIconRefreshRecord('{"version":"1.0.1","iconStamp":"x"}')).toEqual({
      version: "1.0.1",
      iconStamp: "x",
    });
    expect(parseIconRefreshRecord("not json")).toBeNull();
    expect(parseIconRefreshRecord('{"iconStamp":"x"}')).toBeNull();
    expect(parseIconRefreshRecord(null)).toBeNull();
  });
});

describe("refreshMacIconAfterUpdate", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  function fixture(options: { prior: boolean }) {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-icon-refresh-"));
    scratch.push(root);
    const bundle = NodePath.join(root, "SpecWithCode.app");
    NodeFS.mkdirSync(NodePath.join(bundle, "Contents", "Resources"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(bundle, "Contents", "MacOS"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(bundle, "Contents", "Resources", "Assets.car"), "icon");
    const workDir = NodePath.join(root, "userdata");
    NodeFS.mkdirSync(workDir);
    if (options.prior) NodeFS.writeFileSync(NodePath.join(workDir, "environment-id"), "env");
    const calls: string[] = [];
    const tools: IconRefreshTools = {
      touch: async (path) => {
        calls.push(`touch ${path}`);
      },
      lsregister: async (args) => {
        calls.push(`lsregister ${args.join(" ")}`);
      },
      clearDockIconCache: async () => {
        calls.push("clear dock icon cache");
      },
      dockPids: async () => [4242],
      kill: (pid) => calls.push(`kill ${pid}`),
    };
    return {
      bundle,
      workDir,
      calls,
      tools,
      execPath: NodePath.join(bundle, "Contents", "MacOS", "SpecWithCode"),
    };
  }

  it("registers the bundle, records the version and reloads the Dock only when asked", async () => {
    const f = fixture({ prior: true });
    const asked: string[] = [];
    const host = {
      platform: "darwin" as NodeJS.Platform,
      isPackaged: true,
      execPath: f.execPath,
      appVersion: "1.0.345",
      workDir: f.workDir,
      log: () => undefined,
      tools: f.tools,
    };
    await refreshMacIconAfterUpdate({
      ...host,
      ask: async (prompt) => {
        asked.push(prompt.title);
        return 1;
      },
    });
    expect(asked).toEqual([DOCK_RESTART_PROMPT.title]);
    expect(f.calls).toEqual([`touch ${f.bundle}`, `lsregister -f ${f.bundle}`]);
    const record = parseIconRefreshRecord(
      NodeFS.readFileSync(NodePath.join(f.workDir, ICON_REFRESH_FILE), "utf8"),
    );
    expect(record?.version).toBe("1.0.345");
    expect(record?.iconStamp).toMatch(/^Assets\.car:/);

    // Same version again: nothing runs, nothing is asked.
    f.calls.length = 0;
    await refreshMacIconAfterUpdate({ ...host, ask: async () => 0 });
    expect(f.calls).toEqual([]);

    // Next version with a new icon, and the user agrees.
    NodeFS.writeFileSync(NodePath.join(f.bundle, "Contents", "Resources", "Assets.car"), "icon2");
    await refreshMacIconAfterUpdate({ ...host, appVersion: "1.0.346", ask: async () => 0 });
    expect(f.calls).toEqual([
      `touch ${f.bundle}`,
      `lsregister -f ${f.bundle}`,
      "clear dock icon cache",
      "kill 4242",
    ]);
  });

  it("never asks on a new install", async () => {
    const f = fixture({ prior: false });
    let asked = false;
    await refreshMacIconAfterUpdate({
      platform: "darwin",
      isPackaged: true,
      execPath: f.execPath,
      appVersion: "1.0.345",
      workDir: f.workDir,
      log: () => undefined,
      tools: f.tools,
      ask: async () => {
        asked = true;
        return 0;
      },
    });
    expect(asked).toBe(false);
    expect(f.calls).toEqual([`touch ${f.bundle}`, `lsregister -f ${f.bundle}`]);
  });
});
