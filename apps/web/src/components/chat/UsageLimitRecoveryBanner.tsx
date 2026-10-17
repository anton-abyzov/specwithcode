import { CreditRecoveryAction, type CreditRecoveryProps } from "./CreditRecoveryAction";
import { useClientSettings } from "../../hooks/useSettings";
import { formatDisplayDate } from "../../lib/displayDates";
import {
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
} from "@specweave-studio/contracts";
import { GaugeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type RecoveryProps = {
  canCheck?: boolean;
  credits?: CreditRecoveryProps | null;
  runId: RunId;
  resetAt: string | null;
  stoppedAt: string;
  snoozedUntil: string | null;
  recovery: OrchestrationV2LimitRecovery | null;
  /** Another ready provider the stopped run can continue on, with a context handoff. */
  fallback?: {
    label: string;
    model: string;
    /** The project's rule continues on it by itself. */
    automatic: boolean;
    onContinue: () => Promise<void>;
  } | null;
  /**
   * The reset is within the project's wait: nothing switches or spends, and
   * the thread resumes here at the reset.
   */
  waiting?: boolean;
  /** Another device of this project with a provider that has room, for a new thread there. */
  device?: {
    label: string;
    model: string;
    onContinue: () => Promise<void>;
  } | null;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
};

/** "12 min", "2 h 5 min", "3 days": how far off a reset is, rounded up to the minute. */
export function formatResetIn(resetMs: number, nowMs: number): string {
  const minutes = Math.max(1, Math.ceil((resetMs - nowMs) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }
  return `${Math.round(minutes / (24 * 60))} days`;
}

/** Re-renders every half minute while `untilMs` is ahead, then once when it passes. */
function useNowUntil(untilMs: number): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const left = untilMs - Date.now();
    if (!Number.isFinite(left) || left <= 0) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), Math.min(left + 1, 30_000));
    return () => window.clearTimeout(timer);
  }, [untilMs, nowMs]);
  return nowMs;
}

/** The reset as a live countdown with its clock time, and what the thread does at it. */
export function ResetCountdown({
  resetAt,
  waiting,
  autoContinuing,
  automaticLabel,
}: {
  resetAt: string | null;
  waiting?: boolean;
  /** The thread's auto-continue box is ticked. */
  autoContinuing?: boolean;
  automaticLabel?: string | null;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const clock = resetAt ? formatDisplayDate(resetAt, timestampFormat) : null;
  const resetMs = clock ? Date.parse(resetAt ?? "") : Number.NaN;
  const nowMs = useNowUntil(resetMs);
  const when = !Number.isFinite(resetMs)
    ? "Reset time unavailable"
    : resetMs > nowMs
      ? `Resets in ${formatResetIn(resetMs, nowMs)} (${clock})`
      : `Reset at ${clock}`;
  const next = waiting
    ? resetMs > nowMs
      ? "The reset is close, so this thread waits and resumes here instead of switching."
      : "Resuming here now that the limit has reset."
    : autoContinuing && Number.isFinite(resetMs)
      ? resetMs > nowMs
        ? "This thread continues by itself at the reset."
        : "Continuing now that the limit has reset."
      : automaticLabel
        ? `Continuing with ${automaticLabel} by project rule.`
        : null;
  return <>{[when, next].filter(Boolean).join(". ")}</>;
}

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const { runId, resetAt, recovery } = props;
  const autoContinuing =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    priority: "urgent",
    icon: <GaugeIcon />,
    title: props.credits ? "Included usage limit reached" : "Usage limit reached",
    description: (
      <ResetCountdown
        resetAt={resetAt}
        waiting={props.waiting === true}
        autoContinuing={autoContinuing}
        automaticLabel={props.fallback?.automatic ? props.fallback.label : null}
      />
    ),
    // The auto-continue checkbox always shows; without a reset time it says why it is off.
    actions: <RecoveryActions key={`${runId}:${resetAt}`} {...props} />,
    // Up to four buttons plus a status line: beside the title they squeezed it to 0 px.
    actionsLayout: "wrap-below",
  };
}

