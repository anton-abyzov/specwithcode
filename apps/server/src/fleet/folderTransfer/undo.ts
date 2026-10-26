// @effect-diagnostics nodeBuiltinImport:off - Undo restores backed-up files and refs from the Apply journal.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { moveEntry, removePartials, type JournalEntry } from "./apply.ts";
import { exists, JsonLog, lstatOrNull } from "./durable.ts";
import { runGit } from "./git.ts";
import { hashFile } from "./manifest.ts";
import { linkTargetOnWire } from "./paths.ts";

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
  const stat = await lstatOrNull(absolute);
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

const repoDir = (root: string, repo: string) => (repo === "." ? root : location(root, repo));

const pathsOf = (entries: ReadonlyArray<JournalEntry>, t: "write" | "write-done" | "backup") =>
  new Set(
    entries.filter((entry) => entry.t === t).map((entry) => (entry as { path: string }).path),
  );

/** Where each recorded backup goes, for those whose move really happened. */
async function savedBackups(entries: ReadonlyArray<JournalEntry>) {
  const saved = new Map<string, string>();
  for (const entry of entries)
    if (entry.t === "backup" && (await exists(entry.backup))) saved.set(entry.path, entry.backup);
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
  const expected = expectedContent(entries);
  const done = pathsOf(entries, "write-done");
  const writes = pathsOf(entries, "write");
  const saved = await savedBackups(entries);
  const restoredOnly = new Set<string>();
  const items: Array<UndoItem> = [];
  for (const entry of entries) {
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
  const entries = await new JsonLog<JournalEntry>(input.journalFile).read();
  const expected = expectedContent(entries);
  const root = input.targetRoot;
  const kept: Array<string> = [];
  const moved: Array<string> = [];
  const problems: Array<string> = [];
  let restored = 0;
  const backups = await savedBackups(entries);
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
  for (const entry of [...entries].reverse()) {
    try {
      switch (entry.t) {
        case "write": {
          // A cross-volume copy killed mid-way leaves its partial beside the target.
          await removePartials(location(root, entry.path), input.journalFile, listings);
          const state = await matchesWrite(root, entry, expected);
          const backup = backups.get(entry.path);
          const saved = backup !== undefined;
          // An intent Apply stopped before: nothing was written, nothing to restore.
          if (state === "missing" && !saved) break;
          if (state === "edited" && !done.has(entry.path) && !saved) {
            // Not marked written and nothing really backed up (a crash can fall between a
            // backup's record and its move): this may not be Apply's file at all. Never move it.
            kept.push(entry.path);
            skipRestore.add(entry.path);
            break;
          }
          if (state === "same") await NodeFSP.rm(location(root, entry.path), { force: true });
          else if (state === "edited" && !(await keepEdit(entry.path))) break;
          if (saved) await moveEntry(backup, location(root, entry.path), input.journalFile);
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
          if (state === "missing") break;
          if (state === "edited" && !(await keepEdit(entry.path))) break;
          if (state === "same") await NodeFSP.rm(location(root, entry.path), { force: true });
          restored += 1;
          break;
        }
        case "backup": {
          // Backed up but not rewritten here: a removal ("mirror exactly") or a replaced folder.
          if (writes.has(entry.path) || skipRestore.has(entry.path)) break;
          await removePartials(location(root, entry.path), input.journalFile, listings);
          if (!backups.has(entry.path)) break;
          if (await lstatOrNull(location(root, entry.path))) {
            if (!(await keepEdit(entry.path))) break;
          }
          await moveEntry(entry.backup, location(root, entry.path), input.journalFile);
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
          else problems.push(`${entry.repo}: local changes block returning to the earlier commit.`);
          break;
        }
        case "stash": {
          const cwd = repoDir(root, entry.repo);
          const applied = await runGit(cwd, ["stash", "apply", "--index", "-q", entry.sha], {
            allowFailure: true,
          });
          if (applied.code !== 0) {
            problems.push(
              `${entry.repo}: your saved changes are in the stash "swc-handoff"; apply them with git stash.`,
            );
            break;
          }
          const list = (await runGit(cwd, ["stash", "list", "--format=%H"])).stdout.split("\n");
          const index = list.indexOf(entry.sha);
          if (index >= 0) await runGit(cwd, ["stash", "drop", "-q", `stash@{${index}}`]);
          restored += 1;
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
  return { restored, kept, movedToBackup: moved, problems };
}
