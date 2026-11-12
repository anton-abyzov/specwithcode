/**
 * What a provider's usage means for one model, as the model picker and the
 * chat usage chip show it. It reads the provider snapshot the server already
 * publishes (the same windows Usage → Limits draws) and never asks a provider
 * for anything.
 *
 * Only a confirmed read warns of a limit: a fresh snapshot with a spent
 * window that applies to the model, or the native admission denial the server
 * itself refuses turns on. Anything we cannot vouch for (no read yet, an old
 * read, a failed probe, a provider that never reports, an offline machine)
 * stays selectable and says so. Even a confirmed limit is advisory when the
 * user deliberately selects a model; the server decides whether a turn runs.
 *
 * @module modelAvailability
 */
import type { ServerProvider, ServerProviderUsageWindow } from "@specweave-studio/contracts";
import { MACHINE_USAGE_MAX_AGE_MS } from "@specweave-studio/shared/machineFallback";
import { isPerTokenProvider, usageDeniesTurn } from "@specweave-studio/shared/providerFallback";
import { formatDuration } from "@specweave-studio/shared/usageLimits";
import {
  isLiveWindow,
  windowAppliesToModel,
  windowModelScope,
  windowName,
} from "@specweave-studio/shared/usageWindows";

import { leftPercent, usageTone, type UsageTone } from "./usageIndicatorModel";

/** A read older than this is shown as old and never disables anything. */
export const USAGE_FRESH_MS = MACHINE_USAGE_MAX_AGE_MS;

/** A read older than this is checked again when the picker opens, and shows its age. */
export const USAGE_RECHECK_AFTER_MS = 5 * 60_000;

/**
 * An old "limit reached" with no reset time stops counting after this long:
 * without a reset time nothing says the limit still holds, so the state becomes
 * "not read" and is checked again instead of lingering as "Limit?" forever.
 * A known reset time is honoured however old the read is.
 */
export const STALE_LIMIT_EXPIRY_MS = 60 * 60_000;

/** Drivers whose signed-in instances always report subscription windows. */
const SUBSCRIPTION_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

/** Whose quota the binding window is: the whole account, or one model family on it. */
export type UsageScope = "account" | "model";

export interface UsageBinding {
  readonly label: string;
  /** The shared window name for a sentence: `5-hour`, `weekly`, `Fable weekly`. */
  readonly name: string;
  readonly scope: UsageScope;
  /** The model family a model-scoped window caps (`Fable`). */
  readonly family: string | null;
  readonly resetsAt: number | null;
}

export type ModelAvailability =
  /** Room left on a fresh read. `binding` is the window with the least left. */
  | {
      readonly kind: "room";
      readonly leftPercent: number;
      readonly tone: UsageTone;
      readonly binding: UsageBinding;
      readonly checkedAt: number;
      /**
       * When an account-wide window binds, the tightest family window that also
       * applies: model rows show it, the band shows the account-wide one.
       */
      readonly familyRoom?: {
        readonly leftPercent: number;
        readonly tone: UsageTone;
        readonly binding: UsageBinding;
      };
    }
  /**
   * A fresh read shows a spent window that applies to this model. Unless the
   * provider still says it accepts ordinary turns (extra usage on the account),
   * no turn can run on it until the reset.
   */
  | {
      readonly kind: "exhausted";
      readonly binding: UsageBinding;
      readonly checkedAt: number;
      readonly providerAllows: boolean;
    }
  /** The provider's own admission refuses turns (spend cap, rate limit), whatever the bars say. */
  | {
      readonly kind: "denied";
      readonly detail: string | null;
      readonly resetsAt: number | null;
      readonly checkedAt: number;
    }
  /** The last read is too old to rely on; `wasExhausted` when it showed the limit reached. */
  | {
      readonly kind: "stale";
      readonly leftPercent: number | null;
      readonly wasExhausted: boolean;
      readonly checkedAt: number;
      readonly resetSinceRead: boolean;
      /** When the spent window it showed resets, if reported and still ahead. */
      readonly resetsAt?: number | null;
    }
  /**
   * Signed in to a subscription but no usage read has arrived yet, or
   * (`refreshing`) an old reading is being read again right now.
   */
  | { readonly kind: "loading"; readonly refreshing?: boolean }
  /** The provider could not be read, or reported no windows. */
  | {
      readonly kind: "unknown";
      readonly reason: "probeFailed" | "notSignedIn" | "noWindows" | "notRead";
    }
  /** Billed per token (an API key or Bedrock): no subscription quota. */
  | { readonly kind: "perToken" }
  /**
   * The provider reports no usage. `message` is the machine's reason when it
   * tried and could not read it (for Copilot: which GitHub CLI sign-in is
   * missing), so the picker says what to do instead of a generic line.
   */
  | { readonly kind: "unreported"; readonly message?: string }
  /** The machine that runs the provider is not connected. */
  | { readonly kind: "offline"; readonly machineLabel: string | null }
  /**
   * The signed-in account changed and the new one has not been read yet. The
   * reading on hand belongs to the previous account, so nothing of it shows.
   */
  | { readonly kind: "switching" };

