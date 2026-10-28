import { useState, type ReactNode } from "react";
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronRightIcon,
  GitBranchIcon,
  FolderIcon,
} from "lucide-react";
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
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
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

/** Which repository rows are cloned from origin and which are left out of the copy. */
export interface RepositoryChoices {
  readonly clone: ReadonlyArray<string>;
  readonly skip: ReadonlyArray<string>;
}

/** The repository choices the destination's plan holds now. */
export function planRepositoryChoices(rows: ReadonlyArray<FolderCopyRow>): RepositoryChoices {
  return {
    clone: rows.filter((row) => row.clone).map((row) => row.id),
    skip: rows.filter((row) => row.status === "skipped").map((row) => row.id),
  };
}

/** Repository rows the person can leave out: every repository except the folder's own root. */
const skippable = (row: FolderCopyRow) =>
  row.kind === "repository" && row.path !== "." && row.status !== "only-here";

/** A row with a folder choice or a listed file conflict still unanswered. */
const needsChoice = (row: FolderCopyRow) =>
  (row.choices.length > 0 && row.decision === null) ||
  row.conflicts.some((conflict) => conflict.decision === null);

/** Review lists show five rows, then a button for the rest. */
const COLLAPSED_ROWS = 5;

function CollapsedList({
  items,
  render,
}: {
  readonly items: ReadonlyArray<FolderCopyRow>;
  readonly render: (row: FolderCopyRow) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, COLLAPSED_ROWS);
  return (
    <>
      <ul className="space-y-2">{shown.map(render)}</ul>
      {items.length > shown.length && (
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Show {(items.length - shown.length).toLocaleString()} more
        </Button>
      )}
    </>
  );
}

