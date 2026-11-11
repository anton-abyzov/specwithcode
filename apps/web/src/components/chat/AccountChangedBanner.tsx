import { useTx } from "../../i18n";
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

/** The CLIs whose sign-in the server watches for a change of subscription. */
const SUBSCRIPTION_CHANGE_DRIVERS = new Set(["claudeAgent", "codex"]);

/**
 * Whether the server will continue this stop by itself on the new
 * subscription, so the notice may say "continues shortly". The early resume
 * (UsageLimitRecoveryWorker) needs the project to approve subscription changes
 * by itself (`autoApproveSubscriptionChange`, on by default). Auto-continue
 * at the reset need not be on: the server arms the stop for the change
 * itself (`accountChangeArmCommand`), unless the person chose for this stop,
 * by turning its resume off or stopping the thread. It keeps the other gates
 * of the reset-time resume: not settled, not snoozed, no approval or question
 * waiting on the person (the server refuses the resume while one blocks), and
 * a project that is neither paused nor archived. Anything else asks the
 * person to confirm.
 */
export function accountChangeAutoContinues(input: {
  readonly driver: string | undefined;
  /** The project's `autoApproveSubscriptionChange`. */
  readonly autoApprove: boolean;
  readonly runId: RunId;
  readonly limitRecovery:
    | {
        readonly runId: RunId;
        readonly autoResume: boolean;
        /** The command that made the choice; a rule's arm starts with `limit-arm:`. */
        readonly requestId?: string | undefined;
      }
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
    input.driver !== undefined &&
    SUBSCRIPTION_CHANGE_DRIVERS.has(input.driver) &&
    input.autoApprove &&
    !personChoseForStop(input.limitRecovery, input.runId) &&
    input.settledOverride !== "settled" &&
    !(input.snoozedUntil != null && Date.parse(input.snoozedUntil) > input.nowMs) &&
    !input.pendingRequest &&
    input.project?.paused !== true &&
    input.project?.archived !== true
  );
}

/** A person turned this stop's resume off, or stopped the thread: only they continue it. */
function personChoseForStop(
  recovery:
    | {
        readonly runId: RunId;
        readonly autoResume: boolean;
        readonly requestId?: string | undefined;
      }
    | null
    | undefined,
  runId: RunId,
): boolean {
  return (
    recovery != null &&
    recovery.runId === runId &&
    !recovery.autoResume &&
    !(recovery.requestId ?? "").startsWith("limit-arm:")
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
 * subscription the same CLI was signed in to before. It says only what the
 * snapshot shows: another subscription, with room. Nothing about cost, API
 * keys, cached context or another provider or model.
 */
export function accountChangedBannerItem(props: AccountChangedProps): ComposerBannerStackItem {
  const detected = `We detected a sign-in to another subscription in the same ${props.providerName} CLI. The limit was on the previous one, and the new one has room.`;
  return {
    id: `account-changed:${props.runId}`,
    variant: "info",
    priority: "urgent",
    icon: <UserRoundCheckIcon />,
    title: `${props.providerName} subscription changed`,
    description: props.autoContinuing
      ? `${detected} This thread continues on the new subscription shortly.`
      : detected,
    actions: props.autoContinuing ? null : <ConfirmAndContinue onContinue={props.onContinue} />,
    // The text wraps under the title on a phone instead of hiding behind a details button.
    actionsLayout: "wrap-below",
    dismissLabel: "Dismiss subscription change notice",
    onDismiss: props.onDismiss,
  };
}

function ConfirmAndContinue({ onContinue }: { readonly onContinue: () => Promise<void> }) {
  const tx = useTx();
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
        {pending ? tx("Continuing...") : tx("Confirm and continue")}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-destructive-foreground">
          {error}
        </span>
      ) : null}
    </span>
  );
}
