import { formatTokens } from "@specweave-studio/shared/usageFormat";
import { formatDuration } from "@specweave-studio/shared/usageLimits";
import type { LimitHistoryIndex } from "@specweave-studio/shared/usageLimitForecast";
import { Fragment, useState } from "react";

import { cn } from "../../../lib/utils";
import { ProviderInstanceIcon } from "../../chat/ProviderInstanceIcon";
import { Button } from "../../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../ui/table";
import { formatDay } from "./SubscriptionRow";
import { type EfficiencyPeriod, busiestDay } from "./efficiency";
import type { SubscriptionRenewal } from "./subscriptionRows";

export const RESETS_PAGE_SIZE = 10;

const CAUSE: Record<EfficiencyPeriod["cause"], string> = {
  scheduled: "At its scheduled time",
  early: "Reset early by the provider",
  redeemed: "A banked reset was used",
};

function periodKey(period: EfficiencyPeriod): string {
  return `${period.accountKey}|${period.windowId}|${period.endedAt}`;
}

function formatWhen(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Use through the period against an even pace, from the quota history. Only
 * recent periods have samples, so older rows show the figures without it.
 */
/** The readings kept from inside a period; the quota history holds about two weeks. */
function samplesOf(period: EfficiencyPeriod, history: LimitHistoryIndex | null) {
  const startedAt = period.startedAt;
  return startedAt === null
    ? []
    : (history?.get(`${period.accountKey}|${period.windowKind}:${period.windowId}`) ?? []).filter(
        (sample) => sample.at >= startedAt && sample.at <= period.lastReadAt,
      );
}

function UsePath({
  period,
  samples,
  color,
}: {
  readonly period: EfficiencyPeriod;
  readonly samples: ReturnType<typeof samplesOf>;
  readonly color: string;
}) {
  const startedAt = period.startedAt;
  if (startedAt === null || samples.length < 3) return null;
  const span = Math.max(1, period.endedAt - startedAt);
  const x = (at: number) => ((at - startedAt) / span) * 100;
  const y = (used: number) => 40 - (Math.max(0, Math.min(100, used)) / 100) * 40;
  const points = [
    `0,${y(0)}`,
    ...samples.map((sample) => `${x(sample.at).toFixed(2)},${y(sample.usedPercent).toFixed(2)}`),
  ].join(" ");
  return (
    <figure className="flex flex-col gap-1" data-use-path="">
      <figcaption className="text-xs text-muted-foreground">
        Use through the period (line) against an even pace (dashed)
      </figcaption>
      <svg
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        className="h-14 w-full"
        role="img"
        aria-label={`Use rose to ${Math.round(period.usedPercent)}% by the reset`}
      >
        <line
          x1="0"
          y1="40"
          x2="100"
          y2="40"
          className="stroke-border"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1="0"
          y1="40"
          x2="100"
          y2="0"
          className="stroke-muted-foreground"
          strokeWidth="1"
          strokeDasharray="3 4"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </figure>
  );
}

function Fact({ value, note }: { readonly value: string; readonly note: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-sm font-medium text-foreground">{value}</span>
      <span className="text-xs text-muted-foreground">{note}</span>
    </div>
  );
}

function TokensFact({
  lost,
  tooLittleUsed,
}: {
  readonly lost: number | null;
  /** The only thing in the way of an estimate is how little was used. */
  readonly tooLittleUsed: boolean;
}) {
  return lost === null ? (
    <Fact
      value="Tokens not measurable"
      note={
        tooLittleUsed
          ? "too little was used to estimate from"
          : "the spend behind this percent cannot be told apart here"
      }
    />
  ) : lost === 0 ? (
    <Fact value="No tokens left unused" note="the quota was used up" />
  ) : (
    <Fact
      value={`About ${formatTokens(Math.round(lost))} tokens unused`}
      note="estimate from this fleet's own usage"
    />
  );
}

function BusiestFact({ samples }: { readonly samples: ReturnType<typeof samplesOf> }) {
  const busiest = busiestDay(samples);
  return busiest === null ? (
    <Fact value="Busiest day not kept" note="daily readings are kept for about two weeks" />
  ) : (
    <Fact
      value={`Busiest ${new Date(busiest.day).toLocaleDateString(undefined, { weekday: "long" })}, ${formatDay(busiest.day)}`}
      note={`${Math.round(busiest.percent)}% of the quota that day`}
    />
  );
}

function RenewalFact({ renewal }: { readonly renewal: SubscriptionRenewal | null }) {
  return renewal === null ? (
    <Fact value="Renewal not reported" note="the provider gives no date and no day is set" />
  ) : (
    <Fact
      value={`Renews ${formatDay(renewal.at)}`}
      note={renewal.source === "provider" ? "reported by the provider" : "from the day you set"}
    />
  );
}

/**
 * Every reset in scope, newest first, ten to a page. A row opens in place
 * with what the table leaves out: how exact the figure is, the planned
 * share, the token estimate, the busiest day, the renewal, where the account
 * is signed in, and use through the period.
 */
export function ResetsTable({
  periods,
  history,
  labelOf,
  colorOf,
  machinesOf,
  tokensLostOf,
  renewalOf,
  targetOf,
}: {
  readonly periods: readonly EfficiencyPeriod[];
  readonly history: LimitHistoryIndex | null;
  readonly labelOf: (accountKey: string) => string;
  readonly colorOf: (accountKey: string) => string;
  readonly machinesOf: (accountKey: string) => readonly string[];
  readonly tokensLostOf: (period: EfficiencyPeriod) => number | null;
  readonly renewalOf: (accountKey: string) => SubscriptionRenewal | null;
  readonly targetOf: (accountKey: string) => number;
}) {
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const pages = Math.max(1, Math.ceil(periods.length / RESETS_PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const first = current * RESETS_PAGE_SIZE;
  const shown = periods.slice(first, first + RESETS_PAGE_SIZE);
  if (periods.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-resets-table="empty">
        No reset recorded here yet. Resets appear as each weekly or monthly window starts over while
        the app is running.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-resets-table="">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Reset</TableHead>
            <TableHead>Subscription</TableHead>
            <TableHead>Used</TableHead>
            <TableHead className="text-right">Unused</TableHead>
            <TableHead className="hidden sm:table-cell">Why it reset</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((period, index) => {
            const key = periodKey(period);
            const detailId = `reset-detail-${first + index}`;
            const isOpen = open === key;
            const color = colorOf(period.accountKey);
            const machines = machinesOf(period.accountKey);
            const target = targetOf(period.accountKey);
            const gap = period.endedAt - period.lastReadAt;
            return (
              <Fragment key={key}>
                <TableRow
                  data-reset-row={key}
                  className={cn("cursor-pointer", isOpen && "bg-muted/50")}
                  onClick={() => setOpen(isOpen ? null : key)}
                >
                  <TableCell className="whitespace-nowrap tabular-nums">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={isOpen ? detailId : undefined}
                      aria-label={`${formatWhen(period.endedAt)}, ${labelOf(period.accountKey)}`}
                      className="rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpen(isOpen ? null : key);
                      }}
                    >
                      {formatWhen(period.endedAt)}
                    </button>
                  </TableCell>
                  <TableCell className="max-w-36 sm:max-w-none">
                    <span className="flex min-w-0 items-center gap-2">
                      <ProviderInstanceIcon
                        driverKind={period.driver}
                        displayName={labelOf(period.accountKey)}
                        showBadge={false}
                        className="size-4 shrink-0"
                        iconClassName="size-4 text-foreground/80"
                      />
                      <span className="min-w-0 truncate">{labelOf(period.accountKey)}</span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2 tabular-nums">
                      <span className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-muted sm:block">
                        <span
                          className="block h-full rounded-full"
                          style={{ width: `${period.usedPercent}%`, backgroundColor: color }}
                        />
                      </span>
                      {period.upperBound ? (
                        <span className="hidden sm:inline">at least</span>
                      ) : null}
                      {Math.round(period.usedPercent)}%
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {period.upperBound ? "up to " : ""}
                    {Math.round(period.lostPercent)}%
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">{CAUSE[period.cause]}</TableCell>
                </TableRow>
                {isOpen ? (
                  <TableRow id={detailId} data-reset-detail={key} className="hover:bg-transparent">
                    <TableCell colSpan={5} className="bg-muted/30">
                      <div className="flex flex-col gap-3 py-1">
                        <div className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
                          <Fact
                            value={`${period.upperBound ? "At least " : ""}${Math.round(period.usedPercent)}% used`}
                            note={
                              target === 100
                                ? "of the whole subscription"
                                : `of a planned ${target}%`
                            }
                          />
                          <Fact
                            value={`Read ${formatDuration(gap)} before`}
                            note={
                              period.upperBound
                                ? "use after that read is unknown"
                                : "so the figure is exact"
                            }
                          />
                          <Fact
                            value={
                              period.startedAt === null
                                ? "Start not seen"
                                : `${formatDay(period.startedAt)} to ${formatDay(period.endedAt)}`
                            }
                            note={CAUSE[period.cause]}
                          />
                          <Fact
                            value={
                              machines.length === 0 ? "Not signed in now" : machines.join(", ")
                            }
                            note="where it is signed in"
                          />
                          <TokensFact
                            lost={tokensLostOf(period)}
                            tooLittleUsed={!period.upperBound && period.usedPercent < 5}
                          />
                          <BusiestFact samples={samplesOf(period, history)} />
                          <RenewalFact renewal={renewalOf(period.accountKey)} />
                        </div>
                        <UsePath
                          period={period}
                          samples={samplesOf(period, history)}
                          color={color}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span data-resets-range="">
          {first + 1} to {first + shown.length} of {periods.length}{" "}
          {periods.length === 1 ? "reset" : "resets"}
        </span>
        {pages > 1 ? (
          <span className="flex gap-1.5">
            <Button
              size="xs"
              variant="outline"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              Previous
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
            >
              Next
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  );
}
