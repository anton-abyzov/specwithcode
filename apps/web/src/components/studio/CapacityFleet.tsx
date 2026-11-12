import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  isProviderAvailable,
  type ModelSelection,
  type ServerConfig,
  type ServerProvider,
} from "@specweave-studio/contracts";
import type {
  StudioCapacityAccount,
  StudioCapacityMode,
  StudioCapacitySnapshot,
} from "@specweave-studio/contracts/studio";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, InfoIcon, MonitorIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EnvironmentPresentation } from "../../state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useEnvironmentScope } from "../../state/session";
import { planLabel } from "../../studio/accountSwitches";
import { availabilityText, modelAvailability } from "../../studio/modelAvailability";
import { getDriverOption } from "../settings/providerDriverMeta";
import {
  canOperateStudioCapacity,
  mutateStudioCapacity,
  useStudioCapacity,
} from "../../studio/capacity";
import {
  absoluteTime,
  canSelectCapacity,
  capacityLabel,
  capacitySummary,
  quotaFresh,
  relativeTime,
  resolveNativeModel,
  resolvePolicyDraft,
  verifiedPoolId,
} from "../../studio/overviewModel";

/** How the next draft's account is picked among the eligible ones on a host. */
const POLICIES: ReadonlyArray<{ value: StudioCapacityMode; label: string; hint: string }> = [
  { value: "balanced", label: "Balanced", hint: "Least used account first" },
  { value: "reset-first", label: "Reset first", hint: "Soonest reset first" },
  { value: "spend-first", label: "Spend first", hint: "Most used account first" },
];

/**
 * What a host card knows of its Switch read. `loading` is a host whose first
 * read has not come back, so nothing can be said about it yet.
 */
type HostCapacity = StudioCapacitySnapshot | "loading";

/** Switch has never answered on that machine: it is not installed there. */
const withoutSwitch = (snapshot: StudioCapacitySnapshot | null | undefined) =>
  snapshot?.switchSeen === false;

/**
 * The providers set up on a machine, in the order its server lists them:
 * enabled, installed and not signed out. A provider whose sign-in check failed
 * or has not finished reports `unknown` and stays listed with what is known of
 * its usage, so the card never says nobody is signed in while somebody is.
 * A machine without Switch shows these instead of Switch profiles.
 */
export function providersOnHost(providers: ReadonlyArray<ServerProvider>) {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      provider.auth.status !== "unauthenticated",
  );
}

/**
 * A provider's usage for a host card: the limits every model of the account
 * shares. When each limit it reports belongs to one model family, there is no
 * account-wide reading, so the default model's is shown instead of "no limits".
 * A spent limit of one model family is not shown here; the model picker shows
 * it on that family's models.
 */
export function hostProviderAvailability(provider: ServerProvider, nowMs: number) {
  const account = modelAvailability({ provider, model: null, nowMs, connected: true });
  if (account.kind !== "unknown" || account.reason !== "noWindows") return account;
  const model = provider.models.find((entry) => entry.isDefault) ?? provider.models[0];
  return model
    ? modelAvailability({ provider, model: model.slug, nowMs, connected: true })
    : account;
}

type Props = {
  environments: readonly EnvironmentPresentation[];
  configs: ReadonlyMap<EnvironmentId, ServerConfig>;
  onNewDraft: (
    environmentId: EnvironmentId,
    model: ModelSelection,
    validate?: () => boolean,
  ) => void;
};

