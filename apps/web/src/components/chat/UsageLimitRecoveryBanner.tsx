import { ApiCreditRecoveryAction, type ApiCreditRecoveryProps } from "./ApiCreditRecoveryAction";
import { CreditRecoveryAction, type CreditRecoveryProps } from "./CreditRecoveryAction";
import { useClientSettings } from "../../hooks/useSettings";
import { formatDisplayDate } from "../../lib/displayDates";
import {
  type EnvironmentId,
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
  type ServerProvider,
  type ThreadId,
} from "@specweave-studio/contracts";
import {
  canTakeTurn,
  hasUsableFallbackCapacity,
  providerUsedPercent,
  reportsNoUsage,
  usageAtThreshold,
  type FallbackOrderEntry,
  type FallbackOrderUnavailable,
  type ProviderFallbackRule,
} from "@specweave-studio/shared/providerFallback";
import {
  PRESWITCH_RETURN_BLOCK_REASON,
  type PreswitchReturnBlock,
} from "@specweave-studio/shared/preswitchReturn";
import { ChevronDownIcon, GaugeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Checkbox } from "../ui/checkbox";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { LimitHandoffCandidates } from "./LimitHandoffCandidates";
import { getLocale, t, useT, type Translate } from "../../i18n";

type RecoveryProps = {
  canCheck?: boolean;
  credits?: CreditRecoveryProps | null;
  /** API accounts the stopped turn can continue on, or the way to add one. */
  apiCredits?: ApiCreditRecoveryProps | null;
  /** The thread's own API account ran out of credits (not a subscription limit). */
  creditsExhausted?: boolean;
  runId: RunId;
  resetAt: string | null;
  stoppedAt: string;
  snoozedUntil: string | null;
  recovery: OrchestrationV2LimitRecovery | null;
  /** Another ready provider the stopped run can continue on, by switching model. */
  fallback?: {
    label: string;
    model: string;
    /** The project's rule continues on it by itself. */
    automatic: boolean;
    onContinue: () => Promise<void>;
  } | null;
  /**
   * The rest of the user's fallback order, in order: each either continues
   * the stopped run there, or says why it cannot now.
   */
  fallbackChoices?: ReadonlyArray<FallbackChoice>;
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
  /** The project lists other machines a limited thread may move to: offer the first that can take it. */
  machines?: { environmentId: EnvironmentId; threadId: ThreadId } | null;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
  /**
   * The project-wide switch: auto-continue every thread of this project when
   * its limit resets, including threads already waiting. Absent outside a project.
   */
  project?: {
    readonly on: boolean;
    /** Settings turns it on for every project, so this one cannot turn it off. */
    readonly global: boolean;
    readonly onChange: (on: boolean) => Promise<void>;
  } | null;
};

/** One entry of the fallback order on the limit banner. */
export interface FallbackChoice {
  readonly label: string;
  readonly model: string;
  /** Absent only when the entry cannot be selected; `unavailable` can be a warning. */
  readonly onContinue?: () => Promise<void>;
  readonly unavailable?: string;
}

/** Manual choices may retry a limit or explicitly choose per-token billing. */
export function canSelectManualFallback(
  entry: Pick<FallbackOrderEntry, "provider" | "unavailable">,
): boolean {
  const { provider, unavailable } = entry;
  if (
    provider === undefined ||
    !provider.enabled ||
    !provider.installed ||
    provider.availability === "unavailable" ||
    provider.auth.status === "unauthenticated" ||
    provider.status === "error" ||
    provider.status === "disabled"
  ) {
    return false;
  }
  return (
    unavailable === null ||
    unavailable === "unverified" ||
    unavailable === "limited" ||
    unavailable === "full" ||
    unavailable === "per-token" ||
    unavailable === "excluded" ||
    (unavailable === "not-ready" && provider.status === "warning")
  );
}

