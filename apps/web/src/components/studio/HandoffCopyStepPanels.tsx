import type { ReactNode } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type {
  EnvironmentId,
  FolderCopyChoice,
  FolderCopyFileClass,
  FolderCopyMode,
  FolderCopySourceStatus,
  FolderCopySourceSummary,
  FolderCopyStatus,
  FolderCopyUndoResult,
  MachineHandoffRetention,
  MachineHandoffSourceChanges,
} from "@specweave-studio/contracts";
import type { LeftOnSource } from "./HandoffSourceChanges";
import type { CopyLinkOutcome } from "../../studio/projectLink";
import { formatBytes } from "../../studio/folderCopy";
import { HandoffSecretsStep } from "./HandoffSecretsStep";
import { CopyClassPicker, CopyPlanPreview } from "./HandoffCopyPreview";
import { CopyProgressPanel } from "./CopyProgressPanel";
import {
  planRepositoryChoices,
  secretFilesCopied,
  type RepositoryChoices,
} from "./handoffCopySecrets";
import type { useCopyScope } from "./HandoffCopyScope";
import type { PendingCopy } from "./handoffFolderCopyPending";
import { HandoffCopySetup, type CopyMachine } from "./HandoffCopySetup";
import { HandoffCopyDone, HandoffCopyFailed, HandoffCopyUndone } from "./HandoffCopyDone";
import {
  workingView,
  type CopyRecompare,
  type CopyStage,
  type TransferBusy,
} from "./handoffCopySteps";
import { replacesNothing } from "./handoffCopyAuto";
import type { CopyNotices } from "./handoffCopyNotices";
import { CopyNextStep, CopyNoticesBlock, CopyWorkingHint } from "./HandoffCopyGuide";
import { Button } from "../ui/button";

