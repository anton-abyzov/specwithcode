import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { isWorkspaceMissingFailureCode } from "@specweave-studio/shared/orchestrationV2ThreadError";
import { useMemo } from "react";

import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { vcsEnvironment } from "../../state/vcs";
import type {
  WorkspaceMissingRecoveryActions,
  WorkspaceRecoveryOutcome,
} from "./WorkspaceMissingRecovery";

const SEND_AGAIN = "Send your message again.";

function failureText(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Something went wrong.";
}

/** Null for a cancelled command, which needs no message. */
function failedOutcome(
  result: AtomCommandResult<unknown, unknown>,
): WorkspaceRecoveryOutcome | null {
  if (result._tag !== "Failure") return null;
  return { ok: false, message: isAtomCommandInterrupted(result) ? null : failureText(result) };
}

/**
 * The recovery actions for a run that failed because the thread's folder is
 * gone. Undefined for any other failure, or when the thread can't be changed
 * from this connection. A repair releases the held queue; the failed message
 * itself never reached a provider, so the user sends it again.
 */
export function useWorkspaceMissingRecovery(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  /** From the failed latest run's root failure; null when the thread has none. */
  readonly failureItemId: string | null;
  readonly failureCode: string | null;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly projectFolder: string | null;
  /** The thread can be changed (orchestration operate) and its failure is current. */
  readonly enabled: boolean;
  readonly canWriteSourceControl: boolean;
  /** The composer's own resolve, with its stop-first confirmation; null when unsupported. */
  readonly resolveThread: (() => Promise<AtomCommandResult<unknown, unknown>>) | null;
  /**
   * Releases the thread's held queue through the composer's model check, so
   * queued requests never run on a model other than their own. May throw
   * with a sentence for the user.
   */
  readonly resumeHeldQueue: (threadId: ThreadId) => Promise<AtomCommandResult<unknown, unknown>>;
}): WorkspaceMissingRecoveryActions | undefined {
  const restoreWorkspace = useAtomCommand(vcsEnvironment.restoreThreadWorkspace, {
    reportFailure: false,
  });
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const {
    environmentId,
    threadId,
    failureItemId,
    failureCode,
    worktreePath,
    branch,
    projectFolder,
    enabled,
    canWriteSourceControl,
    resolveThread,
    resumeHeldQueue: resumeQueue,
  } = input;
  return useMemo(() => {
    if (!enabled || threadId === null || failureCode === null) return undefined;
    if (!isWorkspaceMissingFailureCode(failureCode)) return undefined;
    const resumeHeldQueue = async (note: string): Promise<WorkspaceRecoveryOutcome> => {
      try {
        const resumed = await resumeQueue(threadId);
        return failedOutcome(resumed) ?? { ok: true, message: note };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Could not resume the queue.",
        };
      }
    };
    return {
      threadId,
      failureItemId,
      code: failureCode,
      branch,
      projectFolder,
      ...(canWriteSourceControl && worktreePath !== null && branch !== null
        ? {
            onRecreate: async () => {
              const result = await restoreWorkspace({ environmentId, input: { threadId } });
              if (result._tag !== "Success") {
                return failedOutcome(result) ?? { ok: false, message: null };
              }
              const { status, message } = result.value;
              if (status !== "restored" && status !== "already-present") {
                return { ok: false, message };
              }
              return resumeHeldQueue(`Folder restored. ${SEND_AGAIN}`);
            },
          }
        : {}),
      ...(worktreePath !== null && projectFolder !== null
        ? {
            onUseProjectFolder: async () => {
              // Compare-and-set: refused if the folder changed meanwhile. The
              // branch stays as it was; only where the thread runs changes.
              const result = await updateMetadata({
                environmentId,
                input: { threadId, worktreePath: null, expectedWorktreePath: worktreePath },
              });
              return (
                failedOutcome(result) ??
                resumeHeldQueue(`Now runs in the project folder. ${SEND_AGAIN}`)
              );
            },
          }
        : {}),
      ...(resolveThread !== null
        ? {
            onResolve: async () => {
              const result = await resolveThread();
              return failedOutcome(result) ?? { ok: true, message: "Thread resolved." };
            },
          }
        : {}),
    } satisfies WorkspaceMissingRecoveryActions;
  }, [
    enabled,
    threadId,
    failureItemId,
    failureCode,
    worktreePath,
    branch,
    projectFolder,
    canWriteSourceControl,
    resolveThread,
    environmentId,
    restoreWorkspace,
    updateMetadata,
    resumeQueue,
  ]);
}
