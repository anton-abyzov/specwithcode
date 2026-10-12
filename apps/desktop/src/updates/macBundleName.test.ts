import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  expectedBundleName,
  planBundleRename,
  relaunchEnvironmentArgs,
  RENAME_SCRIPT,
  resolveSwapTarget,
  selectLegacySiblingsToRemove,
  startBundleRenameIfNeeded,
  type BundleRenameMarker,
} from "./macBundleName.ts";

const scratch: string[] = [];
const makeScratch = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-rename-"));
  scratch.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of scratch.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const LEGACY = "/Applications/SpecWeave Studio (Alpha).app";
const LEGACY_EXEC = `${LEGACY}/Contents/MacOS/SpecWithCode`;

const plan = (
  overrides: Partial<Parameters<typeof planBundleRename>[0]> & {
    readonly existing?: ReadonlyArray<string>;
    readonly readOnly?: ReadonlyArray<string>;
  } = {},
) => {
  const { existing = [], readOnly = [], ...rest } = overrides;
  return planBundleRename({
    platform: "darwin",
    isPackaged: true,
    execPath: LEGACY_EXEC,
    appVersion: "1.0.0",
    exists: (path) => existing.includes(path),
    writable: (path) => !readOnly.includes(path),
    marker: null,
    ...rest,
  });
};

// A pid that has already exited, so the scripts do not wait.
const exitedPid = () => NodeChildProcess.spawnSync(process.execPath, ["-e", "0"]).pid ?? 999_999;

