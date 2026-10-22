/**
 * Usage beside the model choice: a small meter on the composer's model
 * trigger, a status line on each model row, and the selected provider's
 * windows at the top of the picker. Everything reads the provider snapshots
 * the picker already holds, so showing it asks no provider for anything.
 */
import type { ProviderInstanceId, ServerProviderUsageWindow } from "@specweave-studio/contracts";
import { formatDuration } from "@specweave-studio/shared/usageLimits";
import {
  blockingWindow,
  isLiveWindow,
  windowModelScope,
} from "@specweave-studio/shared/usageWindows";
import { useCallback, useEffect, useMemo, useState } from "react";

import { usePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  availabilityText,
  isAvailabilityBlocking,
  modelAvailability,
  roomLeftPercent,
  type AvailabilityText,
  type ModelAvailability,
} from "../../studio/modelAvailability";
import { usageTone } from "../../studio/usageIndicatorModel";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import "../studio/shell/usage.css";

/** What a chat composer tells its picker about where and what is running. */
export interface ModelPickerUsageConfig {
  /** False while the thread's machine is not connected. */
  readonly connected: boolean;
  readonly machineLabel: string | null;
  /** The model the current turn runs on, while one runs. */
  readonly running: { readonly instanceId: ProviderInstanceId; readonly model: string } | null;
}

/** The picker's resolved usage view: one clock, one formatter, every model's state. */
export interface ModelPickerUsage extends ModelPickerUsageConfig {
  readonly nowMs: number;
  availability(instanceId: ProviderInstanceId, model: string | null): ModelAvailability;
  text(instanceId: ProviderInstanceId, availability: ModelAvailability): AvailabilityText;
  /** The reason a usage-blocked model can't be chosen, or null. */
  blockedReason(instanceId: ProviderInstanceId, model: string): string | null;
  formatAt(ms: number): string;
}

/**
 * Resolve usage against the picker's entries. The clock advances when the
 * picker opens and whenever a provider snapshot arrives, never on a timer, so
 * the composer does not repaint for nothing.
 */
export function useModelPickerUsage(
  config: ModelPickerUsageConfig | undefined,
  entries: ReadonlyArray<ProviderInstanceEntry>,
  open: boolean,
): ModelPickerUsage | undefined {
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    setNowMs(Date.now());
  }, [entries, open]);
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const byId = useMemo(
    () => new Map(entries.map((entry) => [entry.instanceId, entry] as const)),
    [entries],
  );
  const formatAt = useCallback(
    (ms: number) => formatUpcomingTimestamp(new Date(ms).toISOString(), timestampFormat, nowMs),
    [nowMs, timestampFormat],
  );
  const connected = config?.connected;
  const machineLabel = config?.machineLabel ?? null;
  const availability = useCallback(
    (instanceId: ProviderInstanceId, model: string | null) =>
      modelAvailability({
        provider: byId.get(instanceId)?.snapshot,
        model,
        nowMs,
        ...(connected === undefined ? {} : { connected }),
        machineLabel,
      }),
    [byId, connected, machineLabel, nowMs],
  );
  const text = useCallback(
    (instanceId: ProviderInstanceId, state: ModelAvailability) =>
      availabilityText(state, {
        provider: byId.get(instanceId)?.displayName ?? "This provider",
        nowMs,
        formatAt,
      }),
    [byId, formatAt, nowMs],
  );
  const blockedReason = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      const state = availability(instanceId, model);
      return isAvailabilityBlocking(state) ? text(instanceId, state).long : null;
    },
    [availability, text],
  );
  return useMemo(
    () => (config ? { ...config, nowMs, availability, text, blockedReason, formatAt } : undefined),
    [availability, blockedReason, config, formatAt, nowMs, text],
  );
}

const TONE_TEXT: Record<AvailabilityText["tone"], string> = {
  muted: "text-muted-foreground",
  ok: "text-muted-foreground",
  warn: "text-warning-foreground",
  full: "text-destructive-foreground",
};

