import type { FolderCopySourceSummary, FolderCopyStatus } from "@specweave-studio/contracts";

/**
 * Groups what measuring and comparing report into one "Not copied" block plus a few
 * short lines, so a folder with dozens of worktrees does not become a wall of notices.
 */
export interface CopyNotices {
  /** Dependency and build folders left out; zero when none or unknown. */
  readonly rebuildableFolders: number;
  /** Linked worktrees inside the folder that are not copied. */
  readonly worktrees: ReadonlyArray<string>;
  /** Of those, the ones with uncommitted changes, which stay on this machine. */
  readonly dirtyWorktrees: ReadonlyArray<string>;
  /** Skipped worktrees whose status check failed or timed out: they may hold uncommitted changes. */
  readonly uncheckedWorktrees: ReadonlyArray<string>;
  /** Skipped worktrees with commits on no branch, or a rebase or merge in progress. */
  readonly strandedWorktrees: ReadonlyArray<string>;
  /** True totals before the source shortened the lists. */
  readonly worktreeCount: number;
  readonly dirtyCount: number;
  /** Worktrees whose working folder is outside the copied folder. */
  readonly outsideWorktrees: ReadonlyArray<string>;
  readonly outsideWorktreeCount: number;
  readonly outsideWorktreeTotals: Readonly<Record<string, number>>;
  /** Worktrees of repositories outside the folder, copied as independent repositories. */
  readonly separateRepositories: ReadonlyArray<string>;
  readonly linksOutside: number;
  /** Everything else, one short line each, with the root path named. */
  readonly lines: ReadonlyArray<string>;
}

const OUTSIDE = /^(.+?): (\d+) worktree\(s\) outside this folder (?:are|were) not copied: (.*)$/s;
const INSIDE = /^(\d+) linked worktree\(s\) inside this folder (?:are|were) not copied: (.*)$/s;

/** Fresh inventory replaces saved inventory notices, while destination warnings survive. */
export function copyNoticeWarnings(
  summary: Pick<FolderCopySourceSummary, "warnings"> | null,
  copy: Pick<FolderCopyStatus, "warnings"> | null,
  refreshed: boolean,
): ReadonlyArray<string> {
  const saved = copy?.warnings ?? [];
  return [
    ...(summary?.warnings ?? []),
    ...saved.filter((warning) => !refreshed || (!OUTSIDE.test(warning) && !INSIDE.test(warning))),
  ];
}
const SEPARATE = /^(.+?): this worktree will become an independent Git repository/;
/** The source's running-work notice, from this version or an older one. */
const ACTIVE_WORK = /^Work is still running (?:in this folder|here)\./;
const ACTIVE_WORK_COPY =
  "Work is still running here. Files that change during the copy won't be included.";
const ACTIVE_WORK_MOVE = `${ACTIVE_WORK_COPY.slice(0, -1)}, and the project moves once that work stops.`;
/**
 * The source's Git snapshot notice. Its second sentence (work made afterward stays here;
 * copy again) is for a copy only: a move takes the coordinator along and continues there.
 */
const GIT_SNAPSHOT =
  /^(Git history, branches and staged changes are captured when copying starts\.)\s+Work created afterward stays on this machine;.*$/s;

const SNAPSHOT_FUTURE = "are captured when copying starts";
const SNAPSHOT_PAST = "were captured when copying started";

/** The list part of a notice, up to the sentence that follows it. */
function namesOf(rest: string): string[] {
  const end = rest.search(/\.\s+[A-Z]/);
  const list = (end >= 0 ? rest.slice(0, end) : rest.replace(/\.\s*$/, ""))
    .replace(/ and \d+ more$/, "")
    .trim();
  return list
    .split(", ")
    .map((name) => name.trim())
    .filter(Boolean);
}

/** A repository path for people: the folder's own root by name, others as they are. */
export function repositoryLabel(path: string, rootLabel: string): string {
  return path === "." || path === "" ? rootLabel : path;
}

