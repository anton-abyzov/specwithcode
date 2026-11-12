import { useCallback, useEffect, useState } from "react";
import { BACKGROUND_WORK_BLOCKS_CHANGE_FAILURE_CODE } from "@specweave-studio/shared/orchestrationV2ThreadError";
import { SquareIcon } from "lucide-react";
import { useTx } from "../../i18n";
import { Button } from "../ui/button";

/** How long Continue waits for the stopped work to leave the thread's list. */
const STOP_SETTLE_TIMEOUT_MS = 8_000;

export interface BackgroundWorkBlockRecoveryActions {
  /** Stops the thread's background work, then continues the refused run. */
  onStopAndContinue: () => void;
  busy: boolean;
}

/** Whether a failure is a start refused because background work blocks a settings change. */
export const isBackgroundWorkBlockFailureCode = (code: string | null | undefined): boolean =>
  code === BACKGROUND_WORK_BLOCKS_CHANGE_FAILURE_CODE;

/**
 * The one way out of a start that background work refused, while that work
 * still runs: stop it and continue the run. Undefined for any other failure,
 * and once the work has ended, when a plain Continue does the same.
 */
export function useBackgroundWorkBlockRecovery(input: {
  /** Names the thread, so a pending continue never fires in another one. */
  threadKey: string | null;
  failureCode: string | null;
  backgroundWorkRunning: boolean;
  /** False when the run cannot continue or the viewer may not operate the thread. */
  enabled: boolean;
  stopping: boolean;
  /** Resolves true once the stop was accepted. */
  stopBackgroundWork: () => Promise<boolean>;
  continueRun: () => void;
}): BackgroundWorkBlockRecoveryActions | undefined {
  const { threadKey, backgroundWorkRunning, continueRun, stopBackgroundWork } = input;
  // The thread whose stop was accepted and whose continue is still owed.
  const [continueOwedKey, setContinueOwedKey] = useState<string | null>(null);
  const continueOwed = continueOwedKey !== null && continueOwedKey === threadKey;
  useEffect(() => {
    if (!continueOwed) return;
    const finish = () => {
      setContinueOwedKey(null);
      continueRun();
    };
    // Stop closes the provider process before the list empties; the timeout
    // covers work the list never drops.
    if (!backgroundWorkRunning) {
      finish();
      return;
    }
    const timer = window.setTimeout(finish, STOP_SETTLE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [continueOwed, backgroundWorkRunning, continueRun]);
  const onStopAndContinue = useCallback(() => {
    if (threadKey === null) return;
    void stopBackgroundWork().then((accepted) => {
      if (accepted) setContinueOwedKey(threadKey);
    });
  }, [threadKey, stopBackgroundWork]);
  if (!input.enabled || !isBackgroundWorkBlockFailureCode(input.failureCode)) return undefined;
  if (!backgroundWorkRunning && !continueOwed) return undefined;
  return { onStopAndContinue, busy: input.stopping || continueOwed };
}

export function BackgroundWorkBlockRecovery({
  recovery,
}: {
  recovery: BackgroundWorkBlockRecoveryActions;
}) {
  const tx = useTx();
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={recovery.busy}
      onClick={recovery.onStopAndContinue}
      data-background-work-block-recovery
    >
      <SquareIcon aria-hidden />
      {recovery.busy ? tx("Stopping background work…") : tx("Stop background work and continue")}
    </Button>
  );
}
