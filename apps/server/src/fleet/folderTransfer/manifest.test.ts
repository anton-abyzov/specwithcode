// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { isSecretLikeProjectPath } from "../../workspace/WorkspaceSensitivePaths.ts";
import {
  classifyFile,
  DEFAULT_SELECTION,
  EXACT_SELECTION,
  isRebuildableDirectoryName,
} from "./classify.ts";
import { git, makeUmbrella, type UmbrellaFixture } from "./folderFixture.testkit.ts";
import {
  CHUNK_SIZE,
  forEachLimited,
  readManifestFile,
  scanFolder,
  hashSelected,
  selectEntries,
  writeManifest,
  type FolderScan,
} from "./manifest.ts";
import { isSafeRelativePath, symlinkTargetInside } from "./paths.ts";

let base: string;
let fixture: UmbrellaFixture;
let scan: FolderScan;

beforeAll(async () => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-manifest-")));
  fixture = makeUmbrella(base);
  scan = await scanFolder(fixture.root);
}, 60_000);
afterAll(() => NodeFS.rmSync(base, { recursive: true, force: true }));

const entry = (path: string) => scan.entries.find((item) => item.path === path);

describe("scanFolder", () => {
  it("classifies every file by Git state and kind", () => {
    expect(entry("README.md")?.class).toBe("tracked");
    expect(entry("docs/guide.md")?.class).toBe("tracked");
    expect(entry("notes/todo.md")?.class).toBe("untracked");
    expect(entry("work/session.log")?.class).toBe("ignoredData");
    expect(entry(".specweave/increments/0001-x/evidence/run.txt")?.class).toBe("ignoredData");
    expect(entry(".env")?.class).toBe("secret");
    expect(entry(".git/HEAD")?.class).toBe("repository");
    // A worktree of a repository inside the folder is left out entirely.
    expect(entry("repositories/svc-a-wt-feature")).toBeUndefined();
    expect(entry("repositories/svc-a-wt-feature/.git")).toBeUndefined();
    // Files in nested repositories belong to the innermost one, even under an ignored folder.
    expect(entry("repositories/svc-b/src/b.ts")).toMatchObject({
      class: "tracked",
      repo: "repositories/svc-b",
    });
    expect(entry("repositories/svc-b/scratch.txt")?.class).toBe("untracked");
  });

  it("records rebuildable folders without opening them", () => {
    const modules = entry("node_modules");
    expect(modules).toMatchObject({
      type: "directory",
      class: "rebuildable",
      size: 0,
      collapsed: { files: 0 },
    });
    expect(entry("node_modules/pkg/index.js")).toBeUndefined();
    expect(scan.totals.rebuildable).toEqual({ files: 0, bytes: 0 });
    expect(scan.skipped?.rebuildableFolders).toBe(1);
  });

  it("records links as links and never follows them", () => {
    expect(entry(".cursor/skills/appstore")).toMatchObject({
      type: "symlink",
      target: "../../skills/appstore",
      class: "tracked",
    });
    // Windows stores the absolute "/tmp" link against the current drive.
    const outsideTarget =
      process.platform === "win32" ? NodePath.resolve("/tmp").replaceAll("\\", "/") : "/tmp";
    expect(entry("outside-link")).toMatchObject({ type: "symlink", target: outsideTarget });
    expect(scan.entries.some((item) => item.path.startsWith(".cursor/skills/appstore/"))).toBe(
      false,
    );
    expect(symlinkTargetInside(".cursor/skills/appstore", "../../skills/appstore")).toBe(
      "skills/appstore",
    );
    expect(symlinkTargetInside("outside-link", "/tmp")).toBeNull();
    expect(symlinkTargetInside("outside-link", "D:/tmp")).toBeNull();
    expect(symlinkTargetInside("a", "../x")).toBeNull();
  });

  // POSIX permission bits: Windows has no executable bit to keep.
  it.skipIf(process.platform === "win32")("keeps file modes", () => {
    expect(entry("scripts/run.sh")?.mode).toBe(0o755);
  });

  it("describes each repository: refs, stash, status and worktrees", () => {
    const byPath = new Map(scan.repositories.map((repo) => [repo.path, repo]));
    expect([...byPath.keys()].toSorted()).toEqual([
      ".",
      "repositories/svc-a",
      "repositories/svc-b",
    ]);
    const serviceB = byPath.get("repositories/svc-b")!;
    expect(serviceB).toMatchObject({ kind: "main", branch: "main", stashCount: 1 });
    expect(Object.keys(serviceB.branches).toSorted()).toEqual(["local-only", "main"]);
    expect(serviceB.status).toEqual(expect.arrayContaining([" M src/b.ts", "?? scratch.txt"]));
    expect(serviceB.identity).toMatch(/^file:\/\/.*svc-b\.git$/);
    // The worktree inside the folder is not copied; its branch travels with svc-a
    // and svc-a no longer registers it.
    const serviceA = byPath.get("repositories/svc-a")!;
    expect(serviceA.worktrees).toEqual([]);
    expect(Object.keys(serviceA.branches).toSorted()).toEqual(["feature", "main"]);
    expect(
      scan.entries.some((item) => item.path.startsWith("repositories/svc-a/.git/worktrees/")),
    ).toBe(false);
    expect(scan.skipped?.worktrees).toEqual(["repositories/svc-a-wt-feature"]);
    expect(scan.notices?.join(" ")).toContain(
      "1 linked worktree(s) inside this folder are not copied: repositories/svc-a-wt-feature.",
    );
  });
});