export function CapacityFleet({ environments, configs, onNewDraft }: Props) {
  const tx = useTx();
  const [now, setNow] = useState(Date.now);
  // Age display only; this clock never refreshes a native provider or sends a request.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const [snapshots, setSnapshots] = useState<ReadonlyMap<EnvironmentId, HostCapacity>>(new Map());
  const onSnapshot = useCallback((id: EnvironmentId, snapshot: HostCapacity | null) => {
    setSnapshots((previous) => {
      if (previous.get(id) === (snapshot ?? undefined)) return previous;
      const next = new Map(previous);
      if (snapshot) next.set(id, snapshot);
      else next.delete(id);
      return next;
    });
  }, []);
  const reported = environments
    .filter((e) => e.connection.phase === "connected")
    .flatMap((e) => snapshots.get(e.environmentId) ?? []);
  // Quota pools are counted by Switch, so only machines that run it count.
  const current = reported.filter(
    (entry): entry is StudioCapacitySnapshot => entry !== "loading" && !withoutSwitch(entry),
  );
  const summary = capacitySummary(current, now);
  // With no Switch read to count, the line would say "unknown · 0 · 0" about a
  // service the machine does not have, or about a read still on its way.
  const showSummary = current.length > 0 || reported.length === 0;
  return (
    <section className="studio-fleet" aria-labelledby="studio-fleet-title">
      <div className="studio-section-heading">
        <h2 id="studio-fleet-title">{tx("Hosts & capacity")}</h2>
        <Link className="studio-text-link" to="/settings/connections">
          {tx("Manage connections")} <ArrowRightIcon aria-hidden="true" />
        </Link>
      </div>
      {showSummary && (
        <p className="studio-capacity-note">
          <strong>
            {summary.verifiedPools === null
              ? tx("Independent capacity unknown")
              : tx(
                  summary.verifiedPools === 1
                    ? "{count} verified quota pool"
                    : "{count} verified quota pools",
                  { count: summary.verifiedPools },
                )}
          </strong>
          <span>
            {tx("{eligible} eligible · {unknownPools} unverified", {
              eligible: summary.eligible,
              unknownPools: summary.unknownPools,
            })}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="studio-capacity-info"
                  aria-label={tx(
                    "Hosts and prepared slots do not create additional subscriptions.",
                  )}
                />
              }
            >
              <InfoIcon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipPopup>
              {tx(
                "Eligible profiles map to a verified quota pool. Hosts and prepared slots do not create additional subscriptions.",
              )}
            </TooltipPopup>
          </Tooltip>
        </p>
      )}
      {environments.length === 0 ? (
        <div className="studio-empty">
          <h3>{tx("Connect a host.")}</h3>
          <p>
            {tx(
              "Add a private pairing connection to see its native sessions and observed capacity.",
            )}
          </p>
          <Link className="studio-text-link" to="/settings/connections">
            {tx("Open Connections")} <ArrowRightIcon aria-hidden="true" />
          </Link>
        </div>
      ) : (
        <div className="studio-host-grid">
          {environments.map((environment) => (
            <HostCard
              key={environment.environmentId}
              environment={environment}
              config={configs.get(environment.environmentId) ?? null}
              onSnapshot={onSnapshot}
              onNewDraft={onNewDraft}
              now={now}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function HostCard({
  environment: e,
  config,
  onSnapshot,
  onNewDraft,
  now,
}: {
  environment: EnvironmentPresentation;
  config: ServerConfig | null;
  onSnapshot: (id: EnvironmentId, s: HostCapacity | null) => void;
  onNewDraft: Props["onNewDraft"];
  now: number;
}) {
  const tx = useTx();
  const { snapshot, loading, failed } = useStudioCapacity(e.environmentId);
  const connected = e.connection.phase === "connected";
  const canWrite = useEnvironmentScope(e.environmentId, AuthOrchestrationOperateScope);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const latest = useRef({ snapshot, config, connected, failed, loading, busy });
  useEffect(() => {
    latest.current = { snapshot, config, connected, failed, loading, busy };
  }, [snapshot, config, connected, failed, loading, busy]);
  const recommended = loading ? null : resolvePolicyDraft(snapshot, config?.providers ?? [], now);
  const recommendedAccount = snapshot?.accounts.find((a) => a.id === recommended?.accountId);
  const mainWindows = recommendedAccount?.quota.windows?.filter((w) => w.appliesToSelection) ?? [];
  const resetWindows = mainWindows.length
    ? mainWindows
    : [recommendedAccount?.quota.window, recommendedAccount?.quota.weekly];
  const nextReset = Math.min(
    ...resetWindows.flatMap((w) =>
      w?.resetsAt && Number.isFinite(new Date(w.resetsAt * 1000).getTime()) ? [w.resetsAt] : [],
    ),
  );
  const readPolicyDraft = () => {
    const current = latest.current;
    return current.connected &&
      !current.failed &&
      !current.loading &&
      !current.busy &&
      canOperateStudioCapacity(e.environmentId)
      ? resolvePolicyDraft(current.snapshot, current.config?.providers ?? [], Date.now())
      : null;
  };
  const openPolicyDraft = () => {
    const choice = readPolicyDraft();
    if (!choice || busy) return;
    onNewDraft(e.environmentId, choice.model, () => {
      const current = readPolicyDraft();
      return (
        current?.accountId === choice.accountId &&
        current.model.instanceId === choice.model.instanceId &&
        current.model.model === choice.model.model
      );
    });
  };
  useEffect(() => {
    onSnapshot(
      e.environmentId,
      connected && !failed ? (snapshot ?? (loading ? "loading" : null)) : null,
    );
  }, [e.environmentId, connected, failed, loading, snapshot, onSnapshot]);
  useEffect(() => () => onSnapshot(e.environmentId, null), [e.environmentId, onSnapshot]);
  // Switch is optional. A machine that never ran it shows the providers set
  // up there; the Switch profiles, policy and refresh do not apply to it.
  const noSwitch = connected && !failed && withoutSwitch(snapshot);
  const providers = noSwitch ? providersOnHost(config?.providers ?? []) : [];
  const perform = async (operation: Parameters<typeof mutateStudioCapacity>[1]) => {
    if (busy || !connected || !canWrite) return;
    setBusy(true);
    setActionError(null);
    try {
      await mutateStudioCapacity(e.environmentId, operation);
    } catch {
      setActionError(
        tx("This action could not be completed. Check the connection or its permissions."),
      );
    } finally {
      setBusy(false);
    }
  };
  const accounts = snapshot?.available && !failed && connected ? snapshot.accounts : [];
  const displayed = showAll
    ? accounts
    : accounts.filter((a) => a.id === "codex-1" || a.id === "claude-1" || a.authenticated === true);
  const problem = !connected
    ? tx("Reconnect this host to observe current capacity.")
    : failed
      ? tx("Capacity read failed or was denied. No available capacity is assumed.")
      : snapshot?.error === "switch-timeout"
        ? tx(
            "The local Switch service timed out. Choose Refresh observations to try again. If it keeps timing out, restart Switch on this machine.",
          )
        : snapshot?.error === "switch-invalid-response"
          ? tx(
              "The local Switch response could not be verified. Update Switch on this machine, then choose Refresh observations.",
            )
          : snapshot?.error === "switch-unavailable"
            ? tx(
                "The local Switch service is unavailable. Start Switch on this machine, then choose Refresh observations.",
              )
            : !snapshot && !loading
              ? tx("Capacity is unavailable with this connection’s session read permission.")
              : null;
  return (
    <article className="studio-host">
      <header className="studio-host-header">
        <MonitorIcon aria-hidden="true" />
        <Tooltip>
          <TooltipTrigger render={<h3 />}>{e.label}</TooltipTrigger>
          <TooltipPopup>{e.label}</TooltipPopup>
        </Tooltip>
        <span className={`studio-host-state${connected ? " connected" : ""}`}>
          {connected
            ? tx("Connected")
            : e.connection.phase === "error"
              ? tx("Connection failed")
              : e.connection.phase === "unsupported"
                ? tx("Client not supported")
                : e.connection.phase === "connecting" || e.connection.phase === "reconnecting"
                  ? tx("Connecting…")
                  : tx("Offline")}
        </span>
      </header>
      <div className="studio-host-body">
        {!connected && e.connection.error && (
          <p className="studio-notice" role="status">
            {e.connection.error}
          </p>
        )}
        {problem && (
          <p className="studio-notice" role="status">
            {problem}
          </p>
        )}
        {loading && !snapshot && (
          <p className="studio-small" role="status">
            {tx("Reading host-local observations…")}
          </p>
        )}
        {accounts.length === 0 && snapshot?.available && !problem && (
          <p className="studio-small">{tx("No native profiles were reported.")}</p>
        )}
        {noSwitch && config !== null && providers.length === 0 && (
          <p className="studio-small studio-host-empty">{tx("No providers signed in yet.")}</p>
        )}
        {providers.map((provider) => (
          <ProviderRow
            key={provider.instanceId}
            provider={provider}
            hostLabel={e.label}
            now={now}
          />
        ))}
        {displayed.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            environmentId={e.environmentId}
            config={config}
            canWrite={canWrite && !busy && !loading}
            selected={snapshot?.policy?.selectedAccount === account.id}
            onSelect={() => {
              if (canSelectCapacity(account, Date.now()))
                void perform({ kind: "select", input: { id: account.id } });
            }}
            onNewDraft={onNewDraft}
            now={now}
          />
        ))}
        {accounts.length > displayed.length && (
          <button className="studio-text-link studio-slot-toggle" onClick={() => setShowAll(true)}>
            {tx("Show {value} more prepared profiles", {
              value: accounts.length - displayed.length,
            })}
          </button>
        )}
        {showAll && accounts.length > 2 && (
          <button className="studio-text-link studio-slot-toggle" onClick={() => setShowAll(false)}>
            {tx("Show primary profiles")}
          </button>
        )}
        {snapshot?.available && snapshot.policy && connected && !failed && (
          <div className="studio-policy">
            <label id={`studio-policy-${e.environmentId}`}>{tx("Capacity policy")}</label>
            <Select
              items={POLICIES}
              value={snapshot.policy.mode}
              disabled={!canWrite || busy}
              onValueChange={(mode) => {
                if (mode !== null) void perform({ kind: "policy", input: { mode } });
              }}
            >
              <SelectTrigger size="sm" aria-labelledby={`studio-policy-${e.environmentId}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {POLICIES.map(({ value, label, hint }) => (
                  <SelectItem key={value} value={value}>
                    <span className="studio-policy-option">
                      {label}
                      <small>{hint}</small>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <span className="studio-small">
              {snapshot.policy.selectedAccount
                ? tx("Pinned: {account} · ", { account: snapshot.policy.selectedAccount })
                : ""}
              {recommended
                ? Number.isFinite(nextReset)
                  ? tx("Recommended: {label} · next reset {time}", {
                      label: recommended.label,
                      time: absoluteTime(nextReset),
                    })
                  : tx("Recommended: {label} · next reset unknown", { label: recommended.label })
                : tx("No eligible native instance for this policy.")}
            </span>
            <details className="studio-disclosure">
              <summary>
                <span>{tx("How selection works")}</span>
              </summary>
              <p>
                {renderRich(
                  tx(
                    "{value} {value2} Applies to new sessions. Existing sessions keep their account and provider to preserve cache affinity.",
                  ),
                  {
                    value: tx(
                      snapshot.policy.mode === "reset-first"
                        ? "Use eligible quota that resets soonest; equal resets prefer the one with less left."
                        : snapshot.policy.mode === "spend-first"
                          ? "Use the eligible quota with the least left first."
                          : "Use the eligible quota with the most left first.",
                    ),
                    value2: tx(
                      snapshot.policy.selectedAccount
                        ? "A pinned account waits if it is unavailable."
                        : "Selection is automatic.",
                    ),
                  },
                )}
              </p>
            </details>
            <button
              className="studio-text-link"
              disabled={!canWrite || busy || !recommended}
              onClick={openPolicyDraft}
            >
              {tx("Draft using capacity policy")} <ArrowRightIcon aria-hidden="true" />
            </button>
            {snapshot.policy.selectedAccount && (
              <button
                className="studio-text-link"
                disabled={!canWrite || busy}
                onClick={() => void perform({ kind: "select", input: { id: null } })}
              >
                {tx("Return to Automatic")} <ArrowRightIcon aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        {actionError && (
          <p className="studio-notice" role="alert">
            {actionError}
          </p>
        )}
      </div>
      <footer className="studio-host-footer">
        <Link
          to="/settings/providers"
          search={{ environmentId: e.environmentId }}
          className="studio-text-link"
        >
          {noSwitch && config !== null && providers.length === 0
            ? tx("Set up providers")
            : tx("Providers")}{" "}
          <ArrowRightIcon aria-hidden="true" />
        </Link>
        {!noSwitch && (
          <button
            className="studio-text-link"
            disabled={!connected || !canWrite || busy}
            onClick={() => void perform({ kind: "refresh" })}
          >
            <RefreshCwIcon aria-hidden="true" />
            {busy ? tx("Checking…") : tx("Refresh observations")}
          </button>
        )}
      </footer>
    </article>
  );
}

/**
 * A provider on a machine without Switch: its name and its account's usage in
 * the model picker's words, read from the snapshot the machine
 * already holds.
 */
function ProviderRow({
  provider,
  hostLabel,
  now,
}: {
  provider: ServerProvider;
  hostLabel: string;
  now: number;
}) {
  const name =
    provider.displayName?.trim() || getDriverOption(provider.driver)?.label || provider.driver;
  const usage = availabilityText(hostProviderAvailability(provider, now), {
    provider: name,
    account: planLabel(provider.auth),
    machine: hostLabel,
    nowMs: now,
  });
  return (
    <div className="studio-account">
      <div className="studio-account-title">
        <strong>{name}</strong>
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className="studio-provider-usage"
                data-tone={usage.tone}
                tabIndex={0}
                aria-label={usage.label}
              />
            }
          >
            {usage.short}
          </TooltipTrigger>
          <TooltipPopup>{usage.long}</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}

function AccountRow({
  account: a,
  environmentId,
  config,
  canWrite,
  selected,
  onSelect,
  onNewDraft,
  now,
}: {
  account: StudioCapacityAccount;
  environmentId: EnvironmentId;
  config: ServerConfig | null;
  canWrite: boolean;
  selected: boolean;
  onSelect: () => void;
  onNewDraft: Props["onNewDraft"];
  now: number;
}) {
  const tx = useTx();
  const fresh = quotaFresh(a, now);
  const available = canSelectCapacity(a, now);
  const model = resolveNativeModel(config?.providers ?? [], a.providerInstanceId);
  const canDraft =
    canWrite &&
    model !== null &&
    a.authenticated === true &&
    a.authError === null &&
    (available || a.status === "unknown");
  const pool = verifiedPoolId(a, now);
  return (
    <div className="studio-account">
      <div className="studio-account-title">
        <strong>{a.label}</strong>
        <span className={`studio-account-status${available ? " available" : ""}`}>
          {capacityLabel(a, now)}
        </span>
      </div>
      <div className="studio-quota-windows">
        {a.quota.windows?.length ? (
          a.quota.windows.map((w) => (
            <QuotaWindow
              key={w.id}
              label={
                w.appliesToSelection
                  ? quotaShort(w.windowDurationMins)
                  : `${w.bucketId} · ${quotaShort(w.windowDurationMins)}`
              }
              title={
                w.appliesToSelection
                  ? quotaDuration(w.windowDurationMins)
                  : `Other bucket · ${w.bucketId} · ${quotaDuration(w.windowDurationMins)}`
              }
              value={w}
              fresh={
                fresh &&
                (!w.observedAt ||
                  (Date.parse(w.observedAt) <= now + 5_000 &&
                    now - Date.parse(w.observedAt) <= 15 * 60_000)) &&
                (w.resetsAt === null || w.resetsAt * 1000 > now)
              }
            />
          ))
        ) : (
          <>
            <QuotaWindow
              label={quotaShort(a.quota.window?.windowDurationMins, "Now")}
              title={quotaDuration(a.quota.window?.windowDurationMins, "Current window")}
              value={a.quota.window}
              fresh={fresh}
            />
            <QuotaWindow
              label={quotaShort(a.quota.weekly?.windowDurationMins, "Next")}
              title={quotaDuration(a.quota.weekly?.windowDurationMins, "Secondary window")}
              value={a.quota.weekly}
              fresh={fresh}
            />
          </>
        )}
      </div>
      {a.authError && (
        <p className="studio-small studio-blocked-reason">{authReason(a.authError)}</p>
      )}
      {a.quota.spendControlReached === true && (
        <p className="studio-small studio-blocked-reason">
          {tx("Provider spend control blocks new work")}
        </p>
      )}
      <div className="studio-account-actions">
        <details className="studio-disclosure studio-account-details">
          <summary>
            <span>
              {a.quota.observedAt ? relativeTime(a.quota.observedAt, now) : tx("Not observed")}
              {pool ? tx(" · pool verified") : tx(" · pool unverified")}
            </span>
          </summary>
          <ul>
            <li>
              {a.quota.spendControlReached === true
                ? tx("Spend limit reached")
                : a.quota.ordinaryUsageAllowed === true
                  ? tx("Provider allows new work")
                  : a.quota.ordinaryUsageAllowed === false
                    ? tx("Included usage unavailable")
                    : tx("Provider allowance unknown")}
              {a.quota.spendControlReached !== true && a.quota.rateLimitReachedType
                ? tx(" · provider reported a limit")
                : ""}
            </li>
            <li>{creditLabel(a.quota.credits)}</li>
            <li>
              {a.quota.resetCredits
                ? `${tx(
                    a.quota.resetCredits.availableCount === 1
                      ? "{count} banked reset"
                      : "{count} banked resets",
                    { count: a.quota.resetCredits.availableCount },
                  )}${
                    a.quota.resetCredits.nextExpiresAt
                      ? tx(" · next expires {time}", {
                          time: absoluteTime(a.quota.resetCredits.nextExpiresAt),
                        })
                      : ""
                  }`
                : tx("Banked resets unknown")}
            </li>
            <li>
              {a.quota.observedAt
                ? `${tx(
                    a.quota.source === "manual"
                      ? "Manual observation · {time}"
                      : "Native observation · {time}",
                    { time: absoluteTime(a.quota.observedAt) },
                  )}${fresh ? "" : tx(" · stale")}`
                : tx("No supported quota observation")}
            </li>
            <li>
              {pool
                ? tx("Pool identity verified · {time}", {
                    time: absoluteTime(a.quotaPoolObservedAt),
                  })
                : tx("Pool identity unknown")}
            </li>
          </ul>
        </details>
        {model && canDraft ? (
          <button
            className="studio-text-link"
            onClick={() => {
              if (
                canOperateStudioCapacity(environmentId) &&
                (canSelectCapacity(a, Date.now()) || a.status === "unknown")
              )
                onNewDraft(environmentId, model);
            }}
          >
            {tx("Open native draft")}
          </button>
        ) : (
          <Link
            className="studio-text-link"
            to="/settings/providers"
            search={{
              environmentId,
              ...(a.providerInstanceId ? { instanceId: a.providerInstanceId } : {}),
            }}
          >
            {tx("Set up")}
          </Link>
        )}
        <button className="studio-prefer" disabled={!canWrite || !available} onClick={onSelect}>
          {selected ? tx("Preferred") : tx("Prefer")}
        </button>
      </div>
    </div>
  );
}

export function quotaDuration(
  minutes: number | undefined,
  fallback = "Window duration unknown",
): string {
  if (!minutes || !Number.isFinite(minutes)) return fallback;
  if (minutes % 10080 === 0)
    return minutes === 10080 ? "7-day window" : `${minutes / 1440}-day window`;
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}
/** Compact window label, e.g. "5h" or "7d"; the full label stays in the tooltip. */
function quotaShort(minutes: number | undefined, fallback = "?"): string {
  if (!minutes || !Number.isFinite(minutes)) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
/** Reset time without the year, keeping the explicit Eastern timezone. */
function shortTime(seconds: number): string {
  const date = new Date(seconds * 1_000);
  if (!Number.isFinite(date.getTime())) return "time unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}
function creditLabel(credits: StudioCapacityAccount["quota"]["credits"]): string {
  if (!credits) return "Extra credits unknown";
  if (credits.unlimited) return "Provider reports unlimited credits";
  if (!credits.hasCredits) return "No extra credits reported";
  return credits.balance
    ? `${credits.balance} extra credits reported`
    : "Extra credits reported available";
}
function QuotaWindow({
  label,
  title,
  value,
  fresh,
}: {
  label: string;
  title: string;
  value: StudioCapacityAccount["quota"]["window"];
  fresh: boolean;
}) {
  const tx = useTx();
  const percent = value === null ? null : Math.round(value.usedPercent);
  const left = percent === null ? null : 100 - Math.min(100, Math.max(0, percent));
  const leftText = left === null ? null : tx("{left}% left", { left });
  const detail = `${title}${
    left === null ? "" : ` · ${left === 0 ? tx("limit reached") : leftText}`
  }${fresh ? "" : tx(" · last observed")}`;
  return (
    <div
      className={`studio-quota${fresh ? "" : " stale"}${left !== null && left <= 10 ? " low" : ""}`}
    >
      <Tooltip>
        <TooltipTrigger render={<span className="studio-quota-label" />}>{label}</TooltipTrigger>
        <TooltipPopup>{detail}</TooltipPopup>
      </Tooltip>
      <div className={`studio-meter${percent === null ? " unknown" : ""}`} aria-hidden="true">
        <span style={{ width: `${left ?? 0}%` }} />
      </div>
      <strong>
        {leftText ?? tx("Unknown")}
        <span className="sr-only"> · {detail}</span>
      </strong>
      {value?.resetsAt ? (
        <span className="studio-reset">
          {tx("Resets {value}", { value: shortTime(value.resetsAt) })}
        </span>
      ) : null}
    </div>
  );
}
function authReason(error: NonNullable<StudioCapacityAccount["authError"]>): string {
  return {
    "subscription-auth-unverified": "Consumer subscription identity is unverified.",
    "profile-isolation-unverified": "Independent native profile isolation is unverified.",
    "native-auth-unverified": "Native authentication has not been verified.",
    "api-auth-not-subscription": "API authentication is outside subscription routing.",
    "provider-instance-unavailable": "The configured native provider instance is unavailable.",
  }[error];
}