export interface ModelAvailabilityInput {
  readonly provider: ServerProvider | undefined;
  readonly model: string | null | undefined;
  readonly nowMs: number;
  /** False while the machine is not connected; its snapshot is then only a memory. */
  readonly connected?: boolean;
  readonly machineLabel?: string | null;
  /**
   * After this client saw the instance sign in to another account: the time of
   * the last read it held before the change. That read, and any older, is the
   * previous account's.
   */
  readonly previousAccountReadAt?: number | null;
}

const parseMs = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

function binding(window: ServerProviderUsageWindow): UsageBinding {
  const family = windowModelScope(window);
  return {
    label: window.label,
    name: windowName(window),
    scope: family === null ? "account" : "model",
    family,
    resetsAt: parseMs(window.resetsAt),
  };
}

/** What is left, never rounded to 0% while the window still has room. */
export function roomLeftPercent(usedPercent: number): number {
  return usedPercent >= 100 ? 0 : Math.max(1, leftPercent(usedPercent));
}

const resetOrder = (window: ServerProviderUsageWindow) =>
  parseMs(window.resetsAt) ?? Number.POSITIVE_INFINITY;

export function modelAvailability(input: ModelAvailabilityInput): ModelAvailability {
  const { provider, nowMs } = input;
  if (input.connected === false) {
    return { kind: "offline", machineLabel: input.machineLabel ?? null };
  }
  if (provider === undefined) return { kind: "loading" };
  if (isPerTokenProvider(provider)) return { kind: "perToken" };
  const limits = provider.usageLimits;
  if (limits === undefined) {
    if (!SUBSCRIPTION_DRIVERS.has(provider.driver)) return { kind: "unreported" };
    if (provider.auth.status === "unauthenticated") {
      return { kind: "unknown", reason: "notSignedIn" };
    }
    // A provider checked a while ago with no usage read is not still loading.
    const providerCheckedAt = parseMs(provider.checkedAt);
    return providerCheckedAt !== null && nowMs - providerCheckedAt > USAGE_FRESH_MS
      ? { kind: "unknown", reason: "notRead" }
      : { kind: "loading" };
  }

  const checkedAt = parseMs(limits.nativeAllowanceObservedAt ?? limits.checkedAt) ?? 0;
  // A read older than the account change describes the previous account.
  const changedAt = parseMs(limits.accountChangedAt);
  if (
    (changedAt !== null && checkedAt < changedAt) ||
    (input.previousAccountReadAt != null && checkedAt <= input.previousAccountReadAt)
  )
    return { kind: "switching" };
  const isFresh = (at: number) => nowMs - at <= USAGE_FRESH_MS && at <= nowMs + 60_000;
  const fresh = isFresh(checkedAt);
  const windows = limits.windows.filter((window) => windowAppliesToModel(window, input.model));
  const live = windows.filter((window) => isLiveWindow(window, nowMs));
  // The binding spent window: an account-wide one first (it stops every model),
  // then whichever resets last.
  const spent = live
    .filter((window) => window.usedPercent >= 100)
    .toSorted(
      (left, right) =>
        Number(windowModelScope(left) !== null) - Number(windowModelScope(right) !== null) ||
        resetOrder(right) - resetOrder(left),
    );
  // A reset passing is no proof of room: the server reads again before it trusts it.
  const resetSinceRead = windows.length > live.length;
  const spentResetsAt =
    spent
      .map((window) => parseMs(window.resetsAt))
      .find((at): at is number => at !== null && at > nowMs) ?? null;
  // An old spent read with no reset time ahead no longer says anything.
  const expired = (at: number) =>
    !resetSinceRead && spentResetsAt === null && nowMs - at > STALE_LIMIT_EXPIRY_MS;

  if (usageDeniesTurn(provider)) {
    // A sparse denial is stamped on its own; it is as fresh as when it was seen.
    const deniedAt = Math.max(checkedAt, parseMs(limits.nativeDenialObservedAt) ?? 0);
    if (isFresh(deniedAt) && !resetSinceRead) {
      return {
        kind: "denied",
        detail: limits.rateLimitReachedType ?? null,
        resetsAt: spent[0] ? parseMs(spent[0].resetsAt) : null,
        checkedAt: deniedAt,
      };
    }
    // The server still refuses turns on this denial, so it never expires here;
    // opening the picker reads it again instead.
    return {
      kind: "stale",
      leftPercent: null,
      wasExhausted: true,
      checkedAt: deniedAt,
      resetSinceRead,
      resetsAt: spentResetsAt,
    };
  }
  // A lookup without quota data: kept windows are history, not a read.
  const unreadable =
    limits.unavailable?.reason === "probeFailed" || limits.unavailable?.reason === "unsupported";
  if (limits.unavailable?.reason === "unsupported" && limits.windows.length === 0) {
    if (provider.auth.status === "unauthenticated") {
      return { kind: "unknown", reason: "notSignedIn" };
    }
    const message = limits.unavailable.message?.trim();
    return message ? { kind: "unreported", message } : { kind: "unreported" };
  }

  if (unreadable && live.length === 0) {
    return { kind: "unknown", reason: "probeFailed" };
  }
  if (windows.length === 0) {
    return provider.auth.status === "unauthenticated"
      ? { kind: "unknown", reason: "notSignedIn" }
      : { kind: "unknown", reason: "noWindows" };
  }

  const least = live.reduce<ServerProviderUsageWindow | null>(
    (best, window) => (best === null || window.usedPercent > best.usedPercent ? window : best),
    null,
  );
  const left = least ? roomLeftPercent(least.usedPercent) : null;
  // A window that reset since the read could hold anything now; only a live
  // spent window still proves the model is out.
  const trusted = fresh && !unreadable && (!resetSinceRead || spent.length > 0);

  if (!trusted || least === null) {
    if (spent.length > 0 && expired(checkedAt)) return { kind: "unknown", reason: "notRead" };
    return {
      kind: "stale",
      leftPercent: left,
      wasExhausted: spent.length > 0,
      checkedAt,
      resetSinceRead,
      resetsAt: spentResetsAt,
    };
  }
  if (spent[0]) {
    return {
      kind: "exhausted",
      binding: binding(spent[0]),
      checkedAt,
      providerAllows: limits.ordinaryUsageAllowed === true,
    };
  }
  const tightestFamily =
    windowModelScope(least) === null
      ? live
          .filter((window) => windowModelScope(window) !== null)
          .reduce<ServerProviderUsageWindow | null>(
            (best, window) =>
              best === null || window.usedPercent > best.usedPercent ? window : best,
            null,
          )
      : null;
  const familyLeft = tightestFamily ? roomLeftPercent(tightestFamily.usedPercent) : 0;
  return {
    kind: "room",
    leftPercent: left ?? 0,
    tone: usageTone(left ?? 0),
    binding: binding(least),
    checkedAt,
    ...(tightestFamily
      ? {
          familyRoom: {
            leftPercent: familyLeft,
            tone: usageTone(familyLeft),
            binding: binding(tightestFamily),
          },
        }
      : {}),
  };
}

