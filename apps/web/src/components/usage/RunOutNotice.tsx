import type { ServerProvider, ServerProviderUsageWindow } from "@specweave-studio/contracts";
import { formatDuration } from "@specweave-studio/shared/usageLimits";
import {
  limitRunOutWarning,
  runOutWarningApplies,
  runOutWarningText,
  type RunOutWarning,
  type RunOutWindow,
} from "@specweave-studio/shared/usageRunOut";

import { usePrimarySettings } from "../../hooks/useSettings";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { usageToneTextClassOfUsed } from "../../studio/usageIndicatorModel";

/** A provider read's windows in the shape the warning weighs. */
export function runOutWindowsOf(windows: ReadonlyArray<ServerProviderUsageWindow>): RunOutWindow[] {
  return windows.map((window) => {
    const at = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
    return {
      id: window.id,
      label: window.label,
      // Rounded as the machine rows round it, so 99.5% reads as reached on both.
      usedPercent: Math.round(Math.max(0, Math.min(100, window.usedPercent))),
      // An unparseable reset still blocks as live, so it stays a reading without a reset.
      resetsAt: Number.isFinite(at) ? at : null,
      durationMins: window.windowDurationMins,
      modelScope: window.modelScope,
    };
  });
}

/**
 * `at 3:40 PM` today, `tomorrow at 8:00 AM`, `on 7.11. 08:00` later. Decided
 * by calendar day, since the later date follows the reader's locale.
 */
export function resetPhrase(clock: string, resetsAt: number, now: number): string {
  const day = (ms: number) => {
    const date = new Date(ms);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  };
  const days = Math.round((day(resetsAt) - day(now)) / 86_400_000);
  if (days === 0) return `at ${clock}`;
  return days === 1 ? clock : `on ${clock}`;
}

/** `1h 20m`, or `under a minute` where whole minutes would read `0m`. */
function runsOutIn(ms: number): string {
  return ms < 60_000 ? "under a minute" : formatDuration(ms);
}

/**
 * The most urgent limit warning for a Claude Code subscription: a spent
 * window, or the 5-hour or weekly the current pace empties before it resets.
 * Nothing for other harnesses or when nothing is at risk.
 */
export function RunOutNotice({
  driver,
  windows,
  now,
  className = "",
}: {
  readonly driver: ServerProvider["driver"];
  readonly windows: ReadonlyArray<RunOutWindow>;
  readonly now: number;
  readonly className?: string;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  if (!runOutWarningApplies(driver)) return null;
  const warning: RunOutWarning | null = limitRunOutWarning(windows, now);
  if (warning === null) return null;
  const clock = formatUpcomingTimestamp(
    new Date(warning.resetsAt).toISOString(),
    timestampFormat,
    now,
  );
  const text = runOutWarningText(
    warning,
    resetPhrase(clock, warning.resetsAt, now),
    warning.kind === "pace" ? runsOutIn(warning.runsOutAt - now) : "",
  );
  return (
    <p
      role="status"
      data-run-out={warning.kind}
      className={`text-xs ${usageToneTextClassOfUsed(warning.kind === "reached" ? 100 : 90)} ${className}`}
    >
      {text}
    </p>
  );
}
