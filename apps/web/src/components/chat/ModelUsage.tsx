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
  windowName,
  windowTitle,
} from "@specweave-studio/shared/usageWindows";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  foldMachineAccountSwitches,
  planLabel,
  type MachineAccountSwitches,
  type SeenAccount,
} from "../../studio/accountSwitches";
import {
  accountLimitPhrase,
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
  /** The machine whose provider snapshots the picker shows; scopes account-switch memory. */
  readonly environmentId: string;
  readonly machineLabel: string | null;
  /** The model the current turn runs on, while one runs. */
  readonly running: { readonly instanceId: ProviderInstanceId; readonly model: string } | null;
  /**
   * The model the host moves the next turn to while the chip's model is out of
   * room, when a fallback is on and one is eligible. Null says the turn waits.
   */
  readonly nextOnLimit?: string | null;
  /** Which chat the picker serves, for the marker on the account line. */
  readonly surface?: "thread" | "coordinator";
}

/** The picker's resolved usage view: one clock, one formatter, every model's state. */
export interface ModelPickerUsage extends ModelPickerUsageConfig {
  readonly nowMs: number;
  availability(instanceId: ProviderInstanceId, model: string | null): ModelAvailability;
  text(instanceId: ProviderInstanceId, availability: ModelAvailability): AvailabilityText;
  /** Advisory usage warning; deliberate model selection remains available. */
  warningReason(instanceId: ProviderInstanceId, model: string): string | null;
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
  const switchedAt = useAccountSwitches(config?.environmentId ?? "", entries);
  const availability = useCallback(
    (instanceId: ProviderInstanceId, model: string | null) =>
      modelAvailability({
        provider: byId.get(instanceId)?.snapshot,
        model,
        nowMs,
        ...(connected === undefined ? {} : { connected }),
        machineLabel,
        previousAccountReadAt: switchedAt.get(instanceId) ?? null,
      }),
    [byId, connected, machineLabel, nowMs, switchedAt],
  );
  const text = useCallback(
    (instanceId: ProviderInstanceId, state: ModelAvailability) => {
      const entry = byId.get(instanceId);
      return availabilityText(state, {
        provider: entry?.displayName ?? "This provider",
        account: entry ? planLabel(entry.snapshot.auth) : null,
        machine: machineLabel,
        nowMs,
        formatAt,
      });
    },
    [byId, formatAt, machineLabel, nowMs],
  );
  const warningReason = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      const state = availability(instanceId, model);
      return isAvailabilityBlocking(state) ? text(instanceId, state).long : null;
    },
    [availability, text],
  );
  return useMemo(
    () => (config ? { ...config, nowMs, availability, text, warningReason, formatAt } : undefined),
    [availability, warningReason, config, formatAt, nowMs, text],
  );
}

/**
 * For each instance this client saw sign in to another account on the
 * picker's machine, the time of the last read it held before the change. That
 * read and older ones are the previous account's and never show; the new
 * account's first read does. A probe that names nobody, or only a key where
 * the last named an email, is no switch (see `foldAccountSwitches`). Memory is
 * kept per machine: the picker is not remounted when the thread moves to
 * another machine, whose same instance may be signed in to another account.
 */