/** A stand-in for `open` and `lsregister` that records its arguments. */
const makeRecorder = (dir: string, name: string) => {
  const log = NodePath.join(dir, `${name}.log`);
  const bin = NodePath.join(dir, name);
  NodeFS.writeFileSync(
    bin,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> "${log}"\n`,
    {
      mode: 0o700,
    },
  );
  return {
    bin,
    read: () => (NodeFS.existsSync(log) ? NodeFS.readFileSync(log, "utf8").split("\n") : []),
  };
};

const runRename = (dir: string, current: string, target: string, extra: string[] = []) => {
  const script = NodePath.join(dir, "rename.sh");
  NodeFS.writeFileSync(script, RENAME_SCRIPT, { mode: 0o700 });
  const opener = makeRecorder(dir, "open");
  const lsregister = makeRecorder(dir, "lsregister");
  NodeChildProcess.execFileSync("/bin/sh", [
    script,
    String(exitedPid()),
    current,
    target,
    lsregister.bin,
    opener.bin,
    ...extra,
  ]);
  return { opened: opener.read(), registered: lsregister.read() };
};

describe("planBundleRename", () => {
  it("renames an install that still has the alpha bundle name", () => {
    expect(plan()).toEqual({
      kind: "rename",
      current: LEGACY,
      target: "/Applications/SpecWithCode.app",
    });
  });

  it("leaves an install that already has the product's name", () => {
    expect(
      plan({ execPath: "/Applications/SpecWithCode.app/Contents/MacOS/SpecWithCode" }),
    ).toEqual({ kind: "skip", reason: "already-named" });
  });

  it("derives the nightly name from the nightly executable", () => {
    expect(expectedBundleName("/x/Y.app/Contents/MacOS/SpecWithCode (Nightly)")).toBe(
      "SpecWithCode (Nightly).app",
    );
    expect(
      plan({
        execPath:
          "/Applications/SpecWeave Studio (Nightly).app/Contents/MacOS/SpecWithCode (Nightly)",
      }),
    ).toEqual({
      kind: "rename",
      current: "/Applications/SpecWeave Studio (Nightly).app",
      target: "/Applications/SpecWithCode (Nightly).app",
    });
    // A stable build never takes over a nightly install's name, or the reverse.
    expect(
      plan({
        execPath: "/Applications/SpecWeave Studio (Nightly).app/Contents/MacOS/SpecWithCode",
      }),
    ).toEqual({ kind: "skip", reason: "custom-name" });
  });

  it("keeps a name the user chose", () => {
    expect(plan({ execPath: "/Applications/My Studio.app/Contents/MacOS/SpecWithCode" })).toEqual({
      kind: "skip",
      reason: "custom-name",
    });
  });

  it("skips anything it cannot or should not rename", () => {
    expect(plan({ platform: "linux" })).toEqual({ kind: "skip", reason: "not-macos" });
    expect(plan({ isPackaged: false })).toEqual({ kind: "skip", reason: "development" });
    expect(plan({ execPath: "/usr/local/bin/electron" })).toEqual({
      kind: "skip",
      reason: "no-bundle",
    });
    expect(
      plan({
        execPath:
          "/private/var/folders/x/T/AppTranslocation/ABC/d/SpecWeave Studio (Alpha).app/Contents/MacOS/SpecWithCode",
      }),
    ).toEqual({ kind: "skip", reason: "read-only-location" });
    expect(
      plan({
        execPath: "/Volumes/SpecWithCode/SpecWeave Studio (Alpha).app/Contents/MacOS/SpecWithCode",
      }),
    ).toEqual({ kind: "skip", reason: "read-only-location" });
    expect(plan({ readOnly: ["/Applications"] })).toEqual({ kind: "skip", reason: "not-writable" });
    expect(plan({ readOnly: [LEGACY] })).toEqual({ kind: "skip", reason: "not-writable" });
    expect(plan({ existing: ["/Applications/SpecWithCode.app"] })).toEqual({
      kind: "skip",
      reason: "target-exists",
    });
  });

  it("tries only once per version, so a failed rename cannot loop", () => {
    const marker: BundleRenameMarker = { version: "1.0.0", from: LEGACY };
    expect(plan({ marker })).toEqual({ kind: "skip", reason: "already-attempted" });
    // The next release tries again.
    expect(plan({ marker, appVersion: "1.0.1" }).kind).toBe("rename");
  });
});

describe("startBundleRenameIfNeeded", () => {
  it("records the attempt before it starts the script and skips the second launch", () => {
    const dir = makeScratch();
    const started: Array<{ current: string; target: string; pid: number }> = [];
    const input = {
      platform: "darwin" as const,
      isPackaged: true,
      execPath: NodePath.join(
        dir,
        "SpecWeave Studio (Alpha).app",
        "Contents",
        "MacOS",
        "SpecWithCode",
      ),
      appVersion: "1.0.0",
      pid: 4242,
      workDir: NodePath.join(dir, "userData"),
      env: {},
      start: (value: { current: string; target: string; pid: number }) => {
        started.push({ current: value.current, target: value.target, pid: value.pid });
      },
    };
    NodeFS.mkdirSync(NodePath.dirname(input.execPath), { recursive: true });

    expect(startBundleRenameIfNeeded(input).kind).toBe("rename");
    expect(started).toEqual([
      {
        current: NodePath.join(dir, "SpecWeave Studio (Alpha).app"),
        target: NodePath.join(dir, "SpecWithCode.app"),
        pid: 4242,
      },
    ]);
    expect(
      JSON.parse(NodeFS.readFileSync(NodePath.join(input.workDir, "bundle-rename.json"), "utf8")),
    ).toEqual({ version: "1.0.0", from: NodePath.join(dir, "SpecWeave Studio (Alpha).app") });

    // The rename failed and the same bundle came back: no second attempt.
    expect(startBundleRenameIfNeeded(input)).toEqual({ kind: "skip", reason: "already-attempted" });
    expect(started).toHaveLength(1);
  });
});

describe("RENAME_SCRIPT", () => {
  it("renames the bundle, updates Launch Services and opens it under the new name", () => {
    const dir = makeScratch();
    const current = NodePath.join(dir, "SpecWeave Studio (Alpha).app");
    const target = NodePath.join(dir, "SpecWithCode.app");
    NodeFS.mkdirSync(NodePath.join(current, "Contents"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(current, "Contents", "version"), "1.0.0");

    const { opened, registered } = runRename(dir, current, target, ["--env", "HOME=/tmp/h"]);

    expect(NodeFS.existsSync(current)).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(target, "Contents", "version"), "utf8")).toBe("1.0.0");
    expect(registered.slice(0, 4)).toEqual(["-u", current, "-f", target]);
    expect(opened.slice(0, 4)).toEqual(["-n", "--env", "HOME=/tmp/h", target]);
  });

  it("leaves both bundles alone when the new name is taken and reopens the old one", () => {
    const dir = makeScratch();
    const current = NodePath.join(dir, "SpecWeave Studio (Alpha).app");
    const target = NodePath.join(dir, "SpecWithCode.app");
    NodeFS.mkdirSync(current, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(current, "marker"), "old");
    NodeFS.mkdirSync(target, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(target, "marker"), "other");

    const { opened, registered } = runRename(dir, current, target);

    expect(NodeFS.readFileSync(NodePath.join(current, "marker"), "utf8")).toBe("old");
    expect(NodeFS.readFileSync(NodePath.join(target, "marker"), "utf8")).toBe("other");
    // Not moved inside the existing folder either.
    expect(NodeFS.existsSync(NodePath.join(target, "SpecWeave Studio (Alpha).app"))).toBe(false);
    expect(registered.filter(Boolean)).toEqual([]);
    expect(opened.slice(0, 2)).toEqual(["-n", current]);
  });

  it("keeps the old bundle and reopens it when the move fails", () => {
    const dir = makeScratch();
    const current = NodePath.join(dir, "SpecWeave Studio (Alpha).app");
    // The target's folder does not exist, so mv fails.
    const target = NodePath.join(dir, "missing", "SpecWithCode.app");
    NodeFS.mkdirSync(current, { recursive: true });

    const { opened } = runRename(dir, current, target);

    expect(NodeFS.existsSync(current)).toBe(true);
    expect(opened.slice(0, 2)).toEqual(["-n", current]);
  });
});

describe("relaunchEnvironmentArgs", () => {
  it("forwards HOME and Studio settings only", () => {
    expect(
      relaunchEnvironmentArgs({
        HOME: "/Users/tester",
        STUDIO_HOME: "/tmp/studio",
        PATH: "/usr/bin",
        SECRET_TOKEN: "x",
      }),
    ).toEqual(["--env", "HOME=/Users/tester", "--env", "STUDIO_HOME=/tmp/studio"]);
  });
});

describe("resolveSwapTarget", () => {
  it("moves an alpha-named install to the new name during an update", () => {
    expect(resolveSwapTarget(LEGACY, "/u/pending-update/staged.noindex/SpecWithCode.app")).toBe(
      "/Applications/SpecWithCode.app",
    );
  });

  it("replaces in place otherwise", () => {
    expect(
      resolveSwapTarget(
        "/Applications/SpecWithCode.app",
        "/u/pending-update/staged.noindex/SpecWithCode.app",
      ),
    ).toBe("/Applications/SpecWithCode.app");
    expect(
      resolveSwapTarget("/Applications/My Studio.app", "/u/staged.noindex/SpecWithCode.app"),
    ).toBe("/Applications/My Studio.app");
    // An update that still ships the old name keeps the old name.
    expect(resolveSwapTarget(LEGACY, "/u/staged.noindex/SpecWeave Studio (Alpha).app")).toBe(
      LEGACY,
    );
  });
});

describe("selectLegacySiblingsToRemove", () => {
  const current = "/Applications/SpecWithCode.app";
  const own = { bundleId: "com.specweave.studio", version: "1.0.0" };
  const sibling = (
    overrides: Partial<Parameters<typeof selectLegacySiblingsToRemove>[0]["siblings"][number]> = {},
  ) => ({
    path: LEGACY,
    identity: { bundleId: "com.specweave.studio", version: "0.2.12" },
    running: false,
    ...overrides,
  });

  it("removes an older or same-version alpha copy left next to the app", () => {
    expect(selectLegacySiblingsToRemove({ current, own, siblings: [sibling()] })).toEqual([LEGACY]);
    expect(
      selectLegacySiblingsToRemove({
        current,
        own,
        siblings: [sibling({ identity: { bundleId: "com.specweave.studio", version: "1.0.0" } })],
      }),
    ).toEqual([LEGACY]);
  });

  it("keeps a copy that is newer, running, another app or in another folder", () => {
    for (const overrides of [
      { identity: { bundleId: "com.specweave.studio", version: "1.0.1" } },
      { identity: { bundleId: "com.example.other", version: "0.2.12" } },
      { identity: { bundleId: "com.specweave.studio", version: null } },
      { running: true },
      { path: "/Users/tester/Applications/SpecWeave Studio (Alpha).app" },
      { path: "/Applications/SpecWeave Studio (Nightly).app" },
    ]) {
      expect(
        selectLegacySiblingsToRemove({ current, own, siblings: [sibling(overrides)] }),
      ).toEqual([]);
    }
  });

  it("does nothing while this app's own identity is unknown", () => {
    expect(
      selectLegacySiblingsToRemove({
        current,
        own: { bundleId: null, version: null },
        siblings: [sibling()],
      }),
    ).toEqual([]);
  });
});
