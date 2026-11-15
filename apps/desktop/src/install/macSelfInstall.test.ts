// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixtures run the real relaunch script and real renames in a scratch folder.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixtures run the real relaunch script and real renames in a scratch folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixtures run the real relaunch script and real renames in a scratch folder.
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { BundleIdentity } from "../updates/macSwapInstall.ts";
import {
  candidateBundleNames,
  chooseDestination,
  decideSelfInstall,
  detectSelfInstall,
  installBundle,
  isDiskImageMount,
  parseMountTable,
  parseOwnProcesses,
  programUsesBundle,
  RELAUNCH_SCRIPT,
  reregisterLaunchAgents,
  rewriteBundlePaths,
  runMacSelfInstall,
  stagingPath,
  translocationSource,
  volumeOf,
  type InstalledCopy,
  type SelfInstallHost,
  type SelfInstallPrompt,
  type SelfInstallTools,
} from "./macSelfInstall.ts";
import {
  fillCopy,
  folderLabel,
  resolveSelfInstallLocale,
  SELF_INSTALL_LOCALES,
  selfInstallCopy,
} from "./macSelfInstallCopy.ts";

const scratch: string[] = [];
const makeScratch = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-self-install-"));
  scratch.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of scratch.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const ID = "com.specweave.studio";
const DMG = "/Volumes/SpecWithCode 1.0.307-arm64/SpecWithCode.app";
const DMG_EXEC = `${DMG}/Contents/MacOS/SpecWithCode`;
const TRANSLOCATED =
  "/private/var/folders/ab/xyz/T/AppTranslocation/0A1B2C3D-0000-4000-8000-000000000000/d/SpecWithCode.app";

const own: BundleIdentity = { bundleId: ID, version: "1.0.307" };

const copyAt = (path: string, overrides: Partial<InstalledCopy> = {}): InstalledCopy => ({
  path,
  identity: { bundleId: ID, version: "1.0.200" },
  running: false,
  removable: true,
  ...overrides,
});

describe("detectSelfInstall", () => {
  const detect = (overrides: Partial<Parameters<typeof detectSelfInstall>[0]> = {}) =>
    detectSelfInstall({
      platform: "darwin",
      isPackaged: true,
      execPath: DMG_EXEC,
      env: {},
      inApplicationsFolder: false,
      ...overrides,
    });

  it("offers the step for a disk image and a translocated copy", () => {
    expect(detect()).toEqual({
      kind: "offer",
      bundle: DMG,
      location: "disk-image",
      bundleName: "SpecWithCode.app",
    });
    expect(detect({ execPath: `${TRANSLOCATED}/Contents/MacOS/SpecWithCode` })).toMatchObject({
      kind: "offer",
      location: "translocated",
      bundle: TRANSLOCATED,
    });
  });

  it("skips installed, development, non-Mac and turned-off launches", () => {
    expect(
      detect({ execPath: "/Applications/SpecWithCode.app/Contents/MacOS/SpecWithCode" }),
    ).toEqual({ kind: "skip", reason: "installed" });
    expect(detect({ inApplicationsFolder: true })).toEqual({ kind: "skip", reason: "installed" });
    expect(detect({ isPackaged: false })).toEqual({ kind: "skip", reason: "development" });
    expect(detect({ platform: "linux" })).toEqual({ kind: "skip", reason: "not-macos" });
    expect(detect({ env: { STUDIO_SELF_INSTALL: "off" } })).toEqual({
      kind: "skip",
      reason: "turned-off",
    });
  });

  it("names the target after the product even when the disk image copy was renamed", () => {
    expect(
      detect({ execPath: "/Volumes/X/SpecWithCode copy.app/Contents/MacOS/SpecWithCode" }),
    ).toMatchObject({ bundleName: "SpecWithCode.app" });
  });
});

describe("chooseDestination", () => {
  it("uses /Applications when writable and ~/Applications otherwise", () => {
    expect(chooseDestination({ homeDir: "/Users/a", writable: () => true })).toEqual({
      dir: "/Applications",
      userFolder: false,
    });
    expect(chooseDestination({ homeDir: "/Users/a", writable: () => false })).toEqual({
      dir: "/Users/a/Applications",
      userFolder: true,
    });
  });
});

