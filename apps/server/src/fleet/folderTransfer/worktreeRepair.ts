// @effect-diagnostics nodeBuiltinImport:off - Replaces a copied worktree's pointer files by name.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { JournalEntry } from "./apply.ts";
import type { ChainReading } from "./confinement.ts";
import { exists, lstatOrNull } from "./durable.ts";
import { hashFile } from "./manifest.ts";
import { isSafeDestinationPath } from "./paths.ts";

/** What Apply uses to hold a write to folders the user controls alone. */
export interface Gate {
  /** The chain read before a write; null when it fails, with the entry recorded as refused. */
  readonly enter: (relative: string) => Promise<ChainReading | null>;
  /** The chain read again after the write: a failure or another folder stops the copy. */
  readonly leave: (relative: string, before: ChainReading) => Promise<void>;
}

/**
 * A copied linked worktree's `.git` file names its main repository by absolute
 * path, and the main repository's record names the worktree the same way. The
 * pointer is pointed at the copy only when the record already names exactly
 * this worktree's `.git` here; the record itself is never written. Anything
 * else is left as copied, with a warning. False when the pointer was left.
 */
export async function repairWorktree(
  root: string,
  info: { readonly path: string; readonly mainRepository: string },
  record: (entry: Extract<JournalEntry, { t: "rewritten" }>) => Promise<void>,
  warnings: Array<string>,
  gate: Gate,
): Promise<boolean> {
  const left = () => {
    warnings.push(`${info.path}: its .git file was left as copied; run git worktree repair there.`);
    return false;
  };
  // Both paths come from the source's manifest header: checked here as any received path is.
  const inside = (relative: string) => relative === "." || isSafeDestinationPath(relative);
  if (!inside(info.path) || !inside(info.mainRepository)) return left();
  const inRoot = (relative: string) =>
    relative === "." ? root : NodePath.join(root, ...relative.split("/"));
  const below = (relative: string, rest: string) =>
    relative === "." ? rest : `${relative}/${rest}`;
  const location = inRoot(info.path);
  const gitFile = NodePath.join(location, ".git");
  const pointer = below(info.path, ".git");
  const before = await gate.enter(pointer);
  if (!before || !(await lstatOrNull(gitFile))?.isFile()) return left();
  const text = await NodeFSP.readFile(gitFile, "utf8").catch(() => null);
  const match = text ? /^gitdir:\s*(.+?)\s*$/m.exec(text) : null;
  if (!match) {
    warnings.push(`${info.path}: its .git file could not be read; run git worktree repair there.`);
    return false;
  }
  const name = NodePath.basename(match[1]!);
  const main = inRoot(info.mainRepository);
  const adminDir = NodePath.join(main, ".git", "worktrees", name);
  if (!(await exists(adminDir))) {
    warnings.push(
      `${info.path}: its main repository has no record for it; run git worktree repair there.`,
    );
    return false;
  }
  // The main repository's record is trusted to name the worktree: its folders must be the user's alone.
  const admin = below(info.mainRepository, `.git/worktrees/${name}/gitdir`);
  const recordBefore = isSafeDestinationPath(admin) ? await gate.enter(admin) : null;
  if (!recordBefore) return left();
  // The record must name exactly this worktree's `.git`, here. Git writes it with `/` on Windows.
  const recordFile = NodePath.join(adminDir, "gitdir");
  const recorded = (await lstatOrNull(recordFile))?.isFile()
    ? await NodeFSP.readFile(recordFile, "utf8").catch(() => null)
    : null;
  if (recorded === null || NodePath.resolve(recorded.trim()) !== gitFile) return left();
  // Each pointer is put in place as a new private file, by name. The copied
  // file is never written: it may share its bytes with a file somewhere else.
  const replace = async (file: string, content: string) => {
    const stat = await lstatOrNull(file);
    const current =
      stat?.isFile() && stat.nlink === 1
        ? await NodeFSP.readFile(file, "utf8").catch(() => null)
        : null;
    if (current === content) return;
    const fresh = `${file}.swc-${NodeCrypto.randomUUID()}`;
    try {
      await NodeFSP.writeFile(fresh, content, { flag: "wx", mode: 0o600 });
      await NodeFSP.rename(fresh, file);
    } catch (cause) {
      await NodeFSP.rm(fresh, { force: true }).catch(() => undefined);
      throw cause;
    }
  };
  // Git writes the pointer with `/` on Windows; compare in native form.
  const pointerStat = await lstatOrNull(gitFile);
  if (NodePath.resolve(match[1]!) !== adminDir || pointerStat?.nlink !== 1)
    await replace(gitFile, `gitdir: ${adminDir}\n`);
  // It now says what Git's own repair would write. That is not run: it may write more than this name.
  await gate.leave(pointer, before);
  // The pointer now names this machine's path; record it so Undo does not mistake it for an edit.
  const hashed = await hashFile(gitFile, false).catch(() => null);
  if (hashed)
    await record({
      t: "rewritten",
      path: NodePath.relative(root, gitFile).split(NodePath.sep).join("/"),
      sha256: hashed.sha256,
    });
  return true;
}