export function groupCopyNotices(input: {
  readonly skipped?: FolderCopySourceSummary["skipped"] | undefined;
  readonly linksOutside?: number | undefined;
  readonly warnings: ReadonlyArray<string>;
  /** "Umbrella root" or "Project root". */
  readonly rootLabel: string;
  /**
   * Running work matters before Apply only: Where and Review say it, in the words for a copy
   * or a move; null drops it once copying started, so Done never contradicts a finished move.
   */
  readonly activeWork?: "copy-only" | "copy-and-move" | null;
  readonly captured?: boolean;
  /** What this copy is: a move drops advice that only fits a copy of files. */
  readonly mode?: "copy-only" | "copy-and-move";
  /** Done: the Git snapshot is past (a copy says "were captured"; a finished move drops it). */
  readonly done?: boolean;
}): CopyNotices {
  const skipped = input.skipped;
  const worktrees = [...(skipped?.worktrees ?? [])];
  // Newer sources name the skipped worktrees with uncommitted changes; older ones omit it.
  const dirty = [...(skipped?.dirtyWorktrees ?? [])];
  const outside: string[] = [];
  const outsideTotals: Record<string, number> = Object.create(null);
  const separate: string[] = [];
  const lines: string[] = [];
  for (const warning of new Set(input.warnings)) {
    const away = OUTSIDE.exec(warning);
    if (away) {
      const repository = away[1]!;
      const key = repository === "." ? "" : repositoryLabel(repository, input.rootLabel);
      // Source summary precedes saved destination notices. Never union two inventories.
      if (Object.hasOwn(outsideTotals, key)) continue;
      const names = namesOf(away[3]!);
      const reported = Number(away[2]);
      outsideTotals[key] = Math.max(Number.isSafeInteger(reported) ? reported : 0, names.length);
      for (const name of names)
        outside.push(
          repository === "." ? name : `${name} (${repositoryLabel(repository, input.rootLabel)})`,
        );
      continue;
    }
    const inside = INSIDE.exec(warning);
    if (inside) {
      // Newer sources list them all in `skipped`; older ones only in this notice.
      if (!skipped) worktrees.push(...namesOf(inside[2]!));
      continue;
    }
    if (ACTIVE_WORK.test(warning)) {
      if (input.activeWork)
        lines.push(
          input.activeWork === "copy-only"
            ? input.captured
              ? "Work is still running here. Later changes stay on the source."
              : ACTIVE_WORK_COPY
            : ACTIVE_WORK_MOVE,
        );
      continue;
    }
    const snapshot = GIT_SNAPSHOT.exec(warning);
    if (snapshot && input.mode === "copy-and-move") {
      if (!input.done) lines.push(snapshot[1]!);
      continue;
    }
    if (snapshot && input.done) {
      lines.push(warning.replace(SNAPSHOT_FUTURE, SNAPSHOT_PAST));
      continue;
    }
    const independent = SEPARATE.exec(warning);
    if (independent) {
      separate.push(repositoryLabel(independent[1]!, input.rootLabel));
      continue;
    }
    lines.push(
      warning.startsWith(".: ") ? `${input.rootLabel}: ${warning.slice(3)}` : warning.trim(),
    );
  }
  const listed = [...new Set(worktrees)];
  const dirtyWorktrees = [...new Set(dirty)];
  // Older sources send no totals; a total never undercounts the names listed.
  const atLeast = (value: number | undefined, floor: number) => Math.max(value ?? 0, floor);
  return {
    rebuildableFolders: skipped?.rebuildableFolders ?? 0,
    worktrees: listed,
    dirtyWorktrees,
    uncheckedWorktrees: [...new Set(skipped?.uncheckedWorktrees ?? [])],
    strandedWorktrees: [...new Set(skipped?.strandedWorktrees ?? [])],
    worktreeCount: atLeast(skipped?.worktreeCount, listed.length),
    dirtyCount: atLeast(skipped?.dirtyCount, dirtyWorktrees.length),
    outsideWorktrees: [...new Set(outside)],
    outsideWorktreeCount: Object.values(outsideTotals).reduce((sum, count) => sum + count, 0),
    outsideWorktreeTotals: outsideTotals,
    separateRepositories: [...new Set(separate)],
    linksOutside: input.linksOutside ?? 0,
    lines: [...new Set(lines)],
  };
}

export function hasNotCopied(notices: CopyNotices): boolean {
  return (
    notices.rebuildableFolders > 0 || notices.worktreeCount > 0 || notices.outsideWorktreeCount > 0
  );
}

/**
 * "2 worktrees with uncommitted changes stayed on M4", plus unchecked and stranded ones,
 * for a notice that has no room for the full block. Empty when none.
 */
export function skippedWorktreeParts(notices: CopyNotices, sourceLabel: string): string[] {
  const worktrees = (value: number) =>
    `${value.toLocaleString()} ${value === 1 ? "worktree" : "worktrees"}`;
  const parts: string[] = [];
  if (notices.dirtyCount > 0)
    parts.push(
      `${worktrees(notices.dirtyCount)} with uncommitted changes stayed on ${sourceLabel}`,
    );
  if (notices.uncheckedWorktrees.length > 0)
    parts.push(
      `${worktrees(notices.uncheckedWorktrees.length)} could not be checked and may hold uncommitted changes on ${sourceLabel}`,
    );
  if (notices.strandedWorktrees.length > 0)
    parts.push(
      `${worktrees(notices.strandedWorktrees.length)} on ${sourceLabel} ${notices.strandedWorktrees.length === 1 ? "has" : "have"} commits on no branch that did not travel`,
    );
  return parts;
}

/** A check's repository as the done screen names it. */
export const checkLabel = (repo: string) => (repo === "." ? "Root" : repo);

/**
 * What went wrong in a finished copy, as a clause: files that changed on the source while
 * copying, or the failed checks. Null when everything matched.
 */
export function copyProblem(
  copy: Pick<FolderCopyStatus, "checks" | "unstable">,
  sourceLabel: string,
): string | null {
  if (copy.unstable.length > 0) return `some files changed on ${sourceLabel} while copying`;
  const failing = copy.checks.filter((check) => !check.ok);
  if (failing.length === 1) return `the check of ${checkLabel(failing[0]!.repo)} failed`;
  if (failing.length > 1)
    return `the checks of ${failing.length.toLocaleString()} repositories failed`;
  return null;
}
