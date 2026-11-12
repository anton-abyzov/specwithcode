/**
 * The account limits behind a mixed list (Favorites, search, alternatives) as one
 * strip of chips: the provider's logo, a ring or limit mark and a few words, the
 * worst first. Each chip's tooltip carries the full sentence. More than four fold
 * into "+N", which opens Limits by account.
 */
import type { ProviderInstanceId } from "@specweave-studio/contracts";
import { formatDuration } from "@specweave-studio/shared/usageLimits";
import { CircleDashedIcon, CircleSlashIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  accountLimitPhrase,
  isAvailabilityBlocking,
  type ModelAvailability,
} from "../../studio/modelAvailability";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MeterRing, type ModelPickerUsage } from "./ModelUsage";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export const LIMITS_STRIP_MAX = 4;

export interface LimitsStripChip {
  readonly instanceId: ProviderInstanceId;
  readonly entry: ProviderInstanceEntry;
  readonly state: ModelAvailability;
  readonly tone: "muted" | "warn" | "full";
  /** The few words on the chip: `6% weekly · 2h 20m`, `Personal · 20d`. */
  readonly text: string;
  /** The sentence the prose band printed for this provider. */
  readonly sentence: string;
}

const severity = (chip: LimitsStripChip) =>
  chip.tone === "full"
    ? 0
    : chip.tone === "warn"
      ? 1 + (chip.state.kind === "room" ? chip.state.leftPercent / 100 : 0)
      : 3;

const until = (at: number | null, nowMs: number) =>
  at !== null && at > nowMs ? ` · ${formatDuration(at - nowMs)}` : "";

/** The chips for the providers behind the visible rows, worst first. */
export function limitsStripChips(input: {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly usage: ModelPickerUsage;
  readonly markedInstanceId: ProviderInstanceId | null;
  readonly shortLabels: ReadonlyMap<ProviderInstanceId, string>;
}): ReadonlyArray<LimitsStripChip> {
  const { usage } = input;
  const marker = usage.surface === "coordinator" ? "coordinator" : "this thread";
  const chips = input.entries.flatMap((entry): LimitsStripChip[] => {
    const state = usage.availability(entry.instanceId, null);
    const phrase = accountLimitPhrase(state, {
      nowMs: usage.nowMs,
      short: usage.text(entry.instanceId, state).short,
    });
    if (phrase === null) return [];
    const tone = isAvailabilityBlocking(state)
      ? "full"
      : state.kind === "exhausted" || (state.kind === "room" && state.tone === "warn")
        ? "warn"
        : "muted";
    const name = input.shortLabels.get(entry.instanceId) ?? entry.displayName;
    const text =
      state.kind === "room"
        ? `${state.leftPercent}% ${state.binding.name}${until(state.binding.resetsAt, usage.nowMs)}`
        : isAvailabilityBlocking(state)
          ? `${name}${until(
              state.kind === "exhausted"
                ? state.binding.resetsAt
                : state.kind === "denied"
                  ? state.resetsAt
                  : null,
              usage.nowMs,
            )}`
          : phrase;
    return [
      {
        instanceId: entry.instanceId,
        entry,
        state,
        tone,
        text,
        sentence: `${entry.displayName} ${phrase}${
          entry.instanceId === input.markedInstanceId ? ` (${marker})` : ""
        }`,
      },
    ];
  });
  // A stable sort keeps the displayed model's provider first among equals.
  return chips.toSorted((a, b) => severity(a) - severity(b));
}

const TONE = {
  muted: "text-muted-foreground",
  warn: "text-warning-foreground",
  full: "text-destructive-foreground",
} as const;

export function ModelPickerLimitsStrip(props: {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly usage: ModelPickerUsage;
  readonly markedInstanceId: ProviderInstanceId | null;
  readonly shortLabels: ReadonlyMap<ProviderInstanceId, string>;
  /** Opens Limits by account, for the chips that did not fit. */
  readonly onOpenAll?: (() => void) | undefined;
}) {
  const chips = limitsStripChips(props);
  if (chips.length === 0) return null;
  const shown = chips.slice(0, LIMITS_STRIP_MAX);
  const rest = chips.slice(LIMITS_STRIP_MAX);
  const restLabel = `${rest.length} more: ${rest.map((chip) => chip.sentence).join("; ")}`;
  return (
    <ul
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/70 px-3 py-1.5"
      aria-label="Account limits"
      data-model-picker-limits-strip=""
    >
      {shown.map((chip) => (
        <li key={chip.instanceId} className="min-w-0">
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  tabIndex={0}
                  aria-label={chip.sentence}
                  className={cn(
                    "inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border border-border/80 ps-1.5 pe-2 text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    TONE[chip.tone],
                  )}
                  data-model-picker-limit-chip={chip.tone}
                />
              }
            >
              <ProviderInstanceIcon
                driverKind={chip.entry.driverKind}
                displayName={chip.entry.displayName}
                accentColor={chip.entry.accentColor}
                acpRegistryAgentId={chip.entry.acpRegistryAgentId}
                acpRegistryIconUrl={chip.entry.acpRegistryIconUrl}
                showBadge={false}
                className="size-3.5 shrink-0"
                iconClassName="size-3.5"
              />
              {chip.tone === "full" ? (
                <CircleSlashIcon className="size-3 shrink-0" aria-hidden />
              ) : chip.state.kind === "room" ? (
                <MeterRing percent={chip.state.leftPercent} tone={chip.state.tone} dashed={false} />
              ) : (
                <CircleDashedIcon className="size-3 shrink-0" aria-hidden />
              )}
              <span className="min-w-0 truncate" aria-hidden>
                {chip.text}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="bottom" align="start" className="max-w-72">
              {chip.sentence}
            </TooltipPopup>
          </Tooltip>
        </li>
      ))}
      {rest.length > 0 ? (
        <li>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="inline-flex h-6 items-center rounded-full border border-border/80 px-2 text-xs text-muted-foreground tabular-nums hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  aria-label={restLabel}
                  onClick={props.onOpenAll}
                  disabled={!props.onOpenAll}
                  data-model-picker-limits-more={rest.length}
                />
              }
            >
              +{rest.length}
            </TooltipTrigger>
            <TooltipPopup side="bottom" align="start" className="max-w-72">
              {props.onOpenAll ? "Limits by account" : restLabel}
            </TooltipPopup>
          </Tooltip>
        </li>
      ) : null}
    </ul>
  );
}
