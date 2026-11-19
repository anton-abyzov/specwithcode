import { useTx } from "../../i18n";
import { RotateCcwIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  BackgroundWorkBlockRecovery,
  isBackgroundWorkBlockFailureCode,
  type BackgroundWorkBlockRecoveryActions,
} from "./BackgroundWorkBlockRecovery";
import type { WorkspaceMissingRecoveryActions } from "./WorkspaceMissingRecovery";

/**
 * The provider refused its own sign-in on the thread's machine: another model
 * on that sign-in fails the same way, so signing in again comes first.
 */
export interface SignInRecoveryActions {
  /** The provider's name, such as Codex. */
  readonly provider: string;
  /** The machine whose sign-in expired, when it has a name. */
  readonly machine: string | null;
  /** Opens that provider's sign-in on that machine. */
  readonly onSignIn: () => void;
}

/** "Codex sign-in expired on M5", for the banner title and the timeline row. */
export function signInRecoveryTitle(
  tx: ReturnType<typeof useTx>,
  recovery: Pick<SignInRecoveryActions, "provider" | "machine">,
): string {
  return recovery.machine
    ? tx("{provider} sign-in expired on {machine}", {
        provider: recovery.provider,
        machine: recovery.machine,
      })
    : tx("{provider} sign-in expired", { provider: recovery.provider });
}

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
  /**
   * Set when that failure is a start background work refused and the work
   * still runs; it replaces these actions.
   */
  backgroundWorkBlock?: BackgroundWorkBlockRecoveryActions | undefined;
  /** Set when that failure is an expired sign-in; Sign in again leads. */
  signIn?: SignInRecoveryActions | undefined;
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
  const tx = useTx();
  if (!recovery || recovery.failureItemId !== itemId) return null;
  if (recovery.backgroundWorkBlock !== undefined) {
    return (
      <div className="flex flex-wrap gap-2" data-failure-recovery>
        <BackgroundWorkBlockRecovery recovery={recovery.backgroundWorkBlock} />
      </div>
    );
  }
  const showContinue =
    allowContinue &&
    recovery.onContinue !== undefined &&
    runId !== null &&
    recovery.continueRunId === runId;
  // Another model would be refused the same way while the work runs.
  const showSwitch =
    recovery.onSwitchModel !== undefined && !isBackgroundWorkBlockFailureCode(recovery.failureCode);
  const signIn = recovery.signIn;
  if (!showContinue && !showSwitch && !signIn) return null;
  return (
    <div className="flex flex-wrap gap-2" data-failure-recovery>
      {signIn ? (
        <Button
          type="button"
          size="xs"
          variant="default"
          title={signInRecoveryTitle(tx, signIn)}
          onClick={signIn.onSignIn}
        >
          {tx("Sign in again")}
        </Button>
      ) : null}
      {showContinue ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={recovery.continueBusy}
          onClick={recovery.onContinue}
        >
          <RotateCcwIcon aria-hidden />
          {tx("Continue")}
        </Button>
      ) : null}
      {showSwitch ? (
        <Button type="button" size="xs" variant="outline" onClick={recovery.onSwitchModel}>
          {tx("Switch model")}
        </Button>
      ) : null}
    </div>
  );
}
