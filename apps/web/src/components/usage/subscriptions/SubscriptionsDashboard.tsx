import type { UsageResetPeriod } from "@specweave-studio/contracts";
import { formatTokens } from "@specweave-studio/shared/usageFormat";
import { formatDuration } from "@specweave-studio/shared/usageLimits";
import type { LimitHistoryIndex } from "@specweave-studio/shared/usageLimitForecast";
import { type ReactNode, useState } from "react";

import { cn } from "../../../lib/utils";
import { ProviderInstanceIcon } from "../../chat/ProviderInstanceIcon";
import { Button } from "../../ui/button";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { EfficiencyChart, ScoreRing, useGrowIn } from "./EfficiencyChart";
import { ResetsTable } from "./ResetsTable";
import { formatDay } from "./SubscriptionRow";
import {
  DASHBOARD_RANGES,
  type DashboardGroup,
  type DashboardGroupBy,
  type DashboardRange,
  type EfficiencyPeriod,
  accountWidePeriods,
  efficiencyDashboard,
  rangeTokensLost,
  targetOf,
} from "./efficiency";
import { type SubscriptionRenewal, type SubscriptionRow, nextRenewalOn } from "./subscriptionRows";

const GROUPS: ReadonlyArray<{ readonly value: DashboardGroupBy; readonly label: string }> = [
  { value: "provider", label: "Provider" },
  { value: "account", label: "Account" },
  { value: "machine", label: "Machine" },
];

function Tile({
  title,
  children,
  className,
  name,
}: {
  /** Left out where the tile lays its own heading beside a figure. */
  readonly title?: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly name: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-lg border border-border/60 p-3",
        className,
      )}
      data-dashboard-tile={name}
    >
      {title === undefined ? null : <span className="text-xs text-muted-foreground">{title}</span>}
      {children}
    </div>
  );
}

/** What a subscription is planned for and costs; both only shape the score. */
function PlanEditor({
  accountKey,
  target,
  price,
  onSave,
  onCancel,
}: {
  readonly accountKey: string;
  readonly target: number;
  readonly price: number | undefined;
  readonly onSave: (accountKey: string, plan: { target: number; price: number | null }) => void;
  readonly onCancel: () => void;
}) {
  const [targetText, setTargetText] = useState(String(target));
  const [priceText, setPriceText] = useState(price === undefined ? "" : String(price));
  const nextTarget = Number(targetText);
  const nextPrice = priceText.trim() === "" ? null : Number(priceText);
  const valid =
    Number.isInteger(nextTarget) &&
    nextTarget >= 1 &&
    nextTarget <= 100 &&
    (nextPrice === null || (Number.isFinite(nextPrice) && nextPrice > 0 && nextPrice <= 100_000));
  const field =
    "h-6 rounded-md border border-input bg-background px-1.5 text-xs text-foreground tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <form
      className="col-span-full flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground"
      data-plan-editor={accountKey}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSave(accountKey, { target: nextTarget, price: nextPrice });
      }}
    >
      <label className="flex items-center gap-1.5">
        I plan to use
        <input
          type="number"
          min={1}
          max={100}
          inputMode="numeric"
          autoFocus
          value={targetText}
          onChange={(event) => setTargetText(event.target.value)}
          aria-label="Percent of this subscription you plan to use"
          className={cn(field, "w-14")}
        />
        %
      </label>
      <label className="flex items-center gap-1.5">
        Price a month
        <input
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          value={priceText}
          onChange={(event) => setPriceText(event.target.value)}
          aria-label="What this subscription costs a month"
          placeholder="optional"
          className={cn(field, "w-20")}
        />
      </label>
      <Button type="submit" size="xs" variant="outline" disabled={!valid}>
        Save
      </Button>
      <Button type="button" size="xs" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

