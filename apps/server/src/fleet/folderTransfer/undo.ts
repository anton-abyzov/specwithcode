// @effect-diagnostics nodeBuiltinImport:off - Undo restores backed-up files and refs from the Apply journal.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

import { moveEntry, removePartials, type JournalEntry } from "./apply.ts";
import { exists, JsonLog, lstatOrNull } from "./durable.ts";
import { runGit } from "./git.ts";
import { hashFile } from "./manifest.ts";
import { isSafeRelativePath, linkTargetOnWire } from "./paths.ts";

export interface UndoItem {
  readonly path: string;
  readonly kind: "file" | "ref" | "head" | "stash" | "worktree" | "clone";
  /** What Undo will do, or why it will not. */
  readonly state: "restore" | "edited" | "missing";
  readonly detail: string;
}

export interface UndoPreview {
  readonly items: ReadonlyArray<UndoItem>;
  /** Files or refs changed after Apply; Undo keeps them unless forced. */
  readonly edited: number;
}

export interface UndoResult {
  readonly restored: number;
  /** Paths left as they are because they changed after Apply. */
  readonly kept: ReadonlyArray<string>;
  /** Edited files moved into the backup because Undo was forced. */
  readonly movedToBackup: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<string>;
}

const location = (root: string, relative: string) => NodePath.join(root, ...relative.split("/"));

interface Content {
  readonly sha256: string | null;
  readonly linkTarget: string | null;
}

/** Fingerprint the restoration outcome without following a backed-up symlink. */
async function undoStat(path: string) {
  return NodeFSP.lstat(path).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  });
}

async function undoDigest(path: string): Promise<string | null> {
  const stat = await undoStat(path);
  if (!stat) return null;
  if (stat.isSymbolicLink()) return `link:${await NodeFSP.readlink(path)}`;
  if (stat.isFile()) return `file:${stat.mode & 0o777}:${(await hashFile(path, false)).sha256}`;
  if (!stat.isDirectory()) throw new Error(`Unsupported original entry: ${path}`);
  const children: Array<[string, string | null]> = [];
  for (const name of (await NodeFSP.readdir(path)).sort())
    children.push([name, await undoDigest(NodePath.join(path, name))]);
  return `directory:${stat.mode & 0o777}:${NodeCrypto.createHash("sha256").update(JSON.stringify(children)).digest("hex")}`;
}

async function undoProgress(entries: ReadonlyArray<JournalEntry>, root: string) {
  const intents = new Map<string, Extract<JournalEntry, { t: "undo-file-intent" }>>();
  const completed = new Set<string>();
  for (const entry of entries) {
    if (entry.t === "undo-file-intent") intents.set(entry.path, entry);
    else if (entry.t === "undo-file-done") completed.add(entry.path);
  }
  const reconciled: string[] = [];
  for (const [path, intent] of intents)
    if (!completed.has(path) && (await undoDigest(location(root, path))) === intent.digest) {
      completed.add(path);
      reconciled.push(path);
    }
  return { intents, completed, reconciled };
}

/**
 * Everything Apply journaled for each path: its write, its own later rewrites and
 * restores. Any of them is Apply's own; a restore is synced before it lands, so a
 * crash or failure in between leaves the write in place.
 */
function expectedContent(entries: ReadonlyArray<JournalEntry>) {
  const expected = new Map<string, Array<Content>>();
  const add = (path: string, content: Content) => {
    const list = expected.get(path);
    if (list) list.push(content);
    else expected.set(path, [content]);
  };
  for (const entry of entries)
    if (entry.t === "write" || entry.t === "restore") add(entry.path, entry);
    else if (entry.t === "rewritten") add(entry.path, { sha256: entry.sha256, linkTarget: null });
  return expected;
}

