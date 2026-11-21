import type { MachineColorId } from "@specweave-studio/contracts";
import {
  formatCount,
  formatDayShort,
  formatPercent,
  formatTokens,
  formatUsd,
} from "@specweave-studio/shared/usageFormat";
import type {
  ShareBreakdownEntry,
  ShareMeasure,
  ShareOrigin,
  ShareSegment,
} from "@specweave-studio/shared/usageMachineShare";
import { measureOf } from "@specweave-studio/shared/usageMachineShare";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { type SubscriptionView, localDayStart, niceCeiling } from "./machineShareView";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How the Machines tab shows a machine: its name, chip letters and colour. */
export interface ShareMachineIdentity {
  readonly name: string;
  readonly short: string;
  readonly color: MachineColorId;
}
export type ShareIdentityOf = (machineId: string) => ShareMachineIdentity;

export const OUTSIDE_LABEL = "Outside your machines (estimate)";

export const ORIGIN_TEXT: Record<ShareOrigin, string> = {
  app: "in SpecWithCode",
  native: "outside the app",
  unsplit: "not split",
};

export function formatMeasure(value: number, measure: ShareMeasure): string {
  if (measure === "cost") return formatUsd(value);
  return measure === "tokens" ? formatTokens(value) : formatCount(value);
}

/** Axis ticks are round, so they drop the cents a value keeps. */
function formatAxis(value: number, measure: ShareMeasure): string {
  return measure === "cost" && value >= 10
    ? `$${formatCount(value)}`
    : formatMeasure(value, measure);
}

/** `Nov 14` where the month starts or changes, else the day of the month alone. */
function dayTick(day: string, previous: string | undefined): string {
  return previous === undefined || previous.slice(0, 7) !== day.slice(0, 7)
    ? formatDayShort(day)
    : String(Number(day.slice(8)));
}

/** What a part is called: the machine and where on it, or the estimate. */
export function partName(
  part: { readonly kind: ShareOrigin | "outside"; readonly machineId: string | null },
  identityOf: ShareIdentityOf,
): string {
  if (part.kind === "outside" || part.machineId === null) return OUTSIDE_LABEL;
  return `${identityOf(part.machineId).name}, ${ORIGIN_TEXT[part.kind]}`;
}

function machineColor(machineId: string | null, identityOf: ShareIdentityOf) {
  return machineId === null ? {} : { "data-machine-color": identityOf(machineId).color };
}

/** A square in a part's fill, beside its name in legends and tooltips. */
export function ShareSwatch({
  kind,
  machineId,
  identityOf,
}: {
  readonly kind: ShareOrigin | "outside";
  readonly machineId: string | null;
  readonly identityOf: ShareIdentityOf;
}) {
  return (
    <span
      aria-hidden
      className="usage-machines-swatch"
      data-share-kind={kind}
      {...machineColor(machineId, identityOf)}
    />
  );
}

/**
 * One subscription as a whole split into parts: each machine's use in
 * SpecWithCode and outside it, then the estimate of use on no machine.
 */