describe("decideSelfInstall", () => {
  const target = "/Applications/SpecWithCode.app";
  const legacy = "/Applications/SpecWeave Studio (Alpha).app";

  it("lists the legacy names that the product name replaces", () => {
    expect(candidateBundleNames("SpecWithCode.app")).toEqual([
      "SpecWithCode.app",
      "SpecWeave Studio (Alpha).app",
    ]);
  });

  it("installs fresh, replaces an older copy and trashes an older legacy copy", () => {
    expect(decideSelfInstall({ own, target, copies: [] })).toEqual({
      kind: "install",
      target,
      replace: null,
      trash: [],
    });
    expect(decideSelfInstall({ own, target, copies: [copyAt(target), copyAt(legacy)] })).toEqual({
      kind: "install",
      target,
      replace: target,
      trash: [legacy],
    });
  });

  it("replaces a broken copy with no readable Info.plist", () => {
    expect(
      decideSelfInstall({
        own,
        target,
        copies: [copyAt(target, { identity: { bundleId: null, version: null } })],
      }),
    ).toMatchObject({ kind: "install", replace: target });
  });

  it("opens a same or newer installed copy, legacy names included", () => {
    expect(
      decideSelfInstall({
        own,
        target,
        copies: [copyAt(target, { identity: { bundleId: ID, version: "1.0.307" } })],
      }),
    ).toEqual({ kind: "open-installed", path: target, version: "1.0.307" });
    expect(
      decideSelfInstall({
        own,
        target,
        copies: [copyAt(legacy, { identity: { bundleId: ID, version: "1.0.400" } })],
      }),
    ).toEqual({ kind: "open-installed", path: legacy, version: "1.0.400" });
  });

  it("switches to a running current copy and asks to quit a running older one", () => {
    expect(
      decideSelfInstall({
        own,
        target,
        copies: [copyAt(target, { running: true, identity: { bundleId: ID, version: "1.0.307" } })],
      }),
    ).toEqual({ kind: "switch-to-running", path: target });
    expect(decideSelfInstall({ own, target, copies: [copyAt(legacy, { running: true })] })).toEqual(
      { kind: "quit-older-first", path: legacy },
    );
  });

  it("never touches a different app under the same name", () => {
    expect(
      decideSelfInstall({
        own,
        target,
        copies: [copyAt(target, { identity: { bundleId: "com.example.other", version: "9.0.0" } })],
      }),
    ).toEqual({ kind: "blocked", path: target });
    // A different app under a legacy name is ignored, not trashed.
    expect(
      decideSelfInstall({
        own,
        target,
        copies: [copyAt(legacy, { identity: { bundleId: "com.example.other", version: "1.0.0" } })],
      }),
    ).toEqual({ kind: "install", target, replace: null, trash: [] });
  });

  it("ignores an older copy this user cannot remove, even while it runs", () => {
    expect(
      decideSelfInstall({
        own,
        target: "/Users/a/Applications/SpecWithCode.app",
        copies: [copyAt("/Applications/SpecWithCode.app", { removable: false, running: true })],
      }),
    ).toMatchObject({ kind: "install", replace: null, trash: [] });
  });

  it("counts only this user's processes as running", () => {
    expect(
      parseOwnProcesses(
        "  501 /Applications/SpecWithCode.app/Contents/MacOS/SpecWithCode\n  502 /Applications/Other.app/Contents/MacOS/Other\n",
        501,
      ),
    ).toEqual(["/Applications/SpecWithCode.app/Contents/MacOS/SpecWithCode"]);
  });

  it("leaves an older copy it cannot remove in place", () => {
    const system = "/Applications/SpecWithCode.app";
    expect(
      decideSelfInstall({
        own,
        target: "/Users/a/Applications/SpecWithCode.app",
        copies: [copyAt(system, { removable: false })],
      }),
    ).toEqual({
      kind: "install",
      target: "/Users/a/Applications/SpecWithCode.app",
      replace: null,
      trash: [],
    });
  });
});

