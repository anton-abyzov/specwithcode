import { ORCHESTRATION_V2_WORKSPACE_MISSING_FAILURE_CODE } from "@specweave-studio/contracts";
import { THREAD_LIFECYCLE_LABELS } from "@specweave-studio/shared/threadLifecycleLabels";
import { useState } from "react";
import { Button } from "../ui/button";

/** What a recovery action did, in a sentence for the user. */
export interface WorkspaceRecoveryOutcome {
  readonly ok: boolean;
  readonly message: string | null;
}

export interface WorkspaceMissingRecoveryActions {
  /** The thread these actions change; with the failure, it keys their state. */
  threadId: string;
  /** Only the failed latest run's root failure owns these actions. */
  failureItemId: string | null;
  /** `workspace_missing` or `workspace_branch_missing`. */
  code: string;
  branch: string | null;
  /** The project's main folder, where "Use the project folder" runs the thread. */
  projectFolder: string | null;
  /** Recreates the folder from `branch`. Omitted without source control access. */
  onRecreate?: (() => Promise<WorkspaceRecoveryOutcome>) | undefined;
  onUseProjectFolder?: (() => Promise<WorkspaceRecoveryOutcome>) | undefined;
  /** Omitted when the server cannot resolve threads. */
  onResolve?: (() => Promise<WorkspaceRecoveryOutcome>) | undefined;
}

function folderName(folder: string): string {
  return folder.split(/[\\/]/u).filter(Boolean).at(-1) ?? folder;
}

/**
 * The ways out of a thread whose folder was deleted outside the app: recreate
 * it from the thread's branch, run the thread in the project's main folder,
 * or resolve the thread. Another model fails the same way, so none is offered.
 */
export function WorkspaceMissingRecovery({
  recovery,
}: {
  recovery?: WorkspaceMissingRecoveryActions | undefined;
}) {
  if (!recovery) return null;
  // ChatView stays mounted across threads: a new thread or failure starts
  // fresh, and an action still running for the old one reports nowhere.
  return (
    <WorkspaceMissingRecoveryButtons
      key={`${recovery.threadId}\u0000${recovery.failureItemId ?? ""}`}
      recovery={recovery}
    />
  );
}

function WorkspaceMissingRecoveryButtons({
  recovery,
}: {
  recovery: WorkspaceMissingRecoveryActions;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<WorkspaceRecoveryOutcome | null>(null);
  const { branch, projectFolder } = recovery;
  const canRecreate =
    recovery.code === ORCHESTRATION_V2_WORKSPACE_MISSING_FAILURE_CODE &&
    branch !== null &&
    recovery.onRecreate !== undefined;
  const canUseProjectFolder = projectFolder !== null && recovery.onUseProjectFolder !== undefined;
  const run = (action: () => Promise<WorkspaceRecoveryOutcome>) => {
    setBusy(true);
    setOutcome(null);
    void action()
      .catch((): WorkspaceRecoveryOutcome => ({ ok: false, message: "Something went wrong." }))
      .then((next) => {
        setOutcome(next);
        setBusy(false);
      });
  };
  const done = outcome?.ok === true;
  if (!done && !canRecreate && !canUseProjectFolder && recovery.onResolve === undefined) {
    return null;
  }
  return (
    <div className="space-y-2" data-workspace-missing-recovery>
      {done ? null : (
        <div className="flex flex-wrap gap-2">
          {canRecreate ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => run(recovery.onRecreate!)}
            >
              {`Recreate folder from ${branch}`}
            </Button>
          ) : null}
          {canUseProjectFolder ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy}
              title={`Run this thread in the project's main folder, ${folderName(projectFolder)} (${projectFolder}).`}
              onClick={() => run(recovery.onUseProjectFolder!)}
            >
              Use the project folder
            </Button>
          ) : null}
          {recovery.onResolve ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => run(recovery.onResolve!)}
            >
              {THREAD_LIFECYCLE_LABELS.resolveThread}
            </Button>
          ) : null}
        </div>
      )}
      {outcome?.message ? (
        <p
          role="status"
          className={done ? "text-sm text-muted-foreground" : "text-sm text-destructive-foreground"}
        >
          {outcome.message}
        </p>
      ) : null}
    </div>
  );
}
