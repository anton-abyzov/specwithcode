import type {
  EnvironmentId,
  FolderCopyFileClass,
  FolderCopyMode,
  FolderCopySourceSummary,
  FolderCopyStatus,
} from "@specweave-studio/contracts";
import { useState } from "react";
import { formatBytes } from "../../studio/folderCopy";
import { Button } from "../ui/button";
import { HandoffCopyActions } from "./HandoffCopyActions";
import { CopyClassPicker, CopyPlanPreview } from "./HandoffCopyPreview";
import { HandoffCopyScope, type useCopyScope } from "./HandoffCopyScope";
import { HandoffCopySetup, type CopyMachine } from "./HandoffCopySetup";
import { CopyViewingBanner } from "./HandoffCopyGuide";
import { CopyBackButton } from "./HandoffCopyFooter";
import { secretsLeft, secretsLeftText } from "./handoffCopyAuto";
import type { PendingCopy } from "./handoffFolderCopyPending";
import { COPY_STEP_LABELS, type CopyEditAction, type CopyStepId } from "./handoffCopyWizard";

const ignore = () => {};

/** Each change says what it costs; Save folder has its own two-click form below. */
const EDIT_LABELS: Readonly<Record<Exclude<CopyEditAction, "save-folder">, string>> = {
  "change-where": "Change where (cancels this copy)",
  rechoose: "Change what to copy (measures again)",
  "start-new-with-settings": "Start a new copy with these settings",
};

/**
 * An earlier step of the copy, read-only: every control is disabled and the live actions
 * are hidden, so nothing here acts on the copy or calls a machine. "Go to" returns to the
 * live step, which keeps running underneath.
 */
