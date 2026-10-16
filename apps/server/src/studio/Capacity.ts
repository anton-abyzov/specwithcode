import * as DateTime from "effect/DateTime";
import type { ProviderInstanceId, ServerProvider } from "@specweave-studio/contracts";
import { ProviderSetupError } from "@specweave-studio/contracts";
import type { StudioCapacityPolicyInput, StudioCapacitySelectInput, StudioCapacitySnapshot } from "@specweave-studio/contracts/studio";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Settings from "../serverSettings.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import { hasExplicitProviderApiEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { CLAUDE_STATUS_CHECK_FAILED } from "../provider/providerSnapshot.ts";
import * as NativeRoute from "./NativeRoute.ts";
import * as SwitchClient from "./SwitchClient.ts";
import { companionCreditFailureCleared, nativeCreditContinuationAllowed } from "./nativeCreditContinuation.ts";
import { capacitySnapshot, freshObservation, nativeCapacityBinding, nativeConfigForInstance, nativeQuotaDenied, nativeSnapshotAuthorized, unavailableCapacity } from "./capacitySnapshot.ts";

// Native CLI status probes spawn a login shell; on a host under heavy load
// they took longer than 15 seconds and failed coordinator turns.
export const NATIVE_STATUS_CHECK_TIMEOUT = "60 seconds";

/** Every exhausted window must reset; unrelated windows cannot predict recovery. */
function blockingUsageReset(
  windows: ReadonlyArray<{ readonly usedPercent: number; readonly resetsAt: number | null }>,
  limits: { readonly spendControlReached?: boolean | null | undefined; readonly rateLimitReachedType?: string | null | undefined;
  },
  now: number,
): number | undefined {
  if (limits.spendControlReached === true
    || (limits.rateLimitReachedType != null && limits.rateLimitReachedType !== "rate_limit_reached")) return;
  const blocking = windows.filter((window) => window.usedPercent >= 100);
  if (blocking.length === 0) return;
  let resetAt = 0;
  for (const window of blocking) {
    if (window.resetsAt === null || !Number.isFinite(
        DateTime.make(window.resetsAt).pipe(
          Option.map(DateTime.toEpochMillis),
          Option.getOrElse(() => Number.NaN),
        )) || window.resetsAt <= now) return;
    resetAt = Math.max(resetAt, window.resetsAt);
  }
  return resetAt;
}

export interface NativeCreditStartOptions {
  readonly allowCredits: true;
  readonly expectedQuotaPoolId: string;
}

export class CapacityMutationError extends Schema.TaggedError<CapacityMutationError>()("CapacityMutationError", {
  category: Schema.Literals(["switch-unavailable", "switch-timeout", "switch-invalid-response", "switch-busy", "profile-not-eligible"]),
}) {
  override get message() { return this.category === "profile-not-eligible" ? "This profile is not eligible for new work." : this.category === "switch-busy" ? "Capacity refresh is already running. Try again after it finishes." : "The local capacity service could not apply this change."; }
}

export class Capacity extends Context.Service<Capacity, {
  readonly current: Effect.Effect<StudioCapacitySnapshot>;
  readonly refresh: Effect.Effect<StudioCapacitySnapshot, CapacityMutationError>;
  readonly policy: (input: StudioCapacityPolicyInput) => Effect.Effect<StudioCapacitySnapshot, CapacityMutationError>;
  readonly select: (input: StudioCapacitySelectInput) => Effect.Effect<StudioCapacitySnapshot, CapacityMutationError>;
  /** Admission check only. Never changes an existing session or chooses its account. */
  readonly assertNativeStart: (id: ProviderInstanceId, cwd: string | null, options?: NativeCreditStartOptions) => Effect.Effect<void, ProviderSetupError>;
}>()("specweave-studio/studio/Capacity") {}

