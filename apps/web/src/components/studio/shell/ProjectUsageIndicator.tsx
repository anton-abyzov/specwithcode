/**
 * Subscription usage at a glance, under the coordinator composer: one ring per
 * provider for its fullest window, and a popover listing every machine with
 * what is signed in there, the coordinator's own account in full. It reads the
 * snapshots Usage → Limits already holds, so opening it never asks a provider
 * for anything, and it spends nothing.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  collectLimitAccounts,
  collectLimitPools,
  formatDuration,
  type LimitAccount,
  type LimitPool,
} from "@specweave-studio/shared/usageLimits";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, TicketIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { environmentPresentations } from "../../../state/presentation";
import {
  blockedLabel,
  leftPercent,
  usageIndicatorProviders,
  usageIndicatorSummary,
  usageLeftLabel,
  usageTone,
  type UsageIndicatorProvider,
  type UsageIndicatorWindow,
} from "../../../studio/usageIndicatorModel";
import { ProviderInstanceIcon } from "../../chat/ProviderInstanceIcon";
import { getDriverOption } from "../../settings/providerDriverMeta";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../ui/popover";
import "./usage.css";
import { resetCreditsSummary } from "../../usage/UsageLimits";
import type { EnvironmentId, ProviderInstanceId } from "@specweave-studio/contracts";
import { HostLimitsCompact } from "./HostLimits";

const driverLabel = (driver: LimitPool["driver"]) =>
  getDriverOption(driver)?.label ?? String(driver);

/** A 14px ring filled clockwise from the top by the share left. */
function UsageRing({ percent, tone }: { percent: number | null; tone: string }) {
  const circumference = 2 * Math.PI * 5.5;
  const left = Math.min(100, Math.max(0, percent ?? 0));
  return (
    <svg className="sws-usage-ring" viewBox="0 0 14 14" data-tone={tone} aria-hidden>
      <circle cx="7" cy="7" r="5.5" className="sws-usage-ring-track" />
      {percent === null ? null : (
        <circle
          cx="7"
          cy="7"
          r="5.5"
          className="sws-usage-ring-value"
          strokeDasharray={`${(left / 100) * circumference} ${circumference}`}
          transform="rotate(-90 7 7)"
        />
      )}
    </svg>
  );
}

function WindowRow({ window, now }: { window: UsageIndicatorWindow; now: number }) {
  const left = leftPercent(window.usedPercent);
  if (window.blockedBy) {
    return (
      <div className="sws-usage-window" data-blocked="">
        <span className="sws-usage-window-label">{window.label}</span>
        <span className="sws-usage-bar" data-tone="blocked" aria-hidden>
          <span style={{ width: `${left}%` }} />
        </span>
        <span className="sws-usage-window-blocked">{blockedLabel(window.blockedBy, now)}</span>
      </div>
    );
  }
  return (
    <div className="sws-usage-window">
      <span className="sws-usage-window-label">{window.label}</span>
      <span className="sws-usage-bar" data-tone={usageTone(left)} aria-hidden>
        <span style={{ width: `${left}%` }} />
      </span>
      <span className="sws-usage-window-value" data-tone={usageTone(left)}>
        {usageLeftLabel(window.usedPercent)}
      </span>
      <span className="sws-usage-window-reset">
        {window.nextResetAt === null ? "" : `resets in ${formatDuration(window.nextResetAt - now)}`}
      </span>
    </div>
  );
}

function accountName(account: LimitAccount): string {
  return (
    account.displayName ??
    account.environments[0]?.label ??
    account.sourceLabel ??
    driverLabel(account.driver)
  );
}

function ProviderSection({
  provider,
  pool,
  now,
}: {
  provider: UsageIndicatorProvider;
  pool: LimitPool;
  now: number;
}) {
  const label = driverLabel(provider.driver);
  const plans = [...new Set(pool.accounts.flatMap((account) => account.plan ?? []))];
  return (
    <section className="sws-usage-provider" aria-label={`${label} usage`}>
      <header>
        <ProviderInstanceIcon
          driverKind={provider.driver}
          displayName={label}
          showBadge={false}
          indicatorBackground="var(--popover)"
          className="size-4"
          iconClassName="size-4 text-foreground/80"
        />
        <strong>{label}</strong>
        <span className="sws-usage-plan">
          {provider.accountCount > 1
            ? `${provider.accountCount} accounts pooled`
            : (plans[0] ?? "")}
        </span>
        {provider.bankedResets > 0 ? (
          <span className="sws-usage-banked">
            <TicketIcon aria-hidden />
            {provider.bankedResets} {provider.bankedResets === 1 ? "reset" : "resets"} banked
          </span>
        ) : null}
      </header>
      {provider.windows.map((window) => (
        <WindowRow key={`${window.kind}:${window.id}`} window={window} now={now} />
      ))}
      {provider.accountCount > 1
        ? pool.accounts.map((account) => (
            <p key={account.key} className="sws-usage-account">
              <span>{accountName(account)}</span>
              {account.limits.windows.map((window) => (
                <span key={window.id}>
                  {window.label} {leftPercent(window.usedPercent)}% left
                </span>
              ))}
            </p>
          ))
        : null}
      {/* Read-only here: a reset is spent from Limits, behind its own confirmation. */}
      {pool.accounts.map((account) =>
        account.limits.resetCredits && account.limits.resetCredits.availableCount > 0 ? (
          <p key={account.key} className="sws-usage-account">
            <span>
              {provider.accountCount > 1 ? `${accountName(account)}: ` : ""}
              {resetCreditsSummary(account.limits.resetCredits, now)}
            </span>
          </p>
        ) : null,
      )}
    </section>
  );
}