export function HandoffCopyReview({
  step,
  live,
  error,
  scope,
  sourceLabel,
  targetLabel,
  machines,
  pending,
  machine,
  folder,
  mode,
  canMove,
  chooseFirst,
  summary,
  selection,
  copy,
  auto,
  reviewAuto,
  rootLabel,
  contextTransferred,
  editAction,
  editDisabled,
  backDisabled,
  onReturn,
  onBack,
  onChangeWhere,
  onRechoose,
  onSaveFolder,
  onStartNew,
}: {
  readonly step: CopyStepId;
  readonly live: CopyStepId;
  readonly error: string | null;
  readonly scope: ReturnType<typeof useCopyScope>;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly machines: ReadonlyArray<CopyMachine>;
  readonly pending: PendingCopy | null;
  readonly machine: EnvironmentId | null;
  readonly folder: string;
  readonly mode: FolderCopyMode;
  readonly canMove: boolean;
  readonly chooseFirst: boolean;
  readonly summary: FolderCopySourceSummary | null;
  readonly selection: ReadonlyArray<FolderCopyFileClass>;
  readonly copy: FolderCopyStatus | null;
  /** A one-click copy: What was chosen automatically. */
  readonly auto: boolean;
  /** The compared plan replaced nothing and was approved without stopping. */
  readonly reviewAuto: boolean;
  readonly rootLabel: string;
  readonly contextTransferred: boolean;
  /** The one change this step offers, from editActionFor; null keeps it read-only. */
  readonly editAction: CopyEditAction | null;
  readonly editDisabled: boolean;
  readonly backDisabled: boolean;
  readonly onReturn: () => void;
  /** Null on Where, which has no step before it. */
  readonly onBack: (() => void) | null;
  readonly onChangeWhere: () => void;
  readonly onRechoose: () => void;
  readonly onSaveFolder: (folder: string) => void;
  readonly onStartNew: () => void;
}) {
  // The pointer holds what the copy started with; the form may have been edited since.
  const chosen = pending?.selection ?? selection;
  const savedFolder = pending?.targetFolder ?? folder;
  // A new folder being typed while choosing; null while the folder is read-only.
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const editingFolder = editAction === "save-folder" && newFolder !== null;
  const onEdit = {
    "change-where": onChangeWhere,
    rechoose: onRechoose,
    "start-new-with-settings": onStartNew,
  };
  const sent = copy?.secrets?.map((file) => file.path) ?? [];
  const left =
    copy?.state === "applied"
      ? secretsLeftText(secretsLeft(summary?.secretFiles, copy.secrets), sourceLabel)
      : null;
  return (
    <>
      <CopyViewingBanner viewing={COPY_STEP_LABELS[step]} live={COPY_STEP_LABELS[live]} />
      <div className="space-y-4" data-slot="copy-review" data-step-id={step}>
        {step === "where" && (
          <>
            <HandoffCopyScope scope={scope} sourceLabel={sourceLabel} disabled />
            <HandoffCopySetup
              machines={machines}
              machine={(pending?.environmentId as EnvironmentId | undefined) ?? machine}
              onMachineChange={ignore}
              targetLabel={targetLabel}
              sourceLabel={sourceLabel}
              folder={editingFolder ? newFolder : savedFolder}
              onFolderChange={editingFolder ? setNewFolder : ignore}
              findingHome={false}
              projectRelativePath={
                pending?.projectRelativePath ?? scope.selected.projectRelativePath
              }
              mode={pending?.mode ?? mode}
              onModeChange={ignore}
              canMove={canMove}
              chooseFirst={pending ? pending.auto !== true : chooseFirst}
              onChooseFirstChange={ignore}
              disabled
              folderDisabled={!editingFolder || editDisabled}
            />
          </>
        )}

        {step === "what" && summary && (
          <>
            {auto && (
              <p className="text-sm text-muted-foreground" data-slot="copy-review-auto">
                Chosen automatically. Turn on Choose what to copy to pick these yourself.
              </p>
            )}
            <CopyClassPicker summary={summary} selection={chosen} onChange={ignore} disabled />
          </>
        )}

        {step === "review" && copy && (
          <>
            <p className="text-sm font-medium" data-slot="copy-review-plan">
              {copy.state === "cancelled" ? "Plan as compared." : "Plan as approved."}
              {reviewAuto && copy.state !== "cancelled" && (
                <span className="block font-normal text-muted-foreground">
                  Nothing on {targetLabel} would be replaced, so it was approved automatically.
                </span>
              )}
            </p>
            <CopyPlanPreview
              status={copy}
              disabled
              machines={{ here: targetLabel, source: sourceLabel }}
              rootLabel={rootLabel}
              onlyChanges={false}
              hideWarnings
              onDecide={ignore}
              onClone={ignore}
            />
            {sent.length > 0 && (
              <p className="text-xs wrap-anywhere" data-slot="copy-review-secrets">
                Secret files sent to {targetLabel}: {sent.join(", ")}.
              </p>
            )}
            {left && <p className="text-xs text-muted-foreground">{left}</p>}
          </>
        )}

        {step === "copy" && copy && (
          <p className="text-sm" data-slot="copy-review-copied">
            {copy.state === "cancelled"
              ? `The copy was cancelled. Nothing in ${copy.targetFolder} on ${targetLabel} changed.`
              : copy.state === "undone"
                ? `These files were copied to ${copy.targetFolder} on ${targetLabel}, then undone.`
                : copy.totals
                  ? `${copy.totals.filesToMove.toLocaleString()} ${copy.totals.filesToMove === 1 ? "file" : "files"} (${formatBytes(copy.totals.bytesToMove)}) copied to ${copy.targetFolder} on ${targetLabel}.`
                  : `The files were copied to ${copy.targetFolder} on ${targetLabel}.`}
          </p>
        )}

        {step === "transfer" && contextTransferred && (
          <p className="text-sm" data-slot="copy-review-transfer">
            Coordinator context moved to {targetLabel}. The coordinator runs there now.
          </p>
        )}
      </div>
      <HandoffCopyActions>
        {error && (
          <p
            role="alert"
            className="max-h-24 basis-full overflow-y-auto wrap-anywhere text-sm text-destructive-foreground"
          >
            {error}
          </p>
        )}
        {onBack && <CopyBackButton disabled={backDisabled} onBack={onBack} />}
        <Button onClick={onReturn}>Go to {COPY_STEP_LABELS[live]}</Button>
        {editAction === "save-folder" &&
          (editingFolder ? (
            <Button
              variant="outline"
              disabled={editDisabled || !newFolder.trim() || newFolder.trim() === savedFolder}
              onClick={() => onSaveFolder(newFolder)}
            >
              Save folder
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={editDisabled}
              onClick={() => setNewFolder(savedFolder)}
            >
              Change folder
            </Button>
          ))}
        {editAction && editAction !== "save-folder" && (
          <Button variant="outline" disabled={editDisabled} onClick={onEdit[editAction]}>
            {EDIT_LABELS[editAction]}
          </Button>
        )}
      </HandoffCopyActions>
    </>
  );
}