function GroupRow({
  group,
  driver,
  color,
  editing,
  onEdit,
  children,
}: {
  readonly group: DashboardGroup;
  /** The provider whose logo leads the name; null for a machine group. */
  readonly driver: UsageResetPeriod["driver"] | null;
  readonly color: string;
  readonly editing: boolean;
  readonly onEdit: (() => void) | null;
  readonly children?: ReactNode;
}) {
  const grown = useGrowIn();
  const target = Math.round(group.targetPercent);
  const met = group.score >= 99.5;
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_minmax(4rem,1.2fr)_auto] items-center gap-x-3 gap-y-1.5 border-t border-border/60 py-2 first:border-t-0"
      data-dashboard-group={group.key}
    >
      <span className="flex min-w-0 items-center gap-2">
        {driver === null ? null : (
          <ProviderInstanceIcon
            driverKind={driver}
            displayName={group.label}
            showBadge={false}
            className="size-4 shrink-0"
            iconClassName="size-4 text-foreground/80"
          />
        )}
        <span className="min-w-0 truncate text-sm font-medium">{group.label}</span>
      </span>
      <span
        className="relative h-2 rounded-full bg-muted"
        role="img"
        aria-label={`${Math.round(group.usedPercent)}% used against a plan of ${target}%`}
      >
        <span
          className="block h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{
            width: grown ? `${Math.max(0, Math.min(100, group.usedPercent))}%` : "0%",
            backgroundColor: color,
          }}
        />
        <span
          className="absolute -top-1 h-4 w-0.5 rounded-full bg-foreground/70"
          style={{ left: `calc(${Math.min(100, target)}% - 1px)` }}
          aria-hidden
        />
      </span>
      <span className="flex flex-col items-end text-xs text-muted-foreground tabular-nums">
        <span className="text-sm text-foreground">{Math.round(group.usedPercent)}%</span>
        {onEdit && !editing ? (
          <button
            type="button"
            className="rounded-sm underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onEdit}
          >
            plan {target}%{met && target < 100 ? ", met" : ""}
          </button>
        ) : (
          <span>
            plan {target}%{met && target < 100 ? ", met" : ""}
          </span>
        )}
      </span>
      {children}
    </div>
  );
}

export interface SubscriptionsDashboardProps {
  /** Closed periods from every connected machine; null while the first read is out. */
  readonly ledger: readonly UsageResetPeriod[] | null;
  readonly rows: readonly SubscriptionRow[];
  readonly history: LimitHistoryIndex | null;
  readonly now: number;
  readonly targets: Readonly<Record<string, number>>;
  /** Renewal days the person set, for an account that is signed out and has no row. */
  readonly renewalDays?: Readonly<Record<string, number>>;
  readonly prices: Readonly<Record<string, number>>;
  readonly labelOf: (accountKey: string) => string;
  readonly colorOf: (accountKey: string) => string;
  readonly providerOf: (driver: UsageResetPeriod["driver"]) => string;
  readonly providerColorOf: (driver: UsageResetPeriod["driver"]) => string;
  readonly machinesOf: (accountKey: string) => readonly string[];
  /** Tokens the unused quota of one reset would have bought, or null when not measurable. */
  readonly tokensLostOf: (period: EfficiencyPeriod) => number | null;
  readonly onSetPlan: (
    accountKey: string,
    plan: { readonly target: number; readonly price: number | null },
  ) => void;
}

/**
 * The Subscriptions dashboard: one filter row, the efficiency score and its
 * neighbours, the score by week, each group against its plan, and the resets
 * behind the numbers. Everything below the filters reads the same range.
 */