describe("LaunchAgent re-registration", () => {
  const plist = (program: string, path: string) =>
    `<plist><dict><key>ProgramArguments</key><array><string>${program}</string></array>` +
    `<key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string></dict></dict></plist>`;

  it("rewrites whole bundle paths only, with XML escaping", () => {
    const from = "/Volumes/A & B/SpecWithCode.app";
    const text = plist(
      "/Volumes/A &amp; B/SpecWithCode.app/Contents/MacOS/SpecWithCode",
      "/Volumes/A &amp; B/SpecWithCode.app/Contents/MacOS:/Volumes/A &amp; B/SpecWithCode.app2/bin",
    );
    const next = rewriteBundlePaths(text, [from], "/Applications/SpecWithCode.app");
    expect(next).toContain(
      "<string>/Applications/SpecWithCode.app/Contents/MacOS/SpecWithCode</string>",
    );
    expect(next).toContain(":/Volumes/A &amp; B/SpecWithCode.app2/bin");
    expect(programUsesBundle(text, [from])).toBe(true);
    expect(
      programUsesBundle(
        plist(
          "/Users/a/.specwithcode/bin/node",
          "/Volumes/A &amp; B/SpecWithCode.app/Contents/MacOS",
        ),
        [from],
      ),
    ).toBe(false);
  });

  it("rewrites matching agents and reloads only those whose program ran from the old bundle", () => {
    const home = makeScratch();
    const dir = NodePath.join(home, "Library", "LaunchAgents");
    NodeFS.mkdirSync(dir, { recursive: true });
    const uid = process.getuid?.() ?? 0;
    NodeFS.writeFileSync(
      NodePath.join(dir, "com.specweave.studio.service.plist"),
      plist("/Users/a/.specwithcode/runtime/node", `${DMG}/Contents/MacOS:/usr/bin`),
    );
    NodeFS.writeFileSync(
      NodePath.join(dir, "com.specweave.studio.helper.plist"),
      plist(`${DMG}/Contents/MacOS/SpecWithCode`, "/usr/bin"),
    );
    NodeFS.writeFileSync(
      NodePath.join(dir, "com.example.other.plist"),
      plist(`${DMG}/Contents/MacOS/SpecWithCode`, "/usr/bin"),
    );
    const calls: string[][] = [];
    const result = reregisterLaunchAgents({
      homeDir: home,
      uid,
      from: [DMG],
      to: "/Applications/SpecWithCode.app",
      launchctl: (args) => calls.push([...args]),
    });
    expect(result.rewritten.map((file) => NodePath.basename(file)).sort()).toEqual([
      "com.specweave.studio.helper.plist",
      "com.specweave.studio.service.plist",
    ]);
    expect(result.reloaded.map((file) => NodePath.basename(file))).toEqual([
      "com.specweave.studio.helper.plist",
    ]);
    expect(calls[0]).toEqual(["bootout", `gui/${uid}/com.specweave.studio.helper`]);
    expect(calls[1]?.[0]).toBe("bootstrap");
    expect(
      NodeFS.readFileSync(NodePath.join(dir, "com.specweave.studio.service.plist"), "utf8"),
    ).toContain("/Applications/SpecWithCode.app/Contents/MacOS:/usr/bin");
    expect(NodeFS.readFileSync(NodePath.join(dir, "com.example.other.plist"), "utf8")).toContain(
      DMG,
    );
  });
});

describe("disk image and translocation", () => {
  const mount = [
    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
    "/dev/disk5s1 on /Volumes/SpecWithCode 1.0.307-arm64 (hfs, local, nodev, nosuid, read-only, noowners, quarantine, mounted by a)",
    "/Volumes/SpecWithCode 1.0.307-arm64 on /private/var/folders/ab/xyz/T/AppTranslocation/0A1B2C3D-0000-4000-8000-000000000000 (nullfs, local, nodev, nosuid, read-only, noowners, quarantine, nobrowse, mounted by a)",
  ].join("\n");

  it("finds the real folder of a translocated bundle", () => {
    const source = translocationSource(TRANSLOCATED, parseMountTable(mount));
    expect(source).toBe("/Volumes/SpecWithCode 1.0.307-arm64");
    expect(volumeOf(`${source}/SpecWithCode.app`)).toBe("/Volumes/SpecWithCode 1.0.307-arm64");
    expect(volumeOf("/Users/a/Downloads/SpecWithCode.app")).toBeNull();
  });

  it("ejects only volumes that hdiutil lists as disk images", () => {
    const info = [
      "image-path      : /Users/a/Downloads/SpecWithCode-1.0.307-arm64.dmg",
      "/dev/disk5          \tGUID_partition_scheme          \t",
      "/dev/disk5s1        \tApple_HFS                      \t/Volumes/SpecWithCode 1.0.307-arm64",
    ].join("\n");
    expect(isDiskImageMount(info, "/Volumes/SpecWithCode 1.0.307-arm64")).toBe(true);
    expect(isDiskImageMount(info, "/Volumes/USB")).toBe(false);
  });
});

