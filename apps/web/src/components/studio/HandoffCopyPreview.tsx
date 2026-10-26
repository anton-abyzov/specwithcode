import type { ReactNode } from "react";
import { AlertTriangleIcon, CheckIcon, GitBranchIcon, FolderIcon } from "lucide-react";
import {
  folderCopyAllConflictsKey,
  type FolderCopyChoice,
  type FolderCopyFileClass,
  type FolderCopyRow,
  type FolderCopySourceSummary,
  type FolderCopyStatus,
  type FolderCopyUndoResult,
} from "@specweave-studio/contracts";
import {
  type ChoiceMachines,
  choiceText,
  copyRowTitle,
  DEFAULT_COPY_SELECTION,
  EXACT_COPY_SELECTION,
  FILE_CLASS_ORDER,
  FILE_CLASS_TEXT,
  formatBytes,
  isExactCopy,
  progressFraction,
  progressText,
  ROW_STATUS_TEXT,
  selectedTotals,
} from "../../studio/folderCopy";
import { Checkbox } from "../ui/checkbox";
import { changedRows } from "./handoffCopyAuto";
import { Radio, RadioGroup } from "../ui/radio-group";

/** Sizes per file class before anything moves; secret-like files stay out of this step. */
export function CopyClassPicker({
  summary,
  selection,
  onChange,
  disabled,
  hideNotes = false,
}: {
  readonly summary: FolderCopySourceSummary;
  readonly selection: ReadonlyArray<FolderCopyFileClass>;
  readonly onChange: (selection: ReadonlyArray<FolderCopyFileClass>) => void;
  readonly disabled: boolean;
  /** The caller shows links outside and warnings in its own grouped notices. */
  readonly hideNotes?: boolean;
}) {
  const chosen = selectedTotals(summary, selection);
  const toggle = (value: FolderCopyFileClass, on: boolean) =>
    onChange(
      FILE_CLASS_ORDER.filter((entry) =>
        entry === value ? on : selection.includes(entry) && entry !== "secret",
      ),
    );
  return (
    <fieldset className="min-w-0 space-y-2" data-slot="copy-classes" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">What to copy</legend>
      <ul className="divide-y rounded-lg border text-sm">
        {FILE_CLASS_ORDER.map((value) => {
          const total = summary.totals[value];
          const secret = value === "secret";
          // Newer sources skip rebuildable folders while measuring; zero means unknown.
          const notMeasured =
            value === "rebuildable" &&
            (summary.skipped?.rebuildableFolders ?? 0) > 0 &&
            total.files === 0 &&
            total.bytes === 0;
          return (
            <li key={value}>
              <label
                data-slot="copy-class"
                data-class={value}
                className={`grid grid-cols-[1.125rem_minmax(0,1fr)_auto] items-start gap-x-3 p-3 ${secret ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
              >
                <span className="flex h-5 items-center">
                  <Checkbox
                    checked={!secret && selection.includes(value)}
                    disabled={disabled || secret}
                    onCheckedChange={(checked) => toggle(value, checked === true)}
                  />
                </span>
                <span className="min-w-0 leading-5">
                  <span className="block font-medium">{FILE_CLASS_TEXT[value].label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {FILE_CLASS_TEXT[value].detail}
                  </span>
                </span>
                <span className="text-right text-xs leading-5 text-muted-foreground tabular-nums">
                  {notMeasured ? (
                    "not measured"
                  ) : (
                    <>
                      {formatBytes(total.bytes)}
                      <span className="block">
                        {total.files.toLocaleString()} {total.files === 1 ? "file" : "files"}
                      </span>
                    </>
                  )}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <label className="flex cursor-pointer items-start gap-3 py-1 text-sm" data-slot="copy-exact">
        <span className="flex h-5 shrink-0 items-center">
          <Checkbox
            checked={isExactCopy(selection)}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange(checked === true ? EXACT_COPY_SELECTION : DEFAULT_COPY_SELECTION)
            }
          />
        </span>
        <span className="leading-5">
          Exact copy of everything
          <span className="block text-xs text-muted-foreground">
            Includes rebuildable folders. Secret-like files are never part of this step.
          </span>
        </span>
      </label>
      <p className="text-sm text-muted-foreground" data-slot="copy-selected-total">
        Selected: {formatBytes(chosen.bytes)} in {chosen.files.toLocaleString()} files.
        {summary.repositories.length > 0 &&
          ` ${summary.repositories.length} ${summary.repositories.length === 1 ? "repository" : "repositories"}.`}
      </p>
      {!hideNotes && summary.linksOutside > 0 && (
        <p className="text-xs text-muted-foreground">
          {summary.linksOutside} {summary.linksOutside === 1 ? "link points" : "links point"}{" "}
          outside the folder and will arrive as links, not as the files they point to.
        </p>
      )}
      {!hideNotes &&
        summary.warnings.map((warning) => (
          <p key={warning} className="wrap-anywhere text-xs text-muted-foreground">
            {warning}
          </p>
        ))}
    </fieldset>
  );
}

/** One row per repository plus the folder's other files, with their decisions. */
export function CopyPlanPreview({
  status,
  onDecide,
  onClone,
  disabled,
  machines,
  rootLabel,
  onlyChanges = false,
  hideWarnings = false,
}: {
  readonly status: FolderCopyStatus;
  readonly onDecide: (decisions: Readonly<Record<string, FolderCopyChoice>>) => void;
  readonly onClone: (rowId: string, clone: boolean) => void;
  readonly disabled: boolean;
  /** Names the machines in each choice instead of "this machine" and "the source". */
  readonly machines?: ChoiceMachines;
  /** Title of the row for the folder's own root, such as the project name. */
  readonly rootLabel?: string;
  /** Lists only rows that change something already there; new and unchanged ones are counted. */
  readonly onlyChanges?: boolean;
  /** The caller shows the plan's warnings in its own grouped notices. */
  readonly hideWarnings?: boolean;
}) {
  const totals = status.totals;
  const rows = onlyChanges ? changedRows(status.rows) : status.rows;
  const shown = new Set(rows);
  const hidden = status.rows.filter((row) => !shown.has(row));
  // Folders only on the destination are kept there, not copied.
  const kept = hidden.filter((row) => row.status === "only-here").length;
  const untouched = hidden.length - kept;
  return (
    <div className="space-y-3 text-sm" data-slot="copy-preview">
      {totals && (
        <p data-slot="copy-preview-totals">
          {totals.filesToMove.toLocaleString()} files, {formatBytes(totals.bytesToMove)} to copy
          {totals.bytesPresent > 0 && `, ${formatBytes(totals.bytesPresent)} already here`}.
          {totals.decisionsNeeded > 0 &&
            ` ${totals.decisionsNeeded} ${totals.decisionsNeeded === 1 ? "choice needs" : "choices need"} an answer before Apply.`}
        </p>
      )}
      <ul className="space-y-2">
        {rows.map((row) => (
          <CopyRow
            key={row.id}
            row={row}
            onDecide={onDecide}
            onClone={onClone}
            disabled={disabled}
            {...(machines ? { machines } : {})}
            {...(rootLabel ? { rootLabel } : {})}
          />
        ))}
      </ul>
      {onlyChanges && (untouched > 0 || kept > 0) && (
        <p className="text-xs text-muted-foreground" data-slot="copy-preview-untouched">
          {[
            untouched === 0
              ? null
              : untouched === 1
                ? "1 other folder is new or unchanged and is copied as it is."
                : `${untouched.toLocaleString()} other folders are new or unchanged and are copied as they are.`,
            kept === 0
              ? null
              : `${kept.toLocaleString()} kept on ${machines?.here ?? "this machine"}: ${kept === 1 ? "that folder is" : "those folders are"} only there.`,
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      )}
      {status.unstable.length > 0 && (
        <Note>
          {status.unstable.length === 1 ? "1 file" : `${status.unstable.length} files`} kept
          changing on the source while it was read and will be checked again before Apply:{" "}
          {status.unstable.slice(0, 5).join(", ")}
          {status.unstable.length > 5 ? "…" : ""}
        </Note>
      )}
      {!hideWarnings && status.warnings.map((warning) => <Note key={warning}>{warning}</Note>)}
      <p className="text-xs text-muted-foreground">
        Nothing on {machines?.here ?? "this machine"} is overwritten without a backup. Undo restores
        the folder for 14 days.
      </p>
    </div>
  );
}

function CopyRow({
  row,
  onDecide,
  onClone,
  disabled,
  machines,
  rootLabel,
}: {
  readonly row: FolderCopyRow;
  readonly onDecide: (decisions: Readonly<Record<string, FolderCopyChoice>>) => void;
  readonly onClone: (rowId: string, clone: boolean) => void;
  readonly disabled: boolean;
  readonly machines?: ChoiceMachines;
  readonly rootLabel?: string;
}) {
  const title = copyRowTitle(row, rootLabel);
  const open = row.conflicts.filter((conflict) => conflict.decision === null).length;
  const attention = (row.needsDecision && row.decision === null) || open > 0;
  const shared = (["keep-mine", "take-theirs"] as const).filter((choice) =>
    row.conflicts.every((conflict) => conflict.choices.includes(choice)),
  );
  return (
    <li
      className={`space-y-2 rounded-lg border p-3 ${attention ? "border-warning/60" : ""}`}
      data-slot="copy-row"
      data-status={row.status}
    >
      <div className="flex min-w-0 items-start gap-2">
        {row.kind === "repository" ? (
          <GitBranchIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        ) : (
          <FolderIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="break-all font-medium">{title}</span>
            <span className="text-xs text-muted-foreground">{ROW_STATUS_TEXT[row.status]}</span>
          </div>
          {row.detail && (
            <p className="wrap-anywhere text-xs text-muted-foreground">{row.detail}</p>
          )}
          <p className="text-xs text-muted-foreground tabular-nums">
            {row.filesToMove.toLocaleString()} files, {formatBytes(row.bytesToMove)} to copy
            {row.bytesPresent > 0 && `, ${formatBytes(row.bytesPresent)} already here`}
          </p>
        </div>
        {!attention && row.status !== "same" && (
          <CheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
      </div>
      {row.cloneAvailable && (
        <label className="flex cursor-pointer items-center gap-2 text-xs" data-slot="copy-clone">
          <Checkbox
            checked={row.clone}
            disabled={disabled}
            onCheckedChange={(checked) => onClone(row.id, checked === true)}
          />
          Clone tracked files from origin and copy only local changes
        </label>
      )}
      {row.needsDecision && row.choices.length > 0 && (
        <RadioGroup
          aria-label={`Choice for ${title}`}
          value={row.decision ?? ""}
          onValueChange={(value) => onDecide({ [row.id]: value as FolderCopyChoice })}
          disabled={disabled}
          className="gap-1"
        >
          {row.choices.map((choice) => (
            <label key={choice} className="flex cursor-pointer items-center gap-2 text-xs">
              <Radio value={choice} />
              {choiceText(choice, machines)}
            </label>
          ))}
        </RadioGroup>
      )}
      {row.conflicts.length > 0 && (
        <details className="text-xs" open={open > 0}>
          <summary className="cursor-pointer">
            {row.conflicts.length + row.moreConflicts} files differ on both machines
            {open > 0 ? `, ${open}${row.moreConflicts > 0 ? "+" : ""} undecided` : ""}
          </summary>
          {shared.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2" data-slot="copy-conflicts-all">
              {shared.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  disabled={disabled}
                  className="rounded border px-2 py-1 hover:bg-accent/40 disabled:opacity-50"
                  onClick={() => onDecide({ [folderCopyAllConflictsKey(row.id)]: choice })}
                >
                  All: {choiceText(choice, machines)}
                </button>
              ))}
            </div>
          )}
          <ul className="mt-2 space-y-2">
            {row.conflicts.map((conflict) => (
              <li key={conflict.id} className="space-y-1">
                <span className="block break-all">
                  {conflict.path}
                  {conflict.reason === "type-differs" && " (a different kind of item here)"}
                </span>
                <RadioGroup
                  aria-label={`Choice for ${conflict.path}`}
                  value={conflict.decision ?? ""}
                  onValueChange={(value) => onDecide({ [conflict.id]: value as FolderCopyChoice })}
                  disabled={disabled}
                  className="flex flex-wrap gap-3"
                >
                  {conflict.choices.map((choice) => (
                    <label key={choice} className="flex cursor-pointer items-center gap-1.5">
                      <Radio value={choice} />
                      {choiceText(choice, machines)}
                    </label>
                  ))}
                </RadioGroup>
              </li>
            ))}
          </ul>
          {row.moreConflicts > 0 && (
            <p className="mt-2 text-muted-foreground">
              {row.moreConflicts} more not listed; use an “All” choice to answer them.
            </p>
          )}
        </details>
      )}
    </li>
  );
}

export function CopyProgress({ status }: { readonly status: FolderCopyStatus }) {
  const text = progressText(status);
  const fraction = progressFraction(status);
  const step = {
    approved: "Starting the copy…",
    transferring: "Copying files…",
    verifying: "Checking copied files…",
    applying: "Applying to the folder…",
    applied: "Registering the folder…",
  }[status.state as "approved" | "transferring" | "verifying" | "applying" | "applied"];
  return (
    <div className="space-y-2 text-sm" role="status" aria-live="polite" data-slot="copy-progress">
      <p>{text ?? step ?? "Working…"}</p>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full bg-primary transition-[width] ${fraction === null ? "w-1/3 animate-pulse" : ""}`}
          style={fraction === null ? undefined : { width: `${Math.round(fraction * 100)}%` }}
        />
      </div>
    </div>
  );
}

/** What Undo would restore, and which files changed after Apply. */
export function CopyUndoPreview({ result }: { readonly result: FolderCopyUndoResult }) {
  const edited = result.items.filter((item) => item.state === "edited");
  return (
    <div className="space-y-2 text-sm" data-slot="copy-undo-preview">
      <p>
        Undo restores {result.items.length.toLocaleString()}{" "}
        {result.items.length === 1 ? "item" : "items"} to how they were before Apply.
      </p>
      {edited.length > 0 && (
        <Note>
          {result.edited === 1 ? "1 file was" : `${result.edited} files were`} edited after Apply.
          Undo moves them to the backup folder instead of deleting them:{" "}
          {edited
            .slice(0, 5)
            .map((item) => item.path)
            .join(", ")}
          {edited.length > 5 ? "…" : ""}
        </Note>
      )}
      {result.problems.map((problem) => (
        <Note key={problem}>{problem}</Note>
      ))}
    </div>
  );
}

function Note({ children }: { readonly children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/8 p-2 text-xs wrap-anywhere">
      <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