function useAccountSwitches(
  machine: string,
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyMap<ProviderInstanceId, number> {
  const seen = useRef(new Map<string, Map<ProviderInstanceId, SeenAccount>>());
  const [switched, setSwitched] = useState<MachineAccountSwitches>(NO_MACHINE_SWITCHES);
  useEffect(() => {
    const next = foldMachineAccountSwitches(seen.current, switched, machine, entries);
    if (next) setSwitched(next);
  }, [entries, machine, switched]);
  return switched.get(machine) ?? NO_SWITCHES;
}

const NO_MACHINE_SWITCHES: MachineAccountSwitches = new Map();
const NO_SWITCHES: ReadonlyMap<ProviderInstanceId, number> = new Map();

const TONE_TEXT: Record<AvailabilityText["tone"], string> = {
  muted: "text-muted-foreground",
  ok: "text-muted-foreground",
  warn: "text-warning-foreground",
  full: "text-destructive-foreground",
};

/**
 * What a model row reads: under an account-wide binding, the family window the
 * row's model also has (the account-wide room is the band's, not the row's).
 */
export function rowAvailability(state: ModelAvailability): ModelAvailability {
  if (state.kind !== "room" || !state.familyRoom) return state;
  const { familyRoom, ...room } = state;
  return { ...room, ...familyRoom };
}

/**
 * Which states a model row names. Room on an account-wide window belongs to the
 * account, not the model, so rows never repeat it; the band or the account line
 * says it once. Family windows, blocks and the denied, stale and unknown states
 * stay on the row. Providers that never report say so once, in the band.
 */
export function rowShowsAvailability(state: ModelAvailability, inProviderTab: boolean): boolean {
  if (state.kind === "room") return state.binding.scope === "model" || !!state.familyRoom;
  if (state.kind === "unreported" || state.kind === "perToken" || state.kind === "loading") {
    return !inProviderTab;
  }
  return true;
}

/**
 * The account limits behind a mixed list (Favorites, search, alternatives), where
 * no provider band shows: one line, the displayed model's provider first, which
 * wraps rather than hiding providers behind "+N".
 */
export function ModelPickerAccountLine({
  entries,
  usage,
  markedInstanceId,
}: {
  /** Providers with visible rows, the displayed model's first. */
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly usage: ModelPickerUsage;
  /** The provider the marker names ("this thread", "coordinator"); null leaves it out. */
  readonly markedInstanceId: ProviderInstanceId | null;
}) {
  const marker = usage.surface === "coordinator" ? "coordinator" : "this thread";
  const items = entries.flatMap((entry) => {
    const state = usage.availability(entry.instanceId, null);
    const phrase = accountLimitPhrase(state, {
      nowMs: usage.nowMs,
      short: usage.text(entry.instanceId, state).short,
    });
    if (phrase === null) return [];
    const tone = isAvailabilityBlocking(state)
      ? "full"
      : state.kind === "room" && state.tone === "warn"
        ? "warn"
        : state.kind === "exhausted"
          ? "warn"
          : "muted";
    return [
      {
        id: entry.instanceId,
        text: `${entry.displayName} ${phrase}${entry.instanceId === markedInstanceId ? ` (${marker})` : ""}`,
        tone,
      } as const,
    ];
  });
  if (items.length === 0) return null;
  return (
    <p
      className="shrink-0 border-b border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground"
      data-model-picker-account-line=""
    >
      <span className="text-foreground">Account limits:</span>{" "}
      {items.map((item, index) => (
        <span key={item.id}>
          {index > 0 ? " · " : null}
          <span className={cn("tabular-nums", TONE_TEXT[item.tone])}>{item.text}</span>
        </span>
      ))}
    </p>
  );
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
  chip,
}: {
  readonly percent: number | null;
  readonly tone: "ok" | "warn" | "full" | "muted";
  readonly dashed: boolean;
  readonly chip?: boolean | undefined;
}) {
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
      {...(chip ? { "data-model-chip-part": "usage-ring" } : {})}
    >
      {/* pathLength keeps the fill right whatever radius the CSS gives the ring. */}
      <circle
        cx="6"
        cy="6"
        r="4.75"
        pathLength={100}
        fill="none"
        strokeWidth="1.75"
        strokeOpacity={tone === "full" ? 1 : dashed ? 0.7 : 0.25}
        {...(dashed ? { strokeDasharray: "5 4" } : {})}
      />
      {percent === null || left === 0 || dashed ? null : (
        <circle
          cx="6"
          cy="6"
          r="4.75"
          pathLength={100}
          fill="none"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeDasharray={`${left} 100`}
          transform="rotate(-90 6 6)"
        />
      )}
    </svg>
  );
}

/** The ring, number and detail a meter draws for a state; null when it draws nothing. */
export function meterParts(
  state: ModelAvailability,
  text: AvailabilityText,
  input: { readonly nowMs: number; readonly nextOnLimit?: string | null },
): {
  readonly ring: {
    percent: number | null;
    tone: "ok" | "warn" | "full" | "muted";
    dashed: boolean;
  };
  readonly value: string;
  /** What a spent limit means for the next turn: `next on Opus 5.5`, `resets in 5d 23h`. */
  readonly detail: string | null;
} | null {
  switch (state.kind) {
    case "room":
      return {
        ring: { percent: state.leftPercent, tone: state.tone, dashed: false },
        value: `${state.leftPercent}%`,
        detail: null,
      };
    case "exhausted":
    case "denied": {
      // Extra usage still runs turns: amber, and never the word Limit.
      if (!isAvailabilityBlocking(state)) {
        return { ring: { percent: 0, tone: "warn", dashed: false }, value: "Extra", detail: null };
      }
      const resetsAt = state.kind === "exhausted" ? state.binding.resetsAt : state.resetsAt;
      const detail = input.nextOnLimit
        ? `next on ${input.nextOnLimit}`
        : resetsAt !== null && resetsAt > input.nowMs
          ? `resets in ${formatDuration(resetsAt - input.nowMs)}`
          : null;
      return { ring: { percent: 0, tone: "full", dashed: false }, value: "Limit", detail };
    }
    // A dashed ring and a word: the reading can't be vouched for, and says so.
    case "stale":
      return {
        ring: { percent: null, tone: state.wasExhausted ? "warn" : "muted", dashed: true },
        value: state.resetSinceRead
          ? "Reset"
          : state.wasExhausted
            ? "Limit?"
            : state.leftPercent === null || state.leftPercent >= 100
              ? "Old"
              : `~${state.leftPercent}%`,
        detail: null,
      };
    case "loading":
      return {
        ring: { percent: null, tone: "muted", dashed: true },
        value: "Checking",
        detail: null,
      };
    case "unknown":
      return {
        ring: { percent: null, tone: "muted", dashed: true },
        value: text.short,
        detail: null,
      };
    case "offline":
      return {
        ring: { percent: null, tone: "muted", dashed: true },
        value: "Offline",
        detail: null,
      };
    // Per token gets a tag, not a ring; an unreported or switched account shows nothing.
    case "perToken":
      return {
        ring: { percent: null, tone: "muted", dashed: false },
        value: "per token",
        detail: null,
      };
    default:
      return null;
  }
}

