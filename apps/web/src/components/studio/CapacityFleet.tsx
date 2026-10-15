import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ModelSelection,
  type ServerConfig,
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
  const [now, setNow] = useState(Date.now);
  // Age display only; this clock never refreshes a native provider or sends a request.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const [snapshots, setSnapshots] = useState<ReadonlyMap<EnvironmentId, StudioCapacitySnapshot>>(
    new Map(),
  );
  const onSnapshot = useCallback((id: EnvironmentId, snapshot: StudioCapacitySnapshot | null) => {
    setSnapshots((previous) => {
      const next = new Map(previous);
      if (snapshot) next.set(id, snapshot);
      else next.delete(id);
      return next;
    });
  }, []);
  const current = environments
    .filter((e) => e.connection.phase === "connected")
    .flatMap((e) => snapshots.get(e.environmentId) ?? []);
  const summary = capacitySummary(current, now);
  return (
    <section className="studio-fleet" aria-labelledby="studio-fleet-title">
      <div className="studio-section-heading">
        <h2 id="studio-fleet-title">Hosts & capacity</h2>
        <Link className="studio-text-link" to="/settings/connections">
          Manage connections <ArrowRightIcon aria-hidden="true" />
        </Link>
      </div>
      <p className="studio-capacity-note">
        <strong>
          {summary.verifiedPools === null
            ? "Independent capacity unknown"
            : `${summary.verifiedPools} verified quota ${summary.verifiedPools === 1 ? "pool" : "pools"}`}
        </strong>
        <span>
          {summary.eligible} eligible · {summary.unknownPools} unverified
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="studio-capacity-info"
                aria-label="Hosts and prepared slots do not create additional subscriptions."
              />
            }
          >
            <InfoIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup>
            Eligible profiles map to a verified quota pool. Hosts and prepared slots do not create
            additional subscriptions.
          </TooltipPopup>
        </Tooltip>
      </p>
      {environments.length === 0 ? (
        <div className="studio-empty">
          <h3>Connect a host.</h3>
          <p>Add a private pairing connection to see its native sessions and observed capacity.</p>
          <Link className="studio-text-link" to="/settings/connections">
            Open Connections <ArrowRightIcon aria-hidden="true" />
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
  onSnapshot: (id: EnvironmentId, s: StudioCapacitySnapshot | null) => void;
  onNewDraft: Props["onNewDraft"];
  now: number;
}) {
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
    onSnapshot(e.environmentId, connected && !failed ? snapshot : null);
    return () => onSnapshot(e.environmentId, null);
  }, [e.environmentId, connected, failed, snapshot, onSnapshot]);
  const perform = async (operation: Parameters<typeof mutateStudioCapacity>[1]) => {
    if (busy || !connected || !canWrite) return;
    setBusy(true);
    setActionError(null);
    try {
      await mutateStudioCapacity(e.environmentId, operation);
    } catch {
      setActionError(
        "This action could not be completed. Check the connection or its permissions.",
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
    ? "Reconnect this host to observe current capacity."
    : failed
      ? "Capacity read failed or was denied. No available capacity is assumed."
      : snapshot?.error === "switch-timeout"
        ? "The local Switch service timed out."
        : snapshot?.error === "switch-invalid-response"
          ? "The local Switch response could not be verified."
          : snapshot?.error === "switch-unavailable"
            ? "The local Switch service is unavailable."
            : !snapshot && !loading
              ? "Capacity is unavailable with this connection’s session read permission."
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
            ? "Connected"
            : e.connection.phase === "error"
              ? "Connection failed"
              : e.connection.phase === "unsupported"
                ? "Client not supported"
                : e.connection.phase === "connecting" || e.connection.phase === "reconnecting"
                  ? "Connecting…"
                  : "Offline"}
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
            Reading host-local observations…
          </p>
        )}
        {accounts.length === 0 && snapshot?.available && !problem && (
          <p className="studio-small">No native profiles were reported.</p>
        )}
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
            Show {accounts.length - displayed.length} more prepared profiles
          </button>
        )}
        {showAll && accounts.length > 2 && (
          <button className="studio-text-link studio-slot-toggle" onClick={() => setShowAll(false)}>
            Show primary profiles
          </button>
        )}
        {snapshot?.available && snapshot.policy && connected && !failed && (
          <div className="studio-policy">
            <label id={`studio-policy-${e.environmentId}`}>Capacity policy</label>
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
                ? `Pinned: ${snapshot.policy.selectedAccount} · `
                : ""}
              {recommended
                ? `Recommended: ${recommended.label} · ${Number.isFinite(nextReset) ? `next reset ${absoluteTime(nextReset)}` : "next reset unknown"}`
                : "No eligible native instance for this policy."}
            </span>
            <details className="studio-disclosure">
              <summary>
                <span>How selection works</span>
              </summary>
              <p>
                {snapshot.policy.mode === "reset-first"
                  ? "Use eligible quota that resets soonest; equal resets prefer more used quota."
                  : snapshot.policy.mode === "spend-first"
                    ? "Use the most used eligible quota first."
                    : "Use the least used eligible quota first."}{" "}
                {snapshot.policy.selectedAccount
                  ? "A pinned account waits if it is unavailable."
                  : "Selection is automatic."}{" "}
                Applies to new sessions. Existing sessions keep their account and provider to
                preserve cache affinity.
              </p>
            </details>
            <button
              className="studio-text-link"
              disabled={!canWrite || busy || !recommended}
              onClick={openPolicyDraft}
            >
              Draft using capacity policy <ArrowRightIcon aria-hidden="true" />
            </button>
            {snapshot.policy.selectedAccount && (
              <button
                className="studio-text-link"
                disabled={!canWrite || busy}
                onClick={() => void perform({ kind: "select", input: { id: null } })}
              >
                Return to Automatic <ArrowRightIcon aria-hidden="true" />
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
          Providers <ArrowRightIcon aria-hidden="true" />
        </Link>
        <button
          className="studio-text-link"
          disabled={!connected || !canWrite || busy}
          onClick={() => void perform({ kind: "refresh" })}
        >
          <RefreshCwIcon aria-hidden="true" />
          {busy ? "Checking…" : "Refresh observations"}
        </button>
      </footer>
    </article>
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
        <p className="studio-small studio-blocked-reason">Provider spend control blocks new work</p>
      )}
      <div className="studio-account-actions">
        <details className="studio-disclosure studio-account-details">
          <summary>
            <span>
              {a.quota.observedAt ? relativeTime(a.quota.observedAt, now) : "Not observed"}
              {pool ? " · pool verified" : " · pool unverified"}
            </span>
          </summary>
          <ul>
            <li>
              {a.quota.spendControlReached === true
                ? "Spend limit reached"
                : a.quota.ordinaryUsageAllowed === true
                  ? "Provider allows new work"
                  : a.quota.ordinaryUsageAllowed === false
                    ? "Included usage unavailable"
                    : "Provider allowance unknown"}
              {a.quota.spendControlReached !== true && a.quota.rateLimitReachedType
                ? " · provider reported a limit"
                : ""}
            </li>
            <li>{creditLabel(a.quota.credits)}</li>
            <li>
              {a.quota.resetCredits
                ? `${a.quota.resetCredits.availableCount} banked ${a.quota.resetCredits.availableCount === 1 ? "reset" : "resets"}${a.quota.resetCredits.nextExpiresAt ? ` · next expires ${absoluteTime(a.quota.resetCredits.nextExpiresAt)}` : ""}`
                : "Banked resets unknown"}
            </li>
            <li>
              {a.quota.observedAt
                ? `${a.quota.source === "manual" ? "Manual" : "Native"} observation · ${absoluteTime(a.quota.observedAt)}${fresh ? "" : " · stale"}`
                : "No supported quota observation"}
            </li>
            <li>
              {pool
                ? `Pool identity verified · ${absoluteTime(a.quotaPoolObservedAt)}`
                : "Pool identity unknown"}
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
            Open native draft
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
            Set up
          </Link>
        )}
        <button className="studio-prefer" disabled={!canWrite || !available} onClick={onSelect}>
          {selected ? "Preferred" : "Prefer"}
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
  const percent = value === null ? null : Math.round(value.usedPercent);
  const left = percent === null ? null : 100 - Math.min(100, Math.max(0, percent));
  const detail = `${title}${percent === null ? "" : ` · ${percent}% used`}${fresh ? "" : " · last observed"}`;
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
        {left === null ? "Unknown" : `${left}% left`}
        <span className="sr-only"> · {detail}</span>
      </strong>
      {value?.resetsAt ? (
        <span className="studio-reset">Resets {shortTime(value.resetsAt)}</span>
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