/** One row per repository plus the folder's other files, with their decisions. */
export function CopyPlanPreview({
  status,
  onDecide,
  onClone,
  repositories,
  onRepositories,
  replanning = false,
  disabled,
  machines,
  rootLabel,
  onlyChanges = false,
  sections = false,
  hideWarnings = false,
}: {
  readonly status: FolderCopyStatus;
  readonly onDecide: (decisions: Readonly<Record<string, FolderCopyChoice>>) => void;
  readonly onClone: (rowId: string, clone: boolean) => void;
  /**
   * Clone and skip choices not yet in the plan, shown at once while the destination
   * compares again. With `onRepositories` the rows get Copy and Clone controls for all.
   */
  readonly repositories?: RepositoryChoices | null;
  readonly onRepositories?: (next: RepositoryChoices) => void;
  /** The destination is comparing again after a clone or skip change. */
  readonly replanning?: boolean;
  readonly disabled: boolean;
  /** Names the machines in each choice instead of "this machine" and "the source". */
  readonly machines?: ChoiceMachines;
  /** Title of the row for the folder's own root, such as the project name. */
  readonly rootLabel?: string;
  /** Lists only rows that change something already there; new and unchanged ones are counted. */
  readonly onlyChanges?: boolean;
  /**
   * Review's layout: rows that need a choice first under "Needs your choice", each list
   * collapsed past five, and the repository controls behind "Adjust repositories (n)".
   */
  readonly sections?: boolean;
  /** The caller shows the plan's warnings in its own grouped notices. */
  readonly hideWarnings?: boolean;
}) {
  const totals = status.totals;
  const folderChoices = status.rows.filter(
    (row) => row.choices.length > 0 && row.decision === null,
  ).length;
  const fileChoices = Math.max(0, (totals?.decisionsNeeded ?? 0) - folderChoices);
  const current = repositories ?? planRepositoryChoices(status.rows);
  // A repository left out stays listed, so it can be taken back.
  const rows = !onlyChanges
    ? status.rows
    : status.rows.filter((row) => current.skip.includes(row.id) || changedRows([row]).length > 0);
  const shown = new Set(rows);
  const hidden = status.rows.filter((row) => !shown.has(row));
  // Folders only on the destination are kept there, not copied.
  const kept = hidden.filter((row) => row.status === "only-here").length;
  const untouched = hidden.length - kept;
  const renderRow = (row: FolderCopyRow) => (
    <CopyRow
      key={row.id}
      row={row}
      onDecide={onDecide}
      onClone={
        onRepositories
          ? (rowId, on) =>
              onRepositories({
                ...current,
                clone: on
                  ? [...current.clone.filter((id) => id !== rowId), rowId]
                  : current.clone.filter((id) => id !== rowId),
              })
          : onClone
      }
      {...(onRepositories && skippable(row)
        ? {
            copied: !current.skip.includes(row.id),
            onCopied: (on: boolean) =>
              onRepositories({
                ...current,
                skip: on ? current.skip.filter((id) => id !== row.id) : [...current.skip, row.id],
              }),
          }
        : {})}
      cloned={onRepositories ? current.clone.includes(row.id) : row.clone}
      stale={replanning}
      disabled={disabled}
      {...(machines ? { machines } : {})}
      {...(rootLabel ? { rootLabel } : {})}
    />
  );
  const choosing = rows.filter(needsChoice);
  const adjustableRow = (row: FolderCopyRow) =>
    skippable(row) ||
    (row.kind === "repository" && row.cloneAvailable && !current.skip.includes(row.id));
  const adjustable = status.rows.filter(adjustableRow).length;
  const grouped = sections && !!onRepositories && adjustable > 0;
  // A repository that replaces nothing is listed once, inside Adjust repositories.
  const quiet = (row: FolderCopyRow) =>
    grouped && adjustableRow(row) && changedRows([row]).length === 0;
  const settled = rows.filter((row) => !needsChoice(row) && !quiet(row));
  const adjustRows = rows.filter((row) => !needsChoice(row) && quiet(row));
  const repositoryControls = onRepositories && (
    <RepositoryControls
      rows={status.rows}
      current={current}
      onChange={onRepositories}
      disabled={disabled}
      replanning={replanning}
      machines={machines}
    />
  );
  return (
    <div className="space-y-3 text-sm" data-slot="copy-preview">
      {sections && repositoryControls && adjustable > 0 ? (
        <Collapsible data-slot="copy-adjust-repositories">
          <CollapsibleTrigger className="group inline-flex items-center gap-1 text-sm font-medium">
            <ChevronRightIcon
              className="size-4 transition-transform group-data-panel-open:rotate-90"
              aria-hidden
            />
            Adjust repositories ({adjustable})
          </CollapsibleTrigger>
          <CollapsiblePanel keepMounted>
            <div className="space-y-2 pt-2">
              {repositoryControls}
              {adjustRows.length > 0 && <CollapsedList items={adjustRows} render={renderRow} />}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : (
        repositoryControls
      )}
      {totals && (
        <p data-slot="copy-preview-totals" className={replanning ? "opacity-60" : undefined}>
          {totals.decisionsNeeded > 0 ? "Planned so far: " : "Planned: "}
          {totals.filesToMove.toLocaleString()} files, {formatBytes(totals.bytesToMove)} to copy
          {totals.bytesPresent > 0 && `, ${formatBytes(totals.bytesPresent)} already here`}.
          {totals.decisionsNeeded > 0 &&
            ` Choose for ${[folderChoices > 0 ? `${folderChoices} ${folderChoices === 1 ? "folder" : "folders"}` : "", fileChoices > 0 ? `${fileChoices} ${fileChoices === 1 ? "file" : "files"}` : ""].filter(Boolean).join(" and ")} before copying. Counts update after your choices.`}
          {totals.filesToMove === 0 &&
            totals.decisionsNeeded === 0 &&
            " Repository content may still arrive through Git; this is not a repository size."}
        </p>
      )}
      {sections ? (
        <>
          {choosing.length > 0 && (
            <section className="space-y-2" data-slot="copy-needs-choice">
              <h3 className="text-sm font-medium">Needs your choice</h3>
              <CollapsedList items={choosing} render={renderRow} />
            </section>
          )}
          {settled.length > 0 && <CollapsedList items={settled} render={renderRow} />}
        </>
      ) : (
        <ul className="space-y-2">{rows.map(renderRow)}</ul>
      )}
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
      {!sections && (
        <p className="text-xs text-muted-foreground">
          Nothing on {machines?.here ?? "this machine"} is overwritten without a backup. Undo
          restores the folder for 14 days.
        </p>
      )}
    </div>
  );
}

function ToolbarButton({
  disabled,
  onClick,
  children,
}: {
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="rounded border px-2 py-1 hover:bg-accent/40 disabled:opacity-50"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Copy all or none and clone all or none for the repository rows, with what cloning saves. */
function RepositoryControls({
  rows,
  current,
  onChange,
  disabled,
  replanning,
  machines,
}: {
  readonly rows: ReadonlyArray<FolderCopyRow>;
  readonly current: RepositoryChoices;
  readonly onChange: (next: RepositoryChoices) => void;
  readonly disabled: boolean;
  readonly replanning: boolean;
  readonly machines: ChoiceMachines | undefined;
}) {
  const repositories = rows.filter(skippable);
  const cloneable = rows.filter(
    (row) => row.kind === "repository" && row.cloneAvailable && !current.skip.includes(row.id),
  );
  if (repositories.length === 0 && cloneable.length === 0) return null;
  const copied = repositories.filter((row) => !current.skip.includes(row.id)).length;
  const cloned = cloneable.filter((row) => current.clone.includes(row.id)).length;
  const target = machines?.here ?? "the other machine";
  const source = machines?.source ?? "this machine";
  const ids = (list: ReadonlyArray<FolderCopyRow>) => new Set(list.map((row) => row.id));
  const repositoryIds = ids(repositories);
  const cloneableIds = ids(cloneable);
  return (
    <div className="space-y-2 rounded-lg border p-3 text-xs" data-slot="copy-repositories">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium">Repositories</span>
        {repositories.length > 0 && (
          <span className="text-muted-foreground" data-slot="copy-repositories-count">
            {copied} of {repositories.length} copied
            {cloneable.length > 0 && `, ${cloned} cloned from origin`}
          </span>
        )}
        <span role="status" aria-live="polite" className="ml-auto text-muted-foreground">
          {replanning ? "Updating sizes…" : ""}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {repositories.length > 1 && (
          <>
            <ToolbarButton
              disabled={disabled || copied === repositories.length}
              onClick={() =>
                onChange({ ...current, skip: current.skip.filter((id) => !repositoryIds.has(id)) })
              }
            >
              Copy all
            </ToolbarButton>
            <ToolbarButton
              disabled={disabled || copied === 0}
              onClick={() =>
                onChange({ ...current, skip: [...new Set([...current.skip, ...repositoryIds])] })
              }
            >
              Copy none
            </ToolbarButton>
          </>
        )}
        {cloneable.length > 1 && (
          <>
            <ToolbarButton
              disabled={disabled || cloned === cloneable.length}
              onClick={() =>
                onChange({ ...current, clone: [...new Set([...current.clone, ...cloneableIds])] })
              }
            >
              Clone all from origin
            </ToolbarButton>
            <ToolbarButton
              disabled={disabled || cloned === 0}
              onClick={() =>
                onChange({
                  ...current,
                  clone: current.clone.filter((id) => !cloneableIds.has(id)),
                })
              }
            >
              Copy all whole
            </ToolbarButton>
          </>
        )}
      </div>
      {cloneable.length > 0 && (
        <p className="text-muted-foreground" data-slot="copy-clone-explained">
          Cloning from origin makes {target} download the committed files from the
          repository&rsquo;s remote (such as GitHub) instead of receiving them from {source}, so
          much less crosses between the machines and large repositories arrive sooner. Uncommitted
          changes and untracked files are still copied. Commits not pushed to origin, local-only
          branches and stashes stay on {source}; push them first, or copy that repository whole.
        </p>
      )}
      {repositories.length > 0 && (
        <p className="text-muted-foreground">
          Untick a repository to leave it out. Nothing of it is copied, and whatever {target}{" "}
          already has there stays as it is.
        </p>
      )}
    </div>
  );
}

function CopyRow({
  row,
  onDecide,
  onClone,
  copied,
  onCopied,
  cloned,
  stale = false,
  disabled,
  machines,
  rootLabel,
}: {
  readonly row: FolderCopyRow;
  readonly onDecide: (decisions: Readonly<Record<string, FolderCopyChoice>>) => void;
  readonly onClone: (rowId: string, clone: boolean) => void;
  /** Set when the row can be left out: whether it is copied. */
  readonly copied?: boolean;
  readonly onCopied?: (copied: boolean) => void;
  readonly cloned: boolean;
  /** The counts are from before the last change; new ones are on the way. */
  readonly stale?: boolean;
  readonly disabled: boolean;
  readonly machines?: ChoiceMachines;
  readonly rootLabel?: string;
}) {
  const title = copyRowTitle(row, rootLabel);
  const left = copied === false;
  const open = row.conflicts.filter((conflict) => conflict.decision === null).length;
  const attention = (row.needsDecision && row.decision === null) || open > 0;
  const shared = (["keep-mine", "take-theirs"] as const).filter((choice) =>
    row.conflicts.every((conflict) => conflict.choices.includes(choice)),
  );
  return (
    <li
      className={`space-y-1.5 rounded-lg border px-3 py-2 ${attention && !left ? "border-warning/60" : ""} ${left ? "bg-muted/40" : ""}`}
      data-slot="copy-row"
      data-status={row.status}
      data-copied={copied === undefined ? undefined : String(!left)}
    >
      <div className="flex min-w-0 items-start gap-2">
        {onCopied && (
          <span className="flex h-5 items-center">
            <Checkbox
              checked={!left}
              disabled={disabled}
              aria-label={`Copy ${title}`}
              onCheckedChange={(checked) => onCopied(checked === true)}
            />
          </span>
        )}
        {row.kind === "repository" ? (
          <GitBranchIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        ) : (
          <FolderIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className={`break-all font-medium ${left ? "text-muted-foreground" : ""}`}>
              {title}
            </span>
            <span className="text-xs text-muted-foreground">
              {left ? ROW_STATUS_TEXT.skipped : ROW_STATUS_TEXT[row.status]}
            </span>
          </div>
          {left ? (
            row.status !== "skipped" && (
              <p className="text-xs text-muted-foreground">Left out of this copy.</p>
            )
          ) : (
            <p
              className={`wrap-anywhere text-xs text-muted-foreground tabular-nums ${stale ? "opacity-60" : ""}`}
            >
              {row.status === "skipped" ? (
                "Copied again once the comparison updates."
              ) : (
                <>
                  {stale ? (
                    "Updating the copy plan…"
                  ) : row.choices.length > 0 && row.decision === null ? (
                    "Choose a version to calculate files and size."
                  ) : row.filesToMove === 0 && row.bytesToMove === 0 ? (
                    open > 0 || (row.moreConflicts > 0 && row.needsDecision) ? (
                      "File transfers depend on the conflict choices below."
                    ) : row.decision === "keep-mine" ? (
                      "Destination version kept; no source files planned for this folder."
                    ) : row.kind === "repository" ? (
                      "No separate file transfers planned. Repository changes may still be applied through Git."
                    ) : (
                      "No file transfers planned for this group."
                    )
                  ) : (
                    <>
                      {row.filesToMove.toLocaleString()} files, {formatBytes(row.bytesToMove)}{" "}
                      planned to copy
                      {row.bytesPresent > 0 && `, ${formatBytes(row.bytesPresent)} already here`}
                    </>
                  )}
                  {row.detail && <span className="block">{row.detail}</span>}
                </>
              )}
            </p>
          )}
          {left && row.status === "skipped" && row.detail && (
            <p className="wrap-anywhere text-xs text-muted-foreground">{row.detail}</p>
          )}
        </div>
        {!attention && !left && row.status !== "same" && (
          <CheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
      </div>
      {row.cloneAvailable && !left && (
        <label className="flex cursor-pointer items-center gap-2 text-xs" data-slot="copy-clone">
          <Checkbox
            checked={cloned}
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
        <div className="space-y-2 text-xs" data-slot="copy-file-conflicts">
          <p>
            {row.conflicts.length + row.moreConflicts} files differ on both machines
            {open > 0 ? `, ${open}${row.moreConflicts > 0 ? "+" : ""} undecided` : ""}
          </p>
          <p className="text-muted-foreground">
            Choose once for this group, or review individual files. Nothing is chosen automatically.
          </p>
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
          <details data-slot="copy-conflict-details">
            <summary className="cursor-pointer">
              Review individual files ({row.conflicts.length + row.moreConflicts})
            </summary>
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
                    onValueChange={(value) =>
                      onDecide({ [conflict.id]: value as FolderCopyChoice })
                    }
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
          </details>
          {row.moreConflicts > 0 && (
            <p className="mt-2 text-muted-foreground">
              {row.moreConflicts} more not listed; use an “All” choice to answer them.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

const STEP_TEXT: Partial<Record<FolderCopyStatus["state"], string>> = {
  approved: "Starting the copy…",
  transferring: "Copying files…",
  verifying: "Checking copied files…",
  applying: "Applying to the folder…",
  applied: "Registering the folder…",
};

/**
 * The copy's one progress line, with a bar. `line` is Copying {size}… (or what applying is
 * doing); the live counts sit muted under it.
 */
export function CopyProgress({
  status,
  line,
}: {
  readonly status: FolderCopyStatus;
  /** Without one, the live counts are the line. */
  readonly line?: string;
}) {
  const counts = progressText(status);
  const fraction = progressFraction(status);
  const detail = line ? counts : null;
  line ??= counts ?? STEP_TEXT[status.state] ?? "Working…";
  return (
    <div className="space-y-2 text-sm" role="status" aria-live="polite" data-slot="copy-progress">
      <p>
        {line}
        {detail && (
          <span className="block text-xs text-muted-foreground" data-slot="copy-progress-detail">
            {detail}
          </span>
        )}
      </p>
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
