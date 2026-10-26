import { RotateCcwIcon } from "lucide-react";
import { Button } from "../ui/button";
import type { WorkspaceMissingRecoveryActions } from "./WorkspaceMissingRecovery";

export interface FailureRecoveryActions {
  /** The failed latest run's root failure; only its row offers recovery. */
  failureItemId?: string | null;
  /** The run a Continue resumes; only that run's failure offers Continue. */
  continueRunId?: string | null;
  onContinue?: (() => void) | undefined;
  continueBusy?: boolean;
  /** Opens the composer's model picker, so the next message runs elsewhere. */
  onSwitchModel?: (() => void) | undefined;
  /** The code on that failure, when it has one. */
  failureCode?: string | null;
  /** Set when that failure is a missing thread folder; it replaces these actions. */
  workspaceMissing?: WorkspaceMissingRecoveryActions | undefined;
}

/**
 * The ways out of a failed turn: Continue it where it stopped, or pick another
 * model or provider for the next message. Callers pass the composer's own
 * resume and picker actions, so nothing here sends or spends on its own.
 */
export function FailureRecovery({
  recovery,
  itemId,
  runId,
  allowContinue = true,
}: {
  recovery?: FailureRecoveryActions | undefined;
  itemId: string;
  runId: string | null;
  /** False for failures whose own recovery says Continue would fail again. */
  allowContinue?: boolean;
}) {
  if (!recovery || recovery.failureItemId !== itemId) return null;
  const showContinue =
    allowContinue &&
    recovery.onContinue !== undefined &&
    runId !== null &&
    recovery.continueRunId === runId;
  const showSwitch = recovery.onSwitchModel !== undefined;
  if (!showContinue && !showSwitch) return null;
  return (
    <div className="flex flex-wrap gap-2" data-failure-recovery>
      {showContinue ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={recovery.continueBusy}
          onClick={recovery.onContinue}
        >
          <RotateCcwIcon aria-hidden />
          Continue
        </Button>
      ) : null}
      {showSwitch ? (
        <Button type="button" size="xs" variant="outline" onClick={recovery.onSwitchModel}>
          Switch model
        </Button>
      ) : null}
    </div>
  );
}
