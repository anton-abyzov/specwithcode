import type {
  EnvironmentId,
  FolderCopyFileClass,
  FolderCopyMode,
  FolderCopyStatus,
  FolderCopyUndoResult,
} from "@specweave-studio/contracts";
import type { CopyLinkOutcome } from "../../studio/projectLink";
import { Button } from "../ui/button";
import { HandoffCopyActions } from "./HandoffCopyActions";
import type { PendingCopy } from "./handoffFolderCopyPending";
import { HandoffCopyDoneActions, HandoffCopyFailedActions } from "./HandoffCopyDone";
import type { CopyStage } from "./handoffCopySteps";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useProjectMoveDialog } from "./ProjectMoveOptions";
import { plainHandoffError } from "./handoffErrors";

/** Screen 1: Cancel closes the dialog, the primary starts (and with file types, stops to choose). */
function SetupActions({
  disabled,
  hint,
  label,
  onStart,
}: {
  readonly disabled: boolean;
  /** What the primary waits for (no machine yet), said quietly beside it. */
  readonly hint: string | null;
  readonly label: string;
  readonly onStart: () => void;
}) {
  const close = useProjectMoveDialog()?.close ?? null;
  return (
    <>
      {hint && (
        <span
          className="min-w-0 flex-1 self-center text-xs text-muted-foreground"
          data-slot="copy-setup-hint"
        >
          {hint}
        </span>
      )}
      {/* One primary, filled even while off, so the dialog never shows two outline buttons. */}
      <Button disabled={disabled} onClick={onStart}>
        {label}
      </Button>
      {close && (
        <Button variant="outline" onClick={close}>
          Cancel
        </Button>
      )}
    </>
  );
}

/** The leading ghost while a copy works or waits: stops it before anything is applied. */
function StopCopyButton({
  disabled,
  move,
  onStop,
}: {
  readonly disabled: boolean;
  /** A move says Stop move: the person is moving the project, not copying files. */
  readonly move: boolean;
  readonly onStop: () => void;
}) {
  return (
    <Button variant="ghost" data-leading disabled={disabled} onClick={onStop}>
      {move ? "Stop move" : "Stop copy"}
    </Button>
  );
}

