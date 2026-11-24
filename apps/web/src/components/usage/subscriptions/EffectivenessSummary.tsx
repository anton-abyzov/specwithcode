/**
 * "Used before reset" at the top of the usage ring's panel: one number for how
 * much of each weekly limit was spent before it reset, then a row per provider
 * with its logo, its last two weeks and this week's projection, and its next
 * reset. The full view is Usage > Limits > Subscriptions, one click away.
 */
import { useAtomValue } from "@effect/atom-react";
import { collectLimitAccounts } from "@specweave-studio/shared/usageLimits";
import { useMemo } from "react";

import { usePrimarySettings } from "../../../hooks/useSettings";
import { environmentPresentations } from "../../../state/presentation";
import { useMachineNicknames } from "../../../studio/machineNickname";
import { ProviderInstanceIcon } from "../../chat/ProviderInstanceIcon";
import {
  type EffectivenessIndex,
  INDEX_DAYS,
  type IndexProvider,
  effectivenessIndex,
} from "./effectivenessIndex";
import { subscriptionRows } from "./subscriptionRows";
import { useUsageResetLedger } from "./usageResetLedgerState";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** "today 5:25 PM", "tomorrow 9:00 AM", or "Dec 4". */
export function resetWhen(at: number, now: number): string {
  const day = (value: number) => new Date(value).toDateString();
  if (day(at) === day(now)) return `today ${timeFormat.format(at)}`;
  if (day(at) === day(now + 24 * 60 * 60_000)) return `tomorrow ${timeFormat.format(at)}`;
  return dayFormat.format(at);
}

const percent = (value: number) => `${Math.round(value)}%`;

function Ring({ value }: { readonly value: number | null }) {
  const radius = 26;
  const length = 2 * Math.PI * radius;
  const shown = value ?? 0;
  return (
    <svg
      width="56"
      height="56"
      viewBox="0 0 64 64"
      role="img"
      aria-label={value === null ? "No reset recorded yet" : `${percent(value)} used before reset`}
      className="shrink-0"
    >
      <circle cx="32" cy="32" r={radius} fill="none" strokeWidth="7" className="stroke-muted" />
      {value === null ? null : (
        <circle
          cx="32"
          cy="32"
          r={radius}
          fill="none"
          strokeWidth="7"
          strokeLinecap="round"
          className="stroke-primary"
          strokeDasharray={`${(length * shown) / 100} ${length}`}
          transform="rotate(-90 32 32)"
        />
      )}
      <text
        x="32"
        y="37"
        textAnchor="middle"
        className="fill-foreground text-sm font-semibold tabular-nums"
      >
        {value === null ? "–" : percent(value)}
      </text>
    </svg>
  );
}

/**
 * Two past weeks, solid, then this week's projection, dashed. A week with no reset is a
 * baseline, and so is this week when there is no projection to draw.
 */
function Spark({ provider }: { readonly provider: IndexProvider }) {
  const bar = (value: number | null, key: string, projected = false) =>
    value === null ? (
      <i key={key} className="h-0.5 flex-1 rounded-xs bg-border" />
    ) : (
      <i
        key={key}
        className={
          projected
            ? "flex-1 rounded-t-xs border border-b-0 border-dashed border-primary"
            : "flex-1 rounded-t-xs bg-primary"
        }
        style={{ height: `${Math.max(8, Math.min(100, value))}%` }}
      />
    );
  return (
    <div className="flex h-5 w-12 items-end gap-0.5" aria-hidden data-effectiveness-spark="">
      {bar(provider.pastWeeks[0].usedPercent, "w0")}
      {bar(provider.pastWeeks[1].usedPercent, "w1")}
      {bar(provider.projectedUsedPercent, "now", true)}
    </div>
  );
}

export function subline(provider: IndexProvider, now: number): string {
  // The reading first: a spent limit is a fact, not a pace.
  if (provider.atLimit) {
    return provider.atLimitUntil === null
      ? "at its limit"
      : `at its limit until ${resetWhen(provider.atLimitUntil, now)}`;
  }
  if (provider.nextReset === null) {
    return provider.lastResetAt === null
      ? "no reset time reported"
      : `last reset ${dayFormat.format(provider.lastResetAt)}`;
  }
  const when = resetWhen(provider.nextReset.at, now);
  const left = provider.nextReset.projectedLeftPercent;
  if (left === null) {
    // No pace to project (no reset recorded yet, or the window is under a day old).
    return provider.usedNowPercent === null
      ? `resets ${when}`
      : `${percent(provider.usedNowPercent)} used · resets ${when}`;
  }
  return Math.round(left) > 0
    ? `${when} · leaves ~${Math.round(left)}%`
    : `${when} · on pace to use it all`;
}

