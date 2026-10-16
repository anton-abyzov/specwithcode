/**
 * Runs a composer's app commands (`/stop`, `/continue`, `/stop-all`,
 * `/continue-all`, `/status`) locally, with no model turn.
 */
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { readThreadShells } from "../state/entities";
import {
  bulkStatusSummary,
  bulkThreadTargets,
  interruptedRunId,
  threadIsRunning,
} from "./bulkThreadControl";
import type { ComposerAppCommand } from "./composerAppCommands";
import { useBulkThreadControl } from "./useBulkThreadControl";

export interface ComposerAppCommandScope {
  /** The thread the composer writes to; `/stop` and `/continue` act on it. */
  readonly thread: EnvironmentThreadShell | null;
  /**
   * The project's threads at the time of the command. Defaults to the live
   * shells in the thread's environment and project.
   */
  readonly projectThreads?: () => ReadonlyArray<EnvironmentThreadShell>;
  /** The composer's own Stop, when it has one with more to do than a plain interrupt. */
  readonly stopSelf?: () => void | Promise<void>;
  /** The composer's own Continue, when it has one with more to do than a plain continue. */
  readonly continueSelf?: () => void | Promise<void>;
}

function notice(title: string, description?: string) {
  toastManager.add({ type: "info", title, ...(description ? { description } : {}) });
}

export function useComposerAppCommands(scope: ComposerAppCommandScope) {
  const { stopThread, stopAll, continueAll } = useBulkThreadControl();
  const { thread, projectThreads, stopSelf, continueSelf } = scope;
  return useCallback(
    async (command: ComposerAppCommand) => {
      const threads = () =>
        projectThreads?.() ??
        (thread === null
          ? []
          : readThreadShells().filter(
              (candidate) =>
                candidate.environmentId === thread.environmentId &&
                candidate.projectId === thread.projectId,
            ));
      // The person asked for all of the project's threads, this one included.
      switch (command) {
        case "stop": {
          if (thread === null || !threadIsRunning(thread)) {
            notice("Nothing is running in this thread.");
            return;
          }
          if (stopSelf) await stopSelf();
          else await stopThread(thread);
          return;
        }
        case "continue": {
          const runId = thread === null ? null : interruptedRunId(thread);
          if (thread === null || runId === null) {
            notice("This thread has no stopped turn to continue.");
            return;
          }
          if (continueSelf) await continueSelf();
          else await continueAll([{ ...thread, resumeRunId: runId }]);
          return;
        }
        case "stop-all": {
          const { running } = bulkThreadTargets(threads());
          if (running.length === 0) {
            notice("No thread in this project is running.");
            return;
          }
          await stopAll(running);
          return;
        }
        case "continue-all": {
          const { interrupted } = bulkThreadTargets(threads());
          if (interrupted.length === 0) {
            notice("No thread in this project is interrupted.");
            return;
          }
          await continueAll(interrupted);
          return;
        }
        case "status": {
          notice("Project threads", bulkStatusSummary(bulkThreadTargets(threads())));
          return;
        }
      }
    },
    [stopThread, stopAll, continueAll, thread, projectThreads, stopSelf, continueSelf],
  );
}
