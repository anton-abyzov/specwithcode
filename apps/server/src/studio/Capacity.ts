import * as DateTime from "effect/DateTime";
import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@specweave-studio/contracts";
import { ProviderSetupError } from "@specweave-studio/contracts";
import type {
  StudioCapacityAccount,
  StudioCapacityPolicyInput,
  StudioCapacitySelectInput,
  StudioCapacitySnapshot,
} from "@specweave-studio/contracts/studio";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import { isLiveWindow, windowModelScope } from "@specweave-studio/shared/usageWindows";
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
import { nativeDenialResetPassed } from "../provider/providerUsageLimits.ts";
import * as NativeRoute from "./NativeRoute.ts";
import * as SwitchClient from "./SwitchClient.ts";
import {
  companionCreditFailureCleared,
  nativeCreditContinuationAllowed,
} from "./nativeCreditContinuation.ts";
import {
  capacitySnapshot,
  claudeApiBillingAuthorized,
  freshObservation,
  nativeCapacityBinding,
  nativeConfigForInstance,
  nativeDenialLapsed,
  nativeQuotaDenied,
  nativeSnapshotAuthorized,
  spentModelWindow,
  unavailableCapacity,
} from "./capacitySnapshot.ts";

// Native CLI status probes spawn a login shell; on a host under heavy load
// they took longer than 15 seconds and failed coordinator turns.
export const NATIVE_STATUS_CHECK_TIMEOUT = "60 seconds";
const EXHAUSTED_RECHECK_INTERVAL_MS = 60_000;
/** How old a native quota reading may be and still admit a start the service could not re-verify. */
const LAST_KNOWN_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** The windows that cap every model of a native account: Codex's, then Claude's. */
const ACCOUNT_WIDE_WINDOWS: Partial<Record<string, ReadonlyArray<string>>> = {
  codex: ["primary", "secondary"],
  claudeAgent: ["five_hour", "seven_day"],
};

/** Every exhausted window must reset; unrelated windows cannot predict recovery. */
function blockingUsageReset(
  windows: ReadonlyArray<{ readonly usedPercent: number; readonly resetsAt: number | null }>,
  limits: {
    readonly spendControlReached?: boolean | null | undefined;
    readonly rateLimitReachedType?: string | null | undefined;
  },
  now: number,
): number | undefined {
  if (
    limits.spendControlReached === true ||
    (limits.rateLimitReachedType != null && limits.rateLimitReachedType !== "rate_limit_reached")
  )
    return;
  const blocking = windows.filter((window) => window.usedPercent >= 100);
  if (blocking.length === 0) return;
  let resetAt = 0;
  for (const window of blocking) {
    if (
      window.resetsAt === null ||
      !Number.isFinite(
        DateTime.make(window.resetsAt).pipe(
          Option.map(DateTime.toEpochMillis),
          Option.getOrElse(() => Number.NaN),
        ),
      ) ||
      window.resetsAt <= now
    )
      return;
    resetAt = Math.max(resetAt, window.resetsAt);
  }
  return resetAt;
}

const CLAUDE_WINDOW_NAMES: Partial<Record<string, string>> = {
  five_hour: "5-hour limit",
  seven_day: "weekly limit",
};

interface ClaudeDenialLimit {
  readonly name: string;
  readonly resetAt: string | undefined;
}

/**
 * The Claude limit that refuses this start and when it resets. A spent model
 * weekly binds its own model; a rejection binds through its spent account-wide
 * windows, else the model weekly it rejected, else the reset it reported.
 */
