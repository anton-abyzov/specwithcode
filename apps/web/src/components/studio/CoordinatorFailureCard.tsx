import { Check, Copy } from "lucide";
import { RotateCcwIcon, TriangleAlertIcon } from "lucide-react";

import { MorphIcon } from "~/components/MorphIcon";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

import { useClientSettings } from "../../hooks/useSettings";
import {
  coordinatorFailureResetAt,
  coordinatorFailureText,
  type CoordinatorFixAction,
} from "../../studio/coordinatorFailure";
import type { CoordinatorTurnFailure } from "../../studio/coordinatorTurnState";
import { useNowUntil } from "../chat/UsageLimitRecoveryBanner";
import { Button } from "../ui/button";

/** The one-click fix for the coordinator's provider, and how it is going. */
export interface CoordinatorFix {
  readonly action: CoordinatorFixAction;
  readonly run: () => void;
  readonly pending: boolean;
  readonly error: string | null;
  /** The install finished and the provider can run now. */
  readonly done: boolean;
  /** This viewer may change providers on that machine. */
  readonly allowed: boolean;
}

/**
 * The fix button beside a coordinator error: install, sign in or open setup,
 * named for the machine. Shown with a failed run and with a refused send.
 */
export function CoordinatorFixButton({
  fix,
  variant = "default",
  doneText = "Installed. Retry to send it again.",
}: {
  readonly fix: CoordinatorFix;
  readonly variant?: "default" | "outline";
  /** What to say once the install finished. */
  readonly doneText?: string;
}) {
  if (fix.done)
    return (
      <span className="text-xs text-muted-foreground" role="status" data-coordinator-fix-done="">
        {doneText}
      </span>
    );
  const busyLabel = fix.action.kind === "install" ? "Installing…" : fix.action.label;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant={variant}
        size="sm"
        disabled={!fix.allowed || fix.pending}
        aria-busy={fix.pending}
        title={fix.allowed ? undefined : "You cannot change providers on that machine."}
        data-coordinator-fix={fix.action.kind}
        onClick={fix.run}
      >
        {fix.pending ? busyLabel : fix.action.label}
      </Button>
      {fix.error ? (
        <span className="text-xs text-destructive-foreground" role="alert">
          {fix.error}
        </span>
      ) : null}
    </span>
  );
}

/** "The coordinator did not answer.": why in one sentence, the fix, a retry, and the run's ID to copy. */
export function CoordinatorFailureCard({
  failure,
  machineLabel,
  profileLabel,
  onRetry,
  retrying,
  retryDisabled,
  fix,
}: {
  readonly failure: CoordinatorTurnFailure;
  readonly machineLabel: string | null;
  /** The profile and model the failed run used, such as "Claude Code · Opus 5.5". */
  readonly profileLabel: string | null;
  readonly onRetry: () => void;
  readonly retrying: boolean;
  readonly retryDisabled: boolean;
  readonly fix?: CoordinatorFix | null;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const resetAt = coordinatorFailureResetAt(failure);
  // Ticks while the reset is ahead, so "in 1d 9h" stays true.
  const nowMs = useNowUntil(resetAt ? Date.parse(resetAt) : Number.NaN);
  const text = coordinatorFailureText({
    failure,
    machineLabel,
    profileLabel,
    nowMs,
    dates: { timestampFormat },
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1500, target: "run ID" });
  return (
    <div
      className="rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-sm"
      role="alert"
      data-coordinator-failure=""
      data-coordinator-failure-class={failure.errorClass ?? undefined}
    >
      <div className="flex items-start gap-3">
        <TriangleAlertIcon
          className="mt-0.5 size-4 shrink-0 text-destructive-foreground"
          aria-hidden
        />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <p className="font-medium">The coordinator did not answer.</p>
            <p
              className="mt-1 leading-relaxed text-muted-foreground"
              data-coordinator-failure-body=""
            >
              {text.body}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {fix ? <CoordinatorFixButton fix={fix} /> : null}
            <Button
              variant="outline"
              size="sm"
              disabled={retryDisabled || retrying || fix?.pending === true}
              aria-busy={retrying}
              onClick={onRetry}
            >
              <RotateCcwIcon aria-hidden />
              {retrying ? "Checking and retrying…" : "Retry last message"}
            </Button>
          </div>
          <details className="text-muted-foreground">
            <summary className="w-fit cursor-pointer rounded-sm text-xs underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
              Error details
            </summary>
            {text.detail ? (
              <p
                className="mt-2 whitespace-pre-wrap break-words text-xs"
                data-coordinator-failure-detail=""
              >
                {text.detail}
              </p>
            ) : null}
            <Button
              variant="ghost"
              size="xs"
              className="mt-2"
              title={failure.runId}
              aria-label="Copy run ID"
              data-coordinator-copy-run=""
              onClick={() => copyToClipboard(failure.runId, undefined)}
            >
              <MorphIcon className="size-3.5" icon={isCopied ? Check : Copy} />
              {isCopied ? "Copied" : "Copy run ID"}
            </Button>
          </details>
        </div>
      </div>
    </div>
  );
}