describe("hashing and the manifest file", () => {
  it("hashes selected files whole and in 8 MiB chunks, and round-trips", async () => {
    const selection = new Set(DEFAULT_SELECTION);
    await hashSelected(scan, selection);
    const big = entry("work/big.bin")!;
    expect(big.size).toBe(fixture.bigFileBytes);
    expect(big.chunks).toHaveLength(Math.ceil(fixture.bigFileBytes / CHUNK_SIZE));
    expect(entry(".env")?.sha256).toBeUndefined();
    expect(entry("README.md")?.sha256).toBe(entry("work/copy-of-readme.md")?.sha256);
    const selected = selectEntries(scan.entries, selection);
    expect(selected.some((item) => item.class === "secret")).toBe(false);
    expect(selected.some((item) => item.collapsed)).toBe(false);
    expect(selected.find((item) => item.path === "work")).toBeDefined();
    const file = NodePath.join(base, "manifest.ndjson.gz");
    await writeManifest(file, {
      header: {
        version: 1,
        operationId: "019a0000-0000-7000-8000-000000000001",
        chunkSize: CHUNK_SIZE,
        selection: [...selection],
        repositories: scan.repositories,
        totals: scan.totals,
        warnings: scan.warnings,
        entryCount: selected.length,
      },
      entries: selected,
    });
    if (process.platform !== "win32") expect(NodeFS.statSync(file).mode & 0o777).toBe(0o600);
    const read = await readManifestFile(file);
    expect(read.entries).toHaveLength(selected.length);
    expect(read.header.repositories).toHaveLength(3);
  });

  it("expands rebuildable folders for an exact copy", async () => {
    const exact = await scanFolder(fixture.root, { expandRebuildable: true });
    expect(exact.entries.find((item) => item.path === "node_modules/pkg/index.js")?.class).toBe(
      "rebuildable",
    );
    expect(
      selectEntries(exact.entries, new Set(EXACT_SELECTION)).some(
        (item) => item.path === "node_modules/pkg/index.js",
      ),
    ).toBe(true);
  });
});

describe("paths and secret-like files", () => {
  it("refuses traversal, absolute and control-character paths", () => {
    for (const bad of [
      "",
      "/etc/passwd",
      "../x",
      "a/../b",
      "a//b",
      "./a",
      "a/.",
      "a\u0000b",
      "a\nb",
    ])
      expect(isSafeRelativePath(bad, "darwin")).toBe(false);
    expect(isSafeRelativePath("a\\b", "win32")).toBe(false);
    expect(isSafeRelativePath("repositories/svc-a/.git/HEAD", "darwin")).toBe(true);
  });

  it("treats env files, keys and listed credential files as secret-like", () => {
    for (const path of [
      ".env",
      "apps/api/.env.local",
      ".envrc",
      "web/.env-local",
      ".env_production",
      ".environment",
      "certs/server.pem",
      "keys/id_ed25519",
      "sub/.npmrc",
      "x/.docker/config.json",
      "deploy/.aws/credentials",
      "cfg/auth.json",
    ])
      expect(isSecretLikeProjectPath(path)).toBe(true);
    for (const path of ["README.md", "src/env.ts", "docs/aws.md", "environment.json"])
      expect(isSecretLikeProjectPath(path)).toBe(false);
  });
});

