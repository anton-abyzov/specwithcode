// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - disposable real Git repositories changed between measuring and copying.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { git, write } from "./folderFixture.testkit.ts";
import { FolderGitError, runGit } from "./git.ts";
import { isScanStopped, scanFolder, type FolderScan } from "./manifest.ts";
import { preparePortableGit } from "./portableGit.ts";

const roots: Array<string> = [];
afterEach(() => {
  // A Git process killed on Windows can hold its folder for a moment after it exits.
  for (const root of roots.splice(0))
    NodeFS.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/**
 * base/
 *   root/app/          main repository: loose and packed objects, branches
 *   root/app-wt/       its worktree inside the root (skipped)
 *   outside-wt/        its worktree outside the root
 *   overlay/           the operation's private snapshot
 */
function umbrella() {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-git-race-")),
  );
  roots.push(base);
  const root = NodePath.join(base, "root");
  const app = NodePath.join(root, "app");
  NodeFS.mkdirSync(app, { recursive: true });
  git(app, "init", "-q");
  for (let index = 0; index < 5; index += 1) {
    write(NodePath.join(app, `file-${index}.txt`), `packed ${index}\n`);
    git(app, "add", ".");
    git(app, "commit", "-qm", `packed ${index}`);
  }
  git(app, "gc", "-q");
  for (let index = 0; index < 5; index += 1) {
    write(NodePath.join(app, `loose-${index}.txt`), `loose ${index}\n`);
    git(app, "add", ".");
    git(app, "commit", "-qm", `loose ${index}`);
  }
  git(app, "branch", "doomed", "HEAD~2");
  git(app, "branch", "kept", "HEAD~1");
  git(app, "worktree", "add", "-qb", "inside", NodePath.join(root, "app-wt"));
  git(app, "worktree", "add", "-qb", "elsewhere", NodePath.join(base, "outside-wt"));
  git(app, "reset", "-q", "HEAD~1");
  git(app, "reset", "-q", "HEAD@{1}");
  expect(NodeFS.existsSync(NodePath.join(app, ".git/ORIG_HEAD"))).toBe(true);
  return { base, root, app, overlay: NodePath.join(base, "overlay") };
}

/** Every snapshot entry exists in the overlay with the recorded type and size. */
function expectEntriesMatchOverlay(prepared: FolderScan, overlay: string) {
  const snapshot = prepared.entries.filter((entry) => entry.portableGit);
  expect(snapshot.length).toBeGreaterThan(0);
  for (const entry of snapshot) {
    const stat = NodeFS.lstatSync(NodePath.join(overlay, entry.path));
    if (entry.type === "file") expect(stat.size).toBe(entry.size);
    else expect(stat.isDirectory()).toBe(entry.type === "directory");
  }
}

describe("Git snapshot while Git keeps changing", () => {
  it("drops refs, worktrees and ORIG_HEAD that Git deleted after measuring", async () => {
    const { root, app, overlay } = umbrella();
    const scan = await scanFolder(root);
    expect(scan.entries.some((entry) => entry.path === "app/.git/refs/heads/doomed")).toBe(true);
    expect(scan.entries.some((entry) => entry.path === "app/.git/ORIG_HEAD")).toBe(true);
    expect(scan.skipped?.worktrees).toEqual(["app-wt"]);

    git(app, "branch", "-D", "doomed");
    git(app, "worktree", "remove", "--force", NodePath.join(root, "app-wt"));
    NodeFS.rmSync(NodePath.join(app, ".git/ORIG_HEAD"));
    git(app, "branch", "after-measure");

    const prepared = await preparePortableGit(scan, overlay);
    const snapshot = NodePath.join(overlay, "app");
    const paths = prepared.entries.map((entry) => entry.path);
    expect(paths).not.toContain("app/.git/refs/heads/doomed");
    expect(paths).not.toContain("app/.git/logs/refs/heads/doomed");
    expect(paths).not.toContain("app/.git/ORIG_HEAD");
    expect(paths.some((path) => path.startsWith("app/.git/worktrees/"))).toBe(false);
    expect(git(snapshot, "for-each-ref", "--format=%(refname:short)", "refs/heads")).not.toContain(
      "doomed",
    );
    // Listed when copying starts: a branch made after measuring is in the snapshot.
    expect(git(snapshot, "rev-parse", "after-measure")).toBe(git(app, "rev-parse", "HEAD"));
    expect(git(snapshot, "rev-parse", "kept")).toBe(git(app, "rev-parse", "kept"));
    git(snapshot, "fsck", "--connectivity-only");
    expect(prepared.repositories[0]?.branches).not.toHaveProperty("doomed");
    expectEntriesMatchOverlay(prepared, overlay);
    expect(prepared.entries.some((entry) => entry.path === "app/.git/objects/pack")).toBe(true);
  });

  it("survives a repack and prune between measuring and copying", async () => {
    const { root, app, overlay } = umbrella();
    const scan = await scanFolder(root);
    const looseBefore = scan.entries.filter((entry) =>
      /^app\/\.git\/objects\/[0-9a-f]{2}\//.test(entry.path),
    );
    expect(looseBefore.length).toBeGreaterThan(0);

    git(app, "repack", "-a", "-d", "-q");
    git(app, "gc", "-q", "--prune=now");

    const prepared = await preparePortableGit(scan, overlay);
    const snapshot = NodePath.join(overlay, "app");
    git(snapshot, "fsck", "--connectivity-only");
    expect(git(snapshot, "rev-parse", "HEAD")).toBe(git(app, "rev-parse", "HEAD"));
    // The measured loose objects are gone; none of them is expected.
    expect(
      prepared.entries.filter((entry) => /^app\/\.git\/objects\/[0-9a-f]{2}\//.test(entry.path)),
    ).toEqual([]);
    expectEntriesMatchOverlay(prepared, overlay);
  });

  it("survives a repack that deletes the listed packs while they are copied", async () => {
    const { root, app, overlay } = umbrella();
    const scan = await scanFolder(root);
    const packsBefore = NodeFS.readdirSync(NodePath.join(app, ".git/objects/pack"));
    let repacked = 0;
    const prepared = await preparePortableGit(scan, overlay, {
      beforePackCopy: (gitDir) => {
        if (gitDir !== NodePath.join(app, ".git") || repacked > 0) return;
        repacked += 1;
        // New packs are written first, then the old packs and loose objects go.
        git(app, "repack", "-a", "-d", "-q");
        git(app, "prune-packed");
        git(app, "prune", "--expire=now");
      },
    });
    expect(repacked).toBe(1);
    const packsAfter = NodeFS.readdirSync(NodePath.join(app, ".git/objects/pack"));
    const survivors = packsAfter.filter(
      (name) => packsBefore.includes(name) && name.endsWith(".pack"),
    );
    expect(survivors).toEqual([]);
    const snapshot = NodePath.join(overlay, "app");
    git(snapshot, "fsck", "--connectivity-only");
    expect(git(snapshot, "rev-parse", "HEAD")).toBe(git(app, "rev-parse", "HEAD"));
    expect(git(snapshot, "log", "--format=%s", "-1", "HEAD~7")).toBe("packed 2");
    // No half pack: every copied .pack has its .idx.
    const copied = NodeFS.readdirSync(NodePath.join(snapshot, ".git/objects/pack"));
    for (const name of copied.filter((item) => item.endsWith(".pack")))
      expect(copied).toContain(name.replace(/\.pack$/, ".idx"));
    expectEntriesMatchOverlay(prepared, overlay);
  });

  it("retries a repository whose snapshot keeps failing, then names it", async () => {
    const { root, app, overlay } = umbrella();
    const scan = await scanFolder(root);
    NodeFS.rmSync(NodePath.join(app, ".git/HEAD"));
    const started = Date.now();
    await expect(preparePortableGit(scan, overlay)).rejects.toThrow(
      /Git snapshot of repository "app".*Retry the copy; source files were not changed/,
    );
    // Three attempts with 0.5 s and 2 s pauses in between.
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_400);
  });

  it("stops promptly when asked during the copy", async () => {
    const { root, overlay } = umbrella();
    const scan = await scanFolder(root);
    let checks = 0;
    const started = Date.now();
    const outcome = await preparePortableGit(scan, overlay, {
      shouldStop: () => {
        checks += 1;
        return checks > 5;
      },
    }).catch((cause: unknown) => cause);
    expect(isScanStopped(outcome)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("stops during the pause before a retry", async () => {
    const { root, app, overlay } = umbrella();
    const scan = await scanFolder(root);
    NodeFS.rmSync(NodePath.join(app, ".git/HEAD"));
    const started = Date.now();
    const outcome = await preparePortableGit(scan, overlay, {
      shouldStop: () => Date.now() - started > 150,
    }).catch((cause: unknown) => cause);
    expect(isScanStopped(outcome)).toBe(true);
    expect(Date.now() - started).toBeLessThan(450);
  });

  it("kills a running Git command when its stop signal fires", async () => {
    const { app } = umbrella();
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    // `cat-file --batch` waits on its open input forever.
    await expect(
      runGit(app, ["cat-file", "--batch"], { signal: controller.signal }),
    ).rejects.toBeInstanceOf(FolderGitError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("copies large packs whole (cloned on macOS) and keeps their permissions", async () => {
    const { root, app, overlay } = umbrella();
    write(NodePath.join(app, "large.bin"), NodeCrypto.randomBytes(3 * 1024 * 1024));
    git(app, "add", ".");
    git(app, "commit", "-qm", "large");
    git(app, "repack", "-a", "-d", "-q");
    const scan = await scanFolder(root);
    await preparePortableGit(scan, overlay);
    const sourcePacks = NodePath.join(app, ".git/objects/pack");
    const large = NodeFS.readdirSync(sourcePacks).find(
      (name) =>
        name.endsWith(".pack") &&
        NodeFS.statSync(NodePath.join(sourcePacks, name)).size > 1024 * 1024,
    )!;
    const copy = NodePath.join(overlay, "app/.git/objects/pack", large);
    const original = NodeFS.readFileSync(NodePath.join(sourcePacks, large));
    expect(NodeFS.readFileSync(copy).equals(original)).toBe(true);
    expect(NodeFS.statSync(copy).mode & 0o777).toBe(
      NodeFS.statSync(NodePath.join(sourcePacks, large)).mode & 0o777,
    );
    git(NodePath.join(overlay, "app"), "fsck", "--connectivity-only");
  });

  it("reports Git bytes copied", async () => {
    const { root, overlay } = umbrella();
    const scan = await scanFolder(root);
    const reports: Array<{ files: number; bytes: number }> = [];
    await preparePortableGit(scan, overlay, {
      onProgress: (progress) => reports.push(progress),
    });
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.at(-1)!.bytes).toBeGreaterThan(0);
  });
});

/** root/app with 50 branches: the first ten packed when `packed`, the rest loose. */
function manyBranches(packed: boolean) {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-git-refs-")),
  );
  roots.push(base);
  const root = NodePath.join(base, "root");
  const app = NodePath.join(root, "app");
  NodeFS.mkdirSync(app, { recursive: true });
  git(app, "init", "-q", "-b", "main");
  write(NodePath.join(app, "a.txt"), "a\n");
  git(app, "add", ".");
  git(app, "commit", "-qm", "a");
  for (let index = 0; index < 10; index += 1) git(app, "branch", `b${index}`);
  if (packed) git(app, "pack-refs", "--all");
  for (let index = 10; index < 50; index += 1) git(app, "branch", `b${index}`);
  return { base, root, app, overlay: NodePath.join(base, "overlay") };
}

const branchNames = (folder: string) =>
  git(folder, "for-each-ref", "--format=%(refname:short)", "refs/heads")
    .split("\n")
    .filter(Boolean);

describe("refs that Git packs, renames or reshapes while they are copied", () => {
  for (const packed of [false, true])
    it(`keeps every branch when Git packs all refs mid-copy (${packed ? "some packed" : "all loose"})`, async () => {
      const { root, app, overlay } = manyBranches(packed);
      const scan = await scanFolder(root);
      let fired = false;
      const prepared = await preparePortableGit(scan, overlay, {
        // The first progress report comes from the first Git file copied.
        onProgress: () => {
          if (fired) return;
          fired = true;
          git(app, "pack-refs", "--all");
        },
      });
      expect(fired).toBe(true);
      const snapshot = NodePath.join(overlay, "app");
      expect(branchNames(snapshot).sort()).toEqual(branchNames(app).sort());
      expect(branchNames(snapshot)).toHaveLength(51);
      expect(git(snapshot, "rev-parse", "--verify", "HEAD")).toBe(git(app, "rev-parse", "HEAD"));
      expect(Object.keys(prepared.repositories[0]!.branches)).toHaveLength(51);
      git(snapshot, "fsck", "--connectivity-only");
    });

  it("treats a listed ref that became a folder as vanished", async () => {
    const { root, app, overlay } = manyBranches(false);
    for (let index = 50; index < 300; index += 1) git(app, "branch", `b${index}`);
    git(app, "branch", "zz-fix");
    const scan = await scanFolder(root);
    let fired = false;
    await preparePortableGit(scan, overlay, {
      onProgress: () => {
        if (fired) return;
        fired = true;
        git(app, "branch", "-D", "zz-fix");
        git(app, "branch", "zz-fix/x");
      },
    });
    expect(fired).toBe(true);
    const snapshot = NodePath.join(overlay, "app");
    expect(branchNames(snapshot)).not.toContain("zz-fix");
    expect(branchNames(snapshot)).toContain("b299");
    git(snapshot, "fsck", "--connectivity-only");
  });

  it("still refuses a ref that is a symbolic link", async () => {
    const { root, app, overlay } = manyBranches(false);
    NodeFS.symlinkSync(
      NodePath.join(app, ".git/refs/heads/b1"),
      NodePath.join(app, ".git/refs/heads/linked"),
    );
    const scan = await scanFolder(root);
    await expect(preparePortableGit(scan, overlay)).rejects.toThrow(/symbolic link/);
  });

  it("takes the repository again when a ref Git kept is missing from the snapshot", async () => {
    const { root, app, overlay } = manyBranches(true);
    const scan = await scanFolder(root);
    let losses = 0;
    const prepared = await preparePortableGit(scan, overlay, {
      beforePackCopy: (gitDir) => {
        if (gitDir !== NodePath.join(app, ".git") || losses > 0) return;
        losses += 1;
        // As if Git moved b3 between the loose and packed copies: gone from both.
        const target = NodePath.join(overlay, "app/.git");
        NodeFS.rmSync(NodePath.join(target, "refs/heads/b3"), { force: true });
        const packedRefs = NodePath.join(target, "packed-refs");
        NodeFS.writeFileSync(
          packedRefs,
          NodeFS.readFileSync(packedRefs, "utf8")
            .split("\n")
            .filter((line) => !line.endsWith(" refs/heads/b3"))
            .join("\n"),
        );
      },
    });
    expect(losses).toBe(1);
    const snapshot = NodePath.join(overlay, "app");
    expect(branchNames(snapshot)).toContain("b3");
    expect(branchNames(snapshot)).toHaveLength(51);
    expect(Object.keys(prepared.repositories[0]!.branches)).toContain("b3");
  });
});

describe("a repository re-created at a stale worktree path", () => {
  it("is walked and copied as an ordinary repository", async () => {
    const { root, app, overlay } = umbrella();
    const stale = NodePath.join(root, "stale");
    git(app, "worktree", "add", "-qb", "was-worktree", stale);
    NodeFS.rmSync(stale, { recursive: true, force: true });
    NodeFS.mkdirSync(stale);
    git(stale, "init", "-q");
    write(NodePath.join(stale, "own.txt"), "independent work\n");
    git(stale, "add", ".");
    git(stale, "commit", "-qm", "independent");
    write(NodePath.join(stale, "draft.txt"), "uncommitted\n");
    // The main repository still names the path as one of its worktrees.
    // Git prints worktree paths with forward slashes on Windows too.
    expect(git(app, "worktree", "list", "--porcelain")).toContain(
      stale.split(NodePath.sep).join("/"),
    );

    const scan = await scanFolder(root);
    expect(scan.skipped?.worktrees).toEqual(["app-wt"]);
    expect(scan.repositories.find((repo) => repo.path === "stale")).toMatchObject({
      kind: "main",
      head: git(stale, "rev-parse", "HEAD"),
    });
    const paths = scan.entries.map((entry) => entry.path);
    expect(paths).toContain("stale/own.txt");
    expect(scan.entries.find((entry) => entry.path === "stale/draft.txt")?.class).toBe("untracked");
    expect(paths).toContain("stale/.git/HEAD");

    const prepared = await preparePortableGit(scan, overlay);
    git(NodePath.join(overlay, "stale"), "fsck", "--connectivity-only");
    expect(git(NodePath.join(overlay, "stale"), "rev-parse", "HEAD")).toBe(
      git(stale, "rev-parse", "HEAD"),
    );
    expect(prepared.entries.some((entry) => entry.path.startsWith("app/.git/worktrees/"))).toBe(
      false,
    );
  });
});
