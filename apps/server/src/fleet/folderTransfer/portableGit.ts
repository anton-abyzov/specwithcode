// @effect-diagnostics nodeBuiltinImport:off - operation-owned Git snapshots never modify the source repository.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { privateDirectory } from "./durable.ts";
import { FolderGitError, runGit } from "./git.ts";
import { emptyTotals, scanFolder, type FolderScan, type ManifestEntry } from "./manifest.ts";

/** Copy regular Git data only. Following a planted link could expose unrelated files. */
async function copyData(source: string, target: string, required = false): Promise<void> {
  const stat = await NodeFSP.lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && !required) return null;
    throw error;
  });
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new Error("Git metadata contains a symbolic link.");
  if (stat.isDirectory()) {
    await NodeFSP.mkdir(target, { recursive: true, mode: 0o700 });
    for (const name of await NodeFSP.readdir(source)) {
      if (name.endsWith(".lock") || name === "fsmonitor--daemon.ipc") continue;
      await copyData(NodePath.join(source, name), NodePath.join(target, name), true);
    }
  } else if (stat.isFile()) {
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true, mode: 0o700 });
    await NodeFSP.copyFile(source, target);
    await NodeFSP.chmod(target, stat.mode & 0o777);
  } else throw new Error("Git metadata is not a regular file or directory.");
}

/** Resolve object dependencies into the private copy, without copying another working folder. */
async function materializeAlternates(common: string, targetGit: string, target: string) {
  const alternates = NodePath.join(targetGit, "objects/info/alternates");
  if (!(await NodeFSP.lstat(alternates).catch(() => null))) return;
  const original = NodePath.join(common, "objects");
  const lines = (await NodeFSP.readFile(alternates, "utf8")).split("\n").filter(Boolean);
  await NodeFSP.writeFile(
    alternates,
    lines.map((line) => NodePath.resolve(original, line)).join("\n") + "\n",
  );
  await runGit(target, ["repack", "-a", "-d"]);
  await NodeFSP.unlink(alternates);
}

/** Paths in the manifest stay relative; only a source-owned marker selects the private overlay. */
export function sourceEntryRoot(folder: string, snapshotRoot: string, entry: ManifestEntry) {
  return entry.portableGit ? snapshotRoot : folder;
}

/** A repack racing the object walk must be retried or refused before any transfer. */
export async function preparePortableGit(
  scan: FolderScan,
  snapshotRoot: string,
): Promise<FolderScan> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prepareOnce(scan, snapshotRoot);
    } catch (cause) {
      const transient =
        cause instanceof FolderGitError || (cause as NodeJS.ErrnoException).code === "ENOENT";
      if (!transient) throw cause;
      if (attempt >= 1)
        throw new Error(
          "Could not prepare a self-contained Git snapshot. Git may have changed or repacked while it was being read. Retry the copy; source files were not changed.",
        );
    }
  }
}

/**
 * Turn an out-of-scope linked worktree into a self-contained repository. Copy
 * its index/HEAD and the common object/ref database, never sibling worktrees,
 * hooks, credentials, or machine-specific common-dir/config pointers.
 */