describe("cross-machine Finder metadata", () => {
  it.each(["ignored", "untracked", "outside"] as const)(
    "excludes %s Finder cache by default while exact copies retain it",
    (gitState) => {
      const kind = classifyFile({ relative: "nested/.DS_Store", insideGitData: false, gitState });
      expect(kind).toBe("rebuildable");
      expect(DEFAULT_SELECTION).not.toContain(kind);
      expect(EXACT_SELECTION).toContain(kind);
    },
  );

  it("retains deliberately tracked Finder metadata as source work", () => {
    expect(
      classifyFile({ relative: "nested/.DS_Store", insideGitData: false, gitState: "tracked" }),
    ).toBe("tracked");
  });
});

describe("rebuildable build output", () => {
  it("treats pure build and test output as rebuildable, but not local state or releases", () => {
    const ignored = (relative: string) =>
      classifyFile({ relative, insideGitData: false, gitState: "ignored" });
    for (const folder of [".open-next", "dist-electron", "playwright-report", "test-results"]) {
      expect(ignored(`app/${folder}/output.json`)).toBe("rebuildable");
      expect(isRebuildableDirectoryName(folder)).toBe(true);
    }
    for (const folder of [".wrangler", "release"]) {
      expect(ignored(`app/${folder}/state.json`)).toBe("ignoredData");
      expect(isRebuildableDirectoryName(folder)).toBe(false);
    }
  });
});

describe("forEachLimited", () => {
  it("stops taking items on the first failure and rejects only after in-flight work settled", async () => {
    const started: Array<number> = [];
    const settled: Array<number> = [];
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let rejected = false;
    const run = forEachLimited(
      Array.from({ length: 20 }, (_, index) => index),
      3,
      async (item) => {
        started.push(item);
        if (item === 1) throw new Error("boom");
        if (item === 0) await slow;
        settled.push(item);
      },
    ).catch((cause: unknown) => {
      rejected = true;
      throw cause;
    });
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    // Item 0 is still running, so the call has not rejected yet.
    expect(rejected).toBe(false);
    releaseSlow();
    await expect(run).rejects.toThrow("boom");
    expect(settled).toContain(0);
    // No worker picked up new items after the failure.
    expect(started.length).toBeLessThan(6);
  });
});

it("counts existing external folders and labels missing registrations without pruning", async () => {
  const main = NodePath.join(base, "external-main");
  NodeFS.mkdirSync(main);
  git(main, "init", "-q");
  NodeFS.writeFileSync(NodePath.join(main, "readme.txt"), "fixture");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "fixture");
  const gone = NodePath.join(base, "gone-external");
  const present = NodePath.join(base, "present-external");
  git(main, "worktree", "add", "-q", "-b", "gone", gone);
  git(main, "worktree", "add", "-q", "-b", "present", present);
  NodeFS.rmSync(gone, { recursive: true, force: true });
  const current = await scanFolder(main);
  expect(current.repositories[0]?.worktrees).toEqual([{ path: null, name: "present-external" }]);
  expect(current.notices?.join(" ")).toContain(
    "1 missing worktree registration(s), not current folders: gone-external",
  );
  expect(current.notices?.join(" ")).toContain("1 worktree(s) outside this folder");
  expect(git(main, "worktree", "list", "--porcelain")).toContain(gone);
  const added = NodePath.join(base, "new-external");
  git(main, "worktree", "add", "-q", "-b", "added", added);
  expect((await scanFolder(main)).repositories[0]?.worktrees).toHaveLength(2);
});
