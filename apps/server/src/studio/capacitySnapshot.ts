import * as DateTime from "effect/DateTime";
// @effect-diagnostics nodeBuiltinImport:off -- Pure native-home comparison; no filesystem or credential access.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type ServerSettings,
} from "@specweave-studio/contracts";
import {
  StudioCapacityAccountId,
  StudioCapacityMode,
  StudioCapacityProvider,
  StudioCapacityWindow,
  StudioCapacityQuotaWindow,
  StudioCapacityAccount,
  type StudioCapacitySnapshot,
} from "@specweave-studio/contracts/studio";
import {
  isLiveWindow,
  windowAppliesToModel,
  windowModelScope,
} from "@specweave-studio/shared/usageWindows";
import { isClaudeApiKeyProvider } from "@specweave-studio/shared/providerFallback";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { expandHomePath } from "../pathExpansion.ts";
import { hasExplicitProviderApiEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { completeClaudeUsageWindows } from "../provider/claudeUsageLimits.ts";
import {
  hasNativeUsageEvidence,
  nativeDenialResetPassed,
} from "../provider/providerUsageLimits.ts";

export const CAPACITY_MAX_AGE_MS = 15 * 60 * 1000;
const FUTURE_SKEW_MS = 5000;
const NativeConfig = Schema.Struct({
  homePath: Schema.optionalKey(Schema.String),
  shadowHomePath: Schema.optionalKey(Schema.String),
  setupMode: Schema.optionalKey(Schema.String),
  enabled: Schema.optionalKey(Schema.Boolean),
});
const RawAccount = Schema.Struct({
  id: StudioCapacityAccountId,
  provider: StudioCapacityProvider,
  authenticated: Schema.NullOr(Schema.Boolean),
  status: Schema.String,
  authKind: Schema.optionalKey(Schema.NullOr(Schema.String)),
  authError: Schema.optionalKey(Schema.NullOr(Schema.String)),
  quota: Schema.optionalKey(Schema.Unknown),
  lastQuotaErrorAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const RawSnapshot = Schema.Struct({
  accounts: Schema.Array(RawAccount).check(Schema.isMaxLength(7)),
  policy: Schema.Struct({
    mode: StudioCapacityMode,
    preferredProvider: Schema.optionalKey(Schema.NullOr(StudioCapacityProvider)),
    selectedAccount: Schema.optionalKey(Schema.NullOr(StudioCapacityAccountId)),
  }),
});
const RawQuota = Schema.Struct({
  window: Schema.optionalKey(Schema.Unknown),
  weekly: Schema.optionalKey(Schema.Unknown),
  observedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  expiresAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  source: Schema.optionalKey(Schema.NullOr(Schema.Literals(["native-app-server", "manual"]))),
  ordinaryUsageAllowed: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  spendControlReached: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  denied: Schema.optionalKey(Schema.Boolean),
  credits: Schema.optionalKey(Schema.Unknown),
  resetCredits: Schema.optionalKey(Schema.Unknown),
  windows: Schema.optionalKey(Schema.Unknown),
  rateLimitReachedType: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeRaw = Schema.decodeUnknownOption(RawSnapshot);
const decodeQuota = Schema.decodeUnknownOption(RawQuota);
const decodeWindow = Schema.decodeUnknownOption(StudioCapacityWindow);
const decodeExtraWindows = Schema.decodeUnknownOption(
  Schema.Array(StudioCapacityQuotaWindow).check(Schema.isMaxLength(32)),
);
const decodeCredits = Schema.decodeUnknownOption(StudioCapacityAccount.fields.quota.fields.credits);
const decodeResets = Schema.decodeUnknownOption(
  StudioCapacityAccount.fields.quota.fields.resetCredits,
);
const decodeConfig = Schema.decodeUnknownOption(NativeConfig);

export function freshObservation(value: string | null | undefined, now: number): boolean {
  const at = value ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at <= now + FUTURE_SKEW_MS && now - at <= CAPACITY_MAX_AGE_MS;
}
/**
 * Unknown quota is not a denial. A Claude stream refusal holds until a full
 * read clears it or its reported reset passes with no account-wide window
 * still spent. A model weekly (Fable) a read shows spent denies only starts
 * on `model`; one a rejection named denies every start through that rejection.
 */
export function nativeQuotaDenied(
  limits: ServerProviderUsageLimits | undefined,
  now: number,
  model?: string | null,
): boolean {
  if (
    !limits ||
    (limits.unavailable?.reason === "unsupported" && !limits.nativeDenialRequiresFullRead)
  )
    return false;
  if (spentModelWindow(limits, now, model)) return true;
  if (nativeDenialResetPassed(limits, now)) return false;
  const negative =
    limits.ordinaryUsageAllowed === false ||
    limits.spendControlReached === true ||
    (!!limits.rateLimitReachedType && limits.ordinaryUsageAllowed !== true);
  return (
    negative &&
    (limits.nativeDenialRequiresFullRead === true ||
      freshObservation(limits.nativeAllowanceObservedAt, now) ||
      freshObservation(limits.nativeDenialObservedAt, now))
  );
}

/** The spent, unreset model-scoped window that caps `model`, of several the one resetting last. */
export function spentModelWindow(
  limits: ServerProviderUsageLimits | undefined,
  now: number,
  model: string | null | undefined,
): ServerProviderUsageWindow | undefined {
  let binding: ServerProviderUsageWindow | undefined;
  for (const window of limits?.windows ?? []) {
    if (
      windowModelScope(window) === null ||
      !windowAppliesToModel(window, model) ||
      window.usedPercent < 100 ||
      !isLiveWindow(window, now)
    )
      continue;
    const at = Date.parse(window.resetsAt ?? "");
    const bindingAt = Date.parse(binding?.resetsAt ?? "");
    if (!binding || !Number.isFinite(at) || at > bindingAt) binding = window;
  }
  return binding;
}

/**
 * A Claude denial whose reported reset has passed. It no longer refuses a
 * start, but the start still re-reads native status before going ahead.
 */
export function nativeDenialLapsed(
  limits: ServerProviderUsageLimits | undefined,
  now: number,
): boolean {
  return (
    !!limits &&
    limits.nativeDenialRequiresFullRead === true &&
    limits.ordinaryUsageAllowed === false &&
    nativeDenialResetPassed(limits, now)
  );
}
/** Claude get_usage windows can support manual retry, not automatic allowance.
 * Complete, current non-exhausted windows can contradict an expired error, but
 * only permit a deliberate retry; they do not turn unknown capacity into ready.
 */
function claudeWindowsPermitManualRetry(
  limits: ServerProviderUsageLimits | undefined,
  now: number,
): boolean {
  if (limits?.unavailable) {
    // A confirmed unsupported lookup is no quota observation. It permits only
    // the expired, wholly unobserved companion-error fallback below. Retained
    // windows or permission history must never be discarded by this exception.
    return (
      limits.unavailable.reason === "unsupported" &&
      !limits.unavailable.invalidResponse &&
      !hasNativeUsageEvidence(limits) &&
      freshObservation(limits.checkedAt, now)
    );
  }
  if (!limits?.windows.length) return true;
  if (
    !freshObservation(limits.checkedAt, now) ||
    !freshObservation(limits.nativeAllowanceObservedAt, now)
  )
    return false;
  return completeClaudeUsageWindows(limits.windows, now);
}
function iso(value: string | null | undefined): string | null {
  const at = value ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? DateTime.formatIso(DateTime.makeUnsafe(at)) : null;
}
function window(value: unknown): StudioCapacityAccount["quota"]["window"] {
  const decoded = decodeWindow(value);
  return Option.isSome(decoded) ? decoded.value : null;
}
export function nativeConfigForInstance(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
): ProviderInstanceConfig | undefined {
  const explicit = settings.providerInstances[instanceId];
  if (explicit) return explicit;
  if (instanceId === "codex")
    return { driver: ProviderDriverKind.make("codex"), config: settings.providers.codex };
  if (instanceId === "claudeAgent")
    return {
      driver: ProviderDriverKind.make("claudeAgent"),
      config: settings.providers.claudeAgent,
    };
  return undefined;
}

/** Exact canonical native home only. Instance slugs and display labels prove nothing. */
export function nativeCapacityBinding(
  entry: ProviderInstanceConfig | undefined,
  baseEnv: NodeJS.ProcessEnv,
): StudioCapacityAccount["id"] | null {
  if (
    !entry ||
    entry.enabled === false ||
    hasExplicitProviderApiEnvironment(
      entry.environment,
      entry.driver === "codex" ? "codex" : "claudeAgent",
    )
  )
    return null;
  const config = decodeConfig(entry.config ?? {});
  if (
    Option.isNone(config) ||
    config.value.enabled === false ||
    config.value.setupMode === "managed"
  )
    return null;
  if (entry.driver !== "codex" && entry.driver !== "claudeAgent") return null;
  const own = entry.environment?.findLast(
    (variable) => variable.name === (entry.driver === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"),
  );
  if (entry.driver === "claudeAgent") {
    // Setting even the default path changes native Keychain scope. Preserve unset.
    if (
      !config.value.homePath?.trim() &&
      own === undefined &&
      baseEnv.CLAUDE_CONFIG_DIR === undefined
    )
      return "claude-1";
    const home = config.value.homePath?.trim() || own?.value || baseEnv.CLAUDE_CONFIG_DIR;
    if (!home) return null;
    for (const n of [2, 3] as const) {
      if (
        NodePath.resolve(expandHomePath(home)) ===
        NodePath.join(NodeOS.homedir(), ".local/share/specweave/account-profiles", `claude-${n}`)
      )
        return `claude-${n}`;
    }
    return null;
  }
  if (config.value.shadowHomePath?.trim()) return null;
  const home = config.value.homePath?.trim() || own?.value || baseEnv.CODEX_HOME;
  if (!home || NodePath.resolve(expandHomePath(home)) === NodePath.join(NodeOS.homedir(), ".codex"))
    return "codex-1";
  for (const n of [2, 3, 4] as const) {
    if (
      NodePath.resolve(expandHomePath(home)) ===
      NodePath.join(NodeOS.homedir(), ".local/share/specweave/account-profiles", `codex-${n}`)
    )
      return `codex-${n}`;
  }
  return null;
}

function freshlyAuthenticated(provider: ServerProvider | undefined, now: number): boolean {
  return (
    !!provider?.enabled &&
    provider.installed &&
    provider.status === "ready" &&
    provider.availability !== "unavailable" &&
    provider.auth.status === "authenticated" &&
    freshObservation(provider.checkedAt, now)
  );
}
/**
 * A Claude CLI signed in to the Claude Console ("API Usage Billing") or given
 * its own key bills every turn to API credits. It has no plan quota to verify:
 * the API's own answer about credits or the key decides each turn.
 */
export function claudeApiBillingAuthorized(
  provider: ServerProvider | undefined,
  now: number,
): boolean {
  if (provider?.driver !== "claudeAgent" || !freshlyAuthenticated(provider, now)) return false;
  const type = provider.auth.type?.toLowerCase().replace(/[\s_.-]+/g, "");
  return type === "apikey" || isClaudeApiKeyProvider(provider);
}
export function nativeSnapshotAuthorized(
  provider: ServerProvider | undefined,
  now: number,
): boolean {
  if (!freshlyAuthenticated(provider, now)) return false;
  const type = provider!.auth.type?.toLowerCase().replace(/[\s_.-]+/g, "");
  if (provider!.driver === "codex") return type === "chatgpt" || type === "chatgptauthtokens";
  if (provider!.driver === "claudeAgent") return claudeSubscriptionAuthType(type);
  return false;
}
/**
 * Auth types a Claude snapshot uses for anything that is not a verified plan.
 * ClaudeProvider names the plan only after the CLI's own `auth status` shows a
 * claude.ai login, so every other type is a plan name. Plans get renamed (Max
 * 20x became Ultra, reported as "Claude Ultra", on 2026-10-30): an allow-list of
 * plan names marked a signed-in subscription unverified on every machine.
 */
const CLAUDE_NOT_A_PLAN = new Set([
  "subscriptionauthunverified",
  "statuscheckfailed",
  "apikey",
  "bedrock",
  "none",
  "unknown",
]);
function claudeSubscriptionAuthType(type: string | undefined): boolean {
  if (!type || !/^[a-z0-9]+$/.test(type) || CLAUDE_NOT_A_PLAN.has(type)) return false;
  // A free claude.ai login has no Claude Code plan to run on.
  return !/^(?:claude)?free(?:plan|subscription)?$/.test(type);
}
export function unavailableCapacity(
  now: number,
  error: Exclude<StudioCapacitySnapshot["error"], null>,
): StudioCapacitySnapshot {
  return {
    schemaVersion: 1,
    observedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    source: "specweave-switch",
    scope: "environment-local",
    available: false,
    error,
    quotaPoolIdentity: "unavailable",
    verifiedQuotaPoolCount: null,
    accounts: [],
    policy: null,
    recommendations: [],
  };
}

/** Complete native reads can replace an older companion observation, never its auth identity. */
function quotaFromNative(provider: ServerProvider | undefined, now: number) {
  if (provider?.driver !== "codex") return undefined;
  const limits = provider?.usageLimits;
  if (!limits || !freshObservation(limits.nativeAllowanceObservedAt, now) || limits.unavailable)
    return undefined;
  const at = limits.nativeAllowanceObservedAt!;
  const normalized = limits.windows.flatMap((w) => {
    const reset = w.resetsAt ? Date.parse(w.resetsAt) / 1000 : NaN;
    const resetsAt = Number.isFinite(reset) && reset > 0 ? reset : null;
    if (!/^[a-zA-Z0-9_:-]{1,100}$/.test(w.id)) return [];
    const parts = w.id.split(":");
    const bucketId = parts.length > 1 ? parts[0]! : "codex";
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(bucketId)) return [];
    return [
      {
        usedPercent: w.usedPercent,
        resetsAt,
        ...(w.windowDurationMins && w.windowDurationMins > 0
          ? { windowDurationMins: w.windowDurationMins }
          : {}),
        id: parts.length > 1 ? w.id : `codex:${w.id}`,
        bucketId,
        appliesToSelection: bucketId === "codex",
        kind: w.kind,
      },
    ];
  });
  const mostUsed = (rows: typeof normalized) =>
    rows.reduce<(typeof normalized)[number] | null>(
      (selected, w) => (!selected || w.usedPercent > selected.usedPercent ? w : selected),
      null,
    );
  return {
    window: mostUsed(
      normalized.filter(
        (w) =>
          w.appliesToSelection &&
          (w.kind === "session" || (w.kind === "other" && w.id.endsWith(":primary"))),
      ),
    ),
    weekly: mostUsed(
      normalized.filter(
        (w) =>
          w.appliesToSelection &&
          (w.kind === "weekly" ||
            w.kind === "monthly" ||
            (w.kind === "other" && w.id.endsWith(":secondary"))),
      ),
    ),
    windows: normalized.map(({ kind: _kind, ...w }) => w),
    observedAt: at,
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(at) + CAPACITY_MAX_AGE_MS)),
    source: "native-app-server" as const,
    ordinaryUsageAllowed: limits.ordinaryUsageAllowed,
    spendControlReached: limits.spendControlReached,
    rateLimitReachedType: limits.rateLimitReachedType,
    credits: limits.credits,
    resetCredits: limits.resetCredits,
  };
}

export function capacitySnapshot(input: {
  raw: unknown;
  settings: ServerSettings;
  providers: ReadonlyArray<ServerProvider>;
  baseEnv: NodeJS.ProcessEnv;
  now: number;
}): StudioCapacitySnapshot {
  const raw = decodeRaw(input.raw);
  if (Option.isNone(raw)) return unavailableCapacity(input.now, "switch-invalid-response");
  const ids = new Set<string>();
  for (const account of raw.value.accounts) {
    if (ids.has(account.id) || !account.id.startsWith(`${account.provider}-`))
      return unavailableCapacity(input.now, "switch-invalid-response");
    ids.add(account.id);
  }
  const mapped = new Map<string, ServerProvider>();
  for (const provider of input.providers) {
    const binding = nativeCapacityBinding(
      nativeConfigForInstance(input.settings, provider.instanceId),
      input.baseEnv,
    );
    if (
      binding &&
      nativeSnapshotAuthorized(provider, input.now) &&
      (provider.driver !== "codex" ||
        (provider.usageLimits?.nativeRouteVerified === true &&
          freshObservation(provider.usageLimits.nativeRouteObservedAt, input.now))) &&
      !mapped.has(binding)
    )
      mapped.set(binding, provider);
  }
  const accounts = raw.value.accounts.map((account): StudioCapacityAccount => {
    const provider = mapped.get(account.id);
    const rawQuota = decodeQuota(account.quota);
    const original = Option.isSome(rawQuota) ? rawQuota.value : undefined;
    const native = quotaFromNative(provider, input.now);
    const useNative =
      native &&
      (!original?.observedAt ||
        !Number.isFinite(Date.parse(original.observedAt)) ||
        Date.parse(native.observedAt) > Date.parse(original.observedAt));
    const q = useNative ? native : original;
    const nativeDenialAt =
      provider?.usageLimits?.nativeDenialObservedAt ??
      provider?.usageLimits?.nativeAllowanceObservedAt;
    const newerNativeDenial =
      nativeQuotaDenied(provider?.usageLimits, input.now) &&
      (provider?.usageLimits?.nativeDenialRequiresFullRead === true ||
        (!!nativeDenialAt &&
          (!q?.observedAt || Date.parse(nativeDenialAt) >= Date.parse(q.observedAt))));
    const metadataAllowed = q?.source === "native-app-server";
    const ordinaryUsageAllowed =
      newerNativeDenial && provider?.usageLimits?.ordinaryUsageAllowed === false
        ? false
        : metadataAllowed && typeof q?.ordinaryUsageAllowed === "boolean"
          ? q.ordinaryUsageAllowed
          : null;
    const spendControlReached =
      newerNativeDenial && provider?.usageLimits?.spendControlReached === true
        ? true
        : metadataAllowed && typeof q?.spendControlReached === "boolean"
          ? q.spendControlReached
          : null;
    const reached = newerNativeDenial
      ? provider?.usageLimits?.rateLimitReachedType
      : metadataAllowed
        ? q?.rateLimitReachedType
        : undefined;
    const rateLimitReachedType =
      typeof reached === "string" && /^[a-z_]{1,80}$/.test(reached) ? reached : null;
    const denied =
      newerNativeDenial ||
      (metadataAllowed &&
        (("denied" in (q ?? {}) && (q as { denied?: boolean }).denied === true) ||
          ordinaryUsageAllowed === false ||
          spendControlReached === true ||
          (rateLimitReachedType !== null && ordinaryUsageAllowed !== true)));
    const decodedCredits = decodeCredits(metadataAllowed ? q?.credits : undefined);
    const credits = Option.isSome(decodedCredits) ? (decodedCredits.value ?? null) : null;
    const decodedResets = decodeResets(metadataAllowed ? q?.resetCredits : undefined);
    const resetCredits = Option.isSome(decodedResets) ? (decodedResets.value ?? null) : null;
    const extra = decodeExtraWindows(q?.windows);
    const previousExtra = useNative ? decodeExtraWindows(original?.windows) : Option.none();
    const extraObservedAt = iso(q?.observedAt),
      previousObservedAt = iso(original?.observedAt);
    const windows = [
      ...(Option.isSome(extra)
        ? extra.value.map((w) => ({
            ...w,
            ...(extraObservedAt ? { observedAt: extraObservedAt } : {}),
          }))
        : []),
      ...(Option.isSome(previousExtra) && previousObservedAt
        ? previousExtra.value
            .filter(
              (w) =>
                !w.appliesToSelection &&
                !(Option.isSome(extra) && extra.value.some((current) => current.id === w.id)),
            )
            .map((w) => ({ ...w, observedAt: previousObservedAt }))
        : []),
    ].slice(0, 32);
    const failureAt = account.lastQuotaErrorAt ? Date.parse(account.lastQuotaErrorAt) : NaN;
    // An old Claude error with no quota observation cannot prove a current
    // limit forever. Fresh native authorization permits a deliberate retry;
    // its capacity stays unknown and cannot enter automatic recommendations.
    const expiredUnobservedClaudeFailure =
      provider?.driver === "claudeAgent" &&
      Number.isFinite(failureAt) &&
      failureAt < input.now - CAPACITY_MAX_AGE_MS &&
      q !== undefined &&
      !denied &&
      claudeWindowsPermitManualRetry(provider.usageLimits, input.now) &&
      [
        q.window,
        q.weekly,
        q.observedAt,
        q.expiresAt,
        q.source,
        q.ordinaryUsageAllowed,
        q.spendControlReached,
        q.rateLimitReachedType,
        q.credits,
        q.resetCredits,
        "denied" in q ? q.denied : undefined,
      ].every((value) => value == null) &&
      (q.windows == null || (Array.isArray(q.windows) && q.windows.length === 0));
    const newerFailure =
      !expiredUnobservedClaudeFailure &&
      account.lastQuotaErrorAt !== null &&
      account.lastQuotaErrorAt !== undefined &&
      (!Number.isFinite(failureAt) || !q?.observedAt || failureAt >= Date.parse(q.observedAt));

    const current = window(q?.window),
      weekly = window(q?.weekly);
    const observedAt = iso(q?.observedAt),
      expiresAt = iso(q?.expiresAt);
    const anyWindow = !!current || !!weekly;
    const expiryValid =
      !!observedAt &&
      !!expiresAt &&
      Date.parse(expiresAt) > Date.parse(observedAt) &&
      Date.parse(expiresAt) - Date.parse(observedAt) <= 60 * 60 * 1000;
    const invalidWindow = [q?.window, q?.weekly].some(
      (rawWindow) =>
        rawWindow != null &&
        (!window(rawWindow) ||
          (window(rawWindow)?.resetsAt == null && ordinaryUsageAllowed !== true)),
    );
    const stale =
      (!useNative && account.status === "stale") ||
      (!!observedAt &&
        (!freshObservation(observedAt, input.now) ||
          (!!expiresAt && Date.parse(expiresAt) <= input.now) ||
          [current, weekly, ...windows.filter((w) => w.appliesToSelection)].some(
            (w) => w?.resetsAt != null && w.resetsAt * 1000 <= input.now,
          )));
    const freshness =
      (!anyWindow && ordinaryUsageAllowed === null && !denied && !credits && !resetCredits) ||
      !observedAt ||
      !q?.source ||
      !expiryValid ||
      invalidWindow
        ? "unknown"
        : stale
          ? "stale"
          : "fresh";
    const kind = account.authKind?.toLowerCase().replace(/[\s_.-]+/g, "");
    let authError: StudioCapacityAccount["authError"] = null;
    if (account.authError === "profile-isolation-unverified") authError = account.authError;
    else if (account.authError === "subscription-auth-unverified" || kind === "oauthtoken")
      authError = "subscription-auth-unverified";
    else if (kind && ["apikey", "bedrock", "vertex", "foundry"].includes(kind))
      authError = "api-auth-not-subscription";
    else if (
      account.authenticated === true &&
      kind !== (account.provider === "codex" ? "chatgpt" : "claudeai")
    )
      authError = "native-auth-unverified";
    let status: StudioCapacityAccount["status"] = "unknown";
    if (authError || account.status === "blocked" || account.status === "error") status = "blocked";
    else if (account.status === "auth-required") status = "auth-required";
    else if (account.authenticated === false) status = "auth-required";
    else if (account.authenticated === true) {
      if (account.status === "active") status = "active";
      else if (denied || newerFailure) status = "exhausted";
      else if (freshness === "fresh" && ordinaryUsageAllowed === true && provider) status = "ready";
      else if (
        (account.status === "exhausted" && !expiredUnobservedClaudeFailure) ||
        (freshness === "fresh" && [current, weekly].some((w) => w?.usedPercent === 100))
      )
        status = "exhausted";
      else if (freshness === "stale" || (!useNative && account.status === "stale"))
        status = "stale";
      else if (freshness === "fresh" && anyWindow && provider && account.status === "ready")
        status = "ready";
    }
    const limits = provider?.usageLimits;
    const poolFresh =
      !!limits?.quotaPoolId &&
      /^codex:sha256:[a-f0-9]{64}$/.test(limits.quotaPoolId) &&
      freshObservation(limits.quotaPoolObservedAt, input.now) &&
      account.authenticated === true &&
      !authError;
    return {
      id: account.id,
      provider: account.provider,
      label: `${account.provider === "codex" ? "Codex" : "Claude"} ${account.id.split("-")[1]}`,
      authenticated: account.authenticated,
      status,
      authError,
      providerInstanceId: provider?.instanceId ?? null,
      quotaPoolId: poolFresh ? limits!.quotaPoolId! : null,
      quotaPoolObservedAt: poolFresh ? iso(limits!.quotaPoolObservedAt) : null,
      quota: {
        window: current,
        weekly,
        windows,
        ordinaryUsageAllowed,
        spendControlReached,
        rateLimitReachedType,
        credits,
        resetCredits,
        observedAt,
        expiresAt,
        source: q?.source ?? null,
        freshness,
      },
    };
  });
  const policy = {
    mode: raw.value.policy.mode,
    preferredProvider: raw.value.policy.preferredProvider ?? null,
    selectedAccount: raw.value.policy.selectedAccount ?? null,
  };
  const recommendations = (["any", "codex", "claude"] as const).map((provider) => {
    const eligible = accounts.filter(
      (a) =>
        a.status === "ready" &&
        a.providerInstanceId !== null &&
        (provider === "any" || a.provider === provider) &&
        (!policy.selectedAccount || a.id === policy.selectedAccount) &&
        (!policy.preferredProvider || a.provider === policy.preferredProvider),
    );
    const selectionWindows = (a: StudioCapacityAccount) => {
      const main = a.quota.windows?.filter((w) => w.appliesToSelection) ?? [];
      return main.length ? main : [a.quota.window, a.quota.weekly].filter((w) => w !== null);
    };
    const used = (a: StudioCapacityAccount) =>
      Math.max(0, ...selectionWindows(a).map((w) => w.usedPercent));
    const nextReset = (a: StudioCapacityAccount) =>
      Math.min(
        ...selectionWindows(a).flatMap((w) =>
          w.resetsAt &&
          Number.isFinite(
            DateTime.make(w.resetsAt * 1000).pipe(
              Option.map(DateTime.toEpochMillis),
              Option.getOrElse(() => Number.NaN),
            ),
          )
            ? [w.resetsAt]
            : [],
        ),
      );
    const sorted = eligible.toSorted((a, b) => {
      const delta =
        policy.mode === "reset-first"
          ? nextReset(a) - nextReset(b)
          : policy.mode === "spend-first"
            ? used(b) - used(a)
            : used(a) - used(b);
      return (
        delta || (policy.mode === "reset-first" ? used(b) - used(a) : 0) || a.id.localeCompare(b.id)
      );
    });
    const selected = sorted[0];
    const reset = selected ? nextReset(selected) : Number.POSITIVE_INFINITY;
    const priority = policy.selectedAccount
      ? "Explicit account preference retained"
      : policy.mode === "reset-first"
        ? Number.isFinite(reset)
          ? `Earliest eligible observed reset: ${DateTime.formatIso(DateTime.makeUnsafe(reset * 1000))}; equal resets prefer the one with less left`
          : "Eligible native permission; next reset unknown"
        : policy.mode === "spend-first"
          ? "Eligible quota with the least left"
          : "Eligible quota with the most left";
    return {
      provider,
      id: selected?.id ?? null,
      providerInstanceId: selected?.providerInstanceId ?? null,
      reason: selected
        ? `${priority}. New session only; existing sessions keep their account and provider.`
        : "No verified native instance has fresh eligible capacity.",
    };
  });
  const identified = accounts.filter((a) => a.quotaPoolId !== null);
  const pools = new Set(identified.map((a) => a.quotaPoolId));
  return {
    schemaVersion: 1,
    observedAt: DateTime.formatIso(DateTime.makeUnsafe(input.now)),
    source: "specweave-switch",
    scope: "environment-local",
    available: true,
    error: null,
    quotaPoolIdentity:
      identified.length === 0
        ? "unavailable"
        : identified.length === accounts.filter((a) => a.authenticated === true).length
          ? "available"
          : "partial",
    verifiedQuotaPoolCount: pools.size || null,
    accounts,
    policy,
    recommendations,
  };
}
