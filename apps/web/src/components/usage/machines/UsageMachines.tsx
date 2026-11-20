import type { UsageLimitHistorySeries } from "@specweave-studio/contracts";
import {
  formatDateTimeShort,
  formatDayShort,
  formatPercent,
} from "@specweave-studio/shared/usageFormat";
import {
  type ShareMachineInput,
  type ShareMeasure,
  type SubscriptionMachine,
  measureOf,
  shareBreakdown,
} from "@specweave-studio/shared/usageMachineShare";
import type { OutsideResult } from "@specweave-studio/shared/usageOutsideEstimate";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Input } from "../../ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../ui/table";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import {
  OUTSIDE_LABEL,
  type ShareIdentityOf,
  ShareBar,
  ShareRank,
  ShareSwatch,
  ShareTrend,
  formatMeasure,
} from "./UsageMachinesCharts";
import {
  CUSTOM_RANGE_DAYS,
  SHARE_MEASURE_OPTIONS,
  SHARE_PERIOD_OPTIONS,
  type SharePeriod,
  type SubscriptionView,
  VIEWER_TIME_ZONE,
  buildSubscriptionViews,
  dayBefore,
  localDay,
} from "./machineShareView";
import "./usage-machines.css";

const MEASURE_NOUN: Record<ShareMeasure, string> = {
  cost: "API-equivalent cost",
  tokens: "tokens",
  requests: "requests",
};

const WINDOW_NOUN: Record<string, string> = { weekly: "weekly", monthly: "monthly" };

function periodValue(period: SharePeriod): string {
  if (period.kind === "days") return String(period.days);
  return period.kind;
}

function instant(atMs: number): string {
  return formatDateTimeShort(new Date(atMs).toISOString());
}

/** The sentence under a bar that says what was used on no reporting machine. */
function EstimateLine({
  view,
  measure,
}: {
  readonly view: SubscriptionView;
  readonly measure: ShareMeasure;
}) {
  const estimate: OutsideResult = view.estimate;
  const checked =
    estimate.lastCheckedAt === null ? null : `Limit last read ${instant(estimate.lastCheckedAt)}`;
  if (estimate.kind === "unavailable") {
    return (
      <p className="text-xs text-muted-foreground" data-share-estimate="unavailable">
        <span className="font-medium text-foreground">No estimate of use elsewhere.</span>{" "}
        {estimate.detail}
        {checked ? ` ${checked}.` : null}
      </p>
    );
  }
  const noun = WINDOW_NOUN[estimate.windowKind] ?? "";
  const outside = view.segments.find((segment) => segment.kind === "outside");
  const tail = `Estimate, ${estimate.confidence} confidence. ${checked}.`;
  return (
    <div
      className="flex flex-col gap-0.5 text-xs text-muted-foreground"
      data-share-estimate={estimate.detected ? "detected" : "none"}
    >
      {estimate.detected ? (
        <p>
          <span className="font-medium text-foreground">
            About{" "}
            {formatPercent(estimate.outsidePoints / Math.max(estimate.consumedPoints, 1e-9), 0)} was
            used outside your machines
          </span>
          : {estimate.outsidePoints} of the {estimate.consumedPoints} points the {noun} limit moved
          {outside?.value != null ? `, about ${formatMeasure(outside.value, measure)}` : ""}
          {estimate.highPoints - estimate.lowPoints >= 1
            ? ` (between ${estimate.lowPoints} and ${estimate.highPoints} points)`
            : ""}
          . {tail}
        </p>
      ) : (
        <p>
          <span className="font-medium text-foreground">
            No use outside your machines detected.
          </span>{" "}
          They explain the {estimate.consumedPoints} points the {noun} limit moved. {tail}
        </p>
      )}
      {estimate.reasons.length > 0 ? <p>{estimate.reasons.join(" ")}</p> : null}
    </div>
  );
}

function machineDetail(machine: SubscriptionMachine, measure: ShareMeasure): string {
  const parts: string[] = [];
  const app = measureOf(machine.app, measure);
  const native = measureOf(machine.native, measure);
  const unsplit = measureOf(machine.unsplit, measure);
  if (app > 0) parts.push(`in SpecWithCode ${formatMeasure(app, measure)}`);
  if (native > 0) parts.push(`outside the app ${formatMeasure(native, measure)}`);
  if (unsplit > 0) parts.push(`not split ${formatMeasure(unsplit, measure)}`);
  if (parts.length === 0) return machine.holds ? "Signed in, no use in this period" : "No use";
  return parts.join(" · ");
}