/** Which states a model row names. Providers that never report say so once, in the band. */
export function rowShowsAvailability(state: ModelAvailability, inProviderTab: boolean): boolean {
  if (state.kind === "unreported" || state.kind === "perToken" || state.kind === "loading") {
    return !inProviderTab;
  }
  return true;
}

/** The status part of a model row's provider line: `62% left · resets in 2h 4m`. */
export function ModelRowAvailability({ text }: { readonly text: AvailabilityText }) {
  return (
    <span
      className={cn(
        "min-w-0 tabular-nums",
        // A reason must be read whole; plain readings may truncate.
        text.tone === "full" || text.tone === "warn" ? "line-clamp-2" : "truncate",
        TONE_TEXT[text.tone],
      )}
      data-model-usage-tone={text.tone}
    >
      {text.short}
    </span>
  );
}

/** A 12px ring filled clockwise by the share left; dashed when the read can't be relied on. */
function MeterRing({
  percent,
  tone,
  dashed,
}: {
  readonly percent: number | null;
  readonly tone: "ok" | "warn" | "full" | "muted";
  readonly dashed: boolean;
}) {
  const radius = 4.75;
  const circumference = 2 * Math.PI * radius;
  const left = Math.min(100, Math.max(0, percent ?? 0));
  return (
    <svg
      // Status fills colour the strokes; text classes stay on their -foreground pairs.
      className={cn(
        "size-3 shrink-0",
        tone === "full"
          ? "stroke-destructive"
          : tone === "warn"
            ? "stroke-warning"
            : "stroke-muted-foreground",
      )}
      viewBox="0 0 12 12"
      aria-hidden
    >
      <circle
        cx="6"
        cy="6"
        r={radius}
        fill="none"
        strokeWidth="1.75"
        strokeOpacity={tone === "full" ? 1 : dashed ? 0.7 : 0.25}
        {...(dashed ? { strokeDasharray: "2 1.6" } : {})}
      />
      {percent === null || left === 0 || dashed ? null : (
        <circle
          cx="6"
          cy="6"
          r={radius}
          fill="none"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeDasharray={`${(left / 100) * circumference} ${circumference}`}
          transform="rotate(-90 6 6)"
        />
      )}
    </svg>
  );
}

/**
 * The composer trigger's meter for the selected model. It names only what a
 * read supports: room, a reached limit, or an old read; a provider that does
 * not report shows nothing rather than a guess.
 */
export function ModelUsageMeter({
  state,
  text,
  hideValueClassName,
}: {
  readonly state: ModelAvailability;
  readonly text: AvailabilityText;
  /** Classes that hide the number when the composer is narrow; the ring stays. */
  readonly hideValueClassName?: string;
}) {
  let ring: { percent: number | null; tone: "ok" | "warn" | "full" | "muted"; dashed: boolean };
  let value: string | null;
  switch (state.kind) {
    case "room":
      ring = { percent: state.leftPercent, tone: state.tone, dashed: false };
      value = `${state.leftPercent}%`;
      break;
    case "exhausted":
    case "denied":
      ring = {
        percent: 0,
        tone: isAvailabilityBlocking(state) ? "full" : "warn",
        dashed: false,
      };
      value = "Limit";
      break;
    // A dashed ring and a word: the reading can't be vouched for, and says so.
    case "stale":
      ring = { percent: null, tone: state.wasExhausted ? "warn" : "muted", dashed: true };
      value = state.resetSinceRead
        ? "Reset"
        : state.wasExhausted
          ? "Limit?"
          : state.leftPercent === null || state.leftPercent >= 100
            ? "Old"
            : `~${state.leftPercent}%`;
      break;
    case "loading":
      ring = { percent: null, tone: "muted", dashed: true };
      value = "Checking";
      break;
    case "unknown":
      ring = { percent: null, tone: "muted", dashed: true };
      value = text.short;
      break;
    case "offline":
      ring = { percent: null, tone: "muted", dashed: true };
      value = "Offline";
      break;
    default:
      return null;
  }
  return (
    <span
      className="flex shrink-0 items-center gap-1 tabular-nums"
      data-model-usage-meter={state.kind}
      aria-hidden
    >
      <MeterRing {...ring} />
      {value ? (
        <span
          className={cn(
            "text-xs",
            ring.tone === "full"
              ? "text-destructive-foreground"
              : ring.tone === "warn"
                ? "text-warning-foreground"
                : "text-muted-foreground",
            hideValueClassName,
          )}
        >
          {value}
        </span>
      ) : null}
    </span>
  );
}