export function SubscriptionsDashboard(props: SubscriptionsDashboardProps) {
  const { ledger, rows, now, targets, prices } = props;
  const [range, setRange] = useState<DashboardRange>("4w");
  const [groupBy, setGroupBy] = useState<DashboardGroupBy>("provider");
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const dashboard = efficiencyDashboard(ledger ?? [], now, {
    range,
    groupBy,
    targets,
    prices,
    groupsOf: ({ accountKey, driver }) =>
      groupBy === "provider"
        ? [{ key: `provider:${driver}`, label: props.providerOf(driver) }]
        : groupBy === "account"
          ? [{ key: accountKey, label: props.labelOf(accountKey) }]
          : (() => {
              // A reset is the account's, not one machine's: an account on two machines is
              // its own group, so no machine is credited with quota another may have spent.
              const machines = props.machinesOf(accountKey).toSorted();
              return machines.length === 0
                ? [{ key: "machine:", label: "Not signed in now" }]
                : [{ key: `machine:${machines.join("|")}`, label: machines.join(" + ") }];
            })(),
  });
  const column = selected === null ? null : (dashboard.columns[selected] ?? null);
  const tablePeriods = column
    ? accountWidePeriods(ledger ?? [])
        .filter((period) => period.endedAt >= column.start && period.endedAt < column.end)
        .toSorted((left, right) => right.endedAt - left.endedAt)
    : dashboard.periods;

  const expiring = rows
    .flatMap((row) =>
      row.windows
        .filter((window) => window.expiring && window.resetsAt !== null)
        .map((window) => ({ row, window })),
    )
    .toSorted((left, right) => right.window.leftPercent - left.window.leftPercent)[0];
  const banked = rows.filter((row) => row.credits !== null);
  const bankedCount = banked.reduce((sum, row) => sum + (row.credits?.count ?? 0), 0);
  const nextExpiry = banked
    .map((row) => row.credits?.nextExpiresAt ?? null)
    .filter((at): at is number => at !== null)
    .toSorted((left, right) => left - right)[0];
  // From the same resets as the percent beside it, so the two cover one span.
  const tokens = rangeTokensLost(dashboard.periods, props.tokensLostOf);
  const renewalOf = (accountKey: string): SubscriptionRenewal | null => {
    const row = rows.find((entry) => entry.accountKey === accountKey);
    if (row) return row.renewal;
    const day = props.renewalDays?.[accountKey];
    return day === undefined ? null : { at: nextRenewalOn(day, now), source: "set", day };
  };
  // A floor on either side cannot be subtracted into an exact change.
  const delta =
    dashboard.score === null ||
    dashboard.previousScore === null ||
    dashboard.upperBound ||
    dashboard.previousUpperBound
      ? null
      : Math.round(dashboard.score - dashboard.previousScore);
  const driverOfGroup = (group: DashboardGroup) =>
    groupBy === "machine"
      ? null
      : (accountWidePeriods(ledger ?? []).find((period) =>
          group.accountKeys.includes(period.accountKey),
        )?.driver ?? null);
  const colorOfGroup = (group: DashboardGroup) => {
    if (groupBy === "account") return props.colorOf(group.key);
    const first = accountWidePeriods(ledger ?? []).find((period) =>
      group.accountKeys.includes(period.accountKey),
    );
    return groupBy === "provider" && first ? props.providerColorOf(first.driver) : "var(--primary)";
  };

  return (
    <div className="flex flex-col gap-4" data-subscriptions-dashboard="">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ToggleGroup
          aria-label="Time range"
          value={[range]}
          onValueChange={(next) => {
            const value = DASHBOARD_RANGES.find((entry) => entry.value === next[0])?.value;
            if (value === undefined) return;
            setRange(value);
            setSelected(null);
            setEditing(null);
          }}
        >
          {DASHBOARD_RANGES.map((entry) => (
            <Toggle key={entry.value} value={entry.value}>
              {entry.label}
            </Toggle>
          ))}
        </ToggleGroup>
        <ToggleGroup
          aria-label="Group by"
          value={[groupBy]}
          onValueChange={(next) => {
            const value = GROUPS.find((entry) => entry.value === next[0])?.value;
            if (value === undefined) return;
            setGroupBy(value);
            setEditing(null);
          }}
        >
          {GROUPS.map((entry) => (
            <Toggle key={entry.value} value={entry.value}>
              {entry.label}
            </Toggle>
          ))}
        </ToggleGroup>
        <span className="text-xs text-muted-foreground" data-dashboard-range="">
          {formatDay(dashboard.rangeStart)} to {formatDay(dashboard.rangeEnd - 1)}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <Tile name="efficiency" className="flex-row items-center gap-4">
          <ScoreRing score={dashboard.score} floor={dashboard.upperBound} />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-muted-foreground">Efficiency</span>
            {dashboard.score === null ? (
              <span className="text-sm font-medium">
                {ledger === null ? "Reading the reset history…" : "Not enough history yet"}
              </span>
            ) : (
              <span className="flex flex-col">
                {dashboard.upperBound ? (
                  <span className="text-xs text-muted-foreground" data-efficiency-floor="">
                    at least
                  </span>
                ) : null}
                <span className="text-4xl font-semibold tabular-nums" data-efficiency-score="">
                  {Math.round(dashboard.score)}%
                </span>
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {delta === null ? null : delta === 0 ? (
                "No change · "
              ) : (
                <span
                  className={delta >= 0 ? "text-success-foreground" : "text-destructive-foreground"}
                >
                  {delta >= 0 ? "Up" : "Down"} {Math.abs(delta)}{" "}
                  {Math.abs(delta) === 1 ? "point" : "points"}
                  {" · "}
                </span>
              )}
              {dashboard.score === null
                ? "The score needs two resets in the range."
                : `of the quota you planned to use${dashboard.weightedByPrice ? ", weighted by price" : ""}`}
            </span>
          </div>
        </Tile>
        <Tile title="Left unused" name="unused">
          <span className="text-2xl font-semibold tabular-nums">
            {dashboard.unusedPercent === null
              ? "Not reported"
              : `${dashboard.upperBound ? "up to " : ""}${Math.round(dashboard.unusedPercent)}%`}
          </span>
          <span className="text-xs text-muted-foreground">
            {dashboard.unusedPercent === null
              ? "No reset in this range"
              : tokens === null
                ? `average over ${dashboard.resets} ${dashboard.resets === 1 ? "reset" : "resets"}`
                : `about ${formatTokens(tokens)} tokens (estimate)`}
          </span>
        </Tile>
        <Tile title="Resets in 24 hours" name="expiring">
          {expiring ? (
            <>
              <span className="text-2xl font-semibold text-warning-foreground tabular-nums">
                {Math.round(expiring.window.leftPercent)}% left
              </span>
              <span className="text-xs text-muted-foreground">
                {expiring.row.accountKey === null
                  ? expiring.window.title
                  : props.labelOf(expiring.row.accountKey)}
                {" · resets in "}
                {formatDuration((expiring.window.resetsAt ?? now) - now)}
              </span>
            </>
          ) : (
            <>
              <span className="text-2xl font-semibold">Nothing</span>
              <span className="text-xs text-muted-foreground">No quota is about to be lost</span>
            </>
          )}
        </Tile>
        <Tile title="Banked resets" name="banked">
          <span className="text-2xl font-semibold tabular-nums">
            {banked.length === 0 ? "None" : bankedCount}
          </span>
          <span className="text-xs text-muted-foreground">
            {banked.length === 0
              ? "No provider reports any"
              : nextExpiry === undefined
                ? "No expiry reported"
                : `next expires ${formatDay(nextExpiry)}`}
          </span>
        </Tile>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.55fr_1fr]">
        <section className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/60 p-3">
          <h3 className="text-sm font-medium">
            {range === "1y" ? "Efficiency by month" : "Efficiency by week"}
          </h3>
          {dashboard.columns.some((entry) => entry.score !== null) ? (
            <EfficiencyChart
              columns={dashboard.columns}
              range={range}
              selected={selected}
              onSelect={setSelected}
            />
          ) : (
            <p className="text-sm text-muted-foreground" data-efficiency-chart="empty">
              {ledger === null
                ? "Reading the reset history…"
                : "No reset recorded yet. The chart fills in as each weekly or monthly window resets while the app is running."}
            </p>
          )}
        </section>
        <section
          className="flex min-w-0 flex-col gap-1 rounded-lg border border-border/60 p-3"
          data-dashboard-groups=""
        >
          <h3 className="text-sm font-medium">
            By {GROUPS.find((entry) => entry.value === groupBy)?.label.toLowerCase()}
          </h3>
          {dashboard.groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">No reset in this range.</p>
          ) : (
            dashboard.groups.map((group) => {
              const only = group.accountKeys.length === 1 ? group.accountKeys[0]! : null;
              const isEditing = only !== null && editing === group.key;
              return (
                <GroupRow
                  key={group.key}
                  group={group}
                  driver={driverOfGroup(group)}
                  color={colorOfGroup(group)}
                  editing={isEditing}
                  onEdit={only === null ? null : () => setEditing(group.key)}
                >
                  {isEditing && only !== null ? (
                    <PlanEditor
                      accountKey={only}
                      target={targetOf(targets, only)}
                      price={prices[only]}
                      onSave={(accountKey, plan) => {
                        props.onSetPlan(accountKey, plan);
                        setEditing(null);
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  ) : null}
                </GroupRow>
              );
            })
          )}
          <p className="pt-1 text-xs text-muted-foreground">
            The tick is the share you plan to use. A subscription that meets its plan counts in
            full, so a spare kept at 30% does not lower the score.
          </p>
        </section>
      </div>

      <section className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium" data-resets-heading="">
            {column
              ? `Resets · ${range === "1y" ? new Date(column.start).toLocaleDateString(undefined, { month: "long", year: "numeric" }) : `week of ${formatDay(column.start)}`}`
              : "Resets in this range"}
          </h3>
          {column ? (
            <Button size="xs" variant="outline" onClick={() => setSelected(null)}>
              Show the whole range
            </Button>
          ) : null}
        </div>
        <ResetsTable
          key={`${range}:${selected ?? "all"}`}
          periods={tablePeriods}
          history={props.history}
          labelOf={props.labelOf}
          colorOf={props.colorOf}
          machinesOf={props.machinesOf}
          tokensLostOf={props.tokensLostOf}
          renewalOf={renewalOf}
          targetOf={(accountKey) => targetOf(targets, accountKey)}
        />
      </section>
    </div>
  );
}