// A fake bundle is a folder with an Info marker, enough for the swap order.
function fakeBundle(path: string, version: string): void {
  NodeFS.mkdirSync(NodePath.join(path, "Contents"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(path, "Contents", "version"), version);
}
const versionOf = (path: string) =>
  NodeFS.readFileSync(NodePath.join(path, "Contents", "version"), "utf8");

function fakeTools(overrides: Partial<SelfInstallTools> = {}): SelfInstallTools & {
  readonly trashed: string[];
} {
  const trashed: string[] = [];
  return {
    trashed,
    copy: async (source, destination) => {
      NodeFS.cpSync(source, destination, { recursive: true });
    },
    verify: async () => undefined,
    identity: async (bundle) => ({
      bundleId: ID,
      version: NodeFS.existsSync(NodePath.join(bundle, "Contents", "version"))
        ? versionOf(bundle)
        : null,
    }),
    trash: async (path) => {
      trashed.push(path);
      NodeFS.rmSync(path, { recursive: true, force: true });
    },
    remove: async (path) => NodeFS.rmSync(path, { recursive: true, force: true }),
    lsregister: async () => undefined,
    ...overrides,
  };
}

// Installing from a disk image exists only on macOS. The swap renames a real bundle through
// POSIX paths and the relaunch script runs under /bin/sh; a Windows host has neither.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

describe.skipIf(windowsHost)("installBundle", () => {
  it("copies beside the target, verifies, swaps and trashes the old copy last", async () => {
    const root = makeScratch();
    const source = NodePath.join(root, "dmg", "SpecWithCode.app");
    const apps = NodePath.join(root, "Applications");
    const target = NodePath.join(apps, "SpecWithCode.app");
    const legacy = NodePath.join(apps, "SpecWeave Studio (Alpha).app");
    fakeBundle(source, "1.0.307");
    fakeBundle(target, "1.0.200");
    fakeBundle(legacy, "1.0.100");
    const order: string[] = [];
    const tools = fakeTools({
      verify: async (bundle) => {
        order.push(`verify ${NodePath.basename(bundle)}`);
        // The installed app is still in place while the copy is checked.
        expect(versionOf(target)).toBe("1.0.200");
      },
    });
    const result = await installBundle({ source, target, own, trash: [legacy], tools });
    expect(order).toEqual([`verify ${NodePath.basename(stagingPath(target, "1.0.307"))}`]);
    expect(versionOf(target)).toBe("1.0.307");
    expect(tools.trashed).toEqual([`${target}.install-old`, legacy]);
    expect(result.trashed).toEqual([legacy]);
    expect(NodeFS.readdirSync(apps)).toEqual(["SpecWithCode.app"]);
  });

  it("leaves the installed app untouched when the copy or its check fails", async () => {
    const root = makeScratch();
    const source = NodePath.join(root, "dmg", "SpecWithCode.app");
    const apps = NodePath.join(root, "Applications");
    const target = NodePath.join(apps, "SpecWithCode.app");
    fakeBundle(source, "1.0.307");
    fakeBundle(target, "1.0.200");
    await expect(
      installBundle({
        source,
        target,
        own,
        trash: [],
        tools: fakeTools({
          verify: async () => {
            throw new Error("code object is not signed at all");
          },
        }),
      }),
    ).rejects.toThrow("not signed");
    expect(versionOf(target)).toBe("1.0.200");
    expect(NodeFS.readdirSync(apps)).toEqual(["SpecWithCode.app"]);

    await expect(
      installBundle({
        source,
        target,
        own: { bundleId: ID, version: "1.0.999" },
        trash: [],
        tools: fakeTools(),
      }),
    ).rejects.toThrow("does not match");
    expect(versionOf(target)).toBe("1.0.200");
  });

  it("puts back an old copy a cut-short run left aside, then installs", async () => {
    const root = makeScratch();
    const source = NodePath.join(root, "dmg", "SpecWithCode.app");
    const target = NodePath.join(root, "Applications", "SpecWithCode.app");
    fakeBundle(source, "1.0.307");
    fakeBundle(`${target}.install-old`, "1.0.200");
    const tools = fakeTools();
    await installBundle({ source, target, own, trash: [], tools });
    expect(versionOf(target)).toBe("1.0.307");
    expect(tools.trashed).toEqual([`${target}.install-old`]);
  });

  it("stops before the swap when the installed copy was opened meanwhile", async () => {
    const root = makeScratch();
    const source = NodePath.join(root, "dmg", "SpecWithCode.app");
    const apps = NodePath.join(root, "Applications");
    const target = NodePath.join(apps, "SpecWithCode.app");
    fakeBundle(source, "1.0.307");
    fakeBundle(target, "1.0.200");
    await expect(
      installBundle({
        source,
        target,
        own,
        trash: [],
        tools: fakeTools(),
        isRunning: async (bundle) => bundle === target,
      }),
    ).rejects.toThrow("was opened while installing");
    expect(versionOf(target)).toBe("1.0.200");
    expect(NodeFS.readdirSync(apps)).toEqual(["SpecWithCode.app"]);
  });

  it("keeps the old copy aside instead of deleting it when the Trash refuses it", async () => {
    const root = makeScratch();
    const source = NodePath.join(root, "dmg", "SpecWithCode.app");
    const apps = NodePath.join(root, "Applications");
    const target = NodePath.join(apps, "SpecWithCode.app");
    fakeBundle(source, "1.0.307");
    fakeBundle(target, "1.0.200");
    const removed: string[] = [];
    const base = fakeTools();
    await installBundle({
      source,
      target,
      own,
      trash: [],
      tools: fakeTools({
        trash: async () => {
          throw new Error("Trash is not available");
        },
        remove: async (path) => {
          removed.push(path);
          await base.remove(path);
        },
      }),
    });
    expect(versionOf(target)).toBe("1.0.307");
    expect(versionOf(`${target}.install-old`)).toBe("1.0.200");
    expect(removed).not.toContain(`${target}.install-old`);
  });

  it("names a leftover it cannot move and leaves no staging copy", async () => {
    const root = makeScratch();
    const source = NodePath.join(root, "dmg", "SpecWithCode.app");
    const apps = NodePath.join(root, "Applications");
    const target = NodePath.join(apps, "SpecWithCode.app");
    fakeBundle(source, "1.0.307");
    fakeBundle(target, "1.0.200");
    fakeBundle(`${target}.install-old`, "1.0.100");
    await expect(
      installBundle({
        source,
        target,
        own,
        trash: [],
        tools: fakeTools({
          trash: async () => {
            throw new Error("Trash is not available");
          },
        }),
      }),
    ).rejects.toThrow("Move SpecWithCode.app.install-old out of");
    expect(versionOf(target)).toBe("1.0.200");
    expect(NodeFS.readdirSync(apps).sort()).toEqual([
      "SpecWithCode.app",
      "SpecWithCode.app.install-old",
    ]);
  });

  it("keeps an earlier-named copy that was opened during the install", async () => {
    const root = makeScratch();
    const source = NodePath.join(root, "dmg", "SpecWithCode.app");
    const apps = NodePath.join(root, "Applications");
    const target = NodePath.join(apps, "SpecWithCode.app");
    const legacy = NodePath.join(apps, "SpecWeave Studio (Alpha).app");
    fakeBundle(source, "1.0.307");
    fakeBundle(legacy, "1.0.100");
    const result = await installBundle({
      source,
      target,
      own,
      trash: [legacy],
      tools: fakeTools(),
      isRunning: async (bundle) => bundle === legacy,
    });
    expect(result.trashed).toEqual([]);
    expect(versionOf(legacy)).toBe("1.0.100");
    expect(versionOf(target)).toBe("1.0.307");
  });

  it("creates ~/Applications when it is missing", async () => {
    const root = makeScratch();
    const source = NodePath.join(root, "dmg", "SpecWithCode.app");
    const target = NodePath.join(root, "home", "Applications", "SpecWithCode.app");
    fakeBundle(source, "1.0.307");
    await installBundle({ source, target, own, trash: [], tools: fakeTools() });
    expect(versionOf(target)).toBe("1.0.307");
  });
});

describe.skipIf(windowsHost)("RELAUNCH_SCRIPT", () => {
  it("waits for the app to exit, opens the installed copy, then ejects the disk image", () => {
    const dir = makeScratch();
    const script = NodePath.join(dir, "relaunch.sh");
    const log = NodePath.join(dir, "log");
    const fake = (name: string) => {
      const path = NodePath.join(dir, name);
      NodeFS.writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "${log}"\n`, { mode: 0o755 });
      return path;
    };
    NodeFS.writeFileSync(script, RELAUNCH_SCRIPT.replace("sleep 3", "sleep 0"), { mode: 0o700 });
    NodeChildProcess.execFileSync("/bin/sh", [
      script,
      "999999",
      "/Applications/SpecWithCode.app",
      fake("open"),
      "/Volumes/SpecWithCode 1.0.307",
      fake("hdiutil"),
      "--env",
      "STUDIO_HOME=/tmp/x",
    ]);
    expect(NodeFS.readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "open -n --env STUDIO_HOME=/tmp/x /Applications/SpecWithCode.app",
      "hdiutil detach /Volumes/SpecWithCode 1.0.307",
    ]);
  });
});

describe("runMacSelfInstall", () => {
  /** Where the app installs under a home folder: joined with forward slashes on every host. */
  const installedIn = (home: string) =>
    NodePath.posix.join(home, "Applications", "SpecWithCode.app");

  const setup = (input: {
    readonly answers: ReadonlyArray<number>;
    readonly running?: ReadonlyArray<string>;
    readonly writable?: boolean;
    readonly tools?: Partial<SelfInstallTools>;
  }) => {
    const root = makeScratch();
    const home = NodePath.join(root, "home");
    const prompts: SelfInstallPrompt[] = [];
    const opened: string[] = [];
    const relaunches: Array<{ target: string; volume: string | null }> = [];
    const answers = [...input.answers];
    const runningSnapshots = [...(input.running ?? [])];
    const base = fakeTools();
    const tools = fakeTools({
      copy: async (_source, destination) => fakeBundle(destination, own.version!),
      identity: async (bundle) => (bundle === DMG ? own : base.identity(bundle)),
      ...input.tools,
    });
    const host: SelfInstallHost = {
      platform: "darwin",
      isPackaged: true,
      execPath: DMG_EXEC,
      env: {},
      homeDir: home,
      uid: 501,
      pid: 4242,
      workDir: NodePath.join(root, "userdata"),
      locale: "en",
      inApplicationsFolder: () => false,
      ask: async (prompt) => {
        prompts.push(prompt);
        return answers.shift() ?? prompt.cancelId;
      },
      open: (path) => opened.push(path),
      log: () => undefined,
      tools,
      writable: () => input.writable ?? true,
      runningExecutables: async () => {
        const next = runningSnapshots.length > 1 ? runningSnapshots.shift()! : runningSnapshots[0];
        return next === undefined ? [] : [next];
      },
      diskImages: async () => `/dev/disk5s1\tApple_HFS\t/Volumes/SpecWithCode 1.0.307-arm64`,
      relaunch: (args) => relaunches.push({ target: args.target, volume: args.volume }),
      reregister: () => ({ rewritten: [], reloaded: [] }),
    };
    return { host, prompts, opened, relaunches, tools };
  };

  it("keeps today's behaviour after Not now", async () => {
    const { host, prompts } = setup({ answers: [1] });
    expect(await runMacSelfInstall(host)).toEqual({ kind: "continue", reason: "not-now" });
    expect(prompts[0]?.title).toBe("Install SpecWithCode");
    expect(prompts[0]?.buttons).toEqual(["Install", "Not now"]);
  });

  it("explains the home-folder install when /Applications is not writable", async () => {
    const { host, prompts } = setup({ answers: [1], writable: false });
    await runMacSelfInstall(host);
    expect(prompts[0]?.detail).toContain("~/Applications");
    expect(prompts[0]?.detail).toContain("for you only");
  });

  it("offers to open a newer installed copy and quits this one", async () => {
    // fakeTools only sees bundles that exist, so the newer copy is a real folder.
    const { host, opened, prompts } = setup({ answers: [0] });
    const installed = installedIn(host.homeDir);
    fakeBundle(installed, "1.0.400");
    const result = await runMacSelfInstall({
      ...host,
      writable: (path) => path !== "/Applications",
    });
    expect(prompts[0]?.title).toBe("SpecWithCode is already installed");
    expect(result).toEqual({ kind: "exit", reason: "open-installed" });
    expect(opened).toEqual([installed]);
  });

  it("asks to quit a running older copy, checks again, then installs", async () => {
    const root = makeScratch();
    const target = installedIn(NodePath.join(root, "home"));
    const { host, prompts, relaunches } = setup({
      answers: [0, 0],
      running: [`${target}/Contents/MacOS/SpecWithCode`, ""],
    });
    fakeBundle(target, "1.0.200");
    const result = await runMacSelfInstall({
      ...host,
      homeDir: NodePath.join(root, "home"),
      writable: (path) => path !== "/Applications",
    });
    expect(prompts.map((prompt) => prompt.title)).toEqual([
      "Quit the older SpecWithCode first",
      "Install SpecWithCode",
    ]);
    expect(prompts[1]?.detail).toContain(
      "The older version in the ~/Applications folder is replaced",
    );
    expect(result).toEqual({ kind: "exit", reason: "installed" });
    expect(relaunches).toEqual([{ target, volume: "/Volumes/SpecWithCode 1.0.307-arm64" }]);
  });

  it("still quits for the installed copy when re-registration or the relaunch script fails", async () => {
    const root = makeScratch();
    const target = installedIn(NodePath.join(root, "home"));
    const { host, opened } = setup({
      answers: [0],
      tools: {
        lsregister: async () => {
          throw new Error("lsregister failed");
        },
      },
    });
    const result = await runMacSelfInstall({
      ...host,
      homeDir: NodePath.join(root, "home"),
      writable: (path) => path !== "/Applications",
      reregister: () => {
        throw new Error("plist unreadable");
      },
      relaunch: () => {
        throw new Error("spawn failed");
      },
    });
    expect(result).toEqual({ kind: "exit", reason: "installed" });
    expect(versionOf(target)).toBe("1.0.307");
    expect(opened).toEqual([target]);
  });

  it("reports a failed install and keeps running from the disk image", async () => {
    const root = makeScratch();
    const { host, prompts, relaunches } = setup({
      answers: [0],
      tools: {
        copy: async () => {
          throw new Error("No space left on device");
        },
      },
    });
    const result = await runMacSelfInstall({
      ...host,
      homeDir: NodePath.join(root, "home"),
      writable: (path) => path !== "/Applications",
    });
    expect(result).toEqual({ kind: "continue", reason: "failed" });
    expect(prompts[1]?.title).toBe("SpecWithCode couldn't be installed");
    expect(prompts[1]?.detail).toContain("No space left on device");
    expect(relaunches).toEqual([]);
  });

  it("does nothing outside a disk image", async () => {
    const { host, prompts } = setup({ answers: [] });
    const result = await runMacSelfInstall({
      ...host,
      execPath: "/Applications/SpecWithCode.app/Contents/MacOS/SpecWithCode",
    });
    expect(result).toEqual({ kind: "continue", reason: "installed" });
    expect(prompts).toEqual([]);
  });
});

describe("copy", () => {
  it("has every string, non-empty, in all nine languages with the same placeholders", () => {
    const english = selfInstallCopy("en");
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    expect(SELF_INSTALL_LOCALES).toHaveLength(9);
    for (const locale of SELF_INSTALL_LOCALES) {
      const copy = selfInstallCopy(locale);
      for (const key of Object.keys(english) as Array<keyof typeof english>) {
        expect(copy[key].length, `${locale}.${key}`).toBeGreaterThan(0);
        expect(placeholders(copy[key]), `${locale}.${key}`).toEqual(placeholders(english[key]));
        expect(copy[key], `${locale}.${key}`).not.toContain("—");
      }
      expect(folderLabel(locale, true)).toBe("~/Applications");
    }
  });

  it("follows the system's preferred languages with English as the fallback", () => {
    expect(resolveSelfInstallLocale(["ru-RU", "en-US"])).toBe("ru");
    expect(resolveSelfInstallLocale(["zh-Hant-TW"])).toBe("zh-CN");
    expect(resolveSelfInstallLocale(["pt-PT"])).toBe("pt-BR");
    expect(resolveSelfInstallLocale(["nl-NL", "de-DE"])).toBe("de");
    expect(resolveSelfInstallLocale(["nl-NL"])).toBe("en");
    expect(fillCopy("in {folder} {missing}", { folder: "Applications" })).toBe(
      "in Applications {missing}",
    );
  });
});