function scopedLabel(window: ServerProviderUsageWindow): { label: string; family: string | null } {
  const family = windowModelScope(window);
  return { label: window.label, family };
}

/**
 * One window: label, bar of what is left, the value, and when it resets. An
 * untrusted read (old, or the probe failed) draws a faded bar and an
 * approximate value, never a firm number.
 */
function BandWindow({
  window,
  windows,
  usage,
  trusted,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly usage: ModelPickerUsage;
  readonly trusted: boolean;
}) {
  const { nowMs } = usage;
  const left = roomLeftPercent(window.usedPercent);
  const tone = trusted ? usageTone(left) : "ok";
  const resetAt = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  const resetKnown = Number.isFinite(resetAt) && resetAt > nowMs;
  const blocker = blockingWindow(window, windows, nowMs);
  const { label, family } = scopedLabel(window);
  const spent = window.usedPercent >= 100;
  const value = !trusted
    ? spent
      ? "Limit?"
      : `~${left}% left`
    : blocker
      ? "Blocked"
      : spent
        ? "Limit reached"
        : `${left}% left`;
  const reset = resetKnown ? formatDuration(resetAt - nowMs) : "";
  const reading = !trusted
    ? `${spent ? "limit reached" : `${left}% left`} when last read, too old to rely on`
    : blocker
      ? `${left}% left but blocked by the ${blocker.label.toLowerCase()} limit`
      : value;
  const description = `${label}${family ? `, only ${family} models` : ", every model on this account"}: ${reading}${
    resetKnown ? `, resets ${usage.formatAt(resetAt)} (in ${reset})` : ""
  }`;
  return (
    <li
      className="grid grid-cols-[minmax(0,5.5rem)_minmax(1.5rem,1fr)_auto_3.25rem] items-center gap-2"
      aria-label={description}
      data-model-usage-window={window.id}
      data-scope={family ? "model" : "account"}
    >
      <span className={cn("truncate text-muted-foreground", blocker && trusted && "opacity-70")}>
        {label}
      </span>
      <span
        className={cn("sws-usage-bar", !trusted && "opacity-45")}
        data-tone={blocker && trusted ? "blocked" : tone}
        aria-hidden
      >
        <span style={{ width: `${left}%` }} />
      </span>
      <span
        className={cn(
          "truncate text-right tabular-nums",
          blocker || !trusted
            ? "text-muted-foreground"
            : tone === "full"
              ? "text-destructive-foreground"
              : tone === "warn"
                ? "text-warning-foreground"
                : "text-foreground",
        )}
      >
        {value}
      </span>
      <span className="truncate text-right text-muted-foreground tabular-nums">{reset}</span>
    </li>
  );
}

/** A window whose reset passed since the read: its room is unknown until the next read. */
function ResetWindow({ window }: { readonly window: ServerProviderUsageWindow }) {
  return (
    <li
      className="grid grid-cols-[minmax(0,5.5rem)_minmax(1.5rem,1fr)_auto] items-center gap-2"
      aria-label={`${window.label}: reset since the last read, not read since`}
      data-model-usage-window={window.id}
      data-reset-since-read="true"
    >
      <span className="truncate text-muted-foreground">{window.label}</span>
      <span
        className="h-1.5 rounded-full border border-dashed border-muted-foreground/50"
        aria-hidden
      />
      <span className="truncate text-right text-muted-foreground">Reset, not read since</span>
    </li>
  );
}

function readAgo(checkedAt: string | undefined, nowMs: number): string | null {
  const at = checkedAt === undefined ? Number.NaN : Date.parse(checkedAt);
  if (!Number.isFinite(at)) return null;
  const ms = nowMs - at;
  return ms < 60_000 ? "read just now" : `read ${formatDuration(ms)} ago`;
}

