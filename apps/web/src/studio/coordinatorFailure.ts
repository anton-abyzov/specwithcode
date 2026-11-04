/**
 * What the project pane says when the coordinator cannot answer: one plain
 * sentence built from the run's structured failure (its class, its reset time,
 * the machine and the model), and the one action that fixes it, if any.
 *
 * The host's own text stays the source for anything this module does not
 * know; it is shown once, never next to a sentence that already says it.
 */
import type { TimestampFormat } from "@specweave-studio/contracts/settings";
import { formatDuration } from "@specweave-studio/shared/usageLimits";

import { resolveTimestampLocale } from "../timestampFormat";
import type { CoordinatorTurnFailure } from "./coordinatorTurnState";

/** The host's prose names the reset this way; read it only when no structured time came. */
const RESET_IN_TEXT = /Next observed reset: (\S+?)\.(?:\s|$)/;

/** When the limit behind a usage-limit failure resets: the structured time, else the host's text. */
export function coordinatorFailureResetAt(
  failure: Pick<CoordinatorTurnFailure, "resetAt" | "message">,
): string | null {
  if (failure.resetAt && Number.isFinite(Date.parse(failure.resetAt))) return failure.resetAt;
  const parsed = RESET_IN_TEXT.exec(failure.message)?.[1];
  return parsed && Number.isFinite(Date.parse(parsed)) ? parsed : null;
}

export interface ResetWhenOptions {
  readonly timestampFormat?: TimestampFormat;
  readonly locale?: string;
  readonly timeZone?: string;
}

const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

/** "Thu 7:00 PM" in the viewer's own zone and clock style. */
export function formatResetClock(resetMs: number, options: ResetWhenOptions = {}): string {
  const locale = resolveTimestampLocale(options.locale);
  const format = options.timestampFormat ?? "locale";
  const key = JSON.stringify([locale, options.timeZone, format]);
  let formatter = weekdayFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
      ...(format === "locale" ? {} : { hour12: format === "12-hour" }),
    });
    if (weekdayFormatters.size >= 16) weekdayFormatters.clear();
    weekdayFormatters.set(key, formatter);
  }
  return formatter.format(new Date(resetMs));
}

/**
 * "resets Thu 7:00 PM, in 1d 9h", or "reset Thu 7:00 PM" once it has passed.
 * Null when the time cannot be read.
 */
export function formatResetWhen(
  resetAt: string | null,
  nowMs: number,
  options: ResetWhenOptions = {},
): string | null {
  const resetMs = resetAt ? Date.parse(resetAt) : Number.NaN;
  if (!Number.isFinite(resetMs)) return null;
  const clock = formatResetClock(resetMs, options);
  if (resetMs <= nowMs) return `reset ${clock}`;
  // Under a minute left still reads as a time, not "0m".
  const left = formatDuration(Math.max(resetMs - nowMs, 60_000));
  return `resets ${clock}, in ${left}`;
}

/** A machine label worth saying: a real name, not the raw ID or a stand-in. */
function namedMachine(machineLabel: string | null | undefined): string | null {
  const label = machineLabel?.trim();
  if (!label || /^(this|that) machine$/i.test(label)) return null;
  return label;
}

/**
 * The host's sentence with "this machine" and "that machine" replaced by the
 * machine's name, which the host does not know: "cannot run on M1".
 */
export function nameMachineInText(text: string, machineLabel: string | null | undefined): string {
  const name = namedMachine(machineLabel);
  if (!name) return text;
  return text.replace(/\b(this|that) machine\b/gi, name);
}

export interface CoordinatorFailureText {
  /** The sentence the card leads with. */
  readonly body: string;
  /** The host's own text, only when the body does not already say it. */
  readonly detail: string | null;
  /** The failure is a reached usage limit. */
  readonly usageLimit: boolean;
}

/**
 * The card's text. A usage limit reads from structured fields: who ran out,
 * where, and when it resets. Anything else is the host's sentence with the
 * machine named, shown once.
 */
export function coordinatorFailureText(input: {
  readonly failure: CoordinatorTurnFailure;
  readonly machineLabel: string | null | undefined;
  /** "Claude Code · Opus 5.5": the profile and model the failed run used. */
  readonly profileLabel: string | null | undefined;
  readonly nowMs: number;
  readonly dates?: ResetWhenOptions;
}): CoordinatorFailureText {
  const { failure } = input;
  const machine = namedMachine(input.machineLabel);
  const named = nameMachineInText(failure.message, machine);
  if (failure.errorClass !== "usage_limit") return { body: named, detail: null, usageLimit: false };
  const who = input.profileLabel?.trim() || "This model";
  const where = machine ? ` on ${machine}` : "";
  const resetAt = coordinatorFailureResetAt(failure);
  const resetMs = resetAt ? Date.parse(resetAt) : Number.NaN;
  // Once the reset has passed, the usage is back: say so instead of "no usage left".
  const body =
    Number.isFinite(resetMs) && resetMs <= input.nowMs
      ? `${who}${where} hit its usage limit. The limit reset ${formatResetClock(resetMs, input.dates)}, so Retry should work.`
      : `${who}${where} has no usage left.${resetSentence(resetAt, input.nowMs, input.dates)} Retry checks again, or pick another model.`;
  return { body, detail: named === body ? null : named, usageLimit: true };
}

function resetSentence(
  resetAt: string | null,
  nowMs: number,
  dates: ResetWhenOptions | undefined,
): string {
  const when = formatResetWhen(resetAt, nowMs, dates);
  return when ? ` It ${when}.` : "";
}

/** The setup problem a provider has, as the coordinator's fix button sees it. */
export interface CoordinatorProviderState {
  readonly displayName: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  /** "authenticated", "unauthenticated" or "unknown". */
  readonly authStatus: string;
  readonly status: string;
  /** One Install click makes it usable on that machine. */
  readonly oneClickInstall: boolean;
}

export type CoordinatorFixAction =
  | { readonly kind: "install"; readonly label: string }
  | { readonly kind: "sign-in"; readonly label: string }
  | { readonly kind: "setup"; readonly label: string };

/**
 * The one action that lets the coordinator run again on its provider, named
 * for the machine: "Install Copilot on M1", "Sign in to Copilot on M1", or
 * "Open provider setup". Null when the provider has nothing to fix.
 */
export function coordinatorFixAction(input: {
  readonly provider: CoordinatorProviderState | null;
  readonly machineLabel: string | null | undefined;
}): CoordinatorFixAction | null {
  const { provider } = input;
  const machine = namedMachine(input.machineLabel);
  const on = machine ? ` on ${machine}` : "";
  if (provider === null) return { kind: "setup", label: "Open provider setup" };
  const name = shortProviderName(provider.displayName);
  if (provider.oneClickInstall) return { kind: "install", label: `Install ${name}${on}` };
  if (!provider.enabled || !provider.installed || provider.status === "error")
    return { kind: "setup", label: "Open provider setup" };
  if (provider.authStatus === "unauthenticated")
    return { kind: "sign-in", label: `Sign in to ${name}${on}` };
  return null;
}

/** "GitHub Copilot" reads as "Copilot" on a button; other names stay. */
function shortProviderName(displayName: string): string {
  const name = displayName.trim();
  return /^github copilot\b/i.test(name) ? name.replace(/^github\s+/i, "") : name || "provider";
}

/** What a retry says once the host picked where it runs: "Retrying on Claude Code · Opus 5.5." */
export function retryRoutingNotice(label: string): string {
  return `Retrying on ${label.trim() || "the coordinator's model"}.`;
}
