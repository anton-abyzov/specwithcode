import { classifyProjectActions } from "@specweave-studio/shared/projectAttention";
import { observeProjectThread } from "@specweave-studio/client-runtime/state/projectAttention";
import { THREAD_LIFECYCLE_LABELS } from "@specweave-studio/shared/threadLifecycleLabels";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@specweave-studio/client-runtime/state/shell";
import { threadRuntimeIsActive } from "@specweave-studio/client-runtime/state/shell";
import { threadRunHealth } from "@specweave-studio/client-runtime/state/models";
import type { RunHealth } from "@specweave-studio/shared/orchestrationV2PendingBackgroundWork";
import type { ModelSelection, ServerProvider } from "@specweave-studio/contracts";
import type {
  StudioCapacityAccount,
  StudioCapacitySnapshot,
} from "@specweave-studio/contracts/studio";
import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";

export type AttentionKind =
  | "approval"
  | "input"
  | "signin"
  | "plan"
  | "held"
  | "limited"
  | "failed"
  | "stalled";
export type SessionView = {
  readonly thread: EnvironmentThreadShell;
  readonly project: EnvironmentProject | null;
  readonly state: string;
  readonly attention: AttentionKind | null;
  readonly working: boolean;
  readonly settled: boolean;
};

const ATTENTION_LABELS: Record<AttentionKind, string> = {
  approval: "Approval requested",
  input: "Answer needed",
  signin: "Sign-in needed",
  plan: "Plan ready to review",
  held: "Queued messages held",
  limited: "Usage limit reached",
  failed: "Run failed",
  stalled: "No recent activity",
};

export const attentionLabel = (kind: AttentionKind) => ATTENTION_LABELS[kind];

/**
 * A running turn this quiet is listed in Needs you only when nothing explains
 * it: the classifier already grants its own command the long-command allowance
 * and never stalls a wait on the person or on another thread.
 */
export const NEEDS_YOU_QUIET_MS = 30 * 60_000;

/** The quiet a running thread shows as stalled in Needs you, or null when it is not. */
function needsYouStall(
  health: RunHealth | null,
): { readonly idleMs: number; readonly label: string | null } | null {
  return health?.state === "stalled" && health.idleMs >= NEEDS_YOU_QUIET_MS ? health : null;
}

/** Shells carry native attention state; reading the desk does not hydrate every conversation. */
export function deriveSessions(
  threads: readonly EnvironmentThreadShell[],
  projects: readonly EnvironmentProject[],
  connectedEnvironmentIds: ReadonlySet<string>,
  nowMs: number = Date.now(),
): SessionView[] {
  const projectByKey = new Map(projects.map((p) => [`${p.environmentId}:${p.id}`, p]));
  return threads
    .filter((thread) => thread.deletedAt === null && thread.archivedAt === null)
    .map((thread): SessionView => {
      const status = resolveSidebarThreadStatus(thread);
      const observedWorking = threadRuntimeIsActive(thread.runtime);
      // Disconnected shells cannot prove activity, so they cannot prove a stall.
      const health = connectedEnvironmentIds.has(thread.environmentId)
        ? threadRunHealth(thread, nowMs)
        : null;
      const stall = needsYouStall(health);
      const observedAttention: AttentionKind | null =
        classifyProjectActions(observeProjectThread(thread))[0]?.reason ?? null;
      const settled = thread.settledOverride === "settled";
      const observedState =
        stall !== null && observedAttention === null
          ? `No activity for ${formatMinutes(stall.idleMs)}${
              stall.label === null ? "" : ` on ${stall.label}`
            }`
          : observedAttention === "held"
            ? `${heldQueueCountLabel(thread.heldQueuedCount ?? 0)} · Resume or discard`
            : observedAttention
              ? attentionLabel(observedAttention)
              : status === "waiting"
                ? "Waiting for background work"
                : health?.state === "waiting" &&
                    health.awaitingPerson === undefined &&
                    health.waitingMs >= 60_000
                  ? `Waiting on ${health.label} · ${formatMinutes(health.waitingMs)}`
                  : observedWorking
                    ? "Working"
                    : settled
                      ? THREAD_LIFECYCLE_LABELS.resolved
                      : "Ready";
      // Disconnected shells retain navigation and history, but cannot prove current activity.
      const connected = connectedEnvironmentIds.has(thread.environmentId);
      return {
        thread,
        project: projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null,
        state: connected ? observedState : `Disconnected · Last observed: ${observedState}`,
        attention: connected ? observedAttention : null,
        working: connected && observedWorking,
        settled,
      };
    })
    .sort((a, b) => {
      const priority = (s: SessionView) => (s.attention ? 0 : s.working ? 1 : s.settled ? 3 : 2);
      return (
        priority(a) - priority(b) ||
        validTimestamp(b.thread.updatedAt) - validTimestamp(a.thread.updatedAt)
      );
    });
}

/**
 * When a session's shown state began. A stopped run (usage limit or failure)
 * keeps the time it stopped, because the thread's updatedAt also moves when
 * the service restarts and reads it back.
 */
export function sessionStateSince(thread: EnvironmentThreadShell): string {
  return thread.runtime?.status === "failed"
    ? (thread.latestRun?.completedAt ?? thread.updatedAt)
    : thread.updatedAt;
}

function heldQueueCountLabel(count: number): string {
  return `${count} queued message${count === 1 ? "" : "s"} held`;
}