/** Every provider's pooled windows across the connected hosts and hubs, as of `now`. */
function useSubscriptionUsage(
  now: number,
  destination?: {
    environmentId: EnvironmentId | null;
    instanceId: ProviderInstanceId | null;
    model?: string | null;
  },
) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const environmentId = destination?.environmentId;
  const instanceId = destination?.instanceId;
  const model = destination?.model ?? null;
  const scoped = destination !== undefined;
  const presentation = environmentId ? presentations.get(environmentId) : undefined;
  const pools = useMemo(() => {
    if (!scoped) return collectLimitPools(collectLimitAccounts(presentations), now);
    // Admission runs against this host and native instance. Other accounts,
    // even a fresher hub snapshot, cannot lend it their remaining capacity.
    if (!environmentId || !instanceId || !presentation?.serverConfig) return [];
    const selected = new Map([
      [
        environmentId,
        {
          ...presentation,
          serverConfig: {
            providers: presentation.serverConfig.providers?.filter(
              (provider) => provider.instanceId === instanceId,
            ),
          },
        },
      ],
    ]);
    return collectLimitPools(collectLimitAccounts(selected), now);
  }, [presentations, now, scoped, environmentId, instanceId, presentation]);
  const providers = useMemo(() => usageIndicatorProviders(pools, now, model), [pools, now, model]);
  return { pools, providers, environmentLabel: presentation?.entry.target.label };
}

function ProviderSections({
  pools,
  providers,
  now,
}: ReturnType<typeof useSubscriptionUsage> & { now: number }) {
  return providers.map((provider) => {
    const pool = pools.find((candidate) => candidate.driver === provider.driver);
    return pool ? (
      <ProviderSection key={provider.driver} provider={provider} pool={pool} now={now} />
    ) : null;
  });
}

/** The same per-provider breakdown as the indicator's popover, laid out in a settings section. */
export function SubscriptionUsageSummary() {
  const [now, setNow] = useState(Date.now);
  const usage = useSubscriptionUsage(now);
  return (
    <div className="sws-usage-popover sws-usage-summary">
      {usage.providers.length === 0 ? (
        <p className="project-muted">
          No signed-in subscription reports limits on the connected hosts yet.
        </p>
      ) : (
        <ProviderSections {...usage} now={now} />
      )}
      <footer>
        <Link to="/usage" className="sws-usage-link">
          All limits and accounts <ArrowRightIcon aria-hidden />
        </Link>
        <button type="button" className="sws-usage-link" onClick={() => setNow(Date.now())}>
          Update reset countdowns
        </button>
      </footer>
    </div>
  );
}

export function ProjectUsageIndicator({
  onOpenProjectUsage,
  projectEnvironmentId = null,
  providerInstanceId = null,
  model = null,
}: {
  onOpenProjectUsage: () => void;
  /** The actual host and native instance used by this project's coordinator. */
  projectEnvironmentId?: EnvironmentId | null;
  providerInstanceId?: ProviderInstanceId | null;
  /** The model of the coordinator's next turn: model windows (Weekly · Fable) count only for it. */
  model?: string | null;
}) {
  // The clock moves when the popover opens; a ticking one would repaint the composer for nothing.
  const [now, setNow] = useState(Date.now);
  const [open, setOpen] = useState(false);
  const usage = useSubscriptionUsage(now, {
    environmentId: projectEnvironmentId,
    instanceId: providerInstanceId,
    model,
  });
  const { providers } = usage;
  if (providers.length === 0) return null;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setNow(Date.now());
        setOpen(next);
      }}
    >
      <PopoverTrigger
        className="sws-usage-chip"
        aria-label={`Coordinator subscription usage on ${usage.environmentLabel}: ${usageIndicatorSummary(providers, driverLabel)}`}
        title={`Coordinator subscription usage on ${usage.environmentLabel}`}
      >
        {providers.map((provider) => (
          <span key={provider.driver} className="sws-usage-chip-item" data-tone={provider.tone}>
            <ProviderInstanceIcon
              driverKind={provider.driver}
              displayName={driverLabel(provider.driver)}
              showBadge={false}
              className="size-3.5"
              iconClassName="size-3.5"
            />
            <UsageRing
              percent={provider.peak ? leftPercent(provider.peak.usedPercent) : null}
              tone={provider.tone}
            />
            <span className="sws-usage-chip-value">
              {provider.peak ? `${leftPercent(provider.peak.usedPercent)}% left` : "?"}
            </span>
          </span>
        ))}
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" width="lg" padding="compact">
        <div className="sws-usage-popover">
          <header className="sws-usage-popover-head">
            <PopoverTitle>Limits by machine</PopoverTitle>
            <p>
              Each machine uses its own sign-ins. The account this project&apos;s coordinator uses
              on {usage.environmentLabel} shows every window.
            </p>
          </header>
          <HostLimitsCompact
            projectEnvironmentId={projectEnvironmentId}
            coordinatorInstanceId={providerInstanceId}
            now={now}
          />
          <footer>
            <Link to="/usage" className="sws-usage-link">
              All limits and accounts <ArrowRightIcon aria-hidden />
            </Link>
            <button
              type="button"
              className="sws-usage-link"
              onClick={() => {
                setOpen(false);
                onOpenProjectUsage();
              }}
            >
              This project's tokens <ArrowRightIcon aria-hidden />
            </button>
          </footer>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
