import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@specweave-studio/contracts";
import type { UsageChartMetric } from "./UsageProviderChart";
import { resolveShortcutCommand, type ShortcutEventLike } from "../../keybindings";

export type UsageMetric = UsageChartMetric | "limits";
export const METRIC_OPTIONS = [
  { value: "cost", label: "Cost", command: "usage.cost" },
  { value: "tokens", label: "Tokens", command: "usage.tokens" },
  { value: "limits", label: "Limits", command: "usage.limits" },
] as const satisfies readonly { value: UsageMetric; label: string; command: KeybindingCommand }[];

export const WINDOW_OPTIONS = [
  { days: 1, label: "Past 24h", command: "usage.period.day" },
  { days: 7, label: "7 days", command: "usage.period.week" },
  { days: 30, label: "30 days", command: "usage.period.month" },
  { days: 90, label: "90 days", command: "usage.period.quarter" },
] as const;

export const USAGE_SHEET_SELECTOR = "[data-usage-sheet]";

/** Resolves page shortcuts without taking letters from fields or popup controls. */
export function resolveUsageShortcut(
  event: ShortcutEventLike & { target: EventTarget | null },
  keybindings: ResolvedKeybindingsConfig,
) {
  const target = event.target;
  // The Usage sheet is itself a dialog; only a popup over it takes the letters.
  const layer =
    target instanceof HTMLElement
      ? target.closest('[role="dialog"], [aria-modal="true"], [data-slot$="popup"]')
      : null;
  if (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable ||
      (layer !== null && !layer.matches(USAGE_SHEET_SELECTOR)))
  ) {
    return null;
  }

  return resolveShortcutCommand(event, keybindings, {
    context: { usagePageOpen: true },
  });
}
