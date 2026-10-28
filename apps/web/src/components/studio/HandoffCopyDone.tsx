import type { ReactNode } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type {
  EnvironmentId,
  FolderCopyMode,
  FolderCopyStatus,
  FolderCopyUndoResult,
  ProjectId,
} from "@specweave-studio/contracts";
import type { CopyLinkOutcome } from "../../studio/projectLink";
import { copiedProjectFolder } from "../../studio/folderCopy";
import { EllipsisIcon } from "lucide-react";
import { MachineReadinessChecklist } from "../settings/MachineReadinessChecklist";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { checkLabel, copyProblem } from "./handoffCopyNotices";
import { CopyUndoPreview } from "./HandoffCopyPreview";
import { ProjectLinkDialog } from "./ProjectLinkDialog";
import { useProjectMoveDialog } from "./ProjectMoveOptions";

/** Paths listed for files that changed on the source while copying; the rest are counted. */
const UNSTABLE_SHOWN = 20;

/** What a finished copy left on the destination, its link, secrets, checks and Undo. */
export function HandoffCopyDone({
  project,
  copy,
  projectId,
  machine,
  mode,
  contextTransferred,
  targetLabel,
  sourceLabel,
  transferNotice,
  movingAnyway = false,
  copyAgain = false,
  secretsNote = null,
  link,
  undoPreview,
  linkDialog,
  onLinkDialogClose,
  onLinked,
}: {
  readonly project: EnvironmentProject;
  readonly copy: FolderCopyStatus;
  readonly projectId: ProjectId;
  readonly machine: EnvironmentId;
  readonly mode: FolderCopyMode;
  readonly contextTransferred: boolean;
  readonly targetLabel: string;
  readonly sourceLabel: string;
  readonly transferNotice: string | null;
  /** The person chose Move anyway: context transfers with the differences listed. */
  readonly movingAnyway?: boolean;
  /** Copy again is offered; its advice is never shown without the button. */
  readonly copyAgain?: boolean;
  /** Secret-like files that stayed on the source, said once the copy is done. */
  readonly secretsNote?: string | null;
  readonly link: CopyLinkOutcome | { readonly status: "linking" } | null;
  readonly undoPreview: FolderCopyUndoResult | null;
  readonly linkDialog: boolean;
  readonly onLinkDialogClose: () => void;
  readonly onLinked: () => void;
}) {
  const problem = copyProblem(copy, sourceLabel);
  // Inside the dialog its title says it; standalone, the panel does.
  const titled = useProjectMoveDialog() !== null;
  const moved = mode === "copy-and-move" && contextTransferred;
  return (
    <div className="space-y-3 text-sm" data-slot="copy-done">
      {!titled && (
        <p className="text-base font-medium wrap-anywhere" data-slot="copy-done-title">
          {project.title} is on {targetLabel}
        </p>
      )}
      {problem && (
        <CopyProblems copy={copy} sourceLabel={sourceLabel}>
          {movingAnyway
            ? `The files are on ${targetLabel}, but ${problem}. You chose Move anyway, so the coordinator ${contextTransferred ? "moved" : "moves"} with these differences.`
            : copyAgain
              ? `The files are on ${targetLabel}, but ${problem}. Copy again: it compares first and moves only what changed.`
              : `The files are on ${targetLabel}, but ${problem}.`}
        </CopyProblems>
      )}
      <div className="space-y-1" data-slot="copy-done-body">
        <p role="status">
          {moved
            ? `The coordinator now runs on ${targetLabel}.`
            : mode === "copy-and-move"
              ? copyAgain
                ? "The coordinator stays here until you copy again."
                : "Files are copied. Move the coordinator once work here is idle."
              : `${targetLabel} has a copy. The coordinator stays here.`}
        </p>
        <p className="text-xs text-muted-foreground wrap-anywhere">
          In{" "}
          <span className="font-mono">
            {moved
              ? (copy.projectFolder ??
                copiedProjectFolder(copy.targetFolder, copy.projectRelativePath))
              : copy.targetFolder}
          </span>
        </p>
      </div>
      {transferNotice && (
        <p role="status" className="text-xs text-warning-foreground">
          {transferNotice}
        </p>
      )}
      {secretsNote && (
        <p className="text-xs text-warning-foreground" data-slot="copy-secrets-left">
          {secretsNote}
        </p>
      )}
      {mode === "copy-only" && link && (
        <p
          className="text-muted-foreground text-xs wrap-anywhere"
          role={link.status === "review" ? "alert" : "status"}
          data-slot="copy-link"
        >
          {link.status === "linking"
            ? `Linking the copy on ${targetLabel} to ${sourceLabel}…`
            : link.status === "linked"
              ? `Linked: ${sourceLabel} can send work to the copy on ${targetLabel}.`
              : `Not linked yet. ${link.reason}`}
        </p>
      )}
      {copy.secrets && copy.secrets.length > 0 && (
        <ul className="space-y-1 text-xs" aria-label="Secret files sent">
          {copy.secrets.map((secret) => (
            <li key={secret.path} className="wrap-anywhere">
              <span className="font-mono">{secret.writtenAs}</span>
              {secret.state === "beside"
                ? ` was written beside ${secret.path}, which differs on ${targetLabel}.`
                : secret.state === "unchanged"
                  ? " was already the same."
                  : " is in place, readable only by you."}
            </li>
          ))}
        </ul>
      )}
      {undoPreview && <CopyUndoPreview result={undoPreview} />}
      <MachineReadinessChecklist
        environmentId={machine}
        environmentLabel={targetLabel}
        projectId={projectId}
      />
      {mode === "copy-only" && copy.backupsDiscardedAt !== undefined && (
        <p className="text-muted-foreground text-xs">
          The backups from this copy were removed after 14 days, so it can no longer be undone.
        </p>
      )}
      {linkDialog && (
        <ProjectLinkDialog
          open
          onOpenChange={(open) => !open && onLinkDialogClose()}
          project={project}
          initialCandidate={{ environmentId: machine, projectId }}
          initialKept="here"
          autoReview
          onLinked={onLinked}
        />
      )}
    </div>
  );
}

