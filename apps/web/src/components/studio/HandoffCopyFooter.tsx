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
import { CloseOrCancelHint } from "./HandoffCopyGuide";

/**
 * Looks at the step before, never acts on the copy. It is the first button with mr-auto, so
 * it keeps the far left while the step's actions sit right.
 */
export function CopyBackButton({
  disabled,
  onBack,
}: {
  readonly disabled: boolean;
  readonly onBack: () => void;
}) {
  return (
    <Button
      variant="ghost"
      data-slot="copy-back"
      className="mr-auto"
      disabled={disabled}
      onClick={onBack}
    >
      Back
    </Button>
  );
}

/** The live stage's actions, placed by the dialog through HandoffCopyActions. */
export function HandoffCopyFooter({
  stage,
  error,
  busy,
  working,
  pending,
  copy,
  machine,
  mode,
  targetLabel,
  auto,
  chooseFirst,
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
  onTransfer,
  onOpen,
  onLink,
  onStartNew,
  onBack,
  backDisabled,
}: {
  readonly stage: CopyStage;
  readonly error: string | null;
  readonly busy: boolean;
  readonly working: boolean;
  readonly pending: PendingCopy | null;
  readonly copy: FolderCopyStatus | null;
  readonly machine: EnvironmentId | null;
  readonly mode: FolderCopyMode;
  readonly targetLabel: string;
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
  /** Null on Where, which has no step before it. */
  readonly onBack: (() => void) | null;
  readonly backDisabled: boolean;
}) {
  const cancelShown =
    stage === "scanning" ||
    (stage === "copying" && copy !== null && copy.state !== "applying" && copy.state !== "applied");
  return (
    <HandoffCopyActions>
      {error && (
        <p
          role="alert"
          className="max-h-24 basis-full overflow-y-auto wrap-anywhere text-sm text-destructive-foreground"
        >
          {error}
        </p>
      )}
      {/* First, with mr-auto: Back keeps the left edge while the step's actions sit right. */}
      {onBack && <CopyBackButton disabled={backDisabled} onBack={onBack} />}
      {cancelShown && <CloseOrCancelHint />}
      {stage === "scanning" && (
        <Button variant="outline" onClick={onCancelMeasure}>
          Cancel copy
        </Button>
      )}
      {stage === "setup" &&
        (pending ? (
          <Button disabled={busy} onClick={() => onResume(pending)}>
            Check the copy again
          </Button>
        ) : (
          <Button disabled={busy || setupBlocked} onClick={onMeasure}>
            {chooseFirst ? "Measure the folder" : `Copy to ${targetLabel}`}
          </Button>
        ))}
      {(stage === "select" || stage === "planning") && (
        <>
          <Button disabled={busy || selection.length === 0} onClick={onPlan}>
            {stage === "planning"
              ? "Comparing folders…"
              : auto
                ? `Copy to ${targetLabel}`
                : `Preview on ${targetLabel}`}
          </Button>
          <Button variant="outline" disabled={busy} onClick={onStop}>
            Cancel copy
          </Button>
        </>
      )}
      {stage === "preview" && copy && (
        <>
          {replaced ? (
            <>
              <Button disabled={busy || !!copy.disk || secretsUnconfirmed} onClick={onReplaceAll}>
                Replace all
              </Button>
              <Button
                variant="outline"
                disabled={
                  busy ||
                  !!copy.disk ||
                  (copy.totals?.decisionsNeeded ?? 1) > 0 ||
                  secretsUnconfirmed
                }
                onClick={onApply}
              >
                Copy with these choices
              </Button>
            </>
          ) : (
            <Button
              disabled={busy || (copy.totals?.decisionsNeeded ?? 1) > 0 || secretsUnconfirmed}
              onClick={onApply}
            >
              {approveLabel}
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={onStop}>
            Cancel copy
          </Button>
        </>
      )}
      {(stage === "copying" || stage === "moving") && (
        <>
          <Button disabled>
            {stage === "moving"
              ? "Transferring context…"
              : copy?.state === "applying"
                ? "Applying files…"
                : "Copying files…"}
          </Button>
          {stage === "copying" && copy && copy.state !== "applying" && copy.state !== "applied" && (
            <Button variant="outline" disabled={working} onClick={onStop}>
              Cancel copy
            </Button>
          )}
        </>
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
        />
      )}
      {stage === "done" && copy && copy.projectId && machine && (
        <HandoffCopyDoneActions
          copy={copy}
          mode={mode}
          busy={busy}
          targetLabel={targetLabel}
          copyAgain={copyAgain}
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
      {stage === "undone" && (
        <Button variant="outline" onClick={onStartNew}>
          Start a new copy
        </Button>
      )}
    </HandoffCopyActions>
  );
}