/** Whether `relative` still holds something Apply left there. */
async function holds(root: string, relative: string, contents: ReadonlyArray<Content>) {
  const absolute = location(root, relative);
  const stat = await undoStat(absolute);
  if (!stat) return "missing" as const;
  let linkTarget: string | undefined;
  let sha256: string | undefined;
  for (const content of contents) {
    if (content.linkTarget !== null) {
      if (!stat.isSymbolicLink()) continue;
      linkTarget ??= linkTargetOnWire(await NodeFSP.readlink(absolute));
      if (linkTarget === content.linkTarget) return "same" as const;
    } else if (stat.isFile() && content.sha256) {
      sha256 ??= (await hashFile(absolute, false)).sha256;
      if (sha256 === content.sha256) return "same" as const;
    }
  }
  return "edited" as const;
}

const matchesWrite = (
  root: string,
  entry: Extract<JournalEntry, { t: "write" }>,
  expected: ReadonlyMap<string, ReadonlyArray<Content>>,
) => holds(root, entry.path, expected.get(entry.path) ?? [entry]);

async function refValue(cwd: string, ref: string) {
  const result = await runGit(cwd, ["rev-parse", "--verify", "-q", ref], { allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : null;
}

/** Local Git stash names are NUL-delimited, not wire protocol paths. */
function safeStashPath(cwd: string, path: string) {
  if (!path || path.includes("\0") || NodePath.isAbsolute(path)) return false;
  if (path.split("/").some((part) => !part || part === "." || part === "..")) return false;
  if (process.platform === "win32" && /[\\:]/.test(path)) return false;
  const relative = NodePath.relative(cwd, location(cwd, path));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
}

/** Only the paths whose index/worktree state the saved stash restores. */
async function stashPaths(cwd: string, sha: string) {
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error("Invalid saved stash identity.");
  const names = async (args: string[]) =>
    (await runGit(cwd, args)).stdout.split("\0").filter(Boolean);
  const tracked = [
    ...new Set([
      ...(await names([
        "diff-tree",
        "--no-renames",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-z",
        `${sha}^1`,
        sha,
      ])),
      ...(await names([
        "diff-tree",
        "--no-renames",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-z",
        `${sha}^1`,
        `${sha}^2`,
      ])),
    ]),
  ].sort();
  const untrackedTree = await refValue(cwd, `${sha}^3`);
  const untracked = untrackedTree
    ? await names(["ls-tree", "-r", "-z", "--name-only", untrackedTree])
    : [];
  const all = [...new Set([...tracked, ...untracked])].sort();
  if (all.some((path) => !safeStashPath(cwd, path)))
    throw new Error("A saved stash path cannot be inspected safely.");
  return { tracked, untracked, untrackedTree, all };
}

async function stashBefore(cwd: string, paths: readonly string[]) {
  const files: Array<[string, string | null]> = [];
  for (const path of paths) files.push([path, await undoDigest(location(cwd, path))]);
  const index = paths.length
    ? (await runGit(cwd, ["ls-files", "--stage", "-z", "--", ...paths])).stdout
    : "";
  return NodeCrypto.createHash("sha256").update(JSON.stringify({ files, index })).digest("hex");
}

/** Compare Git's saved working/index trees without changing the destination index. */
async function stashRestored(
  cwd: string,
  sha: string,
  paths: Awaited<ReturnType<typeof stashPaths>>,
  backupRoot: string,
) {
  const quiet = async (args: string[], env?: Readonly<Record<string, string>>) => {
    const result = await runGit(
      cwd,
      ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--quiet", ...args],
      { allowFailure: true, ...(env ? { env } : {}) },
    );
    if (result.code > 1) throw new Error("Could not inspect the saved stash restoration outcome.");
    return result.code === 0;
  };
  if (paths.tracked.length && !(await quiet(["--cached", `${sha}^2`, "--", ...paths.tracked])))
    return false;
  if (
    paths.untracked.length &&
    (await runGit(cwd, ["ls-files", "--stage", "-z", "--", ...paths.untracked])).stdout
  )
    return false;
  if (!paths.all.length) return true;
  await NodeFSP.mkdir(backupRoot, { recursive: true });
  const index = NodePath.join(backupRoot, `.undo-stash-index-${NodeCrypto.randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  const workingTreeMatches = async (tree: string, names: string[]) => {
    // A fresh private index cannot inherit assume-unchanged/skip-worktree bits
    // that could hide a real file difference in the user's destination index.
    await runGit(cwd, ["-c", "core.sparseCheckout=false", "read-tree", tree], { env });
    const saved = new Set(
      (await runGit(cwd, ["ls-files", "--cached", "-z", "--", ...names], { env })).stdout
        .split("\0")
        .filter(Boolean),
    );
    // diff ignores files absent from this private index as untracked. A saved
    // deletion is restored only when the actual path is absent as well.
    for (const name of names) {
      if (saved.has(name)) continue;
      try {
        await NodeFSP.lstat(location(cwd, name));
        return false;
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw cause;
      }
    }
    return quiet(["--", ...names], env);
  };
  try {
    if (paths.tracked.length && !(await workingTreeMatches(sha, paths.tracked))) return false;
    if (
      paths.untrackedTree &&
      paths.untracked.length &&
      !(await workingTreeMatches(paths.untrackedTree, paths.untracked))
    )
      return false;
    return true;
  } finally {
    await NodeFSP.rm(index, { force: true });
    await NodeFSP.rm(`${index}.lock`, { force: true });
  }
}

const repoDir = (root: string, repo: string) => (repo === "." ? root : location(root, repo));

const pathsOf = (entries: ReadonlyArray<JournalEntry>, t: "write" | "write-done" | "backup") =>
  new Set(
    entries.filter((entry) => entry.t === t).map((entry) => (entry as { path: string }).path),
  );

/** Where each recorded backup goes, for those whose move really happened. */
async function savedBackups(entries: ReadonlyArray<JournalEntry>) {
  const saved = new Map<string, string>();
  for (const entry of entries)
    if (entry.t === "backup" && (await undoStat(entry.backup))) saved.set(entry.path, entry.backup);
  return saved;
}

/** A file or link Apply restored from the copied index without having written it (left out as unstable). */
const matchesRestored = (
  root: string,
  path: string,
  expected: ReadonlyMap<string, ReadonlyArray<Content>>,
) => holds(root, path, expected.get(path)!);

/** Reads the journal and reports, per step, whether Undo can restore it exactly. */
export async function previewUndo(input: {
  readonly targetRoot: string;
  readonly journalFile: string;
}): Promise<UndoPreview> {
  const entries = await new JsonLog<JournalEntry>(input.journalFile).read();
  const { completed } = await undoProgress(entries, input.targetRoot);
  const expected = expectedContent(entries);
  const done = pathsOf(entries, "write-done");
  const writes = pathsOf(entries, "write");
  const saved = await savedBackups(entries);
  const restoredOnly = new Set<string>();
  const items: Array<UndoItem> = [];
  for (const entry of entries) {
    if (
      "path" in entry &&
      completed.has(entry.path) &&
      ["write", "rewritten", "restore", "backup"].includes(entry.t)
    )
      continue;
    if (
      (entry.t === "rewritten" || entry.t === "restore") &&
      !writes.has(entry.path) &&
      !restoredOnly.has(entry.path)
    ) {
      restoredOnly.add(entry.path);
      const state = await matchesRestored(input.targetRoot, entry.path, expected);
      if (state === "missing") continue;
      items.push({
        path: entry.path,
        kind: "file",
        state: state === "same" ? "restore" : "edited",
        detail:
          state === "same"
            ? "Removes the file the copy added."
            : "Edited after the copy; kept unless you undo anyway.",
      });
    } else if (entry.t === "write") {
      const state = await matchesWrite(input.targetRoot, entry, expected);
      // Apply records intents a batch ahead; one it stopped before never touched the folder.
      if (state === "missing" && !done.has(entry.path)) continue;
      // Not marked written and nothing really backed up: Undo never moves it.
      if (state === "edited" && !done.has(entry.path) && !saved.has(entry.path)) continue;
      items.push({
        path: entry.path,
        kind: "file",
        state: state === "same" ? "restore" : state,
        detail:
          state === "same"
            ? "Restores what was here before."
            : state === "edited"
              ? "Edited after the copy; kept unless you undo anyway."
              : "Already removed.",
      });
    } else if (entry.t === "ref") {
      const now = await refValue(repoDir(input.targetRoot, entry.repo), entry.ref);
      items.push({
        path: `${entry.repo}:${entry.ref}`,
        kind: "ref",
        state: now === entry.new ? "restore" : "edited",
        detail:
          now === entry.new ? "Returns to its earlier commit." : "Moved after the copy; kept.",
      });
    } else if (entry.t === "head") {
      const now = await refValue(repoDir(input.targetRoot, entry.repo), "HEAD");
      items.push({
        path: entry.repo,
        kind: "head",
        state: now === entry.new ? "restore" : "edited",
        detail:
          now === entry.new
            ? "Checkout returns to its earlier commit."
            : "New commits after the copy; kept.",
      });
    } else if (entry.t === "cloned" || entry.t === "worktree-added") {
      items.push({
        path: entry.path,
        kind: entry.t === "cloned" ? "clone" : "worktree",
        state: (await exists(location(input.targetRoot, entry.path))) ? "restore" : "missing",
        detail: "Moved into the backup.",
      });
    }
  }
  return { items, edited: items.filter((item) => item.state === "edited").length };
}

/**
 * Restores files and refs byte for byte from the backup, newest step first.
 * Anything changed after Apply is kept and reported; with `force`, edited files
 * move into the backup (under `kept-edits/`) so nothing is lost either way.
 */
export async function undoApply(input: {
  readonly targetRoot: string;
  readonly backupRoot: string;
  readonly journalFile: string;
  readonly force?: boolean;
}): Promise<UndoResult> {
  const journal = new JsonLog<JournalEntry>(input.journalFile);
  const entries = await journal.read();
  const { intents, completed, reconciled } = await undoProgress(entries, input.targetRoot);
  const expected = expectedContent(entries);
  const stashKey = (entry: { repo: string; sha: string }) => `${entry.repo}\0${entry.sha}`;
  const stashIntents = new Map(
    entries.flatMap((entry) =>
      entry.t === "undo-stash-intent" ? [[stashKey(entry), entry.before] as const] : [],
    ),
  );
  const restoredStashes = new Set(
    entries.flatMap((entry) => (entry.t === "undo-stash-restored" ? [stashKey(entry)] : [])),
  );
  const doneStashes = new Set(
    entries.flatMap((entry) => (entry.t === "undo-stash-done" ? [stashKey(entry)] : [])),
  );
  const root = input.targetRoot;
  const kept: Array<string> = [];
  const moved: Array<string> = [];
  const problems: Array<string> = [];
  let restored = 0;
  const backups = await savedBackups(entries);
  const recordedBackups = pathsOf(entries, "backup");
  const writes = pathsOf(entries, "write");
  const done = pathsOf(entries, "write-done");
  const skipRestore = new Set<string>();
  const keepEdit = async (relative: string) => {
    if (!input.force) {
      kept.push(relative);
      skipRestore.add(relative);
      return false;
    }
    await moveEntry(
      location(root, relative),
      location(NodePath.join(input.backupRoot, "kept-edits"), relative),
      input.journalFile,
    );
    moved.push(relative);
    return true;
  };

  const listings = new Map<string, ReadonlyArray<string>>();
  const beginFile = async (path: string, backup?: string) => {
    const previous = intents.get(path);
    if (previous) {
      if (previous.backup !== null && !(await exists(previous.backup)))
        throw new Error(
          `The original backup is missing and restoration could not be confirmed; ${path} was kept.`,
        );
      return;
    }
    const digest = backup === undefined ? null : await undoDigest(backup);
    if (backup !== undefined && digest === null)
      throw new Error(`Original backup is missing: ${path}`);
    const intent = { t: "undo-file-intent", path, backup: backup ?? null, digest } as const;
    await journal.append(intent, true);
    intents.set(path, intent);
  };
  const finishFile = async (path: string) => {
    // The next durable intent (or close) flushes this completion too. A crash
    // before that is reconciled from the already-synced intent and original digest.
    await journal.append({ t: "undo-file-done", path });
    completed.add(path);
  };
  try {
    for (const path of reconciled) await finishFile(path);
    for (const entry of [...entries].reverse()) {
      try {
        if (
          "path" in entry &&
          completed.has(entry.path) &&
          ["write", "rewritten", "restore", "backup"].includes(entry.t)
        )
          continue;
        switch (entry.t) {
          case "write": {
            // A cross-volume copy killed mid-way leaves its partial beside the target.
            await removePartials(location(root, entry.path), input.journalFile, listings);
            const state = await matchesWrite(root, entry, expected);
            const backup = backups.get(entry.path);
            const saved = backup !== undefined;
            if (!saved && recordedBackups.has(entry.path)) {
              // Older journals may already have moved an original back without a
              // progress mark. Never move that possible original out of place.
              throw new Error(
                `The original backup is missing; ${entry.path} was kept for recovery.`,
              );
            }
            // An intent Apply stopped before: nothing was written, nothing to restore.
            if (state === "missing" && !saved) {
              await beginFile(entry.path);
              await finishFile(entry.path);
              break;
            }
            if (state === "edited" && !done.has(entry.path) && !saved) {
              // Not marked written and nothing really backed up (a crash can fall between a
              // backup's record and its move): this may not be Apply's file at all. Never move it.
              kept.push(entry.path);
              skipRestore.add(entry.path);
              break;
            }
            await beginFile(entry.path, backup);
            if (state === "same") await NodeFSP.rm(location(root, entry.path), { force: true });
            else if (state === "edited" && !(await keepEdit(entry.path))) break;
            if (saved) await moveEntry(backup, location(root, entry.path), input.journalFile);
            await finishFile(entry.path);
            restored += 1;
            break;
          }
          case "rewritten":
          case "restore": {
            if (entry.t === "restore")
              await removePartials(location(root, entry.path), input.journalFile, listings);
            // Restored from the copied index without a write of its own: the copy added it.
            if (writes.has(entry.path) || skipRestore.has(entry.path)) break;
            skipRestore.add(entry.path);
            const state = await matchesRestored(root, entry.path, expected);
            await beginFile(entry.path);
            if (state === "missing") {
              await finishFile(entry.path);
              break;
            }
            if (state === "edited" && !(await keepEdit(entry.path))) break;
            if (state === "same") await NodeFSP.rm(location(root, entry.path), { force: true });
            await finishFile(entry.path);
            restored += 1;
            break;
          }
          case "backup": {
            // Backed up but not rewritten here: a removal ("mirror exactly") or a replaced folder.
            if (writes.has(entry.path) || skipRestore.has(entry.path)) break;
            await removePartials(location(root, entry.path), input.journalFile, listings);
            if (!backups.has(entry.path)) break;
            await beginFile(entry.path, entry.backup);
            if (await lstatOrNull(location(root, entry.path))) {
              if (!(await keepEdit(entry.path))) break;
            }
            await moveEntry(entry.backup, location(root, entry.path), input.journalFile);
            await finishFile(entry.path);
            restored += 1;
            break;
          }
          case "mkdir":
            await NodeFSP.rmdir(location(root, entry.path)).catch(() => undefined);
            break;
          case "root-created":
            await NodeFSP.rmdir(entry.path).catch(() => undefined);
            break;
          case "ref": {
            const cwd = repoDir(root, entry.repo);
            const now = await refValue(cwd, entry.ref);
            if (now !== entry.new) {
              kept.push(`${entry.repo}:${entry.ref}`);
              break;
            }
            if (entry.old === null) await runGit(cwd, ["update-ref", "-d", entry.ref]);
            else await runGit(cwd, ["update-ref", entry.ref, entry.old]);
            restored += 1;
            break;
          }
          case "head": {
            const cwd = repoDir(root, entry.repo);
            const now = await refValue(cwd, "HEAD");
            if (now !== entry.new || !entry.old) {
              kept.push(entry.repo);
              break;
            }
            const result = await runGit(cwd, ["reset", "--keep", "-q", entry.old], {
              allowFailure: true,
            });
            if (result.code === 0) restored += 1;
            else
              problems.push(`${entry.repo}: local changes block returning to the earlier commit.`);
            break;
          }
          case "stash": {
            const key = stashKey(entry);
            if (doneStashes.has(key)) break;
            const cwd = repoDir(root, entry.repo);
            if (!restoredStashes.has(key)) {
              const paths = await stashPaths(cwd, entry.sha);
              const matches = await stashRestored(cwd, entry.sha, paths, input.backupRoot);
              if (!matches) {
                const before = await stashBefore(cwd, paths.all);
                const previous = stashIntents.get(key);
                if (previous !== undefined && previous !== before) {
                  problems.push(
                    `${entry.repo}: interrupted stash restoration could not be confirmed; current edits were kept. Inspect saved stash ${entry.sha} before retrying.`,
                  );
                  break;
                }
                if (previous === undefined) {
                  await journal.append(
                    { t: "undo-stash-intent", repo: entry.repo, sha: entry.sha, before },
                    true,
                  );
                  stashIntents.set(key, before);
                }
                const applied = await runGit(cwd, ["stash", "apply", "--index", "-q", entry.sha], {
                  allowFailure: true,
                  env: { GIT_LITERAL_PATHSPECS: "0" },
                });
                if (applied.code !== 0) {
                  problems.push(
                    `${entry.repo}: could not restore saved stash ${entry.sha}; inspect its saved changes before retrying.`,
                  );
                  break;
                }
              }
              if (!(await stashRestored(cwd, entry.sha, paths, input.backupRoot))) {
                problems.push(
                  `${entry.repo}: saved stash restoration could not be confirmed; its stash was kept.`,
                );
                break;
              }
              await journal.append(
                { t: "undo-stash-restored", repo: entry.repo, sha: entry.sha },
                true,
              );
              restoredStashes.add(key);
              restored += 1;
            }
            const list = (await runGit(cwd, ["stash", "list", "--format=%H"])).stdout.split("\n");
            const index = list.indexOf(entry.sha);
            if (index >= 0) await runGit(cwd, ["stash", "drop", "-q", `stash@{${index}}`]);
            await journal.append({ t: "undo-stash-done", repo: entry.repo, sha: entry.sha }, true);
            doneStashes.add(key);
            break;
          }
          case "worktree-added": {
            const main = repoDir(root, entry.main);
            const result = await runGit(main, ["worktree", "remove", location(root, entry.path)], {
              allowFailure: true,
            });
            if (result.code !== 0) {
              kept.push(entry.path);
              problems.push(
                `${entry.path}: the worktree has changes; remove it with git worktree remove when ready.`,
              );
            } else restored += 1;
            break;
          }
          case "cloned": {
            const absolute = location(root, entry.path);
            if (await exists(absolute)) {
              await moveEntry(
                absolute,
                location(NodePath.join(input.backupRoot, "undone-clones"), entry.path),
                input.journalFile,
              );
              restored += 1;
            }
            break;
          }
          default:
            break;
        }
      } catch (cause) {
        problems.push(
          `${"path" in entry ? entry.path : entry.t}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
  } finally {
    await journal.close();
  }
  return { restored, kept, movedToBackup: moved, problems };
}
