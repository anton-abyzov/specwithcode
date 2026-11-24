import { useRef, useState } from "react";
import {
  USAGE_CUSTOM_RANGE_MAX_DAYS,
  USAGE_RANGE_PROBLEM_TEXT,
  customRangeProblem,
  formatUsageRange,
  rangeDayCount,
  type UsagePresetDays,
  type UsageRange,
} from "@specweave-studio/shared/usageRange";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTitle } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WINDOW_OPTIONS } from "./usageShortcuts";

const CUSTOM = "custom";

function dayBefore(day: string, days: number): string {
  const ms = Date.parse(`${day}T00:00:00Z`) - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** From and Until fields with one message per broken rule; Apply waits for a valid range. */
export function UsageCustomRange({
  initial,
  today,
  onApply,
  onCancel,
}: {
  readonly initial: { readonly sinceDay: string; readonly untilDay: string };
  readonly today: string;
  readonly onApply: (range: { readonly sinceDay: string; readonly untilDay: string }) => void;
  readonly onCancel: () => void;
}) {
  const [sinceDay, setSinceDay] = useState(initial.sinceDay);
  const [untilDay, setUntilDay] = useState(initial.untilDay);
  const problem = customRangeProblem(sinceDay, untilDay, today);
  const count = rangeDayCount(sinceDay, untilDay);
  return (
    <form
      className="flex w-72 flex-col gap-2 text-sm"
      aria-label="Custom range"
      onSubmit={(event) => {
        event.preventDefault();
        if (problem === null) onApply({ sinceDay, untilDay });
      }}
    >
      <PopoverTitle>Custom range</PopoverTitle>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        From
        <Input
          type="date"
          size="sm"
          aria-label="From"
          value={sinceDay}
          max={today}
          onChange={(event) => setSinceDay(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Until
        <Input
          type="date"
          size="sm"
          aria-label="Until"
          value={untilDay}
          max={today}
          onChange={(event) => setUntilDay(event.target.value)}
        />
      </label>
      {problem === null ? (
        <p className="text-xs text-muted-foreground">
          {count} {count === 1 ? "day" : "days"} · up to {USAGE_CUSTOM_RANGE_MAX_DAYS} days, ending
          today or earlier
        </p>
      ) : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {USAGE_RANGE_PROBLEM_TEXT[problem]}
        </p>
      )}
      <div className="mt-1 flex justify-end gap-2">
        <Button type="button" size="xs" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={problem !== null}>
          Apply
        </Button>
      </div>
    </form>
  );
}

/**
 * The page range: the four presets and Custom. A custom range reads as its
 * dates on the Custom segment, such as "Nov 1 – Nov 15".
 */
export function UsageRangeControl({
  range,
  today,
  disabled,
  compact = false,
  titleFor,
  onChange,
}: {
  readonly range: UsageRange;
  readonly today: string;
  readonly disabled: boolean;
  readonly compact?: boolean;
  readonly titleFor: (option: (typeof WINDOW_OPTIONS)[number]) => string;
  readonly onChange: (range: UsageRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const customLabel =
    range.kind === "custom" ? formatUsageRange(range.sinceDay, range.untilDay, today) : "Custom…";
  const value = range.kind === "custom" ? CUSTOM : String(range.days);
  const pick = (next: string | null | undefined) => {
    if (!next) return;
    if (next === CUSTOM) {
      setOpen(true);
      return;
    }
    const option = WINDOW_OPTIONS.find((entry) => String(entry.days) === next);
    if (option) onChange({ kind: "preset", days: option.days as UsagePresetDays });
  };
  const initial =
    range.kind === "custom"
      ? { sinceDay: range.sinceDay, untilDay: range.untilDay }
      : { sinceDay: dayBefore(today, 13), untilDay: today };
  return (
    <div ref={anchor} className="flex min-w-0 items-center">
      {compact ? (
        <Select value={value} disabled={disabled} onValueChange={(next) => pick(next)}>
          <SelectTrigger
            aria-label="Usage period"
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>
              {range.kind === "custom"
                ? customLabel
                : WINDOW_OPTIONS.find((option) => option.days === range.days)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {WINDOW_OPTIONS.map((option) => (
              <SelectItem key={option.days} value={String(option.days)} title={titleFor(option)}>
                {option.label}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM}>{customLabel}</SelectItem>
          </SelectPopup>
        </Select>
      ) : (
        <ToggleGroup
          aria-label="Usage period"
          variant="segmented"
          value={[value]}
          disabled={disabled}
          onValueChange={(next) => pick(next[0])}
        >
          {WINDOW_OPTIONS.map((option) => (
            <Toggle key={option.days} value={String(option.days)} title={titleFor(option)}>
              {option.label}
            </Toggle>
          ))}
          <Toggle
            value={CUSTOM}
            title="Pick the first and last day"
            // A second press on an applied custom range edits it.
            onClick={() => {
              if (range.kind === "custom" && !disabled) setOpen(true);
            }}
          >
            {customLabel}
          </Toggle>
        </ToggleGroup>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverPopup anchor={anchor} align="end">
          {open ? (
            <UsageCustomRange
              initial={initial}
              today={today}
              onCancel={() => setOpen(false)}
              onApply={(next) => {
                setOpen(false);
                onChange({ kind: "custom", ...next });
              }}
            />
          ) : null}
        </PopoverPopup>
      </Popover>
    </div>
  );
}
