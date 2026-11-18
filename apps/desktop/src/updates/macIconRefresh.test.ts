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
  readIconStamp,
  refreshMacIconAfterUpdate,
  type IconRefreshTools,
} from "./macIconRefresh.ts";

const EXEC = "/Applications/SpecWithCode.app/Contents/MacOS/SpecWithCode";
const base = {
  platform: "darwin" as NodeJS.Platform,
  isPackaged: true,
  execPath: EXEC,
  appVersion: "1.0.345",
  iconStamp: "icon.icns:new",
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
      planIconRefresh({ ...base, previous: { version: "1.0.345", iconStamp: "icon.icns:new" } }),
    ).toEqual({ kind: "skip", reason: "same-version" });
  });

  it("re-registers after an update and offers a Dock reload only when the icon changed", () => {
    expect(
      planIconRefresh({ ...base, previous: { version: "1.0.344", iconStamp: "icon.icns:new" } }),
    ).toEqual({
      kind: "refresh",
      bundle: "/Applications/SpecWithCode.app",
      offerDockRestart: false,
    });
    expect(
      planIconRefresh({ ...base, previous: { version: "1.0.341", iconStamp: "icon.icns:old" } }),
    ).toMatchObject({ kind: "refresh", offerDockRestart: true });
  });

  it("does not offer the reload over a stamp it cannot compare", () => {
    // 1.0.347 to 1.0.349 saved an Assets.car digest, which changes with every build.
    expect(
      planIconRefresh({
        ...base,
        appVersion: "1.0.350",
        previous: { version: "1.0.349", iconStamp: "Assets.car:47d8255b8474ae75173ac03a83ff2bef" },
      }),
    ).toEqual({
      kind: "refresh",
      bundle: "/Applications/SpecWithCode.app",
      offerDockRestart: false,
    });
    expect(
      planIconRefresh({ ...base, previous: { version: "1.0.344", iconStamp: null } }),
    ).toMatchObject({ kind: "refresh", offerDockRestart: false });
    // No readable icon in this build: nothing to compare either.
    expect(
      planIconRefresh({
        ...base,
        iconStamp: null,
        previous: { version: "1.0.344", iconStamp: "icon.icns:old" },
      }),
    ).toMatchObject({ kind: "refresh", offerDockRestart: false });
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
    NodeFS.writeFileSync(NodePath.join(bundle, "Contents", "Resources", "Assets.car"), "build 1");
    NodeFS.writeFileSync(NodePath.join(bundle, "Contents", "Resources", "icon.icns"), "icon");
    const stateDir = NodePath.join(root, "userdata");
    NodeFS.mkdirSync(stateDir);
    if (options.prior) NodeFS.writeFileSync(NodePath.join(stateDir, "environment-id"), "env");
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
      stateDir,
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
      stateDir: f.stateDir,
      canAsk: true,
      whenWindowShown: async () => {
        f.calls.push("window shown");
      },
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
    expect(f.calls).toEqual([`touch ${f.bundle}`, `lsregister -f ${f.bundle}`, "window shown"]);
    const record = parseIconRefreshRecord(
      NodeFS.readFileSync(NodePath.join(f.stateDir, ICON_REFRESH_FILE), "utf8"),
    );
    expect(record?.version).toBe("1.0.345");
    expect(record?.iconStamp).toMatch(/^icon\.icns:[0-9a-f]{32}$/);

    // Same version again: nothing runs, nothing is asked.
    f.calls.length = 0;
    await refreshMacIconAfterUpdate({ ...host, ask: async () => 0 });
    expect(f.calls).toEqual([]);

    // Next version with a new icon, and the user agrees.
    NodeFS.writeFileSync(NodePath.join(f.bundle, "Contents", "Resources", "icon.icns"), "icon2");
    await refreshMacIconAfterUpdate({ ...host, appVersion: "1.0.346", ask: async () => 0 });
    expect(f.calls).toEqual([
      `touch ${f.bundle}`,
      `lsregister -f ${f.bundle}`,
      "window shown",
      "clear dock icon cache",
      "kill 4242",
    ]);
  });

  it("stamps the icon the same across builds that only recompiled Assets.car", () => {
    const f = fixture({ prior: true });
    const resources = NodePath.join(f.bundle, "Contents", "Resources");
    const first = readIconStamp(f.bundle);
    NodeFS.writeFileSync(NodePath.join(resources, "Assets.car"), "build 2");
    expect(readIconStamp(f.bundle)).toBe(first);
    NodeFS.writeFileSync(NodePath.join(resources, "icon.icns"), "another icon");
    expect(readIconStamp(f.bundle)).not.toBe(first);
    NodeFS.rmSync(NodePath.join(resources, "icon.icns"));
    expect(readIconStamp(f.bundle)).toBeNull();
  });

  it("does not ask again on later updates that keep the icon", async () => {
    const f = fixture({ prior: true });
    const recordPath = NodePath.join(f.stateDir, ICON_REFRESH_FILE);
    // What 1.0.349 left behind after its own prompt.
    NodeFS.writeFileSync(
      recordPath,
      JSON.stringify({
        version: "1.0.349",
        iconStamp: "Assets.car:47d8255b8474ae75173ac03a83ff2bef",
      }),
    );
    let asked = 0;
    const host = {
      platform: "darwin" as NodeJS.Platform,
      isPackaged: true,
      execPath: f.execPath,
      stateDir: f.stateDir,
      canAsk: true,
      whenWindowShown: async () => undefined,
      log: () => undefined,
      tools: f.tools,
      ask: async () => {
        asked += 1;
        return 0;
      },
    };
    await refreshMacIconAfterUpdate({ ...host, appVersion: "1.0.350" });
    expect(asked).toBe(0);
    expect(f.calls).toEqual([`touch ${f.bundle}`, `lsregister -f ${f.bundle}`]);
    expect(parseIconRefreshRecord(NodeFS.readFileSync(recordPath, "utf8"))).toEqual({
      version: "1.0.350",
      iconStamp: readIconStamp(f.bundle),
    });

    // The next build compiles a different Assets.car for the same icon.
    f.calls.length = 0;
    NodeFS.writeFileSync(NodePath.join(f.bundle, "Contents", "Resources", "Assets.car"), "build 2");
    await refreshMacIconAfterUpdate({ ...host, appVersion: "1.0.351" });
    expect(asked).toBe(0);
    expect(f.calls).toEqual([`touch ${f.bundle}`, `lsregister -f ${f.bundle}`]);

    // A real icon change is still offered.
    NodeFS.writeFileSync(NodePath.join(f.bundle, "Contents", "Resources", "icon.icns"), "icon2");
    await refreshMacIconAfterUpdate({ ...host, appVersion: "1.0.352" });
    expect(asked).toBe(1);
  });

  it("never asks on a new install", async () => {
    const f = fixture({ prior: false });
    let asked = false;
    await refreshMacIconAfterUpdate({
      platform: "darwin",
      isPackaged: true,
      execPath: f.execPath,
      appVersion: "1.0.345",
      stateDir: f.stateDir,
      canAsk: true,
      whenWindowShown: async () => undefined,
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

  it("never asks in automated runs, and retries a failed registration next launch", async () => {
    const f = fixture({ prior: true });
    let asked = false;
    const host = {
      platform: "darwin" as NodeJS.Platform,
      isPackaged: true,
      execPath: f.execPath,
      appVersion: "1.0.345",
      stateDir: f.stateDir,
      canAsk: false,
      whenWindowShown: async () => undefined,
      log: () => undefined,
      ask: async () => {
        asked = true;
        return 0;
      },
    };
    await refreshMacIconAfterUpdate({
      ...host,
      tools: {
        ...f.tools,
        lsregister: async () => {
          throw new Error("lsregister failed");
        },
      },
    });
    expect(asked).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(f.stateDir, ICON_REFRESH_FILE))).toBe(false);
    await refreshMacIconAfterUpdate({ ...host, tools: f.tools });
    expect(asked).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(f.stateDir, ICON_REFRESH_FILE))).toBe(true);
  });

  it("asks again next launch when the app quits before the prompt", async () => {
    const f = fixture({ prior: true });
    const host = {
      platform: "darwin" as NodeJS.Platform,
      isPackaged: true,
      execPath: f.execPath,
      appVersion: "1.0.345",
      stateDir: f.stateDir,
      canAsk: true,
      log: () => undefined,
      tools: f.tools,
      ask: async () => 1,
    };
    // The window never shows: the prompt waits and nothing is recorded.
    void refreshMacIconAfterUpdate({
      ...host,
      whenWindowShown: () => new Promise(() => undefined),
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(NodeFS.existsSync(NodePath.join(f.stateDir, ICON_REFRESH_FILE))).toBe(false);
  });
});