/** Only a confirmed read indicates a turn may be blocked by usage. */
export function isAvailabilityBlocking(availability: ModelAvailability): boolean {
  return (
    (availability.kind === "exhausted" && !availability.providerAllows) ||
    availability.kind === "denied"
  );
}

function resetPhrase(resetsAt: number | null, nowMs: number, formatAt?: (ms: number) => string) {
  if (resetsAt === null) return null;
  if (resetsAt <= nowMs) return "resets now";
  const inText = formatDuration(resetsAt - nowMs);
  return formatAt ? `resets ${formatAt(resetsAt)} (in ${inText})` : `resets in ${inText}`;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function agoPhrase(checkedAt: number, nowMs: number) {
  if (checkedAt <= 0) return "a while ago";
  return nowMs - checkedAt < 60_000 ? "just now" : `${formatDuration(nowMs - checkedAt)} ago`;
}

/** When a trusted read was taken, for the tooltip: `Checked just now.` */
function readSentence(checkedAt: number, nowMs: number) {
  return `Checked ${agoPhrase(checkedAt, nowMs)}.`;
}

/** ` · checked 7m ago` once a trusted read is old enough to matter; empty before. */
export function readAgeSuffix(checkedAt: number, nowMs: number): string {
  return checkedAt > 0 && nowMs - checkedAt >= USAGE_RECHECK_AFTER_MS
    ? ` · checked ${agoPhrase(checkedAt, nowMs)}`
    : "";
}

export interface AvailabilityText {
  /** Fits a model row's provider line: `62% left · resets in 2h 4m`. */
  readonly short: string;
  /** A phrase for an accessible name: `5% of 5-hour limit left`. */
  readonly label: string;
  /**
   * Plain sentences for the tooltip and the accessible description: the
   * account (by plan or provider, never the email), the machine, the window,
   * what is left, the reset, and whose quota the window is.
   */
  readonly long: string;
  /** Text tone for `short`. */
  readonly tone: "muted" | "ok" | "warn" | "full";
}

const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Words for a model's availability. `provider` names the account's provider
 * (`Claude`), `account` its plan (`Claude Max`) when reported, `machine` where
 * it runs; `formatAt` renders an absolute reset time in the user's format.
 */
export function availabilityText(
  availability: ModelAvailability,
  input: {
    readonly provider: string;
    readonly account?: string | null;
    readonly machine?: string | null;
    readonly nowMs: number;
    readonly formatAt?: (ms: number) => string;
  },
): AvailabilityText {
  const { provider, nowMs, formatAt } = input;
  const account = `the ${input.account?.trim() || provider} account${input.machine ? ` on ${input.machine}` : ""}`;
  const scopeSentence = (window: UsageBinding) =>
    window.scope === "model" && window.family
      ? `It counts only ${window.family} models.`
      : `Every ${provider} model on the account shares it, including use from other machines and apps.`;
  switch (availability.kind) {
    case "room": {
      const { binding: window, leftPercent: left } = availability;
      const scoped = window.scope === "model" && window.family;
      const reset = resetPhrase(window.resetsAt, nowMs);
      const longReset = resetPhrase(window.resetsAt, nowMs, formatAt);
      return {
        short: `${scoped ? `${window.family} ` : ""}${left}% left${reset ? ` · ${reset}` : ""}`,
        label: `${left}% of ${window.name} limit left`,
        long: `${left}% of the ${window.name} limit is left on ${account}${longReset ? `; it ${longReset}` : ""}. ${scopeSentence(window)} ${readSentence(availability.checkedAt, nowMs)}`,
        tone: availability.tone === "ok" ? "ok" : availability.tone,
      };
    }
    case "exhausted": {
      const window = availability.binding;
      const reset = resetPhrase(window.resetsAt, nowMs);
      const longReset = resetPhrase(window.resetsAt, nowMs, formatAt);
      const until = longReset
        ? `until it ${longReset}`
        : "until it resets (no reset time reported)";
      if (availability.providerAllows) {
        return {
          short: `${upperFirst(window.name)} limit reached · still accepted`,
          label: `${window.name} limit reached, extra usage allowed`,
          long: `The ${window.name} limit is used up on ${account}, but ${provider} still reports that it accepts turns, so the model stays selectable. Your ${provider} account settings decide whether extra usage is charged.`,
          tone: "warn",
        };
      }
      if (window.scope === "model" && window.family) {
        return {
          short: `${window.family} limit reached${reset ? ` · ${reset}` : ""}`,
          label: `${window.name} limit reached${reset ? `, ${reset}` : ""}`,
          long: `The ${window.name} limit is used up on ${account}, so ${window.family} models can't run ${until}. It counts only ${window.family} models; other ${provider} models still have their own room. ${readSentence(availability.checkedAt, nowMs)}`,
          tone: "full",
        };
      }
      return {
        short: `${upperFirst(window.name)} limit reached${reset ? ` · ${reset}` : ""}`,
        label: `${window.name} limit reached${reset ? `, ${reset}` : ""}`,
        long: `The ${window.name} limit is used up on ${account}. Every ${provider} model on the account shares it, so none can run ${until}. ${readSentence(availability.checkedAt, nowMs)}`,
        tone: "full",
      };
    }
    case "denied": {
      const reset = resetPhrase(availability.resetsAt, nowMs);
      const longReset = resetPhrase(availability.resetsAt, nowMs, formatAt);
      return {
        short: `${provider} paused new turns${reset ? ` · ${reset}` : ""}`,
        label: `${provider} paused new turns${reset ? `, ${reset}` : ""}`,
        long: `${provider} is refusing new turns on ${account}${availability.detail ? ` (${availability.detail})` : ""}${longReset ? `; it ${longReset}` : ""}. Every ${provider} model on the account is affected.`,
        tone: "full",
      };
    }
    case "stale": {
      const ago = agoPhrase(availability.checkedAt, nowMs);
      // Which limit reset is unknown, so a reached limit may still be in force.
      if (availability.wasExhausted && availability.resetSinceRead) {
        return {
          short: "Limit may have reset",
          label: "limit may have reset since the last read",
          long: `Usage on ${account} was last read ${ago} and showed the limit reached. A limit has reset since, but it may not be that one; the turn may still wait for the reset.`,
          tone: "warn",
        };
      }
      if (availability.wasExhausted) {
        const reset = resetPhrase(availability.resetsAt ?? null, nowMs);
        const longReset = resetPhrase(availability.resetsAt ?? null, nowMs, formatAt);
        return {
          short: `Limit reached ${ago}${reset ? ` · ${reset}` : ""}`,
          label: `limit reached when last read ${ago}${reset ? `, ${reset}` : ""}`,
          long: `Usage on ${account} was last read ${ago} and showed the limit reached${longReset ? `; it ${longReset}` : ""}. That read is too old to rely on, so the model stays selectable and is read again when the picker opens; the turn may still wait for the reset.`,
          tone: "warn",
        };
      }
      if (availability.resetSinceRead) {
        return {
          short: "Limit reset since last read",
          label: "limit reset since the last read",
          long: `Limit reset since last read. A ${provider} limit on ${account} has reset since usage was last read ${ago}; it will be read again before the next turn.`,
          tone: "muted",
        };
      }
      return {
        short:
          availability.leftPercent === null
            ? `Last read ${ago}`
            : `${availability.leftPercent}% left ${ago}`,
        label:
          availability.leftPercent === null
            ? `usage last read ${ago}`
            : `about ${availability.leftPercent}% left when read ${ago}`,
        long: `Usage on ${account} was last read ${ago}. It may have changed since.`,
        tone: "muted",
      };
    }
    case "loading":
      return {
        short: "Checking usage…",
        label: "checking usage",
        long: availability.refreshing
          ? `Reading ${provider} usage again now; the last reading was too old to rely on.`
          : `${provider} usage has not been read yet.`,
        tone: "muted",
      };
    case "unknown": {
      const words =
        availability.reason === "probeFailed"
          ? {
              short: "Usage not reported",
              long: `${provider} usage could not be read. The model stays selectable.`,
            }
          : availability.reason === "notSignedIn"
            ? {
                short: "Not signed in",
                long: `${provider} is not signed in here, so there is no usage to show.`,
              }
            : availability.reason === "notRead"
              ? {
                  short: "Usage not reported",
                  long: `${provider} usage has not been read on this machine recently, so its room is unknown. Opening the model picker reads it again. The model stays selectable.`,
                }
              : {
                  short: "Usage not reported",
                  long: `${provider} reported no limit windows for this account.`,
                };
      return { ...words, label: lowerFirst(words.short), tone: "muted" };
    }
    case "perToken":
      return {
        short: "Billed per token",
        label: "billed per token",
        long: `This ${provider} sign-in is billed per token, not to a subscription, so it has no usage limit to show. It is never picked for you.`,
        tone: "muted",
      };
    case "unreported":
      return availability.message
        ? {
            short: "Usage not reported",
            label: "usage not reported",
            long: `${availability.message} The model stays selectable.`,
            tone: "muted",
          }
        : {
            short: "Usage not reported",
            label: "usage not reported",
            long: `${provider} does not report usage limits, so its room is unknown until a turn runs.`,
            tone: "muted",
          };
    case "offline":
      return {
        short: availability.machineLabel
          ? `${availability.machineLabel} offline`
          : "Machine offline",
        label: `${availability.machineLabel ?? "machine"} offline`,
        long: `${availability.machineLabel ?? "The machine"} is not connected, so its usage can't be read.`,
        tone: "muted",
      };
    case "switching":
      return {
        short: "New account, not read yet",
        label: "new account, usage not read yet",
        long: `The ${provider} sign-in${input.machine ? ` on ${input.machine}` : ""} changed to another account. Its usage shows after its first read; the previous account's reading is not shown.`,
        tone: "muted",
      };
  }
}

/**
 * One provider's account-wide limit in a few words, for the account line above
 * a mixed list: `5% of 5-hour · 55m`. Null when there is nothing to say
 * (a provider that never reports, a sign-in billed per token).
 */
export function accountLimitPhrase(
  availability: ModelAvailability,
  input: { readonly nowMs: number; readonly short: string },
): string | null {
  const reset = (at: number | null) =>
    at !== null && at > input.nowMs ? ` · ${formatDuration(at - input.nowMs)}` : "";
  switch (availability.kind) {
    case "room":
      return `${availability.leftPercent}% of ${availability.binding.name}${reset(availability.binding.resetsAt)}${readAgeSuffix(availability.checkedAt, input.nowMs)}`;
    case "exhausted":
      return availability.providerAllows
        ? `${availability.binding.name} limit reached, extra usage allowed${readAgeSuffix(availability.checkedAt, input.nowMs)}`
        : `${availability.binding.name} limit reached${reset(availability.binding.resetsAt)}${readAgeSuffix(availability.checkedAt, input.nowMs)}`;
    case "denied":
      return `paused new turns${reset(availability.resetsAt)}`;
    case "unreported":
    case "perToken":
      return null;
    case "unknown":
      // Unknown usage is the dashed ring's tooltip, never words in a header.
      return availability.reason === "notSignedIn" ? "not signed in" : null;
    default:
      return lowerFirst(input.short);
  }
}

/** A provider's usage as its rail button says it: `5% of the 5-hour limit left, resets in 55m`. */
export function railLimitSentence(
  availability: ModelAvailability,
  input: { readonly nowMs: number; readonly label: string },
): string {
  if (availability.kind === "room") {
    const at = availability.binding.resetsAt;
    return `${availability.leftPercent}% of the ${availability.binding.name} limit left${
      at !== null && at > input.nowMs ? `, resets in ${formatDuration(at - input.nowMs)}` : ""
    }`;
  }
  return input.label;
}

/**
 * The signed-in account in the provider's own words, read from its live snapshot.
 * Only a confirmed sign-in to an account has one: a pending or failed probe and an
 * API key say nothing. A provider that reports no email says so; nothing is inferred.
 */
export function accountEmailLine(provider: string, snapshot: ServerProvider): string | null {
  if (snapshot.auth.status !== "authenticated" || isPerTokenProvider(snapshot)) return null;
  const email = snapshot.auth.email?.trim();
  return email ? `Signed in as ${email}` : `${provider} does not report an account email`;
}

/** Usage refusal text. Model pickers display it as an advisory warning. */
export function availabilityDisabledReason(
  availability: ModelAvailability,
  input: Parameters<typeof availabilityText>[1],
): string | null {
  return isAvailabilityBlocking(availability) ? availabilityText(availability, input).long : null;
}