function RecoveryActions({
  canCheck,
  credits,
  runId,
  resetAt,
  stoppedAt,
  recovery,
  snoozedUntil,
  fallback,
  waiting,
  device,
  onChange,
}: RecoveryProps) {
  const canSchedule = resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const delay = Date.parse(resetAt ?? "") - Math.max(nowMs, Date.now());
    if (!Number.isFinite(delay) || delay <= 0) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), Math.min(delay + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [resetAt, nowMs]);

  const scheduled = Boolean(
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume,
  );
  const snoozed =
    recovery?.snooze === true &&
    recovery.runId === runId &&
    recovery.resetAt === resetAt &&
    resetAt !== null &&
    snoozedUntil !== null &&
    Date.parse(snoozedUntil) === Date.parse(resetAt);
  async function continueElsewhere(target: { label: string; onContinue: () => Promise<void> }) {
    setPending(true);
    setError(null);
    try {
      // A device handoff creates another thread. Disarm this stopped run first
      // so the source cannot also resume when its reset arrives.
      if (scheduled) await onChange({ runId, resetAt, autoResume: false });
      await target.onContinue();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not continue on ${target.label}.`);
    }
    setPending(false);
  }
  async function toggle(action: "resume" | "snooze" | "check") {
    if (action === "snooze" && !snoozed && Date.parse(resetAt ?? "") <= Date.now()) {
      setError("The reset time has passed. Retry the thread manually.");
      setNowMs(Date.now());
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onChange({
        runId,
        resetAt,
        ...(action === "check"
          ? { checkNow: true }
          : action === "resume"
            ? { autoResume: !scheduled }
            : { snooze: !snoozed }),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change limit recovery.");
    }
    setPending(false);
  }
  const canAutoContinue = canSchedule || canCheck === true;
  const handoffs = [fallback, device].filter((target) => target != null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label
        className="flex basis-full items-center gap-2 text-xs text-foreground has-data-disabled:text-muted-foreground"
        title={
          canAutoContinue
            ? "Saved for this thread. SpecWithCode continues the stopped turn by itself, even after a restart."
            : undefined
        }
      >
        <Checkbox
          aria-label={
            canCheck
              ? "Auto-continue when usage is available"
              : "Auto-continue when the limit resets"
          }
          checked={scheduled}
          disabled={pending || !canAutoContinue}
          onCheckedChange={() => void toggle("resume")}
        />
        {canCheck ? "Auto-continue when usage is available" : "Auto-continue when the limit resets"}
        {pending ? <span className="text-muted-foreground">Saving...</span> : null}
      </label>
      {!canAutoContinue ? (
        <p className="basis-full text-xs text-muted-foreground">
          {handoffs.length > 0
            ? "The provider did not say when this limit resets, so the thread cannot continue by itself. Hand it off now, or send a message after the reset."
            : "The provider did not say when this limit resets, so the thread cannot continue by itself. Send a message after the reset."}
        </p>
      ) : null}
      {handoffs.length > 0 ? (
        <div className="flex basis-full flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {scheduled ? "Or hand off now:" : "Hand off now instead of waiting:"}
          </span>
          {fallback ? (
            <Button
              size="xs"
              variant={waiting ? "ghost" : "outline"}
              disabled={pending}
              title={`Hand this thread to ${fallback.label} (${fallback.model}) with its context and continue the stopped turn`}
              onClick={() => void continueElsewhere(fallback)}
            >
              {`Continue with ${fallback.label}`}
            </Button>
          ) : null}
          {device ? (
            <Button
              size="xs"
              variant={waiting ? "ghost" : "outline"}
              disabled={pending}
              title={`Start a thread on ${device.label} (${device.model}) with a written handoff of this conversation. Changes not pushed from this device do not go with it.`}
              onClick={() => void continueElsewhere(device)}
            >
              {`Continue on ${device.label}`}
            </Button>
          ) : null}
        </div>
      ) : null}
      {credits ? <CreditRecoveryAction {...credits} /> : null}
      {canCheck ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={pending || recovery?.checkNow === true}
          onClick={() => void toggle("check")}
        >
          {recovery?.checkNow ? "Check requested" : "Check now"}
        </Button>
      ) : null}
      {!snoozed && resetAt !== null ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={pending || Date.parse(resetAt!) <= nowMs}
          onClick={() => void toggle("snooze")}
        >
          {pending ? "Saving..." : "Snooze until reset"}
        </Button>
      ) : null}
      {canCheck && recovery?.availability ? (
        <p role="status" className="basis-full text-xs text-muted-foreground">
          {recovery.availability.status === "allowed"
            ? scheduled
              ? "Last check allowed ordinary usage; auto-continue is on."
              : "Last check allowed ordinary usage. Tick Auto-continue to continue."
            : recovery.availability.status === "denied"
              ? "This profile still denies ordinary usage."
              : recovery.availability.status === "changed"
                ? "The account or profile changed. Automatic recovery is blocked."
                : scheduled && (!recovery.explicitArm || !recovery.armedAffinity)
                  ? "Check now, then untick and tick Auto-continue again to confirm the current profile."
                  : "Ordinary usage permission could not be verified. The thread remains stopped."}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="basis-full text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Under the "Offer the fallback" rule, the provider has reached the switch
 * threshold and its reset is too far off to wait for: offer to move the
 * thread before the limit stops a turn. Dismissed per usage window.
 */
export function usageApproachingBannerItem(props: {
  id: string;
  providerLabel: string;
  /** Share of the fullest window still left, 0..100. */
  leftPercent: number;
  resetAt: string | null;
  fallbackLabel: string;
  onSwitch: () => void;
  onDismiss: () => void;
}): ComposerBannerStackItem {
  return {
    id: props.id,
    variant: "info",
    priority: "notice",
    icon: <GaugeIcon />,
    title: `${props.providerLabel} has ${Math.max(0, Math.round(props.leftPercent))}% of its usage left`,
    description: (
      <>
        <ResetCountdown resetAt={props.resetAt} />
        {`. Switch this thread to ${props.fallbackLabel} before the limit stops a turn?`}
      </>
    ),
    actions: (
      <Button size="xs" variant="outline" onClick={props.onSwitch}>
        {`Switch to ${props.fallbackLabel}`}
      </Button>
    ),
    dismissLabel: "Not now",
    onDismiss: props.onDismiss,
  };
}