/** Why an entry of the fallback order cannot take the thread now, in a few words. */
export function fallbackUnavailableReason(
  unavailable: FallbackOrderUnavailable | null,
  resetAt: number | null,
  manuallySelectable = false,
  tr: Translate = t,
): string | undefined {
  switch (unavailable) {
    case null:
    case "current":
      return undefined;
    case "missing":
      return tr("limit.unavailable.missing");
    case "limited":
      return tr("limit.unavailable.limited");
    case "signed-out":
      return tr("limit.unavailable.signedOut");
    case "per-token":
      return tr("limit.unavailable.perToken");
    case "full":
      return resetAt === null
        ? tr("limit.unavailable.full")
        : tr("limit.unavailable.fullUntil", {
            time: new Date(resetAt).toLocaleTimeString(getLocale(), {
              hour: "numeric",
              minute: "2-digit",
            }),
          });
    case "too-small":
      return tr("limit.unavailable.tooSmall");
    case "unverified":
      return tr("limit.unavailable.unverified");
    case "not-ready":
      return manuallySelectable
        ? tr("limit.unavailable.providerWarning")
        : tr("limit.unavailable.notReady");
    case "excluded":
      return tr("limit.unavailable.excluded");
  }
}

/** "12 min", "2 h 5 min", "3 days": how far off a reset is, rounded up to the minute. */
export function formatResetIn(resetMs: number, nowMs: number, tr: Translate = t): string {
  const minutes = Math.max(1, Math.ceil((resetMs - nowMs) / 60_000));
  if (minutes < 60) return tr("limit.duration.minutes", { count: minutes });
  if (minutes < 48 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0
      ? tr("limit.duration.hours", { count: hours })
      : tr("limit.duration.hoursMinutes", { hours, minutes: rest });
  }
  return tr("limit.duration.days", { count: Math.round(minutes / (24 * 60)) });
}

