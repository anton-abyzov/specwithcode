import type { ReactNode } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type {
  EnvironmentId,
  FolderCopyChoice,
  FolderCopyFileClass,
  FolderCopyMode,
  FolderCopyOffer,
  FolderCopySourceStatus,
  FolderCopySourceSummary,
  FolderCopyStatus,
  FolderCopyUndoResult,
} from "@specweave-studio/contracts";
import type { CopyLinkOutcome } from "../../studio/projectLink";
import { copiedProjectFolder, formatBytes } from "../../studio/folderCopy";
import { HandoffSecretsStep } from "./HandoffSecretsStep";
import {
  CopyClassPicker,
  CopyPlanPreview,
  CopyProgress,
  planRepositoryChoices,
  type RepositoryChoices,
} from "./HandoffCopyPreview";
import { HandoffCopyScope, CopyScopeMapping, type useCopyScope } from "./HandoffCopyScope";
import type { PendingCopy } from "./handoffFolderCopyPending";
import { HandoffCopySetup, type CopyMachine } from "./HandoffCopySetup";
import { HandoffCopyDone, HandoffCopyFailed, HandoffCopyUndone } from "./HandoffCopyDone";
import { sourceProgressText, type CopyStage } from "./handoffCopySteps";
import { replacesNothing } from "./handoffCopyAuto";
import type { CopyNotices } from "./handoffCopyNotices";
import { CopyNextStep, CopyNoticesBlock } from "./HandoffCopyGuide";
import { Button } from "../ui/button";

/** Secret files outside the repositories left out of the copy: those stay here anyway. */
function secretFilesCopied(
  files: FolderCopySourceSummary["secretFiles"],
  copy: FolderCopyStatus,
  skip: ReadonlyArray<string>,
): FolderCopySourceSummary["secretFiles"] {
  const prefixes = copy.rows
    .filter((row) => skip.includes(row.id) && row.path !== ".")
    .map((row) => `${row.path}/`);
  if (prefixes.length === 0) return files;
  return files.filter((file) => !prefixes.some((prefix) => file.path.startsWith(prefix)));
}

