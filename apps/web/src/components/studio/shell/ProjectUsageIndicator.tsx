/**
 * Subscription usage beyond the model picker's own band: every machine with what
 * is signed in there, the coordinator's account in full, and the pooled summary
 * the project's Usage tab shows. It reads the snapshots Usage → Limits already
 * holds, so opening it never asks a provider for anything, and it spends nothing.
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
import { ArrowLeftIcon, ArrowRightIcon, TicketIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { environmentPresentations } from "../../../state/presentation";
import {
  blockedLabel,
  leftPercent,
  usageIndicatorProviders,
  usageLeftLabel,
  usageTone,
  type UsageIndicatorProvider,
  type UsageIndicatorWindow,
} from "../../../studio/usageIndicatorModel";
import { ProviderInstanceIcon } from "../../chat/ProviderInstanceIcon";
import { getDriverOption } from "../../settings/providerDriverMeta";
import "./usage.css";
import { resetCreditsSummary } from "../../usage/UsageLimits";
import { openUsageSheet } from "../../usage/usageSheetStore";
import type { EnvironmentId, ProviderInstanceId } from "@specweave-studio/contracts";
import { HostLimitsCompact } from "./HostLimits";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";

const driverLabel = (driver: LimitPool["driver"]) =>
  getDriverOption(driver)?.label ?? String(driver);

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
function useSubscriptionUsage(now: number) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const pools = useMemo(
    () => collectLimitPools(collectLimitAccounts(presentations), now),
    [presentations, now],
  );
  const providers = useMemo(() => usageIndicatorProviders(pools, now, null), [pools, now]);
  return { pools, providers };
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

/**
 * Limits on every machine, inside the coordinator's model picker: the picker's band
 * covers the provider in view, this the rest of the fleet.
 */
export function MachineLimitsPanel({
  projectEnvironmentId,
  coordinatorInstanceId,
  onBack,
  onClose,
  onOpenProjectUsage,
}: {
  projectEnvironmentId: EnvironmentId | null;
  coordinatorInstanceId: ProviderInstanceId | null;
  /** Back to the models, when the panel replaced the picker's list. */
  onBack?: (() => void) | undefined;
  /** Closes the popover holding the panel before the Usage sheet opens over the app. */
  onClose?: (() => void) | undefined;
  onOpenProjectUsage?: (() => void) | undefined;
}) {
  // Read once when it opens; a ticking clock would repaint the picker for nothing.
  const [now] = useState(Date.now);
  return (
    <div className="sws-usage-popover sws-machine-limits" data-machine-limits="">
      <header className="sws-usage-popover-head">
        {onBack ? (
          <button type="button" className="sws-usage-link sws-machine-limits-back" onClick={onBack}>
            <ArrowLeftIcon aria-hidden />
            Models
          </button>
        ) : null}
        <h2 className="sws-machine-limits-title">Limits by machine</h2>
        <p>
          Each machine uses its own sign-ins. When a provider has several limit windows, the one
          that runs out first is brighter.
        </p>
      </header>
      <HostLimitsCompact
        projectEnvironmentId={projectEnvironmentId}
        coordinatorInstanceId={coordinatorInstanceId}
        now={now}
      />
      <footer>
        <button
          type="button"
          className="sws-usage-link"
          aria-haspopup="dialog"
          onClick={() => {
            onClose?.();
            openUsageSheet({ metric: "limits" });
          }}
        >
          All limits and accounts <ArrowRightIcon aria-hidden />
        </button>
        {onOpenProjectUsage ? (
          <button type="button" className="sws-usage-link" onClick={onOpenProjectUsage}>
            This project's tokens <ArrowRightIcon aria-hidden />
          </button>
        ) : null}
      </footer>
    </div>
  );
}

/**
 * The same panel where the coordinator has no model picker (nothing can run it on
 * this host), which is when the other machines' limits matter most.
 */
export function MachineLimitsButton({
  className,
  ...panel
}: {
  className?: string;
  projectEnvironmentId: EnvironmentId | null;
  coordinatorInstanceId: ProviderInstanceId | null;
  onOpenProjectUsage?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={className}>Limits by machine</PopoverTrigger>
      <PopoverPopup side="top" align="start" width="lg" padding="compact">
        {open ? (
          <MachineLimitsPanel
            {...panel}
            onClose={() => setOpen(false)}
            onOpenProjectUsage={
              panel.onOpenProjectUsage
                ? () => {
                    setOpen(false);
                    panel.onOpenProjectUsage?.();
                  }
                : undefined
            }
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
