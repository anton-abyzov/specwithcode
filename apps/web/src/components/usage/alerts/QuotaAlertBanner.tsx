import type { EnvironmentId, QuotaBoost, ServerProvider } from "@specweave-studio/contracts";
import { tierModelFor } from "@specweave-studio/shared/modelTiers";
import {
  isGeminiSpendProvider,
  isPaidModelOn,
  isUnknownBillingAgent,
} from "@specweave-studio/shared/providerFallback";
import {
  type QuotaAlert,
  type QuotaAlertEarlyReset,
  type QuotaAlertExpectedReset,
  describeQuotaAlert,
  driftedQuotaAlertPeriods,
  quotaAlertId,
  quotaAlerts,
  trackAccountPriorities,
  visibleQuotaAlerts,
} from "@specweave-studio/shared/quotaAlerts";
import { liveQuotaBoosts, quotaBoostEnd } from "@specweave-studio/shared/quotaBoost";
import {
  type LimitAccount,
  collectLimitAccounts,
  limitAccountKey,
} from "@specweave-studio/shared/usageLimits";
import { windowTitle } from "@specweave-studio/shared/usageWindows";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { TimerIcon, XIcon, ZapIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  usePrimarySettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "../../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../../state/environments";
import { environmentPresentations } from "../../../state/presentation";
import { useMachineNicknames } from "../../../studio/machineNickname";
import { getDriverOption } from "../../settings/providerDriverMeta";
import {
  alertingAnnouncements,
  announcementDriver,
  useResetAnnouncements,
} from "../subscriptions/resetAnnouncementsState";
import { subscriptionRows } from "../subscriptions/subscriptionRows";
import { useUsageResetLedger } from "../subscriptions/usageResetLedgerState";
import { replacesBankedNotice, resetExpiryNotice, resetExpiryAccounts } from "./resetExpiry";
import { notifyQuotaAlert } from "./quotaAlertNotifications";

const MINUTE = 60_000;
/** The ledger only changes when a window resets, so it is re-read this often. */
const LEDGER_REFRESH_MS = 5 * MINUTE;
/** A confirmed announcement is news for this long. */
const ANNOUNCEMENT_NEWS_MS = 48 * 60 * MINUTE;
/** The banner names this many alerts and counts the rest. */
const SHOWN = 2;
const LIMITS_VIEW_KEY = "specwithcode:usage-limits-view";

/**
 * "Codex Pro": the provider and plan; the alert sentence adds the machine. A plan that
 * already names the provider ("Claude Ultra Subscription") is not prefixed again, and
 * "subscription" says nothing in a sentence about one.
 */
export function planLabel(provider: string, plan: string | undefined): string {
  const named = (plan ?? "").trim().replace(/\s+subscription$/i, "");
  if (named === "") return provider;
  return named.toLowerCase().startsWith(provider.toLowerCase()) ? named : `${provider} ${named}`;
}

function alertLabel(account: LimitAccount | undefined, alert: QuotaAlert): string {
  const provider = getDriverOption(alert.driver as LimitAccount["driver"])?.label ?? alert.driver;
  return planLabel(provider, account?.limits.planLabel?.trim() || account?.plan?.trim());
}

const KIND_TITLE: Record<string, string> = {
  monthly: "Monthly",
  weekly: "Weekly",
  session: "Session",
};

/** The reset window as the account names it now, else by its kind. */
function earlyWindowTitle(
  account: LimitAccount | undefined,
  period: { readonly windowId: string; readonly windowKind: string },
): string {
  const live = account?.limits.windows.find((window) => window.id === period.windowId);
  return live ? windowTitle(live) : (KIND_TITLE[period.windowKind] ?? "Limit");
}

/** A project the boost can cover: its name, and its id on every machine that has it. */
export interface QuotaBoostProject {
  readonly name: string;
  readonly ids: readonly string[];
}

/** "6:40 AM", with the weekday when that is not today. */
function untilLabel(until: number, now: number): string {
  const at = new Date(until);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return at.toDateString() === new Date(now).toDateString()
    ? time
    : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** How long a started boost may take to show before focus stops waiting for it. */
const REFOCUS_WAIT_MS = 5_000;

const LINK =
  "rounded-sm text-xs font-medium text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Which projects a boost covers: all of them, or the ones ticked. */
function BoostProjects({
  projects,
  onStart,
  onCancel,
}: {
  readonly projects: readonly QuotaBoostProject[];
  readonly onStart: (projectIds: readonly string[]) => void;
  readonly onCancel: () => void;
}) {
  const [all, setAll] = useState(true);
  // By position: two projects may share a name.
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const ids = projects.flatMap((project, index) => (picked.has(index) ? project.ids : []));
  return (
    <fieldset className="ml-5.5 flex flex-col gap-1.5" data-quota-boost-projects="">
      <legend className="mb-1 text-muted-foreground">New worker threads in</legend>
      <label className="flex items-center gap-1.5">
        <input
          type="checkbox"
          // Opened from the banner's button, which this replaces: focus follows it here.
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          checked={all}
          onChange={(event) => setAll(event.target.checked)}
        />
        Every project
      </label>
      {all ? null : (
        <ul className="flex max-h-36 flex-col gap-1 overflow-y-auto">
          {projects.map((project, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- the list is fixed while open
            <li key={index}>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={picked.has(index)}
                  onChange={(event) => {
                    const next = new Set(picked);
                    if (event.target.checked) next.add(index);
                    else next.delete(index);
                    setPicked(next);
                  }}
                />
                <span className="truncate">{project.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-3">
        <button
          type="button"
          className={LINK}
          disabled={!all && ids.length === 0}
          onClick={() => onStart(all ? [] : ids)}
        >
          Start
        </button>
        <button type="button" className={`${LINK} text-muted-foreground`} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </fieldset>
  );
}

/**
 * Quota about to be lost, above the project list: the soonest loss first, the
 * way to use it (new worker threads start on that subscription until it
 * resets), a way to the Subscriptions view, and a dismissal of the lines it
 * shows that holds until the next period. A running boost is named with its
 * end and "End now". Renders nothing when there is nothing to say.
 */
export function QuotaAlertBanner({
  alerts,
  labelOf,
  now,
  onOpen,
  onDismiss,
  boosts = [],
  projects = [],
  canBoost,
  onBoost,
  onEndBoost,
}: {
  readonly alerts: readonly QuotaAlert[];
  readonly labelOf: (alert: QuotaAlert) => string;
  readonly now: number;
  readonly onOpen: () => void;
  readonly onDismiss: (alerts: readonly QuotaAlert[]) => void;
  /** Running boosts, the one ending first leading. */
  readonly boosts?: ReadonlyArray<Pick<QuotaBoost, "accountKey" | "label" | "until">>;
  readonly projects?: readonly QuotaBoostProject[];
  /** Whether this alert's subscription can take new worker threads from here. */
  readonly canBoost?: (alert: QuotaAlert) => boolean;
  readonly onBoost?: (alert: QuotaAlert, projectIds: readonly string[]) => void;
  readonly onEndBoost?: (accountKey: string) => void;
}) {
  const [picking, setPicking] = useState<string | null>(null);
  // Closing the picker puts focus back on the button that opened it. After Start that
  // button gives way to the new boost's "End now", which takes the focus once it is there.
  const actions = useRef<HTMLElement>(null);
  const refocus = useRef<{ readonly started: string | null; readonly at: number } | null>(null);
  useEffect(() => {
    const wanted = refocus.current;
    if (picking !== null || wanted === null) return;
    const root = actions.current;
    const start = root?.querySelector<HTMLElement>("[data-quota-boost-start]");
    if (wanted.started === null) {
      refocus.current = null;
      start?.focus();
      return;
    }
    // The start may never land (refused, or ended at once), and the person may have moved
    // on: the wait ends after a few seconds or as soon as focus is somewhere else.
    const active = document.activeElement;
    const elsewhere = active !== null && active !== document.body && active !== start;
    if (elsewhere || Date.now() - wanted.at > REFOCUS_WAIT_MS) {
      refocus.current = null;
      return;
    }
    const end = [...(root?.querySelectorAll<HTMLElement>("[data-quota-boost-end]") ?? [])].find(
      (button) => button.dataset.quotaBoostEnd === wanted.started,
    );
    if (end !== undefined) {
      refocus.current = null;
      end.focus();
    } else if (active === document.body) {
      start?.focus();
    }
  });
  const close = (started: string | null) => {
    refocus.current = { started, at: Date.now() };
    setPicking(null);
  };
  if (alerts.length === 0 && boosts.length === 0) return null;
  const shown = alerts.slice(0, SHOWN);
  const more = alerts.length - shown.length;
  // The soonest loss a boost can still use: one already running needs no second start.
  const boostable =
    onBoost === undefined
      ? undefined
      : shown.find(
          (alert) =>
            canBoost?.(alert) === true &&
            !boosts.some((boost) => boost.accountKey === alert.accountKey),
        );
  return (
    <section
      ref={actions}
      className="mx-2 mb-2 flex flex-col gap-1.5 rounded-lg border border-warning/40 bg-warning/8 p-2.5 text-xs"
      role="status"
      aria-label="Quota about to reset"
      data-quota-alert-banner=""
    >
      {boosts.map((boost) => (
        <div key={boost.accountKey} className="flex items-start gap-2" data-quota-boost="">
          <ZapIcon className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" aria-hidden />
          <span className="min-w-0 flex-1 text-foreground">
            New worker threads use {boost.label} until {untilLabel(boost.until, now)}
          </span>
          {onEndBoost ? (
            <button
              type="button"
              className={LINK}
              data-quota-boost-end={boost.accountKey}
              onClick={() => onEndBoost(boost.accountKey)}
            >
              End now
            </button>
          ) : null}
        </div>
      ))}
      {shown.length > 0 ? (
        <div className="flex items-start gap-2">
          <TimerIcon className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" aria-hidden />
          <ul className="flex min-w-0 flex-1 flex-col gap-1">
            {shown.map((alert) => (
              <li
                key={quotaAlertId(alert)}
                className="text-foreground"
                data-quota-alert={alert.kind}
              >
                {describeQuotaAlert(alert, labelOf(alert), now)}
                {alert.sourceUrl !== undefined ? (
                  <>
                    {" "}
                    <a
                      className="underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      href={alert.sourceUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Source
                    </a>
                  </>
                ) : null}
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
            // Only what was read: an alert behind the count shows once these are gone.
            onClick={() => onDismiss(shown)}
          >
            <XIcon className="size-3.5" aria-hidden />
          </button>
        </div>
      ) : null}
      {boostable !== undefined && picking === quotaAlertId(boostable) ? (
        <BoostProjects
          projects={projects}
          onStart={(projectIds) => {
            close(boostable.accountKey);
            onBoost?.(boostable, projectIds);
          }}
          onCancel={() => close(null)}
        />
      ) : (
        <div className="flex flex-wrap gap-x-3 gap-y-1 pl-5.5">
          {boostable !== undefined ? (
            <button
              type="button"
              className={LINK}
              data-quota-boost-start=""
              title={`New worker threads start on ${labelOf(boostable)} until ${untilLabel(
                boostable.kind === "expectedReset"
                  ? (boostable.expectedUntil ?? boostable.periodEnd)
                  : (boostable.windowResetsAt ?? boostable.periodEnd),
                now,
              )}. Open threads and the coordinator keep their model.`}
              onClick={() => setPicking(quotaAlertId(boostable))}
            >
              Use it for new worker threads until it resets
            </button>
          ) : null}
          <button type="button" className={LINK} onClick={onOpen}>
            See subscriptions
          </button>
        </div>
      )}
    </section>
  );
}

/** The live banner: reads every connected machine's accounts and the reset ledger. */
export function QuotaAlerts({
  onOpen,
  projects,
}: {
  readonly onOpen?: () => void;
  readonly projects?: readonly QuotaBoostProject[];
}) {
  const enabled = usePrimarySettings((settings) => settings.quotaAlertsEnabled);
  // Dismissals and the switch live in primary settings. The hosted app has none, so a
  // banner there could be neither dismissed nor turned off.
  const available = usePrimarySettingsAvailable();
  // With the warnings off a running boost still shows and still ends: it is a choice the
  // person made, not a warning.
  return available ? (
    <LiveQuotaAlerts onOpen={onOpen} projects={projects} warn={enabled !== false} />
  ) : null;
}

function LiveQuotaAlerts({
  onOpen,
  projects,
  warn,
}: {
  readonly onOpen?: (() => void) | undefined;
  readonly projects?: readonly QuotaBoostProject[] | undefined;
  readonly warn: boolean;
}) {
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
  const savedBoosts = usePrimarySettings((settings) => settings.quotaBoosts);
  const modelTiers = usePrimarySettings((settings) => settings.modelTiers);
  const modelLanes = usePrimarySettings((settings) => settings.modelLanes);
  const adversarialReview = usePrimarySettings((settings) => settings.adversarialReview);
  const defaultModelProviders = usePrimarySettings((settings) => settings.defaultModelProviders);
  const threadModelMode = usePrimarySettings((settings) => settings.threadModelMode);
  const defaultModelSelection = usePrimarySettings((settings) => settings.defaultModelSelection);
  const subscriptionTargets = usePrimarySettings((settings) => settings.subscriptionTargets);
  const updateSettings = useUpdatePrimarySettings();
  const here = usePrimaryEnvironmentId();
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
            windowTitle: earlyWindowTitle(byKey.get(period.accountKey), period),
            endedAt: Date.parse(period.endedAt),
          },
        ]
      : [],
  );
  const rows = subscriptionRows(accounts, periods, renewalDays ?? {}, now);
  // Posts the main machine read from the announcement feed, re-read as often as the ledger.
  const feed = useResetAnnouncements(here, Math.floor(now / LEDGER_REFRESH_MS));
  // Only the verified feed warns and notifies; a post an agent recorded is listed, unverified.
  const announced = alertingAnnouncements(feed);
  const expected: QuotaAlertExpectedReset[] = announced.flatMap((announcement) => {
    const driver = announcementDriver(announcement.provider);
    return announcement.kind === "expected_reset" && driver !== null
      ? [
          {
            id: announcement.id,
            driver,
            publishedAt: Date.parse(announcement.publishedAt),
            sourceUrl: announcement.sourceUrl,
          },
        ]
      : [];
  });
  const connectedProviderLists = connected
    .toSorted((left, right) =>
      String(left) === String(here)
        ? -1
        : String(right) === String(here)
          ? 1
          : String(left).localeCompare(String(right)),
    )
    .map((environmentId) => presentations.get(environmentId)?.serverConfig?.providers ?? []);
  const trackPriorities = trackAccountPriorities({
    providerLists: connectedProviderLists,
    modelLanes,
    reviewers: adversarialReview?.reviewers,
    sourceOrder: defaultModelProviders,
    threadModelMode,
    defaultModelSelection,
    now,
  });
  const allAlerts = quotaAlerts(rows, early, now, expected, {
    trackPriorities,
    targets: subscriptionTargets,
  });
  const alerts = warn ? visibleQuotaAlerts(allAlerts, dismissed ?? {}) : [];
  // A dismissed period whose end a re-read moved a little: the dismissal follows it.
  const driftedKey = JSON.stringify(driftedQuotaAlertPeriods(allAlerts, dismissed ?? {}));
  useEffect(() => {
    if (driftedKey !== "{}") {
      updateSettings({ quotaAlertDismissals: JSON.parse(driftedKey) as Record<string, number> });
    }
  }, [driftedKey, updateSettings]);
  const labelOf = (alert: QuotaAlert) => alertLabel(byKey.get(alert.accountKey), alert);

  // A boost runs on the main machine, where the setting lives and its threads launch, so
  // the subscription has to be signed in there, on a plan, with a regular model that the
  // plan covers: never a per-token key, a paid router or a model billed by the token.
  const mainProviders: ReadonlyArray<ServerProvider> =
    (here === null ? undefined : presentations.get(here)?.serverConfig?.providers) ?? [];
  const usable = (provider: ServerProvider) =>
    provider.enabled &&
    provider.auth.status !== "unauthenticated" &&
    !isGeminiSpendProvider(provider);
  const modelOn = (provider: ServerProvider) => {
    const model = tierModelFor(provider, "regular", modelTiers);
    return model === undefined ||
      isPaidModelOn(provider, model) ||
      isUnknownBillingAgent(provider, model)
      ? null
      : model;
  };
  const boostTarget = (alert: QuotaAlert) => {
    if (alert.kind !== "window" && alert.kind !== "renewal" && alert.kind !== "expectedReset") {
      return null;
    }
    for (const provider of mainProviders) {
      if (!usable(provider)) continue;
      const key = limitAccountKey(provider.driver, provider.auth.email, provider.usageLimits);
      if (key !== alert.accountKey) continue;
      const model = modelOn(provider);
      if (model !== null) return { instanceId: provider.instanceId, model };
    }
    return null;
  };
  // What each saved boost should become: null once it is over (the reset, an early reset,
  // under 5% left, or its sign-in gone, off, signed out or on another account), or the
  // same boost on the regular model as it is now. Written per account, so two clients
  // never erase each other. A machine still loading its providers changes nothing.
  const boostFixes: Record<string, QuotaBoost | null> = {};
  for (const [accountKey, boost] of Object.entries(savedBoosts ?? {})) {
    if (boost === null) continue;
    const row = rows.find((candidate) => candidate.accountKey === accountKey);
    const windows = row === undefined || row.offline ? undefined : row.windows;
    if (quotaBoostEnd(boost, windows, now) !== null) {
      boostFixes[accountKey] = null;
      continue;
    }
    if (mainProviders.length === 0) continue;
    const provider = mainProviders.find((candidate) => candidate.instanceId === boost.instanceId);
    // Listed but not read yet (its sign-in check is still running, or it has no models
    // so far): nothing is known, so nothing ends.
    if (
      provider !== undefined &&
      provider.enabled &&
      (provider.auth.status === "unknown" || provider.models.length === 0)
    ) {
      continue;
    }
    const signedInAs =
      provider === undefined
        ? null
        : limitAccountKey(provider.driver, provider.auth.email, provider.usageLimits);
    const model = provider !== undefined && usable(provider) ? modelOn(provider) : null;
    if (model === null || (signedInAs !== null && signedInAs !== accountKey)) {
      boostFixes[accountKey] = null;
    } else if (model !== boost.model) {
      boostFixes[accountKey] = { ...boost, model };
    }
  }
  const boostFixesKey = JSON.stringify(boostFixes);
  useEffect(() => {
    if (boostFixesKey !== "{}") {
      updateSettings({
        quotaBoosts: JSON.parse(boostFixesKey) as Record<string, QuotaBoost | null>,
      });
    }
  }, [boostFixesKey, updateSettings]);
  const boosts = liveQuotaBoosts(savedBoosts, now).filter(
    (boost) => boostFixes[boost.accountKey] !== null,
  );

  // Not named `open`: a missing handler would then silently be the browser's window.open.
  const openSubscriptions = () => {
    try {
      localStorage.setItem(LIMITS_VIEW_KEY, "subscriptions");
    } catch {
      // Usage still opens; the Subscriptions tab is one click away.
    }
    onOpen?.();
    void navigate({ to: "/usage" });
  };

  // Every client shows the banner, but one machine speaks for an account: the first
  // connected machine it is signed in on, so two desktops on one account notify once and
  // a sleeping machine never holds the turn. An account no connected machine runs (one a
  // usage source reports) is spoken for by the first connected machine.
  const speaksFor = (accountKey: string) => {
    const holders = (byKey.get(accountKey)?.environments ?? [])
      .map((environment) => String(environment.environmentId))
      .filter((environmentId) => connected.some((id) => String(id) === environmentId))
      .toSorted();
    return here !== null && (holders[0] ?? connected[0]) === String(here);
  };
  const warnings = warn ? resetExpiryAccounts(presentations, now) : [];
  const pending = alerts
    .filter((alert) => speaksFor(alert.accountKey) && !replacesBankedNotice(alert, warnings))
    .map((alert) => ({
      key: alert.key,
      periodEnd: alert.periodEnd,
      title:
        alert.kind === "earlyReset"
          ? "A limit reset early"
          : alert.kind === "expectedReset"
            ? "A limits reset is expected today"
            : "Quota is about to reset unused",
      body: describeQuotaAlert(alert, labelOf(alert), now),
    }));
  // A confirmed post (limits reset, a banked reset granted, a limit changed) notifies once,
  // on the main machine, for a provider the person has an account on in their active tracks,
  // and only while it is news: a post already two days old on its first read says nothing.
  const drivers = new Set(
    accounts
      .filter((account) => {
        const key = limitAccountKey(account.driver, account.email, account.limits);
        return key !== null && trackPriorities.has(key);
      })
      .map((account) => String(account.driver)),
  );
  if (warn && here !== null && connected[0] !== undefined) {
    for (const announcement of announced) {
      const published = Date.parse(announcement.publishedAt);
      const driver = announcementDriver(announcement.provider);
      if (
        announcement.kind === "expected_reset" ||
        driver === null ||
        !drivers.has(driver) ||
        published > now ||
        now - published > ANNOUNCEMENT_NEWS_MS ||
        String(connected[0]) !== String(here)
      ) {
        continue;
      }
      pending.push({
        key: `announcement|${announcement.sourceUrl}`,
        periodEnd: published,
        title: "Limits reset announced",
        body: announcement.headline,
      });
    }
  }
  for (const account of warnings) {
    if (speaksFor(account.key)) pending.push(...account.expiring.map(resetExpiryNotice));
  }
  const pendingKey = JSON.stringify(pending);
  // Tried again on every minute tick: an alert first seen while the window was in front,
  // or before notifications were connected, still notifies once the window is behind.
  useEffect(() => {
    for (const entry of JSON.parse(pendingKey) as typeof pending) {
      notifyQuotaAlert({ ...entry, onOpen: openSubscriptions });
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the alert set and the tick decide; the handler is rebuilt each render.
  }, [pendingKey, now]);

  return (
    <QuotaAlertBanner
      alerts={alerts}
      labelOf={labelOf}
      now={now}
      onOpen={openSubscriptions}
      boosts={boosts}
      projects={projects ?? []}
      canBoost={(alert) => boostTarget(alert) !== null}
      onBoost={(alert, projectIds) => {
        const target = boostTarget(alert);
        if (target === null) return;
        updateSettings({
          quotaBoosts: {
            [alert.accountKey]: {
              accountKey: alert.accountKey,
              ...target,
              projectIds: [...projectIds],
              label: labelOf(alert),
              ...(alert.windowId !== undefined ? { windowId: alert.windowId } : {}),
              // The window's own reset: a renewal's time may sit hours from it. An expected
              // reset ends a day after its post, or sooner when the window starts over.
              until:
                alert.kind === "expectedReset"
                  ? (alert.expectedUntil ?? alert.periodEnd)
                  : (alert.windowResetsAt ?? alert.periodEnd),
              ...(alert.kind === "expectedReset" && alert.windowResetsAt !== undefined
                ? { resetsAtStart: alert.windowResetsAt }
                : {}),
              startedAt: now,
            },
          },
        });
      }}
      onEndBoost={(accountKey) => updateSettings({ quotaBoosts: { [accountKey]: null } })}
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