export function ShareBar({
  view,
  measure,
  identityOf,
  selectedMachineId,
  onSelectMachine,
}: {
  readonly view: SubscriptionView;
  readonly measure: ShareMeasure;
  readonly identityOf: ShareIdentityOf;
  readonly selectedMachineId: string | null;
  readonly onSelectMachine: (machineId: string | null) => void;
}) {
  const describe = (segment: ShareSegment) =>
    `${partName(segment, identityOf)}: ${
      segment.value === null ? "" : `${formatMeasure(segment.value, measure)}, `
    }${formatPercent(segment.share, 0)}`;
  if (view.segments.length === 0) {
    return (
      <div
        role="img"
        aria-label="No use recorded in this period"
        className="h-7 rounded-sm bg-muted"
      />
    );
  }
  return (
    <div
      role="group"
      aria-label={`Split by machine: ${view.segments.map(describe).join("; ")}`}
      className="usage-machines-bar"
    >
      {view.segments.map((segment) => {
        const identity = segment.machineId === null ? null : identityOf(segment.machineId);
        return (
          <Tooltip key={segment.key}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="usage-machines-part"
                  data-share-kind={segment.kind}
                  data-share-part={segment.key}
                  {...machineColor(segment.machineId, identityOf)}
                  aria-label={describe(segment)}
                  aria-pressed={
                    segment.machineId !== null && segment.machineId === selectedMachineId
                  }
                  style={{ flexGrow: Math.max(segment.share, 0.004) }}
                  onClick={() =>
                    onSelectMachine(
                      segment.machineId === selectedMachineId ? null : segment.machineId,
                    )
                  }
                />
              }
            >
              <span className="usage-machines-part-label">
                {identity === null ? "Est." : identity.short} {formatPercent(segment.share, 0)}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="top">
              <span className="flex items-center gap-1.5">
                <ShareSwatch
                  kind={segment.kind}
                  machineId={segment.machineId}
                  identityOf={identityOf}
                />
                {describe(segment)}
              </span>
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** A subscription's use per day, stacked by machine, with a mark at each limit reset. */
export function ShareTrend({
  view,
  measure,
  identityOf,
}: {
  readonly view: SubscriptionView;
  readonly measure: ShareMeasure;
  readonly identityOf: ShareIdentityOf;
}) {
  const days = view.trend;
  const top = niceCeiling(days.reduce((max, day) => Math.max(max, day.total), 0));
  const firstMs = days.length === 0 ? 0 : localDayStart(days[0]!.day);
  const span = days.length * DAY_MS;
  const labelEvery = Math.max(1, Math.ceil(days.length / 14));
  return (
    <div className="usage-machines-trend" data-share-trend>
      <div className="usage-machines-axis" aria-hidden>
        <span>{formatAxis(top, measure)}</span>
        <span>{formatAxis(top / 2, measure)}</span>
        <span>0</span>
      </div>
      <div className="usage-machines-plot" role="group" aria-label="Use per day by machine">
        {days.map((day) => {
          const stack = [
            ...day.parts,
            ...(day.outside === null
              ? []
              : [
                  { key: "outside", kind: "outside" as const, machineId: null, value: day.outside },
                ]),
          ];
          const summary =
            stack.length === 0
              ? `${formatDayShort(day.day)}: no use`
              : `${formatDayShort(day.day)}: ${formatMeasure(day.total, measure)}. ${stack
                  .map(
                    (part) => `${partName(part, identityOf)} ${formatMeasure(part.value, measure)}`,
                  )
                  .join("; ")}`;
          return (
            <Tooltip key={day.day}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="usage-machines-day"
                    data-share-day={day.day}
                    aria-label={summary}
                  />
                }
              >
                <span data-spacer style={{ flex: `${Math.max(top - day.total, 0)} 1 0` }} />
                {[...stack].reverse().map((part) => (
                  <span
                    key={part.key}
                    data-share-kind={part.kind}
                    {...machineColor(part.machineId, identityOf)}
                    style={{ flex: `${part.value} 1 0` }}
                  />
                ))}
              </TooltipTrigger>
              <TooltipPopup side="top">
                <div className="flex flex-col gap-1">
                  <span className="font-medium">
                    {formatDayShort(day.day)} · {formatMeasure(day.total, measure)}
                  </span>
                  {stack.length === 0 ? <span>No use</span> : null}
                  {[...stack].reverse().map((part) => (
                    <span key={part.key} className="flex items-center gap-1.5">
                      <ShareSwatch
                        kind={part.kind}
                        machineId={part.machineId}
                        identityOf={identityOf}
                      />
                      <span className="flex-1">{partName(part, identityOf)}</span>
                      <span className="tabular-nums">{formatMeasure(part.value, measure)}</span>
                    </span>
                  ))}
                </div>
              </TooltipPopup>
            </Tooltip>
          );
        })}
        {view.resets.map((at) => {
          const position = span > 0 ? (at - firstMs) / span : 0;
          if (position < 0 || position > 1) return null;
          return (
            <div
              key={at}
              className="usage-machines-reset"
              data-share-reset
              data-side={position > 0.8 ? "left" : "right"}
              style={{ left: `${position * 100}%` }}
            >
              <span>Limit reset</span>
            </div>
          );
        })}
      </div>
      <div className="usage-machines-days" aria-hidden>
        {days.map((day, index) => (
          <span key={day.day}>
            {index % labelEvery === 0 ? dayTick(day.day, days[index - labelEvery]?.day) : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

const RANK_ROWS = 6;

/** One ranked list of the drill-down: a label, its value and a bar for its size. */
export function ShareRank({
  title,
  entries,
  measure,
  color,
  formatLabel = (label) => label,
  keepOrder = false,
}: {
  readonly title: string;
  readonly entries: readonly ShareBreakdownEntry[];
  readonly measure: ShareMeasure;
  /** The machine the list is filtered to; neutral for all machines. */
  readonly color: MachineColorId | null;
  readonly formatLabel?: (label: string) => string;
  /** Days stay in date order and are all shown. */
  readonly keepOrder?: boolean;
}) {
  const used = entries.filter((entry) => measureOf(entry, measure) > 0 || entry.tokens > 0);
  const shown = keepOrder ? used : used.slice(0, RANK_ROWS);
  const rest = keepOrder ? [] : used.slice(RANK_ROWS);
  const restValue = rest.reduce((sum, entry) => sum + measureOf(entry, measure), 0);
  const rows = [
    ...shown.map((entry) => ({
      key: entry.key,
      label: formatLabel(entry.label),
      value: measureOf(entry, measure),
    })),
    ...(rest.length === 0
      ? []
      : [{ key: "\u0000rest", label: `${rest.length} more`, value: restValue }]),
  ];
  const largest = rows.reduce((max, row) => Math.max(max, row.value), 0);
  return (
    <div className="min-w-0" data-share-rank={title}>
      <h4 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h4>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing in this period.</p>
      ) : (
        <div
          className="usage-machines-rank text-xs"
          {...(color ? { "data-machine-color": color } : {})}
        >
          {rows.map((row) => (
            <div key={row.key} className="contents">
              <span className="truncate text-foreground">{row.label}</span>
              <span className="text-foreground tabular-nums">
                {formatMeasure(row.value, measure)}
              </span>
              <span className="usage-machines-rank-bar" aria-hidden>
                <span style={{ width: `${largest > 0 ? (row.value / largest) * 100 : 0}%` }} />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
