// @effect-diagnostics nodeBuiltinImport:off - Undo restores backed-up files and refs from the Apply journal.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { moveEntry, type JournalEntry } from "./apply.ts";
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

/** The hash each written file should have now: Apply's own later rewrites replace the copied hash. */
function expectedHashes(entries: ReadonlyArray<JournalEntry>) {
  const hashes = new Map<string, string | null>();
  for (const entry of entries)
    if (entry.t === "write" || entry.t === "rewritten") hashes.set(entry.path, entry.sha256);
  return hashes;
}

async function matchesWrite(
  root: string,
  entry: Extract<JournalEntry, { t: "write" }>,
  expected: ReadonlyMap<string, string | null>,
) {
  const absolute = location(root, entry.path);
  const stat = await lstatOrNull(absolute);
  if (!stat) return "missing" as const;
  if (entry.linkTarget !== null)
    return stat.isSymbolicLink() &&
      linkTargetOnWire(await NodeFSP.readlink(absolute)) === entry.linkTarget
      ? "same"
      : "edited";
  const sha256 = expected.get(entry.path) ?? entry.sha256;
  if (!stat.isFile() || !sha256) return "edited";
  return (await hashFile(absolute, false)).sha256 === sha256 ? "same" : "edited";
}

async function refValue(cwd: string, ref: string) {
  const result = await runGit(cwd, ["rev-parse", "--verify", "-q", ref], { allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : null;
}

const repoDir = (root: string, repo: string) => (repo === "." ? root : location(root, repo));

/** Reads the journal and reports, per step, whether Undo can restore it exactly. */
export async function previewUndo(input: {
  readonly targetRoot: string;
  readonly journalFile: string;
}): Promise<UndoPreview> {
  const entries = await new JsonLog<JournalEntry>(input.journalFile).read();
  const expected = expectedHashes(entries);
  const items: Array<UndoItem> = [];
  for (const entry of entries) {
    if (entry.t === "write") {
      const state = await matchesWrite(input.targetRoot, entry, expected);
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
  const expected = expectedHashes(entries);
  const root = input.targetRoot;
  const kept: Array<string> = [];
  const moved: Array<string> = [];
  const problems: Array<string> = [];
  let restored = 0;
  const backups = new Map<string, string>();
  for (const entry of entries) if (entry.t === "backup") backups.set(entry.path, entry.backup);
  const writes = new Set(
    entries.filter((entry) => entry.t === "write").map((entry) => (entry as { path: string }).path),
  );
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
    );
    moved.push(relative);
    return true;
  };

  for (const entry of [...entries].reverse()) {
    try {
      switch (entry.t) {
        case "write": {
          const state = await matchesWrite(root, entry, expected);
          if (state === "same") await NodeFSP.rm(location(root, entry.path), { force: true });
          else if (state === "edited" && !(await keepEdit(entry.path))) break;
          const backup = backups.get(entry.path);
          if (backup && (await exists(backup))) await moveEntry(backup, location(root, entry.path));
          restored += 1;
          break;
        }
        case "backup": {
          // Backed up but not rewritten here: a removal ("mirror exactly") or a replaced folder.
          if (writes.has(entry.path) || skipRestore.has(entry.path)) break;
          if (!(await exists(entry.backup))) break;
          if (await lstatOrNull(location(root, entry.path))) {
            if (!(await keepEdit(entry.path))) break;
          }
          await moveEntry(entry.backup, location(root, entry.path));
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
