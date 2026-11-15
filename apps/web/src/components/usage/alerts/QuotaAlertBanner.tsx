import type { EnvironmentId } from "@specweave-studio/contracts";
import {
  type QuotaAlert,
  type QuotaAlertEarlyReset,
  describeQuotaAlert,
  quotaAlertId,
  quotaAlerts,
  visibleQuotaAlerts,
} from "@specweave-studio/shared/quotaAlerts";
import { type LimitAccount, collectLimitAccounts, limitAccountKey } from "@specweave-studio/shared/usageLimits";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { TimerIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../../hooks/useSettings";
import { environmentPresentations } from "../../../state/presentation";
import { useMachineNicknames } from "../../../studio/machineNickname";
import { getDriverOption } from "../../settings/providerDriverMeta";
import { subscriptionRows } from "../subscriptions/subscriptionRows";
import { useUsageResetLedger } from "../subscriptions/usageResetLedgerState";
import { notifyQuotaAlert } from "./quotaAlertNotifications";

const MINUTE = 60_000;
/** The ledger only changes when a window resets, so it is re-read this often. */
const LEDGER_REFRESH_MS = 5 * MINUTE;
/** The banner names this many alerts and counts the rest. */
const SHOWN = 2;
const LIMITS_VIEW_KEY = "specwithcode:usage-limits-view";

/** "Codex Pro": the provider and plan; the alert sentence adds the machine. */
function planLabel(account: LimitAccount | undefined, alert: QuotaAlert): string {
  const provider = getDriverOption(alert.driver as LimitAccount["driver"])?.label ?? alert.driver;
  const plan = account?.limits.planLabel?.trim() || account?.plan?.trim();
  return plan ? `${provider} ${plan}` : provider;
}

/**
 * Quota about to be lost, above the project list: the soonest loss first, a
 * way to the Subscriptions view, and a dismissal that holds until the next
 * period. Renders nothing when there is nothing to say.
 */
export function QuotaAlertBanner({
  alerts,
  labelOf,
  now,
  onOpen,
  onDismiss,
}: {
  readonly alerts: readonly QuotaAlert[];
  readonly labelOf: (alert: QuotaAlert) => string;
  readonly now: number;
  readonly onOpen: () => void;
  readonly onDismiss: (alerts: readonly QuotaAlert[]) => void;
}) {
  if (alerts.length === 0) return null;
  const shown = alerts.slice(0, SHOWN);
  const more = alerts.length - shown.length;
  return (
    <section
      className="mx-2 mb-2 flex flex-col gap-1.5 rounded-lg border border-warning/40 bg-warning/8 p-2.5 text-xs"
      aria-label="Quota about to reset"
      data-quota-alert-banner=""
    >
      <div className="flex items-start gap-2">
        <TimerIcon className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" aria-hidden />
        <ul className="flex min-w-0 flex-1 flex-col gap-1">
          {shown.map((alert) => (
            <li key={quotaAlertId(alert)} className="text-foreground" data-quota-alert={alert.kind}>
              {describeQuotaAlert(alert, labelOf(alert), now)}
            </li>
          ))}
          {more > 0 ? (
            <li className="text-muted-foreground">
              and {more} more {more === 1 ? "subscription" : "subscriptions"}
            </li>
          ) : null}
        </ul>
        <button
          type="button"
          className="-m-1 rounded-sm p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Dismiss until the next reset"
          onClick={() => onDismiss(alerts)}
        >
          <XIcon className="size-3.5" aria-hidden />
        </button>
      </div>
      <button
        type="button"
        className="self-start rounded-sm pl-5.5 text-xs font-medium text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onOpen}
      >
        See subscriptions
      </button>
    </section>
  );
}

/** The live banner: reads every connected machine's accounts and the reset ledger. */
export function QuotaAlerts({ onOpen }: { readonly onOpen?: () => void }) {
  const enabled = usePrimarySettings((settings) => settings.quotaAlertsEnabled);
  return enabled === false ? null : <LiveQuotaAlerts onOpen={onOpen} />;
}

function LiveQuotaAlerts({ onOpen }: { readonly onOpen?: (() => void) | undefined }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE);
    return () => clearInterval(timer);
  }, []);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const nickname = useMachineNicknames();
  const navigate = useNavigate();
  const renewalDays = usePrimarySettings((settings) => settings.subscriptionRenewalDays);
  const dismissed = usePrimarySettings((settings) => settings.quotaAlertDismissals);
  const updateSettings = useUpdatePrimarySettings();
  const connectedKey = [...presentations]
    .filter(
      ([, presentation]) =>
        presentation.connection === undefined || presentation.connection.phase === "connected",
    )
    .map(([environmentId]) => environmentId)
    .sort()
    .join("\n");
  const connected = useMemo(
    () => (connectedKey === "" ? [] : (connectedKey.split("\n") as EnvironmentId[])),
    [connectedKey],
  );
  const ledger = useUsageResetLedger(connected, Math.floor(now / LEDGER_REFRESH_MS));

  const accounts = collectLimitAccounts(presentations, { machineName: nickname });
  const byKey = new Map<string, LimitAccount>();
  for (const account of accounts) {
    const key = limitAccountKey(account.driver, account.email, account.limits);
    if (key !== null) byKey.set(key, account);
  }
  const periods = ledger?.periods ?? [];
  const early: QuotaAlertEarlyReset[] = periods.flatMap((period) =>
    period.cause === "early" && period.modelScope === undefined
      ? [
          {
            accountKey: period.accountKey,
            driver: period.driver,
            windowId: period.windowId,
            windowTitle: period.windowKind === "monthly" ? "Monthly" : "Weekly",
            endedAt: Date.parse(period.endedAt),
          },
        ]
      : [],
  );
  const alerts = visibleQuotaAlerts(
    quotaAlerts(subscriptionRows(accounts, periods, renewalDays ?? {}, now), early, now),
    dismissed ?? {},
  );
  const labelOf = (alert: QuotaAlert) => planLabel(byKey.get(alert.accountKey), alert);
  const open = () => {
    try {
      localStorage.setItem(LIMITS_VIEW_KEY, "subscriptions");
    } catch {
      // Usage still opens; the Subscriptions tab is one click away.
    }
    onOpen?.();
    void navigate({ to: "/usage" });
  };

  const pending = alerts
    .map((alert) => `${quotaAlertId(alert)}\t${describeQuotaAlert(alert, labelOf(alert), now)}`)
    .join("\n");
  useEffect(() => {
    if (pending === "") return;
    for (const line of pending.split("\n")) {
      const [id, body] = line.split("\t");
      if (id === undefined || body === undefined) continue;
      notifyQuotaAlert({
        id,
        title: id.includes("|early:") ? "A limit reset early" : "Quota is about to reset unused",
        body,
        onOpen: open,
      });
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the alert set decides; `open` is rebuilt each render.
  }, [pending]);

  return (
    <QuotaAlertBanner
      alerts={alerts}
      labelOf={labelOf}
      now={now}
      onOpen={open}
      onDismiss={(all) =>
        updateSettings({
          quotaAlertDismissals: Object.fromEntries(
            all.map((alert) => [alert.key, alert.periodEnd]),
          ),
        })
      }
    />
  );
}
