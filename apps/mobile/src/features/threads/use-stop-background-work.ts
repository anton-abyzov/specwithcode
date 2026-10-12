import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@specweave-studio/contracts";
import { useCallback, useState } from "react";
import { Alert } from "react-native";

import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { BackgroundWorkStop } from "./background-work-status";

export const STOP_BACKGROUND_WORK_FAILED_TITLE = "Couldn't stop background work";
const STOP_BACKGROUND_WORK_FAILED_MESSAGE = "Failed to stop background work.";

/** What to tell the user about a stop request, or null when there is nothing to say. */
export function stopBackgroundWorkFailureMessage(
  result: AtomCommandResult<unknown, unknown>,
): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : STOP_BACKGROUND_WORK_FAILED_MESSAGE;
}

/**
 * Runs one stop request, marking it in flight under `key` until the interrupt settles.
 * Acceptance does not confirm termination, so the button comes back for a retry while
 * the provider finishes stopping the tasks. A rejected request is reported through
 * `onFailure`, so the returning stop button never reads as silent success.
 */
export async function runStopBackgroundWork(input: {
  readonly key: string;
  readonly interrupt: () => Promise<AtomCommandResult<unknown, unknown>>;
  readonly setStoppingKey: (update: (current: string | null) => string | null) => void;
  readonly onFailure: (message: string) => void;
}): Promise<void> {
  input.setStoppingKey(() => input.key);
  let result: AtomCommandResult<unknown, unknown>;
  try {
    result = await input.interrupt();
  } finally {
    input.setStoppingKey((current) => (current === input.key ? null : current));
  }
  const message = stopBackgroundWorkFailureMessage(result);
  if (message !== null) input.onFailure(message);
}

function alertStopFailure(message: string): void {
  Alert.alert(STOP_BACKGROUND_WORK_FAILED_TITLE, message);
}

/**
 * Stops every piece of background work a settled thread still runs. The interrupt path
 * accepts a completed run while its provider still has background work. Null when this
 * device may not operate the thread.
 */
export function useStopBackgroundWork(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): BackgroundWorkStop | null {
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const interruptThreadTurn = useAtomCommand(
    threadEnvironment.interruptTurn,
    "stop background work",
  );
  const [stoppingKey, setStoppingKey] = useState<string | null>(null);
  const key = `${environmentId}:${threadId}`;
  const stopping = stoppingKey === key;
  const onStop = useCallback(() => {
    if (stopping) return;
    void runStopBackgroundWork({
      key,
      interrupt: () => interruptThreadTurn({ environmentId, input: { threadId } }),
      setStoppingKey,
      onFailure: alertStopFailure,
    });
  }, [environmentId, interruptThreadTurn, key, stopping, threadId]);
  return canOperate ? { stopping, onStop } : null;
}