/** The body of the live stage, from the setup form to Done. Actions live in the footer. */
export function HandoffCopyStepPanels({
  stage,
  project,
  scope,
  sourceLabel,
  targetLabel,
  busy,
  pending,
  offer,
  summary,
  measured,
  copy,
  machines,
  machine,
  onMachineChange,
  folder,
  onFolderChange,
  findingHome,
  mode,
  onModeChange,
  canMove,
  chooseFirst,
  onChooseFirstChange,
  selection,
  onChoose,
  auto,
  rootLabel,
  replaced,
  replaceLeft,
  replacingFiles,
  onChange,
  repositoryChoices,
  onRepositories,
  replanning,
  secretPaths,
  secretsConfirmed,
  onSecretPathsChange,
  onSecretsConfirmedChange,
  failedBeforeApply,
  undoPreview,
  contextTransferred,
  transferNotice,
  movingAnyway,
  copyAgain,
  secretsNote,
  link,
  linkDialog,
  onLinkDialogClose,
  onLinked,
  sourceDropped,
  notices,
  next,
  lastCopy,
  onViewLast,
}: {
  readonly stage: CopyStage;
  readonly project: EnvironmentProject;
  readonly scope: ReturnType<typeof useCopyScope>;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly busy: boolean;
  readonly pending: PendingCopy | null;
  readonly offer: FolderCopyOffer | null;
  readonly summary: FolderCopySourceSummary | null;
  readonly measured: FolderCopySourceStatus["progress"];
  readonly copy: FolderCopyStatus | null;
  readonly machines: ReadonlyArray<CopyMachine>;
  readonly machine: EnvironmentId | null;
  readonly onMachineChange: (id: EnvironmentId) => void;
  readonly folder: string;
  readonly onFolderChange: (value: string) => void;
  readonly findingHome: boolean;
  readonly mode: FolderCopyMode;
  readonly onModeChange: (mode: FolderCopyMode) => void;
  readonly canMove: boolean;
  readonly chooseFirst: boolean;
  readonly onChooseFirstChange: (chooseFirst: boolean) => void;
  readonly selection: ReadonlyArray<FolderCopyFileClass>;
  readonly onChoose: (next: ReadonlyArray<FolderCopyFileClass>) => void;
  readonly auto: boolean;
  readonly rootLabel: string;
  readonly replaced: string | null;
  readonly replaceLeft: string | null;
  readonly replacingFiles: number | null;
  readonly onChange: (input: {
    readonly decisions?: Readonly<Record<string, FolderCopyChoice>>;
    readonly clone?: ReadonlyArray<string>;
  }) => void;
  /** Clone and skip clicks not yet in the plan; null when the plan has them all. */
  readonly repositoryChoices: RepositoryChoices | null;
  readonly onRepositories: (next: RepositoryChoices) => void;
  readonly replanning: boolean;
  readonly secretPaths: ReadonlyArray<string>;
  readonly secretsConfirmed: boolean;
  readonly onSecretPathsChange: (paths: ReadonlyArray<string>) => void;
  readonly onSecretsConfirmedChange: (confirmed: boolean) => void;
  readonly failedBeforeApply: boolean;
  readonly undoPreview: FolderCopyUndoResult | null;
  readonly contextTransferred: boolean;
  readonly transferNotice: string | null;
  readonly movingAnyway: boolean;
  readonly copyAgain: boolean;
  readonly secretsNote: string | null;
  readonly link: CopyLinkOutcome | { readonly status: "linking" } | null;
  readonly linkDialog: boolean;
  readonly onLinkDialogClose: () => void;
  readonly onLinked: () => void;
  readonly sourceDropped: boolean;
  readonly notices: CopyNotices;
  readonly next: ReactNode;
  /** The last finished copy, kept for View and Undo while a new one is set up. */
  readonly lastCopy: { readonly targetFolder: string; readonly label: string } | null;
  readonly onViewLast: () => void;
}) {
  return (
    <>
      {(stage === "setup" || stage === "scanning") && (
        <>
          {/* On top: a reopen after a finished copy shows it before the next copy's choices. */}
          {stage === "setup" && !pending && lastCopy && (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
              data-slot="copy-last"
            >
              <span className="min-w-0 wrap-anywhere">
                The last copy to {lastCopy.targetFolder} on {lastCopy.label} finished. View it to
                undo it.
              </span>
              <Button size="sm" variant="outline" disabled={busy} onClick={onViewLast}>
                View
              </Button>
            </div>
          )}
          <HandoffCopyScope
            scope={scope}
            sourceLabel={sourceLabel}
            disabled={busy || pending !== null}
          />
          <HandoffCopySetup
            machines={machines}
            machine={machine}
            onMachineChange={onMachineChange}
            targetLabel={targetLabel}
            sourceLabel={sourceLabel}
            folder={folder}
            onFolderChange={onFolderChange}
            findingHome={findingHome}
            projectRelativePath={scope.selected.projectRelativePath}
            mode={mode}
            onModeChange={onModeChange}
            canMove={canMove}
            chooseFirst={
              pending && pending.cancelled !== true ? pending.auto !== true : chooseFirst
            }
            onChooseFirstChange={onChooseFirstChange}
            disabled={busy || pending !== null}
          />
          {stage === "setup" && pending && (
            <p className="text-sm">
              {pending.cancelled
                ? `The copy to ${pending.targetFolder} on ${targetLabel} was cancelled, but ${sourceLabel} has not confirmed dropping it. Check again once ${sourceLabel} is reachable.`
                : `A copy to ${pending.targetFolder} on ${targetLabel} is unfinished. Check it again once ${targetLabel} is reachable.`}
            </p>
          )}
        </>
      )}

      {stage !== "setup" && stage !== "scanning" && pending && (
        <CopyScopeMapping
          source={copy?.copyRoot ?? offer?.copyRoot ?? pending.copyRoot ?? project.workspaceRoot}
          target={copy?.targetFolder ?? pending.targetFolder}
          projectFolder={
            copy?.projectFolder ??
            copiedProjectFolder(
              copy?.targetFolder ?? pending.targetFolder,
              copy?.projectRelativePath ?? pending.projectRelativePath,
            )
          }
        />
      )}

      {stage === "select" && summary && (
        <CopyClassPicker
          summary={summary}
          selection={selection}
          onChange={onChoose}
          disabled={busy}
          hideNotes
        />
      )}

      {stage === "scanning" && (
        <p
          role="status"
          aria-live="polite"
          className="text-sm text-muted-foreground"
          data-slot="copy-measuring"
        >
          {measured ? sourceProgressText(measured, sourceLabel) : "Measuring the folder…"}
        </p>
      )}

      {stage === "planning" && (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          Comparing with {pending?.targetFolder ?? "the folder"} on {targetLabel}…
          {measured?.step && measured.step !== "listing" && (
            <span className="block text-xs" data-slot="copy-source-step">
              {sourceProgressText(measured, sourceLabel)}
            </span>
          )}
        </p>
      )}

      {stage === "preview" && copy && (
        <>
          <p className="text-sm font-medium" data-slot="copy-preview-headline">
            {replacingFiles !== null && replacingFiles > 0
              ? `${replacingFiles.toLocaleString()} ${replacingFiles === 1 ? "file" : "files"} on ${targetLabel} would be replaced. Old versions are kept so you can undo.`
              : replaced
                ? `${replaced} on ${targetLabel} would be replaced. Old versions are kept so you can undo.`
                : replacesNothing(copy)
                  ? `Nothing on ${targetLabel} would be replaced.`
                  : replacingFiles === 0
                    ? `Nothing on ${targetLabel} would be replaced. Check the changes below before copying.`
                    : `${targetLabel} already has some of these folders. Check the changes below before copying.`}
            {replaceLeft && <span className="block font-normal">{replaceLeft}</span>}
          </p>
          <CopyPlanPreview
            status={copy}
            disabled={busy}
            machines={{ here: targetLabel, source: sourceLabel }}
            rootLabel={rootLabel}
            onlyChanges={auto}
            hideWarnings
            onDecide={(decisions) => onChange({ decisions })}
            repositories={repositoryChoices}
            onRepositories={onRepositories}
            replanning={replanning}
            onClone={(rowId, on) =>
              onChange({
                clone: on
                  ? [...copy.rows.filter((row) => row.clone).map((row) => row.id), rowId]
                  : copy.rows.filter((row) => row.clone && row.id !== rowId).map((row) => row.id),
              })
            }
          />
          {copy.disk && (
            <p role="alert" className="text-sm text-destructive-foreground">
              {targetLabel} needs {formatBytes(copy.disk.needed)} free for this copy and has{" "}
              {formatBytes(copy.disk.free)}.
            </p>
          )}
          {summary && (
            <HandoffSecretsStep
              files={secretFilesCopied(
                summary.secretFiles,
                copy,
                (repositoryChoices ?? planRepositoryChoices(copy.rows)).skip,
              )}
              selected={secretPaths}
              confirmed={secretsConfirmed}
              targetLabel={targetLabel}
              disabled={busy}
              onSelectedChange={onSecretPathsChange}
              onConfirmedChange={onSecretsConfirmedChange}
            />
          )}
        </>
      )}

      {(stage === "copying" || stage === "moving") && copy && (
        <>
          {stage === "moving" ? (
            <p role="status" aria-live="polite" className="text-sm">
              Files are in place. Starting the coordinator on {targetLabel}…
            </p>
          ) : (
            <CopyProgress status={copy} />
          )}
        </>
      )}

      {stage === "failed" && copy && (
        <HandoffCopyFailed
          copy={copy}
          sourceLabel={sourceLabel}
          failedBeforeApply={failedBeforeApply}
          undoPreview={undoPreview}
        />
      )}

      {stage === "done" && copy && copy.projectId && machine && (
        <HandoffCopyDone
          project={project}
          copy={copy}
          projectId={copy.projectId}
          machine={machine}
          mode={mode}
          contextTransferred={contextTransferred}
          targetLabel={targetLabel}
          sourceLabel={sourceLabel}
          transferNotice={transferNotice}
          movingAnyway={movingAnyway}
          copyAgain={copyAgain}
          secretsNote={secretsNote}
          link={link}
          undoPreview={undoPreview}
          linkDialog={linkDialog}
          onLinkDialogClose={onLinkDialogClose}
          onLinked={onLinked}
        />
      )}

      {stage === "undone" && (
        <HandoffCopyUndone copy={copy} sourceLabel={sourceLabel} sourceDropped={sourceDropped} />
      )}

      {/* A held move's notices name the files it restored as they were when copying started. */}
      {(stage === "select" ||
        stage === "preview" ||
        stage === "copying" ||
        stage === "failed" ||
        stage === "done") && <CopyNoticesBlock notices={notices} targetLabel={targetLabel} />}

      {next && <CopyNextStep>{next}</CopyNextStep>}
    </>
  );
}
