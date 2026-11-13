// @effect-diagnostics nodeBuiltinImport:off globalDate:off - builds real version folders in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  oldRuntimeVersionDirsSync,
  planRuntimeVersionPrune,
  pruneRuntimeVersions,
  versionsNamedIn,
} from "./runtimeVersionRetention.ts";

const dir = (name: string, mtimeMs = 0) => ({ name, isDirectory: true, mtimeMs });
const committed = (fromVersion: string, targetVersion: string) => ({
  id: "u1",
  fromVersion,
  targetVersion,
  status: "committed" as const,
});

describe("planRuntimeVersionPrune", () => {
  const entries = ["1.0.180", "1.0.200", "1.0.268", "1.0.275", "1.0.276"].map((name) => dir(name));

  it("keeps the active version and the one it updated from", () => {
    const plan = planRuntimeVersionPrune({
      entries,
      activeVersion: "1.0.276",
      update: committed("1.0.268", "1.0.276"),
      referenced: new Set(),
      nowMs: 0,
    });
    expect(plan.keep).toEqual(["1.0.268", "1.0.276"]);
    expect(plan.remove).toEqual(["1.0.180", "1.0.200", "1.0.275"]);
  });

  it("falls back to the newest older version as the rollback", () => {
    const plan = planRuntimeVersionPrune({
      entries,
      activeVersion: "1.0.276",
      update: undefined,
      referenced: new Set(),
      nowMs: 0,
    });
    expect(plan.keep).toEqual(["1.0.275", "1.0.276"]);
  });

  it("keeps a version something still runs or names, and every newer install", () => {
    const plan = planRuntimeVersionPrune({
      entries: [...entries, dir("1.0.277")],
      activeVersion: "1.0.275",
      update: undefined,
      referenced: new Set(["1.0.180"]),
      nowMs: 0,
    });
    expect(plan.keep).toEqual(["1.0.180", "1.0.268", "1.0.275", "1.0.276", "1.0.277"]);
    expect(plan.remove).toEqual(["1.0.200"]);
  });

  it("removes nothing while an update is pending", () => {
    const plan = planRuntimeVersionPrune({
      entries,
      activeVersion: "1.0.275",
      update: { ...committed("1.0.275", "1.0.276"), status: "pending", dbPath: "/db" },
      referenced: new Set(),
      nowMs: 0,
    });
    expect(plan.remove).toEqual([]);
  });

  it("removes stale staging and trash folders, never a fresh staging or a foreign folder", () => {
    const day = 24 * 60 * 60 * 1000;
    const plan = planRuntimeVersionPrune({
      entries: [
        dir("1.0.276"),
        dir(".staging-old", 0),
        dir(".staging-new", 2 * day),
        dir(".trash-1.0.1-x"),
        dir("notes"),
      ],
      activeVersion: "1.0.276",
      update: undefined,
      referenced: new Set(),
      nowMs: 2 * day + 1,
    });
    expect(plan.leftovers).toEqual([".staging-old", ".trash-1.0.1-x"]);
    expect(plan.remove).toEqual([]);
  });
});

describe("versionsNamedIn", () => {
  it("reads versions from process lines, launchers and unit files on every platform", () => {
    expect(
      versionsNamedIn([
        "/home/a/.specwithcode/m/runtime/node/bin/node /home/a/.specwithcode/m/runtime/versions/1.0.180/bin.mjs __service-launcher",
        'exec "/Users/a/.specwithcode/m4/runtime/versions/1.0.260/bin.mjs" "$@"',
        "C:\\Users\\a\\.specwithcode\\w\\runtime\\versions\\1.0.250\\specweave-studio.exe __service-launcher",
        "versions/latest/bin.mjs",
      ]),
    ).toEqual(new Set(["1.0.180", "1.0.260", "1.0.250"]));
  });
});

describe.skipIf(NodePath.sep !== "/")("pruneRuntimeVersions", () => {
  const roots: Array<string> = [];
  afterEach(() => {
    for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
  });

  const home = (versions: ReadonlyArray<string>, state: object) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-versions-"));
    roots.push(root);
    const baseDir = NodePath.join(root, "m");
    for (const version of versions) {
      const folder = NodePath.join(baseDir, "runtime", "versions", version);
      NodeFS.mkdirSync(folder, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(folder, "bin.mjs"), "x".repeat(1000));
    }
    NodeFS.writeFileSync(
      NodePath.join(baseDir, "runtime", "service-state.json"),
      JSON.stringify({ protocol: 3, ...state }),
    );
    return { root, baseDir };
  };
  const present = (baseDir: string) =>
    NodeFS.readdirSync(NodePath.join(baseDir, "runtime", "versions")).toSorted();

  it("removes old versions, keeps the active, the rollback and what a process runs", async () => {
    const { root, baseDir } = home(["1.0.180", "1.0.200", "1.0.268", "1.0.275", "1.0.276"], {
      activeVersion: "1.0.276",
      update: committed("1.0.275", "1.0.276"),
    });
    const result = await pruneRuntimeVersions({
      nowMs: 0,
      baseDir,
      platform: "linux",
      homeDir: root,
      pathEnv: "",
      processCommandLines: async () => [
        `node ${baseDir}/runtime/versions/1.0.180/bin.mjs __service-launcher`,
      ],
    });
    expect(result.removed.map((entry) => entry.version)).toEqual(["1.0.200", "1.0.268"]);
    expect(result.removed.every((entry) => entry.bytes === 1000)).toBe(true);
    expect(present(baseDir)).toEqual(["1.0.180", "1.0.275", "1.0.276"]);
  });

  it("keeps a version a CLI launcher still points at", async () => {
    const { root, baseDir } = home(["1.0.100", "1.0.275", "1.0.276"], { activeVersion: "1.0.276" });
    NodeFS.mkdirSync(NodePath.join(root, ".local", "bin"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(root, ".local", "bin", "specweave-studio"),
      `#!/bin/sh\nexec node ${baseDir}/runtime/versions/1.0.100/bin.mjs "$@"\n`,
    );
    await pruneRuntimeVersions({
      nowMs: 0,
      baseDir,
      platform: "linux",
      homeDir: root,
      pathEnv: "",
      processCommandLines: async () => [],
    });
    expect(present(baseDir)).toEqual(["1.0.100", "1.0.275", "1.0.276"]);
  });

  it("removes nothing when the process list cannot be read", async () => {
    const { root, baseDir } = home(["1.0.1", "1.0.2", "1.0.3"], { activeVersion: "1.0.3" });
    const result = await pruneRuntimeVersions({
      nowMs: 0,
      baseDir,
      platform: "linux",
      homeDir: root,
      pathEnv: "",
      processCommandLines: async () => null,
    });
    expect(result.skipped).toBe("process-list-unavailable");
    expect(present(baseDir)).toEqual(["1.0.1", "1.0.2", "1.0.3"]);
  });

  it("removes nothing without a service state", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-versions-"));
    roots.push(root);
    const result = await pruneRuntimeVersions({
      nowMs: 0,
      baseDir: root,
      platform: "linux",
      homeDir: root,
      pathEnv: "",
      processCommandLines: async () => [],
    });
    expect(result.skipped).toBe("no-service-state");
  });

  it("lists the folders Storage counts as old app versions", () => {
    const { baseDir } = home(["1.0.1", "1.0.2", "1.0.3"], { activeVersion: "1.0.3" });
    expect(oldRuntimeVersionDirsSync(baseDir)).toEqual([
      NodePath.join(baseDir, "runtime", "versions", "1.0.1"),
    ]);
  });
});