async function prepareOnce(scan: FolderScan, snapshotRoot: string): Promise<FolderScan> {
  const mains = scan.repositories.filter((repo) => repo.kind === "main");
  const external = scan.repositories.filter(
    (repo) => (repo.kind === "linked" && repo.mainRepository === null) || repo.kind === "gitfile",
  );
  let entries = [...scan.entries];
  const repositories = [...scan.repositories];
  const notices = [...(scan.notices ?? [])];
  if (mains.length > 0 || external.length > 0)
    notices.push(
      "Git history, branches and staged changes are captured when copying starts. Work created afterward stays on this machine; copy again to include it.",
    );
  // A main checkout may know about worktrees excluded from the selected root.
  // Keep their branches, but do not ship stale Mac paths as registered worktrees.
  for (const info of scan.repositories.filter((repo) => repo.kind === "main")) {
    const prefix = info.path === "." ? ".git/worktrees/" : `${info.path}/.git/worktrees/`;
    for (const entry of scan.entries.filter(
      (item) =>
        item.type === "file" && item.path.startsWith(prefix) && item.path.endsWith("/gitdir"),
    )) {
      const pointer = (await NodeFSP.readFile(NodePath.join(scan.root, entry.path), "utf8")).trim();
      const location = NodePath.resolve(
        NodePath.dirname(NodePath.join(scan.root, entry.path)),
        pointer,
      );
      if (location.startsWith(`${scan.root}${NodePath.sep}`)) continue;
      const admin = entry.path.slice(0, -"/gitdir".length);
      entries = entries.filter((item) => item.path !== admin && !item.path.startsWith(`${admin}/`));
    }
  }
  if (external.length > 0 || mains.length > 0) await privateDirectory(snapshotRoot);
  // Freeze mutable Git metadata before listing its objects. A later commit may
  // publish a new ref, but the transfer must keep the matching earlier ref and
  // object graph rather than refreshing only half of the repository.
  for (const info of mains) {
    const prefix = info.path === "." ? ".git" : `${info.path}/.git`;
    const targetGit = NodePath.join(snapshotRoot, prefix);
    await NodeFSP.rm(targetGit, { recursive: true, force: true });
    for (const entry of entries.filter(
      (entry) =>
        (entry.path === prefix || entry.path.startsWith(`${prefix}/`)) &&
        entry.path !== `${prefix}/objects` &&
        !entry.path.startsWith(`${prefix}/objects/`),
    )) {
      const target = NodePath.join(snapshotRoot, entry.path);
      if (entry.type === "directory") {
        await NodeFSP.mkdir(target, { recursive: true, mode: entry.mode });
        await NodeFSP.chmod(target, entry.mode);
      } else await copyData(NodePath.join(scan.root, entry.path), target, true);
    }
    // Re-list objects AFTER all HEAD/index/refs/reflogs (including worktree
    // indexes) have been frozen. Missing/repacked files fail before any apply.
    await copyData(
      NodePath.join(scan.root, prefix, "objects"),
      NodePath.join(targetGit, "objects"),
    );
    await materializeAlternates(
      NodePath.join(scan.root, prefix),
      targetGit,
      NodePath.dirname(targetGit),
    );
  }
  // Internal worktrees retain their relationship using deterministic relative
  // pointers. They never read the original Mac admin directory during checks.
  for (const info of scan.repositories.filter(
    (repo) => repo.kind === "linked" && repo.mainRepository !== null,
  )) {
    const gitDir = (
      await runGit(NodePath.join(scan.root, info.path), [
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
      ])
    ).stdout.trim();
    const main = NodePath.join(snapshotRoot, info.mainRepository!);
    const admin = NodePath.join(main, ".git", "worktrees", NodePath.basename(gitDir));
    const folder = NodePath.join(snapshotRoot, info.path);
    await NodeFSP.mkdir(folder, { recursive: true, mode: 0o700 });
    await NodeFSP.writeFile(
      NodePath.join(folder, ".git"),
      `gitdir: ${NodePath.relative(folder, admin)}\n`,
    );
    await NodeFSP.writeFile(
      NodePath.join(admin, "gitdir"),
      `${NodePath.relative(admin, NodePath.join(folder, ".git"))}\n`,
    );
    await NodeFSP.writeFile(
      NodePath.join(admin, "commondir"),
      `${NodePath.relative(admin, NodePath.join(main, ".git"))}\n`,
    );
  }
  for (const info of mains)
    await runGit(NodePath.join(snapshotRoot, info.path), [
      "fsck",
      "--connectivity-only",
      "--no-progress",
    ]);
  for (const info of external) {
    const relative = info.path === "." ? "" : info.path;
    const source = NodePath.join(scan.root, relative);
    const target = NodePath.join(snapshotRoot, relative);
    const targetGit = NodePath.join(target, ".git");
    const common = (
      await runGit(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).stdout.trim();
    const worktree = (
      await runGit(source, ["rev-parse", "--path-format=absolute", "--git-dir"])
    ).stdout.trim();
    for (const marker of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "sequencer",
      "rebase-merge",
      "rebase-apply",
    ])
      if (await NodeFSP.lstat(NodePath.join(worktree, marker)).catch(() => null))
        throw new Error(
          `${info.path}: finish or abort the in-progress Git merge, rebase or cherry-pick before copying this external worktree. Ordinary uncommitted changes can be copied.`,
        );
    await NodeFSP.mkdir(target, { recursive: true, mode: 0o700 });
    // Rebuild only this exact operation-owned overlay, never the selected source.
    await NodeFSP.rm(targetGit, { recursive: true, force: true });
    const format = (await runGit(source, ["rev-parse", "--show-object-format"])).stdout.trim();
    await runGit(target, ["init", "-q", `--object-format=${format}`, "--template="]);
    for (const name of [
      "refs",
      "logs/refs",
      "packed-refs",
      "shallow",
      "info/exclude",
      "info/sparse-checkout",
    ])
      await copyData(NodePath.join(common, name), NodePath.join(targetGit, name));
    for (const name of ["HEAD", "index", "logs/HEAD", "refs", "ORIG_HEAD", "info/sparse-checkout"])
      await copyData(NodePath.join(worktree, name), NodePath.join(targetGit, name));
    for (const key of [
      "core.fileMode",
      "core.symlinks",
      "core.sparseCheckout",
      "core.sparseCheckoutCone",
      "index.sparse",
    ]) {
      const setting = await runGit(source, ["config", "--bool", "--get", key], {
        allowFailure: true,
      });
      if (setting.code === 0) await runGit(target, ["config", key, setting.stdout.trim()]);
    }
    // Split indexes can refer to a shared index in either Git directory.
    for (const directory of new Set([common, worktree]))
      for (const name of await NodeFSP.readdir(directory))
        if (/^sharedindex\.[a-f0-9]+$/.test(name))
          await copyData(NodePath.join(directory, name), NodePath.join(targetGit, name));
    if (info.origin) await runGit(target, ["config", "remote.origin.url", info.origin]);
    await runGit(target, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    await copyData(NodePath.join(common, "objects"), NodePath.join(targetGit, "objects"));
    await materializeAlternates(common, targetGit, target);
    if (await NodeFSP.lstat(NodePath.join(targetGit, "index")).catch(() => null))
      await runGit(target, ["update-index", "--no-split-index"]);
    await runGit(target, ["fsck", "--connectivity-only", "--no-progress"]);
    const materialized = await scanFolder(target);
    const prefix = relative ? `${relative}/.git` : ".git";
    entries = entries.filter(
      (entry) => entry.path !== prefix && !entry.path.startsWith(`${prefix}/`),
    );
    entries.push(
      ...materialized.entries
        .filter((entry) => entry.path === ".git" || entry.path.startsWith(".git/"))
        .map((entry) => ({
          ...entry,
          path: relative ? `${relative}/${entry.path}` : entry.path,
          repo: info.path,
          portableGit: true,
        })),
    );
    repositories[repositories.indexOf(info)] = {
      ...info,
      kind: "main",
      worktrees: [],
      mainRepository: null,
    };
    notices.push(
      `${info.path}: this worktree will become an independent Git repository, preserving its branch, staged changes, history and stashes. Other working folders are not copied.`,
    );
  }
  if (mains.length > 0) {
    const frozen = await scanFolder(snapshotRoot);
    const mainGitPaths = mains.map((info) => (info.path === "." ? ".git" : `${info.path}/.git`));
    const linkedPaths = scan.repositories
      .filter((repo) => repo.kind === "linked" && repo.mainRepository !== null)
      .map((repo) => `${repo.path}/.git`);
    const belongs = (relative: string) =>
      linkedPaths.includes(relative) ||
      mainGitPaths.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
    entries = entries.filter((entry) => !belongs(entry.path));
    entries.push(
      ...frozen.entries
        .filter((entry) => belongs(entry.path))
        .map((entry) => ({ ...entry, portableGit: true })),
    );
    for (const info of frozen.repositories) {
      const index = repositories.findIndex((repo) => repo.path === info.path);
      if (index < 0) continue;
      const previous = repositories[index]!;
      repositories[index] = {
        ...previous,
        head: info.head,
        branch: info.branch,
        branches: info.branches,
        stash: info.stash,
        stashCount: info.stashCount,
      };
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const totals = emptyTotals();
  for (const entry of entries)
    if (entry.type === "file" || entry.collapsed) {
      totals[entry.class].files += entry.collapsed?.files ?? 1;
      totals[entry.class].bytes += entry.size;
    }
  return { ...scan, entries, repositories, totals, notices };
}
