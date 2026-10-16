/**
 * "Stop all running" and "Continue all interrupted" for a project's threads,
 * each thread through the same commands as its own Stop and Continue buttons.
 */
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { isAtomCommandInterrupted } from "@specweave-studio/client-runtime/state/runtime";
import type { RunId } from "@specweave-studio/contracts";
import { useCallback, useState } from "react";

import { ensureLocalApi } from "../localApi";
import { newMessageId } from "../lib/utils";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { toastManager } from "../components/ui/toast";
import { bulkResultMessage, CONTINUE_TEXT, stopAllConfirmMessage } from "./bulkThreadControl";

type BulkThread = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "runtimeMode" | "interactionMode"
>;

export interface BulkThreadControl {
  /** Asks once with the count, then stops each thread. Resolves to whether it ran. */
  readonly stopAll: (threads: ReadonlyArray<BulkThread>) => Promise<boolean>;
  /** Stops one thread, as its Stop button does: no question asked. */
  readonly stopThread: (thread: BulkThread) => Promise<void>;
  /** Continues each thread from its interrupted run. */
  readonly continueAll: (
    threads: ReadonlyArray<BulkThread & { readonly resumeRunId: RunId }>,
  ) => Promise<void>;
  readonly busy: boolean;
}

export function useBulkThreadControl(): BulkThreadControl {
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);

  const stopThreads = useCallback(
    async (threads: ReadonlyArray<BulkThread>) => {
      setBusy(true);
      try {
        const results = await Promise.all(
          threads.map((thread) =>
            interruptTurn({
              environmentId: thread.environmentId,
              input: { threadId: thread.id },
            }),
          ),
        );
        const failed = results.filter(
          (result) => result._tag === "Failure" && !isAtomCommandInterrupted(result),
        ).length;
        toastManager.add({
          type: failed === 0 ? "success" : "warning",
          title: bulkResultMessage("Stopped", threads.length - failed, failed),
        });
      } finally {
        setBusy(false);
      }
    },
    [interruptTurn],
  );

  const stopAll = useCallback(
    async (threads: ReadonlyArray<BulkThread>) => {
      if (threads.length === 0) return false;
      const confirmed = await ensureLocalApi().dialogs.confirm(
        stopAllConfirmMessage(threads.length),
        { variant: "destructive", confirmLabel: "Stop all" },
      );
      if (!confirmed) return false;
      await stopThreads(threads);
      return true;
    },
    [stopThreads],
  );

  const stopThread = useCallback((thread: BulkThread) => stopThreads([thread]), [stopThreads]);

  const continueAll = useCallback(
    async (threads: ReadonlyArray<BulkThread & { readonly resumeRunId: RunId }>) => {
      if (threads.length === 0) return;
      setBusy(true);
      try {
        const results = await Promise.all(
          threads.map((thread) =>
            startTurn({
              environmentId: thread.environmentId,
              input: {
                threadId: thread.id,
                manualContinuationOfRunId: thread.resumeRunId,
                message: {
                  messageId: newMessageId(),
                  role: "user",
                  text: CONTINUE_TEXT,
                  attachments: [],
                },
                runtimeMode: thread.runtimeMode,
                interactionMode: thread.interactionMode,
                dispatchMode: "start",
              },
            }),
          ),
        );
        const failed = results.filter(
          (result) => result._tag === "Failure" && !isAtomCommandInterrupted(result),
        ).length;
        toastManager.add({
          type: failed === 0 ? "success" : "warning",
          title: bulkResultMessage("Continued", threads.length - failed, failed),
        });
      } finally {
        setBusy(false);
      }
    },
    [startTurn],
  );

  return { stopAll, stopThread, continueAll, busy };
}