function claudeDenialLimit(
  limits: ServerProviderUsageLimits,
  now: number,
  model: string | null | undefined,
): ClaudeDenialLimit {
  const scoped = spentModelWindow(limits, now, model);
  const denied = limits.ordinaryUsageAllowed === false && !nativeDenialResetPassed(limits, now);
  const accountWide = denied
    ? limits.windows.filter(
        (window) =>
          ACCOUNT_WIDE_WINDOWS.claudeAgent?.includes(window.id) &&
          window.usedPercent >= 100 &&
          isLiveWindow(window, now),
      )
    : [];
  // A rejected model weekly fences every start until gates pass the model;
  // its window resets exactly when the rejection said it would.
  const reportedAt = Date.parse(limits.nativeDenialResetsAt ?? "");
  const rejectedScoped =
    denied && accountWide.length === 0 && !scoped
      ? limits.windows.filter(
          (window) =>
            windowModelScope(window) !== null &&
            window.usedPercent >= 100 &&
            isLiveWindow(window, now) &&
            Date.parse(window.resetsAt ?? "") === reportedAt,
        )
      : [];
  const blocking = [...accountWide, ...(scoped ? [scoped] : []), ...rejectedScoped];
  const nextReset = limits.unavailable
    ? undefined
    : blockingUsageReset(
        blocking.map((window) => ({
          usedPercent: window.usedPercent,
          resetsAt: window.resetsAt ? Date.parse(window.resetsAt) : null,
        })),
        limits,
        now,
      );
  const resetMs =
    nextReset ??
    (blocking.length === 0 && Number.isFinite(reportedAt) && reportedAt > now
      ? reportedAt
      : undefined);
  // Of several spent windows the one that resets last is the one to name.
  const binding = blocking.reduce<ServerProviderUsageWindow | undefined>(
    (latest, window) =>
      !latest || Date.parse(window.resetsAt ?? "") > Date.parse(latest.resetsAt ?? "")
        ? window
        : latest,
    undefined,
  );
  const scope = binding ? windowModelScope(binding) : null;
  return {
    name: binding
      ? (CLAUDE_WINDOW_NAMES[binding.id] ?? (scope ? `weekly ${scope} limit` : binding.label))
      : "usage limit",
    resetAt: resetMs === undefined ? undefined : DateTime.formatIso(DateTime.makeUnsafe(resetMs)),
  };
}

function claudeDenialMessage(limit: ClaudeDenialLimit): string {
  return `Claude's ${limit.name} is used up${limit.resetAt ? `; it resets at ${limit.resetAt}` : ""}.`;
}

/**
 * Whether the last native quota reading left room, for a start whose refresh
 * failed or came back unverified on a busy host. Only an authenticated
 * native-app-server reading under every limit qualifies; a denial, a full
 * window that has not reset, or a blocked, busy or signed-out profile never does.
 */
function lastKnownHasRoom(account: StudioCapacityAccount | undefined, now: number): boolean {
  if (
    !account ||
    account.authenticated !== true ||
    account.authError ||
    !["ready", "stale", "unknown"].includes(account.status)
  )
    return false;
  const quota = account.quota;
  const observedAt = Date.parse(quota.observedAt ?? "");
  if (
    quota.source !== "native-app-server" ||
    quota.freshness === "unknown" ||
    !Number.isFinite(observedAt) ||
    now - observedAt > LAST_KNOWN_MAX_AGE_MS ||
    quota.ordinaryUsageAllowed === false ||
    quota.spendControlReached === true ||
    quota.rateLimitReachedType != null
  )
    return false;
  const windows = [
    quota.window,
    quota.weekly,
    ...(quota.windows?.filter((window) => window.appliesToSelection) ?? []),
  ].flatMap((window) => (window ? [window] : []));
  return (
    windows.length > 0 &&
    windows.every(
      (window) =>
        window.usedPercent < 100 || (window.resetsAt !== null && window.resetsAt * 1000 <= now),
    )
  );
}

const REFRESH_RETRY_DELAY = "2 seconds";

type CompanionRefresh =
  | { readonly kind: "read"; readonly raw: unknown }
  | { readonly kind: "busy" | "failed" | "timeout" };

const companionRequest = (
  request: Effect.Effect<unknown, SwitchClient.SwitchRequestError>,
): Effect.Effect<CompanionRefresh> =>
  request.pipe(
    Effect.map((raw): CompanionRefresh => ({ kind: "read", raw })),
    Effect.timeoutOption("40 seconds"),
    Effect.map(Option.getOrElse((): CompanionRefresh => ({ kind: "timeout" }))),
    Effect.catchTags({
      SwitchRequestError: (error) =>
        Effect.succeed<CompanionRefresh>({
          kind: error.category === "switch-busy" ? "busy" : "failed",
        }),
    }),
  );