function SubscriptionCard({
  view,
  measure,
  identityOf,
  open,
  onToggle,
}: {
  readonly view: SubscriptionView;
  readonly measure: ShareMeasure;
  readonly identityOf: ShareIdentityOf;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const [machineId, setMachineId] = useState<string | null>(null);
  const selected =
    machineId !== null && view.subscription.machines.some((entry) => entry.machineId === machineId)
      ? machineId
      : null;
  const breakdown = useMemo(
    () => (open ? shareBreakdown(view.share, view.accountKey, selected, measure) : null),
    [open, view.share, view.accountKey, selected, measure],
  );
  const outside = view.segments.find((segment) => segment.kind === "outside");
  const shareOf = (machine: SubscriptionMachine) =>
    view.segments
      .filter((segment) => segment.machineId === machine.machineId)
      .reduce((sum, segment) => sum + segment.share, 0);
  const reading = view.reading;
  const noun = view.window ? (WINDOW_NOUN[view.window.windowKind] ?? "") : "";
  const DisclosureIcon = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
      data-share-subscription={view.accountKey}
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="min-w-0 truncate text-sm font-medium text-foreground">
          {view.provider}
          <span className="font-normal text-muted-foreground">
            {" · "}
            {view.account ?? (view.subscription.unknown ? "account not known" : "one account")}
          </span>
        </h3>
        <span className="ms-auto text-sm text-foreground tabular-nums">
          {formatMeasure(measureOf(view.subscription.total, measure), measure)}{" "}
          <span className="text-xs text-muted-foreground">
            {MEASURE_NOUN[measure]} on your machines
          </span>
        </span>
        <p className="w-full text-xs text-muted-foreground">
          {view.sinceReset
            ? `Since the limit reset on ${instant(view.period.startMs)}`
            : `${formatDayShort(view.period.sinceDay)} to ${formatDayShort(view.period.untilDay)}`}
          {reading
            ? ` · ${noun} limit ${Math.round(reading.usedPercent)}% used${
                reading.resetsAt !== null && reading.resetsAt > view.period.endMs
                  ? `, resets ${instant(reading.resetsAt)}`
                  : ""
              }`
            : ""}
        </p>
      </header>

      <ShareBar
        view={view}
        measure={measure}
        identityOf={identityOf}
        selectedMachineId={open ? selected : null}
        onSelectMachine={(next) => {
          setMachineId(next);
          if (!open) onToggle();
        }}
      />

      <ul className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2" aria-label="Machines">
        {view.subscription.machines.map((machine) => {
          const identity = identityOf(machine.machineId);
          const silent = view.subscription.silentHolders.includes(identity.name);
          return (
            <li key={machine.machineId} className="flex min-w-0 items-baseline gap-2">
              <span className="translate-y-px">
                <ShareSwatch kind="app" machineId={machine.machineId} identityOf={identityOf} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="font-medium text-foreground">{identity.name}</span>
                <span className="text-muted-foreground">
                  {" · "}
                  {machineDetail(machine, measure)}
                  {silent ? " · did not report the whole period" : ""}
                </span>
              </span>
              <span className="text-foreground tabular-nums">
                {formatMeasure(measureOf(machine.total, measure), measure)}
              </span>
              <span className="w-9 text-right text-muted-foreground tabular-nums">
                {formatPercent(shareOf(machine), 0)}
              </span>
            </li>
          );
        })}
        {outside ? (
          <li className="flex min-w-0 items-baseline gap-2">
            <span className="translate-y-px">
              <ShareSwatch kind="outside" machineId={null} identityOf={identityOf} />
            </span>
            <span className="min-w-0 flex-1 font-medium text-foreground">{OUTSIDE_LABEL}</span>
            <span className="text-foreground tabular-nums">
              {outside.value === null ? "" : `≈ ${formatMeasure(outside.value, measure)}`}
            </span>
            <span className="w-9 text-right text-muted-foreground tabular-nums">
              {formatPercent(outside.share, 0)}
            </span>
          </li>
        ) : null}
      </ul>

      <EstimateLine view={view} measure={measure} />
      {view.subscription.unknown ? (
        <p className="text-xs text-muted-foreground">
          Sessions whose account the machine could not name: nobody was signed in when they were
          read, or several accounts shared the folder.
        </p>
      ) : view.subscription.identity === "current" ? (
        <p className="text-xs text-muted-foreground">
          Some sessions were matched by the account signed in now, not the one recorded at the time.
        </p>
      ) : null}

      <button
        type="button"
        className="flex w-fit items-center gap-1 rounded-sm text-xs font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
        onClick={onToggle}
      >
        <DisclosureIcon className="size-3.5" aria-hidden />
        Days and breakdown
      </button>

      {open && breakdown ? (
        <div className="flex flex-col gap-5 pt-1">
          <ShareTrend view={view} measure={measure} identityOf={identityOf} />
          <div className="flex flex-col gap-3">
            <ToggleGroup
              aria-label="Machine shown in the breakdown"
              variant="segmented"
              className="max-w-full flex-wrap"
              value={[selected ?? ""]}
              onValueChange={(next) => setMachineId(next[0] ? next[0] : null)}
            >
              <Toggle value="">All machines</Toggle>
              {view.subscription.machines
                .filter((machine) => machine.total.requests > 0 || machine.total.tokens > 0)
                .map((machine) => (
                  <Toggle key={machine.machineId} value={machine.machineId}>
                    {identityOf(machine.machineId).name}
                  </Toggle>
                ))}
            </ToggleGroup>
            <div className="grid gap-6 md:grid-cols-3" data-share-breakdown={selected ?? "all"}>
              <ShareRank
                title="By model"
                entries={breakdown.models}
                measure={measure}
                color={selected === null ? null : identityOf(selected).color}
              />
              <ShareRank
                title="By project"
                entries={breakdown.projects}
                measure={measure}
                color={selected === null ? null : identityOf(selected).color}
              />
              <ShareRank
                title="By day"
                entries={breakdown.days}
                measure={measure}
                color={selected === null ? null : identityOf(selected).color}
                formatLabel={formatDayShort}
                keepOrder
              />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ShareTable({
  views,
  measure,
  identityOf,
}: {
  readonly views: readonly SubscriptionView[];
  readonly measure: ShareMeasure;
  readonly identityOf: ShareIdentityOf;
}) {
  const cell = (value: number) => (value > 0 ? formatMeasure(value, measure) : "");
  return (
    <Table data-share-table>
      <TableHeader>
        <TableRow>
          <TableHead>Subscription</TableHead>
          <TableHead>Machine</TableHead>
          <TableHead className="text-right">In SpecWithCode</TableHead>
          <TableHead className="text-right">Outside the app</TableHead>
          <TableHead className="text-right">Not split</TableHead>
          <TableHead className="text-right">Total</TableHead>
          <TableHead className="text-right">Share</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {views.flatMap((view) => {
          const name = `${view.provider}${view.account ? ` · ${view.account}` : ""}`;
          const outside = view.segments.find((segment) => segment.kind === "outside");
          const rows = view.subscription.machines.map((machine) => (
            <TableRow key={`${view.accountKey}:${machine.machineId}`}>
              <TableCell>{name}</TableCell>
              <TableCell>
                <span className="flex items-center gap-1.5">
                  <ShareSwatch kind="app" machineId={machine.machineId} identityOf={identityOf} />
                  {identityOf(machine.machineId).name}
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {cell(measureOf(machine.app, measure))}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {cell(measureOf(machine.native, measure))}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {cell(measureOf(machine.unsplit, measure))}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatMeasure(measureOf(machine.total, measure), measure)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatPercent(
                  view.segments
                    .filter((segment) => segment.machineId === machine.machineId)
                    .reduce((sum, segment) => sum + segment.share, 0),
                  0,
                )}
              </TableCell>
            </TableRow>
          ));
          return outside
            ? [
                ...rows,
                <TableRow key={`${view.accountKey}:outside`}>
                  <TableCell>{name}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1.5">
                      <ShareSwatch kind="outside" machineId={null} identityOf={identityOf} />
                      {OUTSIDE_LABEL}
                    </span>
                  </TableCell>
                  <TableCell />
                  <TableCell />
                  <TableCell />
                  <TableCell className="text-right tabular-nums">
                    {outside.value === null ? "" : `≈ ${formatMeasure(outside.value, measure)}`}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatPercent(outside.share, 0)}
                  </TableCell>
                </TableRow>,
              ]
            : rows;
        })}
      </TableBody>
    </Table>
  );
}

const MACHINE_STATE_TEXT = {
  live: "reporting",
  summary: "older version, totals only",
  missing: "no report",
} as const;

export interface UsageMachinesProps {
  readonly inputs: readonly ShareMachineInput[];
  readonly histories: ReadonlyArray<ReadonlyArray<UsageLimitHistorySeries>>;
  readonly scopedWindowIds: ReadonlySet<string>;
  readonly identityOf: ShareIdentityOf;
  readonly now: number;
  readonly period: SharePeriod;
  readonly onPeriodChange: (period: SharePeriod) => void;
  /** No machine has answered yet. */
  readonly loading: boolean;
}

/**
 * Usage > Machines: each subscription as a bar split by the machines that used
 * it, with the days and the breakdown behind it.
 */
export function UsageMachines({
  inputs,
  histories,
  scopedWindowIds,
  identityOf,
  now,
  period,
  onPeriodChange,
  loading,
}: UsageMachinesProps) {
  const [measure, setMeasure] = useState<ShareMeasure>("cost");
  const [layout, setLayout] = useState<"chart" | "table">("chart");
  const [opened, setOpened] = useState<ReadonlySet<string> | null>(null);
  const views = useMemo(
    () =>
      buildSubscriptionViews({
        inputs,
        histories,
        scopedWindowIds,
        period,
        measure,
        now,
        timeZone: VIEWER_TIME_ZONE,
      }),
    [inputs, histories, scopedWindowIds, period, measure, now],
  );
  // The most used subscription starts open; after that the reader decides.
  const open = opened ?? new Set(views[0] ? [views[0].accountKey] : []);
  const today = localDay(now);

  return (
    <div className="flex min-w-0 flex-col gap-5" data-usage-machines>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ToggleGroup
          aria-label="Period"
          variant="segmented"
          className="max-w-full flex-wrap"
          value={[periodValue(period)]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "custom") {
              onPeriodChange({ kind: "custom", sinceDay: dayBefore(today, 6), untilDay: today });
              return;
            }
            const option = SHARE_PERIOD_OPTIONS.find((entry) => entry.value === value);
            if (option) onPeriodChange(option.period);
          }}
        >
          {SHARE_PERIOD_OPTIONS.map((option) => (
            <Toggle key={option.value} value={option.value}>
              {option.label}
            </Toggle>
          ))}
          <Toggle value="custom">Custom</Toggle>
        </ToggleGroup>
        {period.kind === "custom" ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Input
              type="date"
              size="sm"
              aria-label="From"
              className="w-auto"
              value={period.sinceDay}
              min={dayBefore(today, CUSTOM_RANGE_DAYS - 1)}
              max={period.untilDay}
              onChange={(event) => {
                if (event.target.value) onPeriodChange({ ...period, sinceDay: event.target.value });
              }}
            />
            to
            <Input
              type="date"
              size="sm"
              aria-label="To"
              className="w-auto"
              value={period.untilDay}
              min={period.sinceDay}
              max={today}
              onChange={(event) => {
                if (event.target.value) onPeriodChange({ ...period, untilDay: event.target.value });
              }}
            />
          </span>
        ) : null}
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <ToggleGroup
            aria-label="Measure"
            variant="segmented"
            value={[measure]}
            onValueChange={(next) => {
              const option = SHARE_MEASURE_OPTIONS.find((entry) => entry.value === next[0]);
              if (option) setMeasure(option.value);
            }}
          >
            {SHARE_MEASURE_OPTIONS.map((option) => (
              <Toggle key={option.value} value={option.value}>
                {option.label}
              </Toggle>
            ))}
          </ToggleGroup>
          <ToggleGroup
            aria-label="View"
            variant="segmented"
            value={[layout]}
            onValueChange={(next) => {
              if (next[0] === "chart" || next[0] === "table") setLayout(next[0]);
            }}
          >
            <Toggle value="chart">Charts</Toggle>
            <Toggle value="table">Table</Toggle>
          </ToggleGroup>
        </div>
      </div>

      <div className="flex flex-col gap-2 text-xs text-muted-foreground">
        <ul
          className="flex flex-wrap gap-x-4 gap-y-1"
          aria-label="Machines asked"
          data-share-machines
        >
          {inputs.map((input) => (
            <li key={input.machineId} className="flex items-center gap-1.5">
              <ShareSwatch kind="app" machineId={input.machineId} identityOf={identityOf} />
              <span className="font-medium text-foreground">
                {identityOf(input.machineId).name}
              </span>
              <span>
                {input.state === "cached"
                  ? `out of reach, last reported ${
                      input.report ? formatDateTimeShort(input.report.readAt) : "earlier"
                    }`
                  : (input.note ?? MACHINE_STATE_TEXT[input.state])}
              </span>
            </li>
          ))}
        </ul>
        <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Legend">
          <li className="flex items-center gap-1.5">
            <ShareSwatch kind="app" machineId={null} identityOf={identityOf} />
            In SpecWithCode, in the machine's colour
          </li>
          <li className="flex items-center gap-1.5">
            <ShareSwatch kind="native" machineId={null} identityOf={identityOf} />
            Outside the app on that machine
          </li>
          <li className="flex items-center gap-1.5">
            <ShareSwatch kind="outside" machineId={null} identityOf={identityOf} />
            {OUTSIDE_LABEL}
          </li>
        </ul>
      </div>

      {views.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {loading
            ? "Asking each machine what it recorded."
            : inputs.length === 0
              ? "No machine to ask."
              : "No subscription use recorded on these machines in this period."}
        </p>
      ) : layout === "table" ? (
        <ShareTable views={views} measure={measure} identityOf={identityOf} />
      ) : (
        views.map((view) => (
          <SubscriptionCard
            key={view.accountKey}
            view={view}
            measure={measure}
            identityOf={identityOf}
            open={open.has(view.accountKey)}
            onToggle={() => {
              const next = new Set(open);
              if (!next.delete(view.accountKey)) next.add(view.accountKey);
              setOpened(next);
            }}
          />
        ))
      )}
    </div>
  );
}
