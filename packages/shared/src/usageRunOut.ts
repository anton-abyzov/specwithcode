/**
 * The one warning a subscription's limits deserve, if any: a window already
 * spent, or the window the current pace empties before it resets. Claude's
 * 5-hour and weekly are weighed together, so the most urgent of the two wins.
 * The projection is linear (spend so far over time so far); it is a heads-up,
 * not a forecast.
 *
 * @module usageRunOut
 */
import { windowName } from "./usageWindows.ts";

/** Too early in a window, one burst reads as a pace that empties it. */
const MIN_ELAPSED_SHARE = 0.05;
/** A projected run-out within a minute of the reset is no warning. */
const RESET_MARGIN_MS = 60_000;

export interface RunOutWindow {
  readonly id: string;
  readonly label: string;
  readonly usedPercent: number;
  /** Epoch ms of the next reset, or null when unknown. */
  readonly resetsAt: number | null;
  /** The window's length (300 for Claude's 5-hour). */
  readonly durationMins?: number | undefined;
  readonly modelScope?: string | undefined;
  /** Its reset has passed since the reading. */
  readonly stale?: boolean | undefined;
}

export type RunOutWarning =
  | {
      readonly kind: "reached";
      /** `5-hour`, `weekly`. */
      readonly name: string;
      readonly resetsAt: number;
    }
  | {
      readonly kind: "pace";
      readonly name: string;
      readonly resetsAt: number;
      readonly runsOutAt: number;
    };

/**
 * Only Claude Code subscriptions get the warning: its 5-hour and weekly
 * windows come from the account's own usage read. Other harnesses keep their
 * rows and pace glyphs without it.
 */
export function runOutWarningApplies(driver: string): boolean {
  return driver === "claudeAgent";
}

const usable = (window: RunOutWindow, now: number): window is RunOutWindow & { resetsAt: number } =>
  window.stale !== true &&
  window.modelScope === undefined &&
  window.resetsAt !== null &&
  Number.isFinite(window.resetsAt) &&
  window.resetsAt > now &&
  Number.isFinite(window.usedPercent) &&
  window.usedPercent >= 0;

const nameOf = (window: RunOutWindow) =>
  windowName({
    id: window.id,
    label: window.label,
    modelScope: window.modelScope,
    windowDurationMins: window.durationMins,
  });

/**
 * A spent account-wide window outranks any pace; of several spent, the one
 * that resets last binds. Otherwise the window projected to empty first,
 * when that comes before its reset. Model-scoped weeklies (Fable) cap one
 * model only and never drive the account's warning; a window without a
 * reset, a length or a reading yet says nothing.
 */
export function limitRunOutWarning(
  windows: ReadonlyArray<RunOutWindow>,
  now: number,
): RunOutWarning | null {
  if (!Number.isFinite(now)) return null;
  // A spent account-wide window with no usable reset still blocks the others
  // (see `blockingWindow`), so no pace on them may contradict it.
  if (
    windows.some(
      (window) =>
        window.stale !== true &&
        window.modelScope === undefined &&
        window.usedPercent >= 100 &&
        !usable(window, now),
    )
  ) {
    return null;
  }
  const live = windows.filter((window) => usable(window, now));
  let reached: (RunOutWindow & { resetsAt: number }) | null = null;
  for (const window of live) {
    if (window.usedPercent < 100) continue;
    if (reached === null || window.resetsAt > reached.resetsAt) reached = window;
  }
  if (reached) return { kind: "reached", name: nameOf(reached), resetsAt: reached.resetsAt };

  let urgent: { window: RunOutWindow & { resetsAt: number }; runsOutAt: number } | null = null;
  for (const window of live) {
    const mins = window.durationMins;
    if (mins === undefined || !(mins > 0) || window.usedPercent <= 0) continue;
    const length = mins * 60_000;
    const elapsed = now - (window.resetsAt - length);
    if (!(elapsed >= length * MIN_ELAPSED_SHARE) || elapsed > length) continue;
    const perMs = window.usedPercent / elapsed;
    const runsOutAt = now + (100 - window.usedPercent) / perMs;
    if (runsOutAt >= window.resetsAt - RESET_MARGIN_MS) continue;
    if (urgent === null || runsOutAt < urgent.runsOutAt) urgent = { window, runsOutAt };
  }
  return urgent
    ? {
        kind: "pace",
        name: nameOf(urgent.window),
        resetsAt: urgent.window.resetsAt,
        runsOutAt: urgent.runsOutAt,
      }
    : null;
}

/**
 * The warning as a sentence. `resetPhrase` names the reset as the reader's
 * clock does (`at 3:40 PM`, `tomorrow at 8:00 AM`); `runsOutIn` is a duration.
 */
export function runOutWarningText(
  warning: RunOutWarning,
  resetPhrase: string,
  runsOutIn: string,
): string {
  if (warning.kind === "reached") {
    return `${capitalize(warning.name)} limit reached. It resets ${resetPhrase}.`;
  }
  return `Heads up. At this pace you'll hit your ${warning.name} limit in ${runsOutIn}, before it resets ${resetPhrase}.`;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