/** The body of the live stage, from the setup form to Done. Actions live in the footer. */
export function HandoffCopyStepPanels({
  stage,
  project,
  scope,
  sourceLabel,
  targetLabel,
  busy,
  pending,
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
  includeSecrets,
  onSecretsChange,
  onIncludeSecretsChange,
  uncommittedFiles,
  details,
  failedBeforeApply,
  undoPreview,
  contextTransferred,
  movedRetention = null,
  transferNotice,
  transferBusy = null,
  movingAnyway,
  copyAgain,
  sourceReview,
  leftOnSource,
  keptHere,
  secretsNote,
  secretsLocked = null,
  link,
  linkDialog,
  onLinkDialogClose,
  onLinked,
  sourceDropped,
  notices,
  next,
  working,
  recompare = null,
  choices,
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
  /** Secret files travel unless this is off; on by default, and seeing it on is the consent. */
  readonly includeSecrets: boolean;
  /** The review's secrets choice: whether they travel, and which files. */
  readonly onSecretsChange: (included: boolean, paths: ReadonlyArray<string>) => void;
  readonly onIncludeSecretsChange: (include: boolean) => void;
  /** Uncommitted files in the source, for What comes along; null when unknown. */
  readonly uncommittedFiles: number | null;
  /** The Workspace locations rows, shown under Details on the setup screen. */
  readonly details: ReactNode;
  readonly failedBeforeApply: boolean;
  readonly undoPreview: FolderCopyUndoResult | null;
  readonly contextTransferred: boolean;
  /** What a large project's move left on the source; null when every transcript moved. */
  readonly movedRetention?: MachineHandoffRetention | null;
  readonly transferNotice: string | null;
  readonly transferBusy?: TransferBusy | null;
  readonly movingAnyway: boolean;
  readonly copyAgain: boolean;
  /** The source's list of paths that changed after copying, while the person decides. */
  readonly sourceReview: MachineHandoffSourceChanges | null;
  /** What a finished move left only on the source. */
  readonly leftOnSource: LeftOnSource | null;
  /** The person kept the coordinator on the source. */
  readonly keptHere: boolean;
  readonly secretsNote: string | null;
  /** Why this window cannot send secrets and where to send them from; null when it can. */
  readonly secretsLocked?: string | null;
  readonly link: CopyLinkOutcome | { readonly status: "linking" } | null;
  readonly linkDialog: boolean;
  readonly onLinkDialogClose: () => void;
  readonly onLinked: () => void;
  readonly sourceDropped: boolean;
  readonly notices: CopyNotices;
  readonly next: ReactNode;
  /** The one progress line while measuring, comparing, copying or moving. */
  readonly working: string | null;
  /** Why the destination compares again, for the panel's note. */
  readonly recompare?: CopyRecompare;
  /** Your choices, with its Change link, once a copy has started. */
  readonly choices: ReactNode;
  /** The last finished copy, kept for View and Undo while a new one is set up. */
  readonly lastCopy: { readonly targetFolder: string; readonly label: string } | null;
  readonly onViewLast: () => void;
}) {
  const view = working
    ? workingView({ stage, sourceLabel, targetLabel, measured, copy, recompare })
    : null;
  return (
    <>
      {/* Once a copy runs, its choices summary replaces the form: machines, folder and
          options cannot change mid-copy, and account notices about other machines are noise. */}
      {(stage === "setup" || (stage === "scanning" && pending === null)) && (
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
          <HandoffCopySetup
            scope={scope}
            machines={machines}
            machine={machine}
            onMachineChange={onMachineChange}
            targetLabel={targetLabel}
            sourceLabel={sourceLabel}
            sourceRoot={project.workspaceRoot}
            along={{
              uncommittedFiles,
              includeSecrets,
              onIncludeSecretsChange,
              secretsLocked,
              details,
            }}
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

      {choices}

      {stage === "select" && summary && (
        <CopyClassPicker
          summary={summary}
          selection={selection}
          onChange={onChoose}
          disabled={busy}
          hideNotes
        />
      )}

      {working && (
        <div className="space-y-2">
          {view ? (
            <CopyProgressPanel
              view={view}
              sourceLabel={sourceLabel}
              targetLabel={targetLabel}
              startedAt={copy?.startedAt ?? null}
              stepSlot={stage === "scanning" ? "copy-measuring" : "copy-working"}
            />
          ) : (
            <p role="status" aria-live="polite" className="text-sm" data-slot="copy-working">
              {working}
            </p>
          )}
          {/* Moving the coordinator must finish here; everything else carries on closed. */}
          {stage !== "moving" && <CopyWorkingHint move={mode === "copy-and-move"} />}
        </div>
      )}

      {stage === "preview" && copy && (
        <>
          <p className="text-sm font-medium" data-slot="copy-preview-headline">
            {replacingFiles !== null && replacingFiles > 0
              ? `${replacingFiles.toLocaleString()} ${replacingFiles === 1 ? "file" : "files"} on ${targetLabel} would be replaced.`
              : replaced
                ? `${replaced} on ${targetLabel} would be replaced.`
                : replacesNothing(copy)
                  ? `Nothing on ${targetLabel} would be replaced.`
                  : replacingFiles === 0
                    ? `Nothing on ${targetLabel} would be replaced. Check the changes below before copying.`
                    : `${targetLabel} already has some of these folders. Check the changes below before copying.`}
            {(replaced || (replacingFiles ?? 0) > 0) && (
              <span className="block font-normal text-muted-foreground">
                Old versions are kept for 14 days so you can undo.
              </span>
            )}
            {replaceLeft && <span className="block font-normal">{replaceLeft}</span>}
          </p>
          <CopyPlanPreview
            status={copy}
            disabled={busy}
            machines={{ here: targetLabel, source: sourceLabel }}
            rootLabel={rootLabel}
            onlyChanges={auto}
            sections
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
              hints={summary.secretHints}
              selected={secretPaths}
              included={includeSecrets}
              sourceLabel={sourceLabel}
              targetLabel={targetLabel}
              homeSupported={
                machines.find((entry) => entry.id === machine)?.homeSecretFiles === true
              }
              disabled={busy}
              locked={secretsLocked}
              onChange={onSecretsChange}
            />
          )}
        </>
      )}

      {stage === "failed" && copy && (
        <HandoffCopyFailed
          copy={copy}
          sourceLabel={sourceLabel}
          targetLabel={targetLabel}
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
          movedRetention={movedRetention}
          targetLabel={targetLabel}
          sourceLabel={sourceLabel}
          transferNotice={transferNotice}
          transferBusy={transferBusy}
          movingAnyway={movingAnyway}
          copyAgain={copyAgain}
          sourceReview={sourceReview}
          leftOnSource={leftOnSource}
          keptHere={keptHere}
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
