// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { isSecretLikeProjectPath } from "../../workspace/WorkspaceSensitivePaths.ts";
import { DEFAULT_SELECTION, EXACT_SELECTION } from "./classify.ts";
import { makeUmbrella, type UmbrellaFixture } from "./folderFixture.testkit.ts";
import {
  CHUNK_SIZE,
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
    expect(entry("repositories/svc-a-wt-feature/.git")?.class).toBe("repository");
    // Files in nested repositories belong to the innermost one, even under an ignored folder.
    expect(entry("repositories/svc-b/src/b.ts")).toMatchObject({
      class: "tracked",
      repo: "repositories/svc-b",
    });
    expect(entry("repositories/svc-b/scratch.txt")?.class).toBe("untracked");
  });

  it("counts rebuildable folders without listing them", () => {
    const modules = entry("node_modules");
    expect(modules).toMatchObject({
      type: "directory",
      class: "rebuildable",
      collapsed: { files: 1 },
    });
    expect(entry("node_modules/pkg/index.js")).toBeUndefined();
    expect(scan.totals.rebuildable.files).toBe(1);
  });

  it("records links as links and never follows them", () => {
    expect(entry(".cursor/skills/appstore")).toMatchObject({
      type: "symlink",
      target: "../../skills/appstore",
      class: "tracked",
    });
    expect(entry("outside-link")).toMatchObject({ type: "symlink", target: "/tmp" });
    expect(scan.entries.some((item) => item.path.startsWith(".cursor/skills/appstore/"))).toBe(
      false,
    );
    expect(symlinkTargetInside(".cursor/skills/appstore", "../../skills/appstore")).toBe(
      "skills/appstore",
    );
    expect(symlinkTargetInside("outside-link", "/tmp")).toBeNull();
    expect(symlinkTargetInside("a", "../x")).toBeNull();
  });

  it("keeps file modes", () => {
    expect(entry("scripts/run.sh")?.mode).toBe(0o755);
  });

  it("describes each repository: refs, stash, status and worktrees", () => {
    const byPath = new Map(scan.repositories.map((repo) => [repo.path, repo]));
    expect([...byPath.keys()].toSorted()).toEqual([
      ".",
      "repositories/svc-a",
      "repositories/svc-a-wt-feature",
      "repositories/svc-b",
    ]);
    const serviceB = byPath.get("repositories/svc-b")!;
    expect(serviceB).toMatchObject({ kind: "main", branch: "main", stashCount: 1 });
    expect(Object.keys(serviceB.branches).toSorted()).toEqual(["local-only", "main"]);
    expect(serviceB.status).toEqual(expect.arrayContaining([" M src/b.ts", "?? scratch.txt"]));
    expect(serviceB.identity).toMatch(/^file:\/\/.*svc-b\.git$/);
    const serviceA = byPath.get("repositories/svc-a")!;
    expect(serviceA.worktrees).toEqual([
      { path: "repositories/svc-a-wt-feature", name: "svc-a-wt-feature" },
    ]);
    expect(byPath.get("repositories/svc-a-wt-feature")).toMatchObject({
      kind: "linked",
      branch: "feature",
      mainRepository: "repositories/svc-a",
    });
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
    expect(NodeFS.statSync(file).mode & 0o777).toBe(0o600);
    const read = await readManifestFile(file);
    expect(read.entries).toHaveLength(selected.length);
    expect(read.header.repositories).toHaveLength(4);
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
