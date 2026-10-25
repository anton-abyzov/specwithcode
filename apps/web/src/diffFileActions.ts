import type { FileDiffMetadata } from "@pierre/diffs";
import type { ScopedThreadRef } from "@specweave-studio/contracts";
import {
  isWindowsAbsolutePath,
  normalizeProjectPathForComparison,
} from "@specweave-studio/shared/path";

import { useRightPanelStore } from "./rightPanelStore";
import { resolvePathLinkTarget } from "./terminal-links";

/** What a turn's checkpoint stamped at capture; older checkpoints carry neither. */
export interface DiffCheckpointFolder {
  /** The folder the snapshot staged. */
  readonly cwd?: string | undefined;
  /** Its repository root; patch paths are relative to it. */
  readonly repoRoot?: string | undefined;
}

interface OpenDiffFilePrimaryActionInput {
  readonly threadRef: ScopedThreadRef | null;
  readonly filePath: string;
  readonly activeCwd: string | undefined;
  readonly repositoryRoot?: string | undefined;
  /** Set for a turn diff: its paths resolve against the stamped folder, not today's (D-19). */
  readonly checkpoint?: DiffCheckpointFolder | undefined;
  /** The line to open at; the file opens at the top without one. */
  readonly line?: number | undefined;
  readonly openInEditor: (targetPath: string) => void;
}

export interface OpenedDiffFile {
  /** The opened path, relative to the current workspace. */
  readonly workspaceFilePath: string;
  /** The stamped checkpoint folder when it is not the current workspace, else null. */
  readonly otherCheckpointFolder: string | null;
}

function normalizedRelativePathSegments(filePath: string): ReadonlyArray<string> | null {
  if (filePath.startsWith("/") || isWindowsAbsolutePath(filePath) || /^[a-zA-Z]:/.test(filePath)) {
    return null;
  }

  const segments = filePath
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;
  return segments;
}

function repositoryRelativeWorkspaceSegments(
  workspaceRoot: string | undefined,
  repositoryRoot: string | undefined,
): ReadonlyArray<string> | null {
  if (!workspaceRoot || !repositoryRoot) return null;

  const normalizedWorkspaceRoot = normalizeProjectPathForComparison(workspaceRoot);
  const normalizedRepositoryRoot = normalizeProjectPathForComparison(repositoryRoot);
  if (normalizedWorkspaceRoot === normalizedRepositoryRoot) return [];

  const separator = normalizedRepositoryRoot.includes("\\") ? "\\" : "/";
  const repositoryPrefix = normalizedRepositoryRoot.endsWith(separator)
    ? normalizedRepositoryRoot
    : `${normalizedRepositoryRoot}${separator}`;
  if (!normalizedWorkspaceRoot.startsWith(repositoryPrefix)) return null;

  return normalizedWorkspaceRoot
    .slice(repositoryPrefix.length)
    .split(/[\\/]+/)
    .filter(Boolean);
}

export function resolveDiffPathForWorkspace(input: {
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly repositoryRoot: string | undefined;
}): string | null {
  const fileSegments = normalizedRelativePathSegments(input.filePath);
  if (!fileSegments) return null;

  const workspaceSegments = repositoryRelativeWorkspaceSegments(
    input.workspaceRoot,
    input.repositoryRoot,
  );
  if (!workspaceSegments || workspaceSegments.length === 0) {
    return fileSegments.join("/");
  }

  const caseInsensitive = input.repositoryRoot
    ? isWindowsAbsolutePath(input.repositoryRoot)
    : false;
  const belongsToWorkspace = workspaceSegments.every((segment, index) => {
    const candidate = fileSegments[index];
    if (candidate === undefined) return false;
    return caseInsensitive ? candidate.toLowerCase() === segment : candidate === segment;
  });
  if (!belongsToWorkspace) return null;

  const relativeSegments = fileSegments.slice(workspaceSegments.length);
  return relativeSegments.length > 0 ? relativeSegments.join("/") : null;
}

/**
 * A diff path as a path in the current workspace. A turn diff's path is relative to the
 * checkpoint's stamped repository root, so it is first made relative to the stamped folder;
 * file surfaces keep only that relative path, which then opens in today's workspace.
 */
export function resolveDiffFileTarget(input: {
  readonly filePath: string;
  readonly activeCwd: string | undefined;
  readonly repositoryRoot?: string | undefined;
  readonly checkpoint?: DiffCheckpointFolder | undefined;
}): OpenedDiffFile | null {
  const stampedCwd = input.checkpoint?.cwd;
  const workspaceFilePath = resolveDiffPathForWorkspace({
    filePath: input.filePath,
    workspaceRoot: stampedCwd ?? input.activeCwd,
    repositoryRoot: stampedCwd ? input.checkpoint?.repoRoot : input.repositoryRoot,
  });
  if (!workspaceFilePath) return null;
  const otherCheckpointFolder =
    stampedCwd &&
    input.activeCwd &&
    normalizeProjectPathForComparison(stampedCwd) !==
      normalizeProjectPathForComparison(input.activeCwd)
      ? stampedCwd
      : null;
  return { workspaceFilePath, otherCheckpointFolder };
}

/**
 * The first line on the new side that a file's diff changes: its first added line, or where
 * its first deleted block was. Null for a deleted file or a diff without hunks.
 */
export function firstChangedNewSideLine(
  fileDiff: Pick<FileDiffMetadata, "type" | "hunks">,
): number | null {
  if (fileDiff.type === "deleted") return null;
  for (const hunk of fileDiff.hunks) {
    // A hunk with no new-side lines (`+L,0`) sits after line L.
    let line = hunk.additionStart + (hunk.additionCount === 0 ? 1 : 0);
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        line += content.lines;
        continue;
      }
      if (content.additions > 0 || content.deletions > 0) return Math.max(1, line);
    }
  }
  return null;
}

export function openDiffFilePrimaryAction({
  threadRef,
  filePath,
  activeCwd,
  repositoryRoot,
  checkpoint,
  line,
  openInEditor,
}: OpenDiffFilePrimaryActionInput): OpenedDiffFile | null {
  const target = resolveDiffFileTarget({ filePath, activeCwd, repositoryRoot, checkpoint });
  if (!target) return null;

  if (threadRef) {
    useRightPanelStore.getState().openFile(threadRef, target.workspaceFilePath, line);
    return target;
  }

  openInEditor(
    activeCwd
      ? resolvePathLinkTarget(target.workspaceFilePath, activeCwd)
      : target.workspaceFilePath,
  );
  return target;
}