function formatMinutes(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function validTimestamp(value: string | null | undefined): number {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function relativeTime(value: string | null | undefined, now = Date.now()): string {
  const timestamp = validTimestamp(value);
  if (!timestamp) return "Time unknown";
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1_440)}d ago`;
}

export function absoluteTime(value: string | number | null | undefined): string {
  const date = typeof value === "number" ? new Date(value * 1_000) : new Date(value ?? "");
  if (!Number.isFinite(date.getTime())) return "Time unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

/** Exact native instance only: a similarly named slot is not a verified profile binding. */
export function resolveNativeModel(
  providers: readonly ServerProvider[],
  instanceId: string | null,
): ModelSelection | null {
  if (instanceId === null) return null;
  const provider = providers.find((p) => p.instanceId === instanceId);
  if (
    !provider ||
    !provider.enabled ||
    !provider.installed ||
    provider.availability === "unavailable" ||
    provider.status !== "ready" ||
    provider.auth.status !== "authenticated"
  )
    return null;
  const model =
    provider.models.find((m) => m.isDefault && !m.isLegacy) ??
    provider.models.find((m) => !m.isLegacy);
  return model ? { instanceId: provider.instanceId, model: model.slug } : null;
}

export function quotaFresh(account: StudioCapacityAccount, now = Date.now()): boolean {
  const observed = validTimestamp(account.quota.observedAt);
  const expires = validTimestamp(account.quota.expiresAt);
  const windows = [account.quota.window, account.quota.weekly].filter((window) => window !== null);
  return (
    account.quota.freshness === "fresh" &&
    observed > 0 &&
    observed <= now + 5_000 &&
    expires > now &&
    now - observed <= 15 * 60_000 &&
    (windows.length > 0 ||
      (account.quota.source === "native-app-server" &&
        account.quota.ordinaryUsageAllowed === true)) &&
    windows.every((window) => window.resetsAt !== null && window.resetsAt * 1_000 > now)
  );
}

/** Use the host's policy result, never silently replace an ineligible pin or guess a model. */
export function resolvePolicyDraft(
  snapshot: StudioCapacitySnapshot | null,
  providers: readonly ServerProvider[],
  now = Date.now(),
): { accountId: StudioCapacityAccount["id"]; label: string; model: ModelSelection } | null {
  if (!snapshot?.available || snapshot.error || !snapshot.policy) return null;
  const observed = validTimestamp(snapshot.observedAt);
  if (!observed || observed > now + 5_000 || now - observed > 15 * 60_000) return null;
  const { preferredProvider, selectedAccount } = snapshot.policy;
  const recommendation = snapshot.recommendations.find(
    (candidate) => candidate.provider === (preferredProvider ?? "any"),
  );
  if (!recommendation?.id || !recommendation.providerInstanceId) return null;
  if (selectedAccount && recommendation.id !== selectedAccount) return null;
  const account = snapshot.accounts.find((candidate) => candidate.id === recommendation.id);
  if (
    !account ||
    !canSelectCapacity(account, now) ||
    (preferredProvider !== null && account.provider !== preferredProvider) ||
    account.providerInstanceId !== recommendation.providerInstanceId
  )
    return null;
  const provider = providers.find(
    (candidate) => candidate.instanceId === account.providerInstanceId,
  );
  const checked = validTimestamp(provider?.checkedAt);
  if (
    provider?.driver !== (account.provider === "codex" ? "codex" : "claudeAgent") ||
    !checked ||
    checked > now + 5_000 ||
    now - checked > 15 * 60_000
  )
    return null;
  const model = resolveNativeModel(providers, account.providerInstanceId);
  return model ? { accountId: account.id, label: account.label, model } : null;
}

/** Refreshing a quota window cannot refresh its independent account identity. */
export function verifiedPoolId(account: StudioCapacityAccount, now = Date.now()): string | null {
  const observed = validTimestamp(account.quotaPoolObservedAt);
  return account.authenticated === true &&
    account.authError === null &&
    account.provider === "codex" &&
    quotaFresh(account, now) &&
    observed > 0 &&
    observed <= now + 5_000 &&
    now - observed <= 15 * 60_000 &&
    /^codex:sha256:[a-f0-9]{64}$/.test(account.quotaPoolId ?? "")
    ? account.quotaPoolId
    : null;
}

export function capacitySummary(snapshots: readonly StudioCapacitySnapshot[], now = Date.now()) {
  const accounts = snapshots.filter((s) => s.available).flatMap((s) => s.accounts);
  const identities = accounts.map((a) => verifiedPoolId(a, now));
  const pools = new Set(identities.filter((id): id is string => id !== null));
  return {
    profiles: accounts.length,
    eligible: accounts.filter((a) => canSelectCapacity(a, now)).length,
    verifiedPools: pools.size === 0 ? null : pools.size,
    unknownPools: identities.filter((id) => id === null).length,
  };
}

export function capacityLabel(account: StudioCapacityAccount, now = Date.now()): string {
  if (account.status === "blocked" || account.authError) return "Verification required";
  if (account.authenticated === false || account.status === "auth-required")
    return "Sign-in required";
  if (account.authenticated === null) return "Auth unverified";
  if (account.status === "exhausted") return "At limit";
  if (account.status === "active") return "In use";
  if (
    account.status === "stale" ||
    account.quota.freshness === "stale" ||
    (account.quota.observedAt !== null && !quotaFresh(account, now))
  )
    return "Stale observation";
  if (!quotaFresh(account, now) || account.status === "unknown") return "Capacity unknown";
  return account.providerInstanceId === null ? "Set up provider" : "Available";
}

export function canSelectCapacity(account: StudioCapacityAccount, now = Date.now()): boolean {
  return (
    account.authenticated === true &&
    account.authError === null &&
    account.status === "ready" &&
    quotaFresh(account, now) &&
    account.providerInstanceId !== null
  );
}
