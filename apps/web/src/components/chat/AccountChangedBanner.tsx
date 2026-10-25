import type { RunId, ServerProvider } from "@specweave-studio/contracts";
import { canTakeTurn, providerUsedPercent } from "@specweave-studio/shared/providerFallback";
import { UserRoundCheckIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * Whether the instance a limited thread runs on is now signed in to another
 * account with room: the server saw the account change after the stop, and a
 * complete read of the new account, taken at or after the change, shows usage
 * left. The server's recovery uses the same proof before it resumes early.
 */
export function accountChangedWithRoom(
  provider: ServerProvider | undefined,
  stoppedAtMs: number,
  nowMs: number,
): boolean {
  const limits = provider?.usageLimits;
  const changedMs = Date.parse(limits?.accountChangedAt ?? "");
  const fullReadMs = Date.parse(limits?.nativeAllowanceObservedAt ?? "");
  return (
    provider !== undefined &&
    limits !== undefined &&
    limits.unavailable === undefined &&
    Number.isFinite(changedMs) &&
    changedMs > stoppedAtMs &&
    Number.isFinite(fullReadMs) &&
    fullReadMs >= changedMs &&
    canTakeTurn(provider) &&
    (providerUsedPercent(provider, nowMs) ?? 0) < 100
  );
}

/**
 * Whether the server will continue this stop by itself on the new account, so
 * the notice may say "continues shortly". Only Claude has the early resume on
 * an account change (UsageLimitRecoveryWorker), and it keeps the same gates as
 * the reset-time resume: recovery armed for this stop with auto-continue on,
 * not settled, not snoozed, no approval or question waiting on the person
 * (the server refuses the resume while one blocks), and a project that is
 * neither paused nor archived. Anything else gets "Continue now".
 */
export function accountChangeAutoContinues(input: {
  readonly driver: string | undefined;
  readonly runId: RunId;
  readonly limitRecovery:
    | { readonly runId: RunId; readonly autoResume: boolean }
    | null
    | undefined;
  readonly settledOverride: string | null | undefined;
  readonly snoozedUntil: string | null | undefined;
  /** The shell shows an approval or question waiting on the person. */
  readonly pendingRequest: boolean;
  readonly project: { readonly paused?: boolean; readonly archived?: boolean } | null | undefined;
  readonly nowMs: number;
}): boolean {
  return (
    input.driver === "claudeAgent" &&
    input.limitRecovery?.runId === input.runId &&
    input.limitRecovery.autoResume &&
    input.settledOverride !== "settled" &&
    !(input.snoozedUntil != null && Date.parse(input.snoozedUntil) > input.nowMs) &&
    !input.pendingRequest &&
    input.project?.paused !== true &&
    input.project?.archived !== true
  );
}

interface AccountChangedProps {
  readonly runId: RunId;
  readonly providerName: string;
  /** Recovery is armed for this stop, so the server continues it by itself. */
  readonly autoContinuing: boolean;
  readonly onContinue: () => Promise<void>;
  readonly onDismiss: () => void;
}

/**
 * Replaces the usage-limit notice of a stop whose limit belonged to the
 * account the CLI was signed in to before. It says only what the snapshot
 * shows: another account, with room. Nothing about cost or cached context.
 */
export function accountChangedBannerItem(props: AccountChangedProps): ComposerBannerStackItem {
  return {
    id: `account-changed:${props.runId}`,
    variant: "info",
    priority: "urgent",
    icon: <UserRoundCheckIcon />,
    title: `${props.providerName} account changed`,
    description: props.autoContinuing
      ? "The limit was on the previous account. This thread continues on the new one shortly."
      : "The limit was on the previous account, and the new one has room.",
    actions: props.autoContinuing ? null : <ContinueNow onContinue={props.onContinue} />,
    // The text wraps under the title on a phone instead of hiding behind a details button.
    actionsLayout: "wrap-below",
    dismissLabel: "Dismiss account change notice",
    onDismiss: props.onDismiss,
  };
}

function ContinueNow({ onContinue }: { readonly onContinue: () => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        size="xs"
        variant="outline"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            await onContinue();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not continue this thread.");
          }
          setPending(false);
        }}
      >
        {pending ? "Continuing..." : "Continue now"}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-destructive-foreground">
          {error}
        </span>
      ) : null}
    </span>
  );
}