/**
 * The selected provider's usage above its model list: every live window with
 * what is left, which windows are shared by the whole account and which cap
 * one model family, and the machine the account is signed in on. States
 * without bars get one plain sentence.
 */
export function ModelPickerUsageBand({
  entry,
  usage,
}: {
  readonly entry: ProviderInstanceEntry;
  readonly usage: ModelPickerUsage;
}) {
  const state = usage.availability(entry.instanceId, null);
  const limits = entry.snapshot.usageLimits;
  const all = limits?.windows ?? [];
  const windows = all.filter((window) => isLiveWindow(window, usage.nowMs));
  const resetSinceRead = all.filter((window) => !isLiveWindow(window, usage.nowMs));
  const showBars = all.length > 0 && state.kind !== "offline" && state.kind !== "perToken";
  const heading = `${entry.displayName}${usage.machineLabel ? ` on ${usage.machineLabel}` : ""}`;
  // The same read time the state is judged on.
  const ago = readAgo(limits?.nativeAllowanceObservedAt ?? limits?.checkedAt, usage.nowMs);
  const sentence = usage.text(entry.instanceId, state);
  const trusted = state.kind !== "stale" && state.kind !== "unknown";
  const isAccountWide = (window: ServerProviderUsageWindow) => windowModelScope(window) === null;
  const accountWide = windows.filter(isAccountWide);
  const scoped = windows.filter((window) => !isAccountWide(window));
  const accountReset = resetSinceRead.filter(isAccountWide);
  const scopedReset = resetSinceRead.filter((window) => !isAccountWide(window));
  return (
    <section
      className="shrink-0 border-b border-border/70 px-3 pt-2 pb-2.5 text-xs leading-snug"
      aria-label={`${heading} usage`}
      data-model-picker-usage-band={state.kind}
    >
      <header className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate font-medium text-foreground">{heading}</span>
        {showBars && ago ? (
          <span
            className={cn(
              "ms-auto shrink-0 tabular-nums",
              state.kind === "stale" ? "text-warning-foreground" : "text-muted-foreground",
            )}
          >
            {ago}
          </span>
        ) : null}
      </header>
      {showBars ? (
        <>
          <ul className="mt-1.5 flex flex-col gap-1" aria-label="Shared by every model">
            {accountWide.map((window) => (
              <BandWindow
                key={window.id}
                window={window}
                windows={windows}
                usage={usage}
                trusted={trusted}
              />
            ))}
            {accountReset.map((window) => (
              <ResetWindow key={window.id} window={window} />
            ))}
          </ul>
          {scoped.length > 0 || scopedReset.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-1" aria-label="Limits for one model family">
              {scoped.map((window) => (
                <BandWindow
                  key={window.id}
                  window={window}
                  windows={windows}
                  usage={usage}
                  trusted={trusted}
                />
              ))}
              {scopedReset.map((window) => (
                <ResetWindow key={window.id} window={window} />
              ))}
            </ul>
          ) : null}
          {isAvailabilityBlocking(state) || !trusted ? (
            <p className={cn("mt-1.5", TONE_TEXT[sentence.tone])} role="note">
              {sentence.long}
            </p>
          ) : null}
        </>
      ) : (
        <p className={cn("mt-0.5", TONE_TEXT[sentence.tone])}>{sentence.long}</p>
      )}
    </section>
  );
}

/** While a turn runs, a pick changes the next message, not the one already running. */
export function ModelPickerRunningNote({
  runningLabel,
  pickedDiffers,
}: {
  readonly runningLabel: string;
  readonly pickedDiffers: boolean;
}) {
  return (
    <p
      className="shrink-0 border-t border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground"
      data-model-picker-running-note="true"
    >
      <span className="text-foreground">Running on {runningLabel}.</span>{" "}
      {pickedDiffers
        ? "Your pick applies from the next message."
        : "A new pick applies from the next message."}
    </p>
  );
}