/**
 * Files that changed on the source while copying and the failed checks, under a lead
 * sentence that says what they mean for this copy.
 */
function CopyProblems({
  copy,
  sourceLabel,
  detail = null,
  children,
}: {
  readonly copy: FolderCopyStatus;
  readonly sourceLabel: string;
  /** The destination's own words for the hold, shown as they came. */
  readonly detail?: string | null;
  readonly children: ReactNode;
}) {
  const failing = copy.checks.filter((check) => !check.ok);
  return (
    <div
      className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3"
      data-slot="copy-problems"
    >
      <p role="alert" className="font-medium text-warning-foreground">
        {children}
      </p>
      {detail && (
        <p className="text-xs wrap-anywhere" data-slot="copy-server-message">
          {detail}
        </p>
      )}
      {copy.unstable.length > 0 && (
        <div className="space-y-1 text-xs">
          <p>Changed on {sourceLabel} while copying:</p>
          <ul className="list-disc space-y-0.5 pl-4 font-mono" aria-label="Changed while copying">
            {copy.unstable.slice(0, UNSTABLE_SHOWN).map((path) => (
              <li key={path} className="wrap-anywhere">
                {path}
              </li>
            ))}
          </ul>
          {copy.unstable.length > UNSTABLE_SHOWN && (
            <p className="text-muted-foreground">
              and {(copy.unstable.length - UNSTABLE_SHOWN).toLocaleString()} more.
            </p>
          )}
        </div>
      )}
      {failing.map((check) => (
        <div key={check.repo} className="space-y-1 text-xs" data-slot="copy-check-failed">
          <p className="font-medium wrap-anywhere">{checkLabel(check.repo)}</p>
          <ul
            className="list-disc space-y-0.5 pl-4"
            aria-label={`Problems in ${checkLabel(check.repo)}`}
          >
            {check.problems.map((line, index) => (
              <li key={`${index}:${line}`} className="wrap-anywhere">
                {line}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * A copy-and-move the destination held after Apply because files changed on the source or
 * a check failed: nothing is committed and the coordinator stayed on the source.
 */
export const copyHeld = (copy: FolderCopyStatus | null): boolean =>
  copy !== null &&
  !copy.undoIncomplete &&
  copy.state === "failed" &&
  copy.failedStep === "applied" &&
  copy.error?.code === "checks_failed";

/** What a held move left: the differences, that the coordinator stayed, and Undo's preview. */
function HandoffCopyHeld({
  copy,
  sourceLabel,
  targetLabel,
  undoPreview,
}: {
  readonly copy: FolderCopyStatus;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly undoPreview: FolderCopyUndoResult | null;
}) {
  const problem = copyProblem(copy, sourceLabel);
  return (
    <div className="space-y-3 text-sm" data-slot="copy-held">
      <CopyProblems
        copy={copy}
        sourceLabel={sourceLabel}
        detail={problem ? (copy.error?.message ?? null) : null}
      >
        {problem
          ? `The files are on ${targetLabel}, but ${problem}, so the coordinator stayed here.`
          : (copy.error?.message ??
            `The files are on ${targetLabel}, but the coordinator stayed here.`)}
      </CopyProblems>
      {undoPreview && <CopyUndoPreview result={undoPreview} />}
    </div>
  );
}

/**
 * An undone or cancelled copy. The destination's error says what is still open on the
 * source; `sourceDropped` says the source has since dropped it after all.
 */
export function HandoffCopyUndone({
  copy,
  sourceLabel,
  sourceDropped,
}: {
  readonly copy: FolderCopyStatus | null;
  readonly sourceLabel: string;
  readonly sourceDropped: boolean;
}) {
  const error = copy?.state === "undone" ? copy.error?.message : undefined;
  return (
    <div className="space-y-2 text-sm" data-slot="copy-undone">
      <p role="status" className="wrap-anywhere">
        {error ??
          (copy?.state === "undone"
            ? `${copy.targetFolder} is back to how it was before the copy.`
            : "The copy was cancelled.")}
      </p>
      {error && sourceDropped && (
        <p className="text-xs text-muted-foreground">{sourceLabel} has now dropped the copy.</p>
      )}
    </div>
  );
}

/**
 * Undo with a preview first, as the footer's leading ghost; the second click undoes,
 * moving edited files aside if any.
 */
function CopyUndoButton({
  busy,
  undoPreview,
  onUndo,
}: {
  readonly busy: boolean;
  readonly undoPreview: FolderCopyUndoResult | null;
  readonly onUndo: (force: boolean, previewOnly: boolean) => void;
}) {
  return undoPreview ? (
    <Button
      variant="outline"
      data-leading
      disabled={busy}
      onClick={() => onUndo(undoPreview.edited > 0, false)}
    >
      {undoPreview.edited > 0 ? "Undo and keep edited files aside" : "Undo the copy"}
    </Button>
  ) : (
    <Button variant="ghost" data-leading disabled={busy} onClick={() => onUndo(false, true)}>
      Undo…
    </Button>
  );
}

/** A held move's buttons: Copy again leads; Move anyway commits and moves as it is. */
function HandoffCopyHeldActions({
  copy,
  busy,
  undoPreview,
  onCopyAgain,
  onMoveAnyway,
  onUndo,
}: {
  readonly copy: FolderCopyStatus;
  readonly busy: boolean;
  readonly undoPreview: FolderCopyUndoResult | null;
  readonly onCopyAgain: () => void;
  readonly onMoveAnyway: () => void;
  readonly onUndo: (force: boolean, previewOnly: boolean) => void;
}) {
  return (
    <>
      <Button disabled={busy} onClick={onCopyAgain}>
        Copy again
      </Button>
      <Button variant="outline" disabled={busy} onClick={onMoveAnyway}>
        Move anyway
      </Button>
      {copy.backupsDiscardedAt === undefined && (
        <CopyUndoButton busy={busy} undoPreview={undoPreview} onUndo={onUndo} />
      )}
    </>
  );
}

/** A copy that stopped: a held move shows its differences, anything else says why. */
export function HandoffCopyFailed({
  copy,
  sourceLabel,
  targetLabel,
  failedBeforeApply,
  undoPreview,
}: {
  readonly copy: FolderCopyStatus;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly failedBeforeApply: boolean;
  readonly undoPreview: FolderCopyUndoResult | null;
}) {
  if (copyHeld(copy))
    return (
      <HandoffCopyHeld
        copy={copy}
        sourceLabel={sourceLabel}
        targetLabel={targetLabel}
        undoPreview={undoPreview}
      />
    );
  return (
    <div className="space-y-2 text-sm">
      <p role="alert" className="wrap-anywhere text-destructive-foreground">
        {copy.state === "applied"
          ? `The files are on ${targetLabel}, but the coordinator did not start there.`
          : (copy.error?.message ?? "The copy stopped.")}
        {failedBeforeApply ? ` Nothing in ${copy.targetFolder} changed.` : ""}
      </p>
      {copy.undoIncomplete && (
        <p>
          Retry Undo to finish restoring this folder.{" "}
          {!copy.committed && "Ending the source hold keeps Undo recovery available here."}
        </p>
      )}
    </div>
  );
}

/** A stopped copy's buttons: a held move's choices, otherwise Retry and, before Apply, Stop copy. */
export function HandoffCopyFailedActions({
  copy,
  busy,
  failedBeforeApply,
  undoPreview,
  onCopyAgain,
  onRetry,
  onCancel,
  onUndo,
  onEndSourceHold,
  sourceDropped = false,
}: {
  readonly copy: FolderCopyStatus;
  readonly busy: boolean;
  readonly failedBeforeApply: boolean;
  readonly undoPreview: FolderCopyUndoResult | null;
  readonly onCopyAgain: () => void;
  readonly onRetry: () => void;
  readonly onCancel: () => void;
  readonly onUndo: (force: boolean, previewOnly: boolean) => void;
  readonly onEndSourceHold: () => void;
  readonly sourceDropped?: boolean;
}) {
  if (copy.undoIncomplete)
    return (
      <>
        <CopyUndoButton busy={busy} undoPreview={undoPreview} onUndo={onUndo} />
        {!copy.committed && !sourceDropped && (
          <Button variant="outline" disabled={busy} onClick={onEndSourceHold}>
            End source hold
          </Button>
        )}
        {sourceDropped && (
          <p role="status">The source hold ended. Undo recovery remains available here.</p>
        )}
      </>
    );
  if (copyHeld(copy))
    return (
      <HandoffCopyHeldActions
        copy={copy}
        busy={busy}
        undoPreview={undoPreview}
        onCopyAgain={onCopyAgain}
        onMoveAnyway={onRetry}
        onUndo={onUndo}
      />
    );
  return (
    <>
      <Button disabled={busy} onClick={onRetry}>
        Retry
      </Button>
      {failedBeforeApply && (
        <Button variant="ghost" data-leading disabled={busy} onClick={onCancel}>
          Stop copy
        </Button>
      )}
    </>
  );
}

/**
 * The finished copy's buttons: Open on {machine} leads, unless Copy again (files changed
 * while copying or a check failed) or moving the coordinator comes first. Undo… sits left;
 * the ⋯ menu holds the rest.
 */
export function HandoffCopyDoneActions({
  copy,
  mode,
  busy,
  targetLabel,
  copyAgain,
  canCopyAgain,
  canTransfer,
  canUndo,
  undoPreview,
  linkReview,
  startNewLocked,
  onCopyAgain,
  onTransfer,
  onOpen,
  onUndo,
  onLink,
  onStartNew,
}: {
  readonly copy: FolderCopyStatus;
  readonly mode: FolderCopyMode;
  readonly busy: boolean;
  readonly targetLabel: string;
  /** Copy again is the answer: files changed while copying or a check failed. */
  readonly copyAgain: boolean;
  /** A pointer is left to copy again from. */
  readonly canCopyAgain: boolean;
  /** A move whose coordinator has not moved yet. */
  readonly canTransfer: boolean;
  readonly canUndo: boolean;
  readonly undoPreview: FolderCopyUndoResult | null;
  readonly linkReview: boolean;
  /** A coordinator transfer may need recovering: nothing may release the source. */
  readonly startNewLocked: boolean;
  readonly onCopyAgain: () => void;
  /** Null when no pointer is left to move from. */
  readonly onTransfer: (() => void) | null;
  readonly onOpen: () => void;
  readonly onUndo: (force: boolean, previewOnly: boolean) => void;
  readonly onLink: () => void;
  readonly onStartNew: () => void;
}) {
  const transfer = canTransfer && !copyAgain && onTransfer !== null;
  return (
    <>
      {copyAgain && (
        <Button disabled={busy} onClick={onCopyAgain}>
          Copy again
        </Button>
      )}
      {transfer && (
        <Button disabled={busy} onClick={onTransfer}>
          Move coordinator now
        </Button>
      )}
      <Button variant={copyAgain || transfer ? "outline" : "default"} onClick={onOpen}>
        Open on {targetLabel}
      </Button>
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost" size="icon" aria-label="More actions" disabled={busy} />}
        >
          <EllipsisIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end">
          {!copyAgain && canCopyAgain && (
            // Copying again releases the source like a new copy, so the same lock holds it.
            <MenuItem disabled={startNewLocked} onClick={onCopyAgain}>
              Copy again
            </MenuItem>
          )}
          {mode === "copy-only" && linkReview && <MenuItem onClick={onLink}>Link…</MenuItem>}
          <MenuItem disabled={startNewLocked} onClick={onStartNew}>
            Start a new copy
          </MenuItem>
        </MenuPopup>
      </Menu>
      {canUndo && copy.backupsDiscardedAt === undefined && (
        <CopyUndoButton busy={busy} undoPreview={undoPreview} onUndo={onUndo} />
      )}
    </>
  );
}