/** The live stage's actions, placed by the dialog through HandoffCopyActions. */
export function HandoffCopyFooter({
  stage,
  sourceChanged = false,
  error,
  busy,
  working,
  pending,
  copy,
  machine,
  mode,
  targetLabel,
  sourceLabel,
  auto,
  selection,
  setupBlocked,
  replaced,
  approveLabel,
  secretsUnconfirmed,
  failedBeforeApply,
  undoPreview,
  copyAgain,
  contextTransferred,
  link,
  transferRecovery,
  onCancelMeasure,
  onResume,
  onMeasure,
  onPlan,
  onStop,
  onReplaceAll,
  onApply,
  onCopyAgain,
  onRetry,
  onUndo,
  onEndSourceHold,
  sourceDropped,
  onTransfer,
  onOpen,
  onLink,
  onStartNew,
  onChangeSetup,
}: {
  readonly stage: CopyStage;
  readonly sourceChanged?: boolean;
  readonly error: string | null;
  readonly busy: boolean;
  readonly working: boolean;
  readonly pending: PendingCopy | null;
  readonly copy: FolderCopyStatus | null;
  readonly machine: EnvironmentId | null;
  readonly mode: FolderCopyMode;
  readonly targetLabel: string;
  /** This machine's name, for an error's next step. */
  readonly sourceLabel?: string;
  readonly auto: boolean;
  readonly chooseFirst: boolean;
  readonly selection: ReadonlyArray<FolderCopyFileClass>;
  /** The setup form cannot start a copy yet: no machine, folder or scope. */
  readonly setupBlocked: boolean;
  readonly replaced: string | null;
  readonly approveLabel: string;
  readonly secretsUnconfirmed: boolean;
  readonly failedBeforeApply: boolean;
  readonly undoPreview: FolderCopyUndoResult | null;
  readonly copyAgain: boolean;
  readonly contextTransferred: boolean;
  readonly link: CopyLinkOutcome | { readonly status: "linking" } | null;
  readonly transferRecovery: boolean;
  readonly onCancelMeasure: () => void;
  readonly onResume: (saved: PendingCopy) => void;
  readonly onMeasure: () => void;
  readonly onPlan: () => void;
  readonly onStop: () => void;
  readonly onEndSourceHold: () => void;
  readonly sourceDropped: boolean;
  readonly onReplaceAll: () => void;
  readonly onApply: () => void;
  readonly onCopyAgain: () => void;
  readonly onRetry: () => void;
  readonly onUndo: (force: boolean, previewOnly: boolean) => void;
  /** Null when no pointer is left to transfer from. */
  readonly onTransfer: (() => void) | null;
  readonly onOpen: () => void;
  readonly onLink: () => void;
  readonly onStartNew: () => void;
  /** Review's way back: stops this copy and opens the setup with its choices. */
  readonly onChangeSetup: () => void;
}) {
  return (
    <HandoffCopyActions>
      {error && (
        <p
          role="alert"
          className="max-h-24 basis-full overflow-y-auto wrap-anywhere text-sm text-destructive-foreground"
        >
          {plainHandoffError(error, mode === "copy-and-move" ? "move" : "copy", {
            source: sourceLabel,
            destination: targetLabel,
          })}
        </p>
      )}
      {stage === "scanning" && (
        <StopCopyButton disabled={false} move={mode === "copy-and-move"} onStop={onCancelMeasure} />
      )}
      {stage === "setup" &&
        (pending ? (
          <Button disabled={busy} onClick={() => onResume(pending)}>
            Check the copy again
          </Button>
        ) : (
          <SetupActions
            disabled={busy || setupBlocked}
            hint={machine ? null : "Choose a machine above."}
            label={`${mode === "copy-and-move" ? "Move" : "Copy"}${machine ? ` to ${targetLabel}` : ""}`}
            onStart={onMeasure}
          />
        ))}
      {stage === "select" && (
        <Button disabled={busy || sourceChanged || selection.length === 0} onClick={onPlan}>
          {auto ? `Copy to ${targetLabel}` : `Preview on ${targetLabel}`}
        </Button>
      )}
      {/* While comparing, the run is busy: Stop copy waits for the compare to settle. */}
      {(stage === "select" || stage === "planning") && (
        <StopCopyButton disabled={busy} move={mode === "copy-and-move"} onStop={onStop} />
      )}
      {stage === "preview" && copy && (
        <>
          {replaced ? (
            <>
              <Button
                disabled={
                  busy ||
                  sourceChanged ||
                  !!copy.disk ||
                  (copy.totals?.decisionsNeeded ?? 1) > 0 ||
                  secretsUnconfirmed
                }
                onClick={onApply}
              >
                Copy with my choices
              </Button>
              <Button
                variant="outline"
                disabled={busy || sourceChanged || !!copy.disk || secretsUnconfirmed}
                onClick={onReplaceAll}
              >
                Replace everything
              </Button>
            </>
          ) : (
            <Button
              disabled={
                busy ||
                sourceChanged ||
                (copy.totals?.decisionsNeeded ?? 1) > 0 ||
                secretsUnconfirmed
              }
              onClick={onApply}
            >
              {approveLabel}
            </Button>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  data-leading
                  aria-description="Stops this copy and goes back"
                  disabled={busy}
                  onClick={onChangeSetup}
                />
              }
            >
              Change setup
            </TooltipTrigger>
            <TooltipPopup>Stops this copy and goes back</TooltipPopup>
          </Tooltip>
        </>
      )}
      {stage === "copying" && copy && copy.state !== "applying" && copy.state !== "applied" && (
        <StopCopyButton disabled={working} move={mode === "copy-and-move"} onStop={onStop} />
      )}
      {stage === "failed" && copy && (
        <HandoffCopyFailedActions
          copy={copy}
          busy={busy}
          failedBeforeApply={failedBeforeApply}
          undoPreview={undoPreview}
          onCopyAgain={onCopyAgain}
          onRetry={onRetry}
          onCancel={onStop}
          onUndo={onUndo}
          onEndSourceHold={onEndSourceHold}
          sourceDropped={sourceDropped}
        />
      )}
      {stage === "done" && copy && copy.projectId && machine && (
        <HandoffCopyDoneActions
          copy={copy}
          mode={mode}
          busy={busy}
          targetLabel={targetLabel}
          copyAgain={copyAgain}
          canCopyAgain={pending !== null}
          canTransfer={mode === "copy-and-move" && !contextTransferred}
          canUndo={mode === "copy-only" && pending !== null}
          undoPreview={undoPreview}
          linkReview={mode === "copy-only" && link?.status === "review"}
          startNewLocked={transferRecovery}
          onCopyAgain={onCopyAgain}
          onTransfer={onTransfer}
          onOpen={onOpen}
          onUndo={onUndo}
          onLink={onLink}
          onStartNew={onStartNew}
        />
      )}
      {/* Starting the coordinator must finish here; the footer says so instead of going blank. */}
      {stage === "moving" && (
        <p
          className="min-w-0 flex-1 self-center text-sm text-muted-foreground"
          data-slot="copy-moving-hint"
        >
          This takes a few seconds. Keep this window open until it starts.
        </p>
      )}
      {stage === "undone" && (
        <Button variant="outline" onClick={onStartNew}>
          Start a new copy
        </Button>
      )}
    </HandoffCopyActions>
  );
}
