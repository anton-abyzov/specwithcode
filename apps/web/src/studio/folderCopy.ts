import type {
  FolderCopyChoice,
  FolderCopyFileClass,
  FolderCopyRow,
  FolderCopySourceSummary,
  FolderCopyStatus,
} from "@specweave-studio/contracts";

/** How the destination folder gets the project's files. */
export type HandoffFolderMethod = "copy" | "folder" | "clone";

export type CopyableClass = Exclude<FolderCopyFileClass, "secret">;

export const FILE_CLASS_ORDER: ReadonlyArray<FolderCopyFileClass> = [
  "repository",
  "tracked",
  "untracked",
  "ignoredData",
  "rebuildable",
  "secret",
];

export const FILE_CLASS_TEXT: Record<
  FolderCopyFileClass,
  { readonly label: string; readonly detail: string }
> = {
  repository: { label: "Repository data", detail: "History, branches and stashes in .git" },
  tracked: { label: "Tracked files", detail: "Committed files, including your edits" },
  untracked: { label: "New files", detail: "Files Git does not track yet" },
  ignoredData: {
    label: "Ignored project data",
    detail: "Ignored files that are not rebuilt, such as reports and evidence",
  },
  rebuildable: {
    label: "Rebuildable folders",
    detail: "node_modules, build output and caches; rebuild them on the other machine",
  },
  secret: {
    label: "Secret-like files",
    detail: "Handled in the secrets step; never copied here",
  },
};

export const DEFAULT_COPY_SELECTION: ReadonlyArray<CopyableClass> = [
  "repository",
  "tracked",
  "untracked",
  "ignoredData",
];
export const EXACT_COPY_SELECTION: ReadonlyArray<CopyableClass> = [
  ...DEFAULT_COPY_SELECTION,
  "rebuildable",
];

export function isExactCopy(selection: ReadonlyArray<FolderCopyFileClass>) {
  return EXACT_COPY_SELECTION.every((value) => selection.includes(value));
}

/** Decimal units, as a Mac shows them. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1000) return `${Math.max(0, Math.round(bytes || 0))} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function selectedTotals(
  summary: FolderCopySourceSummary,
  selection: ReadonlyArray<FolderCopyFileClass>,
) {
  let files = 0;
  let bytes = 0;
  for (const value of selection) {
    if (value === "secret") continue;
    files += summary.totals[value].files;
    bytes += summary.totals[value].bytes;
  }
  return { files, bytes };
}

export const ROW_STATUS_TEXT: Record<FolderCopyRow["status"], string> = {
  same: "Same on both",
  "fast-forward": "Fast-forwards",
  ahead: "Ahead here",
  diverged: "Diverged",
  dirty: "Changed here",
  conflict: "Conflicts",
  new: "New here",
  "only-here": "Only here",
};

export const CHOICE_TEXT: Record<FolderCopyChoice, string> = {
  "keep-mine": "Keep this machine’s version",
  "take-theirs": "Take the source version (back up this one)",
  "leave-both": "Leave both untouched",
  "keep-both": "Keep both (source copy beside it)",
};

/** The machines a choice is about: the folder's own machine and the one the files come from. */
export interface ChoiceMachines {
  readonly here: string;
  readonly source: string;
}

/**
 * A choice in words. With machine names it says whose version it keeps, so the
 * text reads the same whichever machine the dialog runs on.
 */
export function choiceText(choice: FolderCopyChoice, machines?: ChoiceMachines): string {
  if (!machines) return CHOICE_TEXT[choice];
  const { here, source } = machines;
  switch (choice) {
    case "keep-mine":
      return `Keep ${here}’s version`;
    case "take-theirs":
      return `Take ${source}’s version (back up ${here}’s)`;
    case "keep-both":
      return `Keep both (${source}’s copy beside it)`;
    case "leave-both":
      return CHOICE_TEXT[choice];
  }
}

/** A row's title: its folder, or the given name for the folder's own root. */
export function copyRowTitle(row: Pick<FolderCopyRow, "kind" | "path">, rootLabel?: string) {
  if (row.kind === "files") return "Other files";
  const root = row.path === "" || row.path === ".";
  return root ? (rootLabel ?? "Project root") : row.path;
}

/** Copy states that stop on their own; polling ends at these. */
export function copySettled(status: FolderCopyStatus): boolean {
  if (status.state === "applied") return status.committed && status.projectId !== null;
  return (
    status.state === "previewed" ||
    status.state === "failed" ||
    status.state === "cancelled" ||
    status.state === "undone"
  );
}

export function progressText(status: FolderCopyStatus): string | null {
  const progress = status.progress;
  if (!progress) return null;
  const phase = {
    manifest: "Reading the source list",
    files: "Copying files",
    verify: "Checking copied files",
    apply: "Applying",
  }[progress.phase];
  if (progress.phase === "manifest") return `${phase}…`;
  return `${phase}: ${progress.filesDone.toLocaleString()} of ${progress.filesTotal.toLocaleString()} files, ${formatBytes(progress.bytesDone)} of ${formatBytes(progress.bytesTotal)}${progress.bytesLocal > 0 ? ` (${formatBytes(progress.bytesLocal)} already here)` : ""}`;
}

export function progressFraction(status: FolderCopyStatus): number | null {
  const progress = status.progress;
  if (!progress || progress.phase === "manifest") return null;
  if (progress.bytesTotal > 0) return Math.min(1, progress.bytesDone / progress.bytesTotal);
  if (progress.filesTotal > 0) return Math.min(1, progress.filesDone / progress.filesTotal);
  return null;
}

/** Rows whose own decision or a listed file conflict still has no answer. */
export function undecidedRows(rows: ReadonlyArray<FolderCopyRow>): number {
  return rows.filter(
    (row) =>
      (row.needsDecision && row.decision === null) ||
      row.conflicts.some((conflict) => conflict.decision === null),
  ).length;
}

/** Repository rows "clone from origin" applies to. */
export function cloneableRows(rows: ReadonlyArray<FolderCopyRow>): ReadonlyArray<string> {
  return rows.filter((row) => row.kind === "repository" && row.cloneAvailable).map((row) => row.id);
}