const RING_TONE_TEXT = {
  full: "text-destructive-foreground",
  warn: "text-warning-foreground",
  ok: "text-muted-foreground",
  muted: "text-muted-foreground",
} as const;

/**
 * The composer trigger's meter for the selected model. It names only what a
 * read supports: room, a reached limit, or an old read; a provider that does
 * not report shows nothing rather than a guess. Its words reach assistive
 * technology through the trigger's name and description, so the meter itself
 * is hidden from them.
 */
export function ModelUsageMeter({
  state,
  text,
  nowMs = Date.now(),
  nextOnLimit,
  hideValueClassName,
  chip,
}: {
  readonly state: ModelAvailability;
  readonly text: AvailabilityText;
  readonly nowMs?: number;
  readonly nextOnLimit?: string | null;
  /** Classes that hide the number when the composer is narrow; the ring stays. */
  readonly hideValueClassName?: string;
  /** The number is a part of an enclosing model chip, whose fit decides when it shows. */
  readonly chip?: boolean;
}) {
  const parts = meterParts(state, text, { nowMs, nextOnLimit: nextOnLimit ?? null });
  if (parts === null) return null;
  const { ring, value, detail } = parts;
  const perToken = state.kind === "perToken";
  return (
    <span
      className="flex shrink-0 items-center gap-1 tabular-nums"
      data-model-usage-meter={state.kind}
      aria-hidden
    >
      {perToken ? null : <MeterRing {...ring} chip={chip} />}
      <span
        className={cn(
          "text-xs",
          perToken
            ? "rounded-sm border border-border px-1 text-muted-foreground"
            : RING_TONE_TEXT[ring.tone],
          hideValueClassName,
        )}
        {...(chip ? { "data-model-chip-part": "usage-value" } : {})}
      >
        {value}
      </span>
      {detail ? (
        <span
          className={cn("text-xs", RING_TONE_TEXT[ring.tone], hideValueClassName)}
          {...(chip ? { "data-model-chip-part": "usage-detail" } : {})}
        >
          · {detail}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The meter at the chip's leanest fit: a ring around the provider mark, so the
 * mark and the usage take the room of one icon. Out of flow, so it never adds
 * to the chip's width; the chip's CSS shows it only at the `icon` fit.
 */
export function ModelUsageMarkRing({
  state,
  text,
}: {
  readonly state: ModelAvailability;
  readonly text: AvailabilityText;
}) {
  const parts = meterParts(state, text, { nowMs: 0 });
  if (parts === null || state.kind === "perToken") return null;
  return (
    <span className="sws-model-mark-ring" data-model-mark-ring={state.kind} aria-hidden>
      <MeterRing {...parts.ring} />
    </span>
  );
}

function scopedLabel(window: ServerProviderUsageWindow): { label: string; family: string | null } {
  const family = windowModelScope(window);
  return { label: windowTitle(window), family };
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
      ? `${left}% left but blocked by the ${windowName(blocker)} limit`
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
      aria-label={`${windowTitle(window)}: reset since the last read, not read since`}
      data-model-usage-window={window.id}
      data-reset-since-read="true"
    >
      <span className="truncate text-muted-foreground">{windowTitle(window)}</span>
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
  // While the account switches, the windows on hand belong to the previous
  // account: show the sentence, never their numbers.
  const showBars =
    all.length > 0 &&
    state.kind !== "offline" &&
    state.kind !== "perToken" &&
    state.kind !== "switching";
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
  pickLabel,
}: {
  readonly runningLabel: string;
  /** The pick when it differs from the running model; null when they match. */
  readonly pickLabel: string | null;
}) {
  return (
    <p
      className="shrink-0 border-t border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground"
      data-model-picker-running-note={pickLabel ? "differs" : "same"}
    >
      {pickLabel ? (
        <>
          <span className="text-foreground">This turn stays on {runningLabel}.</span> Your pick,{" "}
          {pickLabel}, starts with your next message.
        </>
      ) : (
        "Picks apply from your next message."
      )}
    </p>
  );
}
