/**
 * A turn's changed files are the difference between two snapshots of its
 * checkout. When HEAD moves in between (a checkout, pull or merge, by this
 * agent or by another one sharing the checkout), that difference also holds
 * every file the move brought in, so a two-file change can read as hundreds.
 * These helpers find the files that only the move changed, so the turn's
 * summary can leave them out. Commits made in the checkout during the turn
 * still count. Pure, so the rules can be tested without Git.
 */

/** Written into each checkpoint commit message so a later diff knows the HEAD it was taken at. */
export const CHECKPOINT_HEAD_TRAILER = "head";

export function checkpointMessage(checkpointRef: string, headOid: string | null): string {
  const subject = `specweave-studio checkpoint ref=${checkpointRef}`;
  return headOid === null ? subject : `${subject}\n\n${CHECKPOINT_HEAD_TRAILER}=${headOid}`;
}

/** The HEAD a checkpoint was taken at, or null for checkpoints written before it was recorded. */
export function checkpointHeadOid(message: string): string | null {
  const match = /^head=([0-9a-f]{40,64})\s*$/m.exec(message);
  return match ? match[1]! : null;
}

// Reflog actions that create a commit in this checkout. Merges, pulls,
// checkouts and resets only move HEAD to commits made elsewhere.
const LOCAL_COMMIT_ACTION =
  /^(?:commit\b(?! \(merge\))|cherry-pick\b|revert\b|rebase\b[^:]*\((?:pick|reword|edit|squash|fixup)\))/;

/**
 * Commits this checkout created at or after `sinceSeconds`, from
 * `git reflog --date=unix --format=%H%x09%gd%x09%gs` output.
 */
export function localCommitsSince(reflog: string, sinceSeconds: number): ReadonlySet<string> {
  const local = new Set<string>();
  for (const line of reflog.split("\n")) {
    const [oid, selector, subject] = line.split("\t");
    if (!oid || !selector || subject === undefined) continue;
    const time = /@\{(\d+)\}$/.exec(selector);
    if (!time || Number(time[1]) < sinceSeconds) continue;
    if (LOCAL_COMMIT_ACTION.test(subject)) local.add(oid);
  }
  return local;
}

export interface CommitPaths {
  readonly oid: string;
  readonly paths: ReadonlyArray<string>;
}

/** Parses `git log --format=@@%H --name-only` output. */
export function parseCommitPaths(log: string): ReadonlyArray<CommitPaths> {
  const commits: Array<{ oid: string; paths: string[] }> = [];
  for (const line of log.split("\n")) {
    if (line.startsWith("@@")) commits.push({ oid: line.slice(2).trim(), paths: [] });
    else if (line.length > 0) commits.at(-1)?.paths.push(line);
  }
  return commits;
}

/**
 * Paths that changed between the turn's two snapshots only because HEAD moved:
 * touched by commits made elsewhere, by no commit made here during the turn,
 * and matching HEAD in both snapshots, so no uncommitted edit sits on top.
 */
export function headMoveOnlyPaths(input: {
  /** Commits on either side of the HEAD move (`git log from...to`). */
  readonly commits: ReadonlyArray<CommitPaths>;
  readonly localCommits: ReadonlySet<string>;
  /** Paths where the earlier snapshot differs from its HEAD. */
  readonly dirtyBefore: ReadonlyArray<string>;
  /** Paths where the later snapshot differs from its HEAD. */
  readonly dirtyAfter: ReadonlyArray<string>;
}): ReadonlySet<string> {
  const keep = new Set<string>([...input.dirtyBefore, ...input.dirtyAfter]);
  const moved = new Set<string>();
  for (const commit of input.commits) {
    for (const path of commit.paths) {
      if (input.localCommits.has(commit.oid)) keep.add(path);
      else moved.add(path);
    }
  }
  for (const path of keep) moved.delete(path);
  return moved;
}