export interface NativeCreditStartOptions {
  readonly allowCredits: true;
  readonly expectedQuotaPoolId: string;
}

export class CapacityMutationError extends Schema.TaggedError<CapacityMutationError>()(
  "CapacityMutationError",
  {
    category: Schema.Literals([
      "switch-unavailable",
      "switch-timeout",
      "switch-invalid-response",
      "switch-busy",
      "profile-not-eligible",
    ]),
  },
) {
  override get message() {
    return this.category === "profile-not-eligible"
      ? "This profile is not eligible for new work."
      : this.category === "switch-busy"
        ? "Capacity refresh is already running. Try again after it finishes."
        : "The local capacity service could not apply this change.";
  }
}

export class Capacity extends Context.Service<
  Capacity,
  {
    readonly current: Effect.Effect<StudioCapacitySnapshot>;
    readonly refresh: Effect.Effect<StudioCapacitySnapshot, CapacityMutationError>;
    readonly policy: (
      input: StudioCapacityPolicyInput,
    ) => Effect.Effect<StudioCapacitySnapshot, CapacityMutationError>;
    readonly select: (
      input: StudioCapacitySelectInput,
    ) => Effect.Effect<StudioCapacitySnapshot, CapacityMutationError>;
    /**
     * Admission check only. Never changes an existing session or chooses its
     * account. `model` lets a spent model weekly refuse only that model.
     */
    readonly assertNativeStart: (
      id: ProviderInstanceId,
      cwd: string | null,
      options?: NativeCreditStartOptions,
      model?: string | null,
    ) => Effect.Effect<void, ProviderSetupError>;
  }
>()("specweave-studio/studio/Capacity") {}