/** Re-renders every half minute while `untilMs` is ahead, then once when it passes. */
export function useNowUntil(untilMs: number): number {
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
  const tr = useT();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const clock = resetAt ? formatDisplayDate(resetAt, timestampFormat) : null;
  const resetMs = clock ? Date.parse(resetAt ?? "") : Number.NaN;
  const nowMs = useNowUntil(resetMs);
  const when = !Number.isFinite(resetMs)
    ? tr("limit.reset.unavailable")
    : resetMs > nowMs
      ? tr("limit.reset.in", { duration: formatResetIn(resetMs, nowMs, tr), clock: clock ?? "" })
      : tr("limit.reset.at", { clock: clock ?? "" });
  const next = waiting
    ? resetMs > nowMs
      ? tr("limit.next.waiting")
      : tr("limit.next.resumingNow")
    : autoContinuing && Number.isFinite(resetMs)
      ? resetMs > nowMs
        ? tr("limit.next.continuesAtReset")
        : tr("limit.next.continuingNow")
      : automaticLabel
        ? tr("limit.next.byRule", { label: automaticLabel })
        : null;
  return <>{[when, next].filter(Boolean).join(tr("limit.sentenceJoin"))}</>;
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
    title: props.creditsExhausted
      ? t("limit.title.credits")
      : props.credits
        ? t("limit.title.included")
        : t("limit.title.usage"),
    description: props.creditsExhausted ? (
      t("limit.creditsExhausted")
    ) : (
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
  apiCredits,
  runId,
  resetAt,
  stoppedAt,
  recovery,
  snoozedUntil,
  fallback,
  fallbackChoices,
  waiting,
  device,
  machines,
  onChange,
  project,
}: RecoveryProps) {
  const tr = useT();
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
      // Continuing on another device creates another thread. Disarm this stopped run first
      // so the source cannot also resume when its reset arrives.
      if (scheduled) await onChange({ runId, resetAt, autoResume: false });
      await target.onContinue();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : tr("limit.error.continueOn", { label: target.label }),
      );
    }
    setPending(false);
  }
  async function toggle(action: "resume" | "snooze" | "check") {
    if (action === "snooze" && !snoozed && Date.parse(resetAt ?? "") <= Date.now()) {
      setError(tr("limit.error.resetPassed"));
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
      setError(cause instanceof Error ? cause.message : tr("limit.error.recovery"));
    }
    setPending(false);
  }
  const canAutoContinue = canSchedule || canCheck === true;
  async function toggleProject(on: boolean) {
    if (!project) return;
    setPending(true);
    setError(null);
    try {
      await project.onChange(on);
      // The project rule reaches this thread on the next sweep; turning it on here
      // continues this thread too, without waiting for that.
      if (on && canAutoContinue && !scheduled) await onChange({ runId, resetAt, autoResume: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("limit.error.project"));
    }
    setPending(false);
  }
  const choices = fallbackChoices ?? [];
  const handoffs = [fallback, device, ...choices].filter((target) => target != null);
  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
      <label
        className="flex basis-full items-center gap-2 text-xs text-foreground has-data-disabled:text-muted-foreground"
        title={canAutoContinue ? tr("limit.auto.savedHint") : undefined}
      >
        <Checkbox
          aria-label={canCheck ? tr("limit.auto.whenUsage") : tr("limit.auto.whenReset")}
          checked={scheduled}
          disabled={pending || !canAutoContinue}
          onCheckedChange={() => void toggle("resume")}
        />
        {canCheck ? tr("limit.auto.whenUsage") : tr("limit.auto.whenReset")}
        {pending ? <span className="text-muted-foreground">{tr("limit.saving")}</span> : null}
      </label>
      {project ? (
        <label
          className="flex basis-full items-center gap-2 text-xs text-foreground has-data-disabled:text-muted-foreground"
          title={project.global ? tr("limit.project.global") : tr("limit.project.hint")}
        >
          <Checkbox
            aria-label={tr("limit.project.label")}
            checked={project.on || project.global}
            disabled={pending || project.global}
            onCheckedChange={() => void toggleProject(!project.on)}
          />
          {tr("limit.project.label")}
        </label>
      ) : null}
      {!canAutoContinue ? (
        <p className="basis-full text-xs text-muted-foreground">
          {handoffs.length > 0 ? tr("limit.noReset.withHandoffs") : tr("limit.noReset")}
        </p>
      ) : null}
      {handoffs.length > 0 ? (
        <div className="flex min-w-0 basis-full flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {scheduled ? tr("limit.orElsewhere") : tr("limit.insteadOfWaiting")}
          </span>
          {fallback ? (
            <Button
              size="xs"
              variant={waiting ? "ghost" : "outline"}
              disabled={pending}
              title={tr("limit.fallback.hint", { label: fallback.label, model: fallback.model })}
              aria-label={tr("limit.fallback.continueWith", {
                label: fallback.label,
                model: fallback.model,
              })}
              className="max-w-full min-w-0"
              onClick={() => void continueElsewhere(fallback)}
            >
              <span className="truncate">
                {tr("limit.fallback.continueWith", {
                  label: fallback.label,
                  model: fallback.model,
                })}
              </span>
            </Button>
          ) : null}
          {choices.length > 0 ? (
            <Menu>
              <MenuTrigger
                disabled={pending}
                render={
                  <Button size="xs" variant="ghost" aria-label={tr("limit.otherModelsAria")} />
                }
              >
                {fallback ? tr("limit.otherModels") : tr("limit.chooseModel")}
                <ChevronDownIcon className="size-3" />
              </MenuTrigger>
              <MenuPopup side="bottom" align="start">
                {choices.map((choice) => (
                  <MenuItem
                    key={`${choice.label}:${choice.model}`}
                    disabled={pending || choice.onContinue === undefined}
                    onClick={() => {
                      const run = choice.onContinue;
                      if (run) void continueElsewhere({ label: choice.label, onContinue: run });
                    }}
                  >
                    <span>{`${choice.label} · ${choice.model}`}</span>
                    {choice.unavailable ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {choice.unavailable}
                      </span>
                    ) : null}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : null}
          {device ? (
            <Button
              size="xs"
              variant={waiting ? "ghost" : "outline"}
              disabled={pending}
              title={tr("limit.device.hint", { label: device.label, model: device.model })}
              onClick={() => void continueElsewhere(device)}
            >
              {machines
                ? tr("limit.device.fresh", { label: device.label })
                : tr("limit.device.continue", { label: device.label })}
            </Button>
          ) : null}
        </div>
      ) : null}
      {machines ? (
        <LimitHandoffCandidates
          environmentId={machines.environmentId}
          threadId={machines.threadId}
        />
      ) : null}
      {credits ? <CreditRecoveryAction {...credits} /> : null}
      {apiCredits ? <ApiCreditRecoveryAction {...apiCredits} /> : null}
      {canCheck ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={pending || recovery?.checkNow === true}
          onClick={() => void toggle("check")}
        >
          {recovery?.checkNow ? tr("limit.checkRequested") : tr("limit.checkNow")}
        </Button>
      ) : null}
      {!snoozed && resetAt !== null ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={pending || Date.parse(resetAt!) <= nowMs}
          onClick={() => void toggle("snooze")}
        >
          {pending ? tr("limit.saving") : tr("limit.snooze")}
        </Button>
      ) : null}
      {canCheck && recovery?.availability ? (
        <p role="status" className="basis-full text-xs text-muted-foreground">
          {recovery.availability.status === "allowed"
            ? scheduled
              ? tr("limit.check.allowedOn")
              : tr("limit.check.allowedOff")
            : recovery.availability.status === "denied"
              ? tr("limit.check.denied")
              : recovery.availability.status === "changed"
                ? tr("limit.check.changed")
                : scheduled && (!recovery.explicitArm || !recovery.armedAffinity)
                  ? tr("limit.check.reconfirm")
                  : tr("limit.check.unverified")}
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
    title: t("limit.approaching.title", {
      provider: props.providerLabel,
      percent: Math.max(0, Math.round(props.leftPercent)),
    }),
    description: (
      <>
        <ResetCountdown resetAt={props.resetAt} />
        {t("limit.sentenceJoin")}
        {t("limit.approaching.question", { label: props.fallbackLabel })}
      </>
    ),
    actions: (
      <Button size="xs" variant="outline" onClick={props.onSwitch}>
        {t("limit.approaching.switch", { label: props.fallbackLabel })}
      </Button>
    ),
    dismissLabel: t("limit.approaching.notNow"),
    onDismiss: props.onDismiss,
  };
}

/**
 * Why the room of a stood-in model is unknown: it reports no usage, its
 * reading is out of date, or it has no reading yet.
 */
export type LimitPairingRoomUnknown = "unreported" | "stale" | "unread";

/**
 * Whether the model a fallback stood in for can take the thread back. Room
 * needs a fresh usage reading below 100% (`hasUsableFallbackCapacity`), or
 * the project coordinator running on that provider right now (`proven`,
 * see provenFallbackSelection). A provider that reports no usage (Copilot
 * and other agents) or whose reading is out of date is unknown.
 */
export function limitPairingRoom(
  provider: ServerProvider | undefined,
  nowMs: number,
  model: string,
  proven?: { readonly instanceId: string } | null,
): { readonly hasRoom: boolean; readonly roomUnknown?: LimitPairingRoomUnknown } {
  if (provider === undefined || !canTakeTurn(provider)) return { hasRoom: false };
  const used = providerUsedPercent(provider, nowMs, model);
  // The coordinator working there proves room only while no reading says it is full,
  // as the server's fallback reads it (resolveProviderFallback).
  if (proven?.instanceId === provider.instanceId && (used === null || used < 100))
    return { hasRoom: true };
  if (reportsNoUsage(provider)) return { hasRoom: false, roomUnknown: "unreported" };
  if (hasUsableFallbackCapacity(provider, nowMs, model)) return { hasRoom: true };
  if (used === null) return { hasRoom: false, roomUnknown: "unread" };
  return used >= 100 ? { hasRoom: false } : { hasRoom: false, roomUnknown: "stale" };
}

/**
 * The room the way back from a usage pre-switch waits for (1075): under the
 * `switch` rule the server returns the thread only once the original reads
 * below the switch threshold (preswitchReturnCommand), so a reading at the
 * threshold, though under 100%, is no room yet.
 */
export function preswitchPairingRoom(
  room: ReturnType<typeof limitPairingRoom>,
  input: {
    readonly provider: ServerProvider | undefined;
    readonly model: string;
    readonly rule: Pick<
      ProviderFallbackRule,
      "providerLimitAction" | "providerLimitSwitchAtPercent" | "providerLimitWaitUnderMinutes"
    >;
    readonly nowMs: number;
  },
): ReturnType<typeof limitPairingRoom> {
  if (!room.hasRoom || input.rule.providerLimitAction !== "switch") return room;
  return usageAtThreshold(input) ? { hasRoom: false } : room;
}

/**
 * The fallback header's line for a thread the usage pre-switch moved before
 * its limit (1075): it goes back by itself once the original has room, unless
 * the original is one the server never moves a thread to, which it names.
 */
export function preswitchFallbackDetail(
  input: {
    readonly originalModel: string;
    readonly hasRoom: boolean;
    readonly returnBlock: PreswitchReturnBlock | null;
  },
  tr: Translate = t,
): string {
  if (input.returnBlock !== null)
    return tr("limit.preswitch.blocked", {
      model: input.originalModel,
      reason: PRESWITCH_RETURN_BLOCK_REASON[input.returnBlock],
    });
  return input.hasRoom
    ? tr("limit.preswitch.hasRoom", { model: input.originalModel })
    : tr("limit.preswitch.noRoom", { model: input.originalModel });
}