/** The chart in words, for screen readers: the bars themselves are hidden from them. */
function trendText(provider: IndexProvider): string {
  const weeks = provider.pastWeeks
    .map((week) => (week.usedPercent === null ? "no reset" : `${percent(week.usedPercent)} used`))
    .join(", then ");
  const now =
    provider.projectedUsedPercent === null
      ? ""
      : `; this week on pace for ${percent(provider.projectedUsedPercent)}`;
  return `Last two weeks ${weeks}${now}.`;
}

export function EffectivenessSummaryView({
  index,
  now,
}: {
  readonly index: EffectivenessIndex;
  readonly now: number;
}) {
  return (
    <section className="flex flex-col gap-2" aria-label="Used before reset" data-effectiveness="">
      <div className="flex items-center gap-3">
        <Ring value={index.usedPercent} />
        <div className="flex min-w-0 flex-col text-xs text-muted-foreground">
          <span>Used before reset · 4 weeks</span>
          <strong className="text-sm font-medium text-foreground">
            {index.usedPercent === null
              ? "No reset recorded yet"
              : `${100 - Math.round(index.usedPercent)}% left on the table per reset`}
          </strong>
          <span>
            {index.resets === 0
              ? "The first reset fills this in"
              : `${index.resets} ${index.resets === 1 ? "reset" : "resets"}`}
          </span>
        </div>
      </div>
      {index.providers.length > 0 ? (
        <ul className="flex flex-col">
          {index.providers.map((provider) => {
            const name = provider.group.label;
            return (
              <li
                key={provider.group.key}
                className="grid grid-cols-[1rem_minmax(0,1fr)_3rem_2.5rem] items-center gap-x-2 rounded-md px-1 py-1"
                data-effectiveness-provider={provider.group.key}
              >
                <ProviderInstanceIcon
                  driverKind={provider.driver}
                  displayName={name}
                  acpRegistryIconUrl={provider.group.iconUrl ?? undefined}
                  showBadge={false}
                  indicatorBackground="var(--popover)"
                  className="size-4"
                  iconClassName="size-4 text-foreground/80"
                />
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-foreground">{name}</div>
                  <div className="truncate text-2xs text-muted-foreground">
                    {subline(provider, now)}
                  </div>
                </div>
                <Spark provider={provider} />
                <span className="sr-only">{trendText(provider)}</span>
                <span
                  className={
                    provider.usedPercent === null
                      ? "text-right text-xs text-muted-foreground"
                      : "text-right text-xs font-semibold tabular-nums text-foreground"
                  }
                >
                  {provider.usedPercent === null ? "new" : percent(provider.usedPercent)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

/** Reads the same snapshots as the rest of the panel, plus each connected machine's reset ledger. */
export function EffectivenessSummary({ now }: { readonly now: number }) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const nickname = useMachineNicknames();
  const renewalDays = usePrimarySettings((settings) => settings.subscriptionRenewalDays);
  const accounts = useMemo(
    () => collectLimitAccounts(presentations, { machineName: nickname }),
    [presentations, nickname],
  );
  const connected = useMemo(
    () =>
      [...presentations]
        .filter(
          ([, presentation]) =>
            presentation.connection === undefined || presentation.connection.phase === "connected",
        )
        .map(([environmentId]) => environmentId),
    [presentations],
  );
  // Five weeks covers the four-week index and the week bucket the oldest reset falls in.
  const ledger = useUsageResetLedger(connected, now, INDEX_DAYS + 7);
  const index = useMemo(
    () =>
      effectivenessIndex(
        subscriptionRows(accounts, ledger?.periods ?? [], renewalDays, now),
        ledger?.periods ?? [],
        now,
      ),
    [accounts, ledger, renewalDays, now],
  );
  if (ledger === null) return null;
  return <EffectivenessSummaryView index={index} now={now} />;
}