const make = Effect.gen(function* () {
  const client = yield* SwitchClient.SwitchClient;
  const settings = yield* Settings.ServerSettingsService;
  const providers = yield* Providers.ProviderRegistry;
  const baseEnv = yield* HostProcessEnvironment;
  const nativeRoute = yield* NativeRoute.NativeRoute;
  const build = (raw: unknown, observedProviders?: ReadonlyArray<ServerProvider>) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const config = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
      if (!config) return unavailableCapacity(now, "switch-unavailable");
      return capacitySnapshot({
        raw,
        settings: config,
        providers: observedProviders ?? (yield* providers.getProviders),
        baseEnv,
        now,
      });
    });
  const current = client.read.pipe(
    Effect.flatMap(build),
    Effect.catchTags({
      SwitchRequestError: (error) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) =>
            unavailableCapacity(
              now,
              error.category === "switch-busy" ? "switch-unavailable" : error.category,
            ),
          ),
        ),
    }),
  );
  const mutate = (request: Effect.Effect<unknown, SwitchClient.SwitchRequestError>) =>
    request.pipe(
      Effect.mapError((error) => new CapacityMutationError({ category: error.category })),
      Effect.flatMap(build),
      Effect.flatMap((snapshot) =>
        snapshot.available
          ? Effect.succeed(snapshot)
          : Effect.fail(
              new CapacityMutationError({ category: snapshot.error ?? "switch-invalid-response" }),
            ),
      ),
    );
  // One exhausted-verdict re-read per instance a minute, so a queue of starts
  // against a limit that really holds costs one read, not one per thread.
  const lastExhaustedRecheck = new Map<ProviderInstanceId, number>();
  const claimExhaustedRecheck = (id: ProviderInstanceId, now: number) => {
    if (now - (lastExhaustedRecheck.get(id) ?? -Infinity) < EXHAUSTED_RECHECK_INTERVAL_MS)
      return false;
    lastExhaustedRecheck.set(id, now);
    return true;
  };
  // Refresh once, and once more after a short wait when it fails or times out.
  // A refresh already running elsewhere is waited for, then its result is read.
  const refreshCompanion = Effect.gen(function* () {
    let outcome: CompanionRefresh = { kind: "failed" };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) yield* Effect.sleep(REFRESH_RETRY_DELAY);
      outcome = yield* companionRequest(client.refresh);
      if (outcome.kind === "read") return outcome;
      if (outcome.kind === "busy") {
        yield* Effect.sleep(REFRESH_RETRY_DELAY);
        return yield* companionRequest(client.read);
      }
    }
    return outcome;
  });
  const assertNativeStart = (
    id: ProviderInstanceId,
    cwd: string | null,
    options?: NativeCreditStartOptions,
    model?: string | null,
  ) =>
    Effect.gen(function* () {
      const deny = (detail: string, usageLimit?: { readonly resetAt?: string }) =>
        new ProviderSetupError({
          instanceId: id,
          operation: "session",
          detail,
          ...(usageLimit ? { usageLimit } : {}),
        });
      const config = yield* settings.getSettings.pipe(
        Effect.mapError(() => deny("Native provider settings could not be verified.")),
      );
      const entry = nativeConfigForInstance(config, id);
      if (options?.allowCredits && entry?.driver !== "codex")
        return yield* deny(
          "Existing-credit requests require the selected native Codex subscription instance.",
        );
      if (!entry || (entry.driver !== "codex" && entry.driver !== "claudeAgent")) return;
      if (
        entry.enabled === false ||
        (typeof entry.config === "object" &&
          entry.config !== null &&
          "enabled" in entry.config &&
          entry.config.enabled === false)
      )
        return yield* deny("This provider instance is disabled.");
      // Explicit API/managed instances retain their own native auth mechanism;
      // they are not subscription slots and never receive quota recommendations.
      if (
        hasExplicitProviderApiEnvironment(
          entry.environment,
          entry.driver === "codex" ? "codex" : "claudeAgent",
        ) ||
        (typeof entry.config === "object" &&
          entry.config !== null &&
          "setupMode" in entry.config &&
          entry.config.setupMode === "managed")
      ) {
        if (options?.allowCredits)
          return yield* deny(
            "Existing-credit requests cannot use an API or managed provider route.",
          );
        return;
      }
      let now = yield* Clock.currentTimeMillis;
      let observedProviders = yield* providers.getProviders;
      let native = observedProviders.find(
        (provider) => provider.instanceId === id && provider.driver === entry.driver,
      );
      // Whether this start already read the native status and the local service afresh.
      let nativeReread = false;
      let companionReread = false;
      // Idle hosts stop background probing. Explicit starts must read supported
      // native status once before treating an old cache or a transient probe error
      // as a sign-in failure. Refresh never logs in or admits the cached result.
      const checkCredits = entry.driver === "codex" && options?.allowCredits === true;
      const creditCheckStartedAt = now;
      // An explicit start can follow a native login or quota reset before the
      // background snapshot expires. Recheck this exact instance once, never
      // another account; a failed probe cannot clear its previous denial.
      const recheckDenied = nativeQuotaDenied(native?.usageLimits, now, model);
      // A Claude denial past its reported reset no longer refuses, but this
      // start still reads native status once; a read that fails admits it.
      const lapsedDenial =
        entry.driver === "claudeAgent" && nativeDenialLapsed(native?.usageLimits, now);
      // A CLI billed to API credits (Console sign-in or its own key) is not a
      // subscription slot: no plan quota or capacity profile applies to it.
      if (claudeApiBillingAuthorized(native, now)) return;
      if (!nativeSnapshotAuthorized(native, now) || checkCredits || recheckDenied || lapsedDenial) {
        const admitCached = lapsedDenial && !recheckDenied && nativeSnapshotAuthorized(native, now);
        const observed = yield* providers
          .refreshInstance(id)
          .pipe(Effect.timeoutOption(NATIVE_STATUS_CHECK_TIMEOUT));
        if (Option.isNone(observed)) {
          if (!admitCached)
            return yield* deny(
              "The native provider status check timed out. Refresh Providers on this machine and try again.",
            );
          now = yield* Clock.currentTimeMillis;
        } else {
          nativeReread = true;
          observedProviders = observed.value;
          native = observedProviders.find(
            (provider) => provider.instanceId === id && provider.driver === entry.driver,
          );
          now = yield* Clock.currentTimeMillis;
          if (claudeApiBillingAuthorized(native, now)) return;
        }
      }
      if (!nativeSnapshotAuthorized(native, now)) {
        if (native?.status === "error" && native.auth.status !== "unauthenticated")
          return yield* deny(
            "The native provider status check failed. Refresh Providers on this machine and try again.",
          );
        // The probe never read the sign-in (timeout or spawn failure, usually a
        // busy host). Saying "sign in" here sends a signed-in user the wrong way.
        if (native?.auth.status === "unknown" && native.auth.type === CLAUDE_STATUS_CHECK_FAILED)
          return yield* deny(
            "The native sign-in status check did not finish, often because this machine is busy. You are not signed out. Refresh Providers on this machine and try again.",
          );
        return yield* deny(
          "Native subscription authorization is unverified. Sign in with the official native CLI on this machine and refresh provider status.",
        );
      }
      if (
        entry.driver === "codex" &&
        !(yield* nativeRoute
          .verify(entry, cwd, baseEnv)
          .pipe(
            Effect.catch((error) =>
              deny(
                error.reason === "timeout"
                  ? "The native Codex route check timed out for this workspace. Refresh Providers on this machine and try again."
                  : "The native Codex route check failed for this workspace. Refresh Providers on this machine and try again.",
              ),
            ),
          ))
      )
        return yield* deny(
          "The effective Codex route for this workspace is not verified as a native subscription. Configure custom endpoints as an explicit API instance.",
        );
      if (
        checkCredits &&
        (!/^codex:sha256:[a-f0-9]{64}$/.test(options!.expectedQuotaPoolId) ||
          native?.usageLimits?.quotaPoolId !== options!.expectedQuotaPoolId)
      )
        return yield* deny(
          "The native account changed after this credit request. Refresh Providers and send a new request for the selected account.",
        );
      if (checkCredits) {
        const limits = native?.usageLimits;
        const at = Date.parse(limits?.nativeAllowanceObservedAt ?? "");
        if (
          !limits ||
          limits.unavailable ||
          !Number.isFinite(at) ||
          at < creditCheckStartedAt ||
          at > now ||
          now - at > 60_000 ||
          limits.quotaPoolObservedAt !== limits.nativeAllowanceObservedAt
        )
          return yield* deny(
            "Existing credits are unavailable or their current native permission could not be verified. Refresh Providers on this machine and try again.",
          );
      }
      const creditContinuation = () =>
        entry.driver === "codex" &&
        options?.allowCredits === true &&
        nativeCreditContinuationAllowed(native?.usageLimits, now);
      if (
        checkCredits &&
        native?.usageLimits?.ordinaryUsageAllowed !== true &&
        !creditContinuation()
      )
        return yield* deny(
          "Existing credits are unavailable or their current native permission could not be verified. Refresh Providers on this machine and try again.",
        );
      // Optional companions and deliberately unbound homes never erase a fresh
      // denial reported by this exact native account or its live notification.
      if (nativeQuotaDenied(native?.usageLimits, now, model) && !creditContinuation()) {
        const limits = native?.usageLimits;
        if (entry.driver === "claudeAgent" && limits) {
          const limit = claudeDenialLimit(limits, now, model);
          return yield* deny(
            claudeDenialMessage(limit),
            limit.resetAt ? { resetAt: limit.resetAt } : {},
          );
        }
        const nextReset =
          limits && !limits.unavailable
            ? blockingUsageReset(
                limits.windows
                  .filter((window) => ACCOUNT_WIDE_WINDOWS[entry.driver]?.includes(window.id))
                  .map((window) => ({
                    usedPercent: window.usedPercent,
                    resetsAt: window.resetsAt ? Date.parse(window.resetsAt) : null,
                  })),
                limits,
                now,
              )
            : undefined;
        const reason = limits?.spendControlReached === true ? "spend control" : "usage limit";
        return yield* deny(
          `This native subscription profile has no remaining permitted usage because its ${reason} denies new work.${nextReset ? ` Next observed reset: ${DateTime.formatIso(DateTime.makeUnsafe(nextReset))}.` : ""} Select an eligible profile for a new session.`,
          nextReset ? { resetAt: DateTime.formatIso(DateTime.makeUnsafe(nextReset)) } : {},
        );
      }
      if (recheckDenied && !creditContinuation()) {
        const limits = native?.usageLimits;
        const observedAt = Date.parse(limits?.nativeAllowanceObservedAt ?? "");
        if (
          !limits ||
          limits.unavailable ||
          !Number.isFinite(observedAt) ||
          observedAt < creditCheckStartedAt ||
          !freshObservation(limits.nativeAllowanceObservedAt, now) ||
          (entry.driver === "codex" && limits.ordinaryUsageAllowed !== true)
        )
          return yield* deny(
            "Current native subscription permission could not be verified. Refresh Providers on this machine and try again.",
          );
      }
      const binding = nativeCapacityBinding(entry, baseEnv);
      if (!binding && entry.driver === "claudeAgent")
        return yield* deny(
          "Independent Claude profile isolation is unverified. Use a supported consumer sign-in on this machine; copied OAuth cannot authorize a profile.",
        );
      if (!binding) return; // Deliberately configured Codex homes have supported per-home native account auth.
      let companionRaw: unknown;
      let snapshot = yield* client.read.pipe(
        Effect.tap((raw) =>
          Effect.sync(() => {
            companionRaw = raw;
          }),
        ),
        Effect.flatMap((raw) => build(raw, observedProviders)),
        Effect.catchTags({
          SwitchRequestError: (error) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((at) =>
                unavailableCapacity(
                  at,
                  error.category === "switch-busy" ? "switch-unavailable" : error.category,
                ),
              ),
            ),
        }),
      );
      if (!snapshot.available) {
        if (
          checkCredits &&
          (companionRaw !== undefined || snapshot.error === "switch-invalid-response")
        )
          return yield* deny(
            "The local capacity response is invalid. Refresh Hosts capacity before using existing credits.",
          );
        if (entry.driver === "claudeAgent" && binding !== "claude-1")
          return yield* deny(
            "Independent Claude profile isolation could not be verified by the local capacity service.",
          );
        return; // Optional companion: native auth remains authoritative for deliberate defaults.
      }
      let account = snapshot.accounts.find((account) => account.id === binding);
      // A launch, scheduled or not, refreshes expired quota through the local
      // service and enforces a verified answer. A refresh that fails, times out
      // or comes back unverified (a loaded host) falls back to the last native
      // reading when it left room; a full or denied reading still refuses.
      if (
        account &&
        (account.quota.freshness === "stale" ||
          account.status === "stale" ||
          (account.quota.observedAt !== null && !freshObservation(account.quota.observedAt, now)))
      ) {
        const lastKnown = account;
        const refreshed = yield* refreshCompanion;
        now = yield* Clock.currentTimeMillis;
        if (!nativeSnapshotAuthorized(native, now))
          return yield* deny(
            "Native provider status expired while checking capacity. Refresh Providers on this machine and try again.",
          );
        if (refreshed.kind !== "read") {
          if (lastKnownHasRoom(lastKnown, now)) return;
          return yield* deny(
            refreshed.kind === "timeout"
              ? "The subscription capacity check timed out. Refresh Hosts capacity on this machine and try again."
              : "Fresh subscription capacity could not be verified. Refresh Hosts capacity on this machine and try again.",
          );
        }
        companionRaw = refreshed.raw;
        companionReread = true;
        snapshot = yield* build(companionRaw, observedProviders);
        if (!snapshot.available) {
          if (lastKnownHasRoom(lastKnown, now)) return;
          return yield* deny(
            "Fresh subscription capacity could not be verified. Refresh Hosts capacity on this machine and try again.",
          );
        }
        account = snapshot.accounts.find((account) => account.id === binding);
      }
      // An exhausted verdict is a cached read. A native sign-in to another
      // account, or a reset that came early, shows only in a new one, so an
      // explicit start re-reads the native status and the local service once
      // before refusing. A read that fails leaves the cached verdict in force.
      if (
        account?.status === "exhausted" &&
        !creditContinuation() &&
        !(nativeReread && companionReread) &&
        claimExhaustedRecheck(id, now)
      ) {
        if (!nativeReread) {
          const reread = yield* providers
            .refreshInstance(id)
            .pipe(Effect.timeoutOption(NATIVE_STATUS_CHECK_TIMEOUT));
          if (Option.isSome(reread)) {
            observedProviders = reread.value;
            native = observedProviders.find(
              (provider) => provider.instanceId === id && provider.driver === entry.driver,
            );
          }
        }
        if (!companionReread) {
          const refreshedRaw = yield* client.refresh.pipe(
            Effect.timeoutOption("40 seconds"),
            Effect.orElseSucceed(() => Option.none<unknown>()),
          );
          if (Option.isSome(refreshedRaw)) companionRaw = refreshedRaw.value;
        }
        now = yield* Clock.currentTimeMillis;
        if (!nativeSnapshotAuthorized(native, now))
          return yield* deny(
            "Native provider status expired while checking capacity. Refresh Providers on this machine and try again.",
          );
        const rebuilt = yield* build(companionRaw, observedProviders);
        if (rebuilt.available) {
          snapshot = rebuilt;
          account = snapshot.accounts.find((account) => account.id === binding);
        }
      }
      // Only override the companion's included-quota exhaustion. Its identity,
      // authentication, busy state and any newer observation still bind this start.
      const fundedSession =
        creditContinuation() &&
        account?.status === "exhausted" &&
        companionCreditFailureCleared(
          companionRaw,
          binding,
          native?.usageLimits?.nativeAllowanceObservedAt,
        ) &&
        account.quota.freshness === "fresh" &&
        account.quota.spendControlReached !== true &&
        (account.quota.rateLimitReachedType == null ||
          account.quota.rateLimitReachedType === "rate_limit_reached") &&
        Date.parse(account.quota.observedAt ?? "") <=
          Date.parse(native?.usageLimits?.nativeAllowanceObservedAt ?? "");
      if (account?.status === "exhausted" && !fundedSession) {
        const nextReset =
          account.quota.freshness === "fresh"
            ? blockingUsageReset(
                [
                  account.quota.window,
                  account.quota.weekly,
                  ...(account.quota.windows?.filter((window) => window.appliesToSelection) ?? []),
                ].flatMap((window) =>
                  window
                    ? [
                        {
                          usedPercent: window.usedPercent,
                          resetsAt: window.resetsAt === null ? null : window.resetsAt * 1000,
                        },
                      ]
                    : [],
                ),
                account.quota,
                now,
              )
            : undefined;
        return yield* deny(
          `This native subscription profile has no remaining permitted usage under its current usage limit.${nextReset ? ` Next observed reset: ${DateTime.formatIso(DateTime.makeUnsafe(nextReset))}.` : ""} Select an eligible profile for a new session.`,
          nextReset ? { resetAt: DateTime.formatIso(DateTime.makeUnsafe(nextReset)) } : {},
        );
      }
      // Same fallback when the refresh answered but could not re-verify quota.
      if (
        account &&
        (account.status === "stale" ||
          account.status === "unknown" ||
          account.quota.freshness !== "fresh") &&
        lastKnownHasRoom(account, now)
      )
        return;
      if (
        !account ||
        account.authenticated !== true ||
        account.authError ||
        ["blocked", "auth-required", "active", "stale"].includes(account.status) ||
        (account.status === "exhausted" && !fundedSession) ||
        ((account.status === "unknown" || account.quota.freshness !== "fresh") &&
          (account.quota.window !== null ||
            account.quota.weekly !== null ||
            account.quota.observedAt !== null))
      )
        return yield* deny(
          "This native subscription profile is blocked, busy, exhausted or unverified. Refresh capacity and use an eligible profile for a new session.",
        );
    });
  return Capacity.of({
    current,
    refresh: mutate(client.refresh),
    policy: (input) => mutate(client.policy(input)),
    select: (input) =>
      Effect.gen(function* () {
        if (input.id !== null) {
          const snapshot = yield* current;
          const account = snapshot.accounts.find((account) => account.id === input.id);
          if (!account || !account.providerInstanceId || account.status !== "ready")
            return yield* new CapacityMutationError({ category: "profile-not-eligible" });
        }
        return yield* mutate(client.select(input));
      }),
    assertNativeStart,
  });
});
export const layer = Layer.effect(Capacity, make).pipe(Layer.provide(SwitchClient.layer));