const make = Effect.gen(function* () {
  const client = yield* SwitchClient.SwitchClient;
  const settings = yield* Settings.ServerSettingsService;
  const providers = yield* Providers.ProviderRegistry;
  const baseEnv = yield* HostProcessEnvironment;
  const nativeRoute = yield* NativeRoute.NativeRoute;
  const build = (raw: unknown, observedProviders?: ReadonlyArray<ServerProvider>) => Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const config = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!config) return unavailableCapacity(now, "switch-unavailable");
    return capacitySnapshot({ raw, settings: config, providers: observedProviders ?? (yield* providers.getProviders), baseEnv, now });
  });
  const current = client.read.pipe(Effect.flatMap(build), Effect.catchTags({
    SwitchRequestError: (error) => Clock.currentTimeMillis.pipe(Effect.map((now) => unavailableCapacity(now, error.category === "switch-busy" ? "switch-unavailable" : error.category))),
  }));
  const mutate = (request: Effect.Effect<unknown, SwitchClient.SwitchRequestError>) => request.pipe(
    Effect.mapError((error) => new CapacityMutationError({ category: error.category })),
    Effect.flatMap(build),
    Effect.flatMap((snapshot) => snapshot.available ? Effect.succeed(snapshot) : Effect.fail(new CapacityMutationError({ category: snapshot.error ?? "switch-invalid-response" }))),
  );
  const assertNativeStart = (id: ProviderInstanceId, cwd: string | null, options?: NativeCreditStartOptions) => Effect.gen(function* () {
    const deny = (detail: string, usageLimit?: { readonly resetAt?: string }) => new ProviderSetupError({ instanceId: id, operation: "session", detail, ...(usageLimit ? { usageLimit } : {}) });
    const config = yield* settings.getSettings.pipe(Effect.mapError(() => deny("Native provider settings could not be verified.")));
    const entry = nativeConfigForInstance(config, id);
    if (options?.allowCredits && entry?.driver !== "codex")
      return yield* deny("Existing-credit requests require the selected native Codex subscription instance.");
    if (!entry || (entry.driver !== "codex" && entry.driver !== "claudeAgent")) return;
    if (entry.enabled === false || (typeof entry.config === "object" && entry.config !== null && "enabled" in entry.config && entry.config.enabled === false))
      return yield* deny("This provider instance is disabled.");
    // Explicit API/managed instances retain their own native auth mechanism;
    // they are not subscription slots and never receive quota recommendations.
    if (hasExplicitProviderApiEnvironment(entry.environment, entry.driver === "codex" ? "codex" : "claudeAgent") || (typeof entry.config === "object" && entry.config !== null && "setupMode" in entry.config && entry.config.setupMode === "managed")) {
      if (options?.allowCredits) return yield* deny("Existing-credit requests cannot use an API or managed provider route.");
      return;
    }
    let now = yield* Clock.currentTimeMillis;
    let observedProviders = yield* providers.getProviders;
    let native = observedProviders.find((provider) => provider.instanceId === id && provider.driver === entry.driver);
    // Idle hosts stop background probing. Explicit starts must read supported
    // native status once before treating an old cache or a transient probe error
    // as a sign-in failure. Refresh never logs in or admits the cached result.
    const checkCredits = entry.driver === "codex" && options?.allowCredits === true;
    const creditCheckStartedAt = now;
    // An explicit start can follow a native login or quota reset before the
    // background snapshot expires. Recheck this exact instance once, never
    // another account; a failed probe cannot clear its previous denial.
    const recheckDenied = nativeQuotaDenied(native?.usageLimits, now);
    if (!nativeSnapshotAuthorized(native, now) || checkCredits || recheckDenied) {
      const observed = yield* providers.refreshInstance(id).pipe(Effect.timeoutOption(NATIVE_STATUS_CHECK_TIMEOUT));
      if (Option.isNone(observed)) return yield* deny("The native provider status check timed out. Refresh Providers on this machine and try again.");
      observedProviders = observed.value;
      native = observedProviders.find((provider) => provider.instanceId === id && provider.driver === entry.driver);
      now = yield* Clock.currentTimeMillis;
    }
    if (!nativeSnapshotAuthorized(native, now)) {
      if (native?.status === "error" && native.auth.status !== "unauthenticated") return yield* deny("The native provider status check failed. Refresh Providers on this machine and try again.");
      // The probe never read the sign-in (timeout or spawn failure, usually a
      // busy host). Saying "sign in" here sends a signed-in user the wrong way.
      if (native?.auth.status === "unknown" && native.auth.type === CLAUDE_STATUS_CHECK_FAILED)
        return yield* deny("The native sign-in status check did not finish, often because this machine is busy. You are not signed out. Refresh Providers on this machine and try again.");
      return yield* deny("Native subscription authorization is unverified. Sign in with the official native CLI on this machine and refresh provider status.");
    }
    if (entry.driver === "codex" && !(yield* nativeRoute.verify(entry, cwd, baseEnv).pipe(
      Effect.catch((error) => deny(error.reason === "timeout"
        ? "The native Codex route check timed out for this workspace. Refresh Providers on this machine and try again."
        : "The native Codex route check failed for this workspace. Refresh Providers on this machine and try again.")),
    )))
      return yield* deny("The effective Codex route for this workspace is not verified as a native subscription. Configure custom endpoints as an explicit API instance.");
    if (checkCredits && (!/^codex:sha256:[a-f0-9]{64}$/.test(options!.expectedQuotaPoolId)
      || native?.usageLimits?.quotaPoolId !== options!.expectedQuotaPoolId))
      return yield* deny("The native account changed after this credit request. Refresh Providers and send a new request for the selected account.");
    if (checkCredits) {
      const limits = native?.usageLimits;
      const at = Date.parse(limits?.nativeAllowanceObservedAt ?? "");
      if (!limits || limits.unavailable || !Number.isFinite(at) || at < creditCheckStartedAt || at > now || now - at > 60_000
        || limits.quotaPoolObservedAt !== limits.nativeAllowanceObservedAt)
        return yield* deny("Existing credits are unavailable or their current native permission could not be verified. Refresh Providers on this machine and try again.");
    }
    const creditContinuation = () => entry.driver === "codex" && options?.allowCredits === true
      && nativeCreditContinuationAllowed(native?.usageLimits, now);
    if (checkCredits && native?.usageLimits?.ordinaryUsageAllowed !== true && !creditContinuation())
      return yield* deny("Existing credits are unavailable or their current native permission could not be verified. Refresh Providers on this machine and try again.");
    // Optional companions and deliberately unbound homes never erase a fresh
    // denial reported by this exact native account or its live notification.
    if (nativeQuotaDenied(native?.usageLimits, now) && !creditContinuation()) {
      const limits = native?.usageLimits;
      const nextReset = limits && !limits.unavailable ? blockingUsageReset(
        limits.windows.filter((window) => ["primary", "secondary"].includes(window.id))
          .map((window) => ({ usedPercent: window.usedPercent, resetsAt: window.resetsAt ? Date.parse(window.resetsAt) : null })),
        limits, now,
      ) : undefined;
      const reason = limits?.spendControlReached === true ? "spend control" : "usage limit";
      return yield* deny(`This native subscription profile has no remaining permitted usage because its ${reason} denies new work.${nextReset ? ` Next observed reset: ${DateTime.formatIso(DateTime.makeUnsafe(nextReset))}.` : ""} Select an eligible profile for a new session.`, nextReset ? { resetAt: DateTime.formatIso(DateTime.makeUnsafe(nextReset)) } : {});
    }
    if (recheckDenied && !creditContinuation()) {
      const limits = native?.usageLimits;
      const observedAt = Date.parse(limits?.nativeAllowanceObservedAt ?? "");
      if (!limits || limits.unavailable || !Number.isFinite(observedAt) || observedAt < creditCheckStartedAt
        || !freshObservation(limits.nativeAllowanceObservedAt, now)
        || (entry.driver === "codex" && limits.ordinaryUsageAllowed !== true))
        return yield* deny("Current native subscription permission could not be verified. Refresh Providers on this machine and try again.");
    }
    const binding = nativeCapacityBinding(entry, baseEnv);
    if (!binding && entry.driver === "claudeAgent") return yield* deny("Independent Claude profile isolation is unverified. Use a supported consumer sign-in on this machine; copied OAuth cannot authorize a profile.");
    if (!binding) return; // Deliberately configured Codex homes have supported per-home native account auth.
    let companionRaw: unknown;
    let snapshot = yield* client.read.pipe(Effect.tap((raw) => Effect.sync(() => { companionRaw = raw; })), Effect.flatMap((raw) => build(raw, observedProviders)), Effect.catchTags({
      SwitchRequestError: (error) => Clock.currentTimeMillis.pipe(Effect.map((at) => unavailableCapacity(at, error.category === "switch-busy" ? "switch-unavailable" : error.category))),
    }));
    if (!snapshot.available) {
      if (checkCredits && (companionRaw !== undefined || snapshot.error === "switch-invalid-response"))
        return yield* deny("The local capacity response is invalid. Refresh Hosts capacity before using existing credits.");
      if (entry.driver === "claudeAgent" && binding !== "claude-1") return yield* deny("Independent Claude profile isolation could not be verified by the local capacity service.");
      return; // Optional companion: native auth remains authoritative for deliberate defaults.
    }
    let account = snapshot.accounts.find((account) => account.id === binding);
    // A launch is explicit user intent. Refresh expired quota once using the
    // supported local service, then enforce its answer; background reads stay
    // passive, and a concurrent refresh never authorizes the expired cache.
    if (account && (account.quota.freshness === "stale" || account.status === "stale" || (account.quota.observedAt !== null && !freshObservation(account.quota.observedAt, now)))) {
      const refreshed = yield* client.refresh.pipe(
        Effect.mapError((error) => deny(error.category === "switch-busy"
          ? "Capacity refresh is already running. Try the new session again after it finishes."
          : "Fresh subscription capacity could not be verified. Refresh Hosts capacity on this machine and try again.")),
        Effect.timeoutOption("40 seconds"),
      );
      if (Option.isNone(refreshed)) return yield* deny("The subscription capacity check timed out. Refresh Hosts capacity on this machine and try again.");
      companionRaw = refreshed.value;
      snapshot = yield* build(refreshed.value, observedProviders);
      now = yield* Clock.currentTimeMillis;
      if (!nativeSnapshotAuthorized(native, now)) return yield* deny("Native provider status expired while checking capacity. Refresh Providers on this machine and try again.");
      if (!snapshot.available) return yield* deny("Fresh subscription capacity could not be verified. Refresh Hosts capacity on this machine and try again.");
      account = snapshot.accounts.find((account) => account.id === binding);
    }
    // Only override the companion's included-quota exhaustion. Its identity,
    // authentication, busy state and any newer observation still bind this start.
    const fundedSession = creditContinuation() && account?.status === "exhausted"
      && companionCreditFailureCleared(companionRaw, binding, native?.usageLimits?.nativeAllowanceObservedAt)
      && account.quota.freshness === "fresh"
      && account.quota.spendControlReached !== true
      && (account.quota.rateLimitReachedType == null || account.quota.rateLimitReachedType === "rate_limit_reached")
      && Date.parse(account.quota.observedAt ?? "") <= Date.parse(native?.usageLimits?.nativeAllowanceObservedAt ?? "");
    if (account?.status === "exhausted" && !fundedSession) {
      const nextReset = account.quota.freshness === "fresh" ? blockingUsageReset(
        [account.quota.window, account.quota.weekly, ...(account.quota.windows?.filter((window) => window.appliesToSelection) ?? [])]
          .flatMap((window) => window ? [{ usedPercent: window.usedPercent, resetsAt: window.resetsAt === null ? null : window.resetsAt * 1000 }] : []),
        account.quota, now,
      ) : undefined;
      return yield* deny(`This native subscription profile has no remaining permitted usage under its current usage limit.${nextReset ? ` Next observed reset: ${DateTime.formatIso(DateTime.makeUnsafe(nextReset))}.` : ""} Select an eligible profile for a new session.`, nextReset ? { resetAt: DateTime.formatIso(DateTime.makeUnsafe(nextReset)) } : {});
    }
    if (!account || account.authenticated !== true || account.authError || ["blocked", "auth-required", "active", "stale"].includes(account.status) || (account.status === "exhausted" && !fundedSession)
      || ((account.status === "unknown" || account.quota.freshness !== "fresh") && (account.quota.window !== null || account.quota.weekly !== null || account.quota.observedAt !== null)))
      return yield* deny("This native subscription profile is blocked, busy, exhausted or unverified. Refresh capacity and use an eligible profile for a new session.");
  });
  return Capacity.of({ current, refresh: mutate(client.refresh), policy: (input) => mutate(client.policy(input)),
    select: (input) => Effect.gen(function* () {
      if (input.id !== null) {
        const snapshot = yield* current;
        const account = snapshot.accounts.find((account) => account.id === input.id);
        if (!account || !account.providerInstanceId || account.status !== "ready") return yield* new CapacityMutationError({ category: "profile-not-eligible" });
      }
      return yield* mutate(client.select(input));
    }), assertNativeStart });
});
export const layer = Layer.effect(Capacity, make).pipe(Layer.provide(SwitchClient.layer));
