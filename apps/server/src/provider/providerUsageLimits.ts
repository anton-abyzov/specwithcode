import type {
  ProviderDriverKind,
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@specweave-studio/contracts";
import { isLiveWindow, windowModelScope } from "@specweave-studio/shared/usageWindows";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits {
  return { checkedAt: input.checkedAt, windows: sortWindows(input.windows) };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

/** Any prior quota or permission evidence prevents an empty-lookup fallback. */
export function hasNativeUsageEvidence(limits: ServerProviderUsageLimits): boolean {
  return (
    limits.windows.length > 0 ||
    [
      limits.nativeAllowanceObservedAt,
      limits.nativeDenialObservedAt,
      limits.nativeDenialRequiresFullRead,
      limits.nativeDenialResetsAt,
      limits.nativeCreditDenialObservedAt,
      limits.ordinaryUsageAllowed,
      limits.spendControlReached,
      limits.rateLimitReachedType,
      limits.credits,
      limits.resetCredits,
    ].some((value) => value !== undefined)
  );
}

/**
 * Fold a sparse runtime update into the limits a provider currently
 * publishes. Windows upsert by `id`; a window the update omits keeps its
 * previous values, and a window that arrives without `resetsAt` or
 * `windowDurationMins` keeps whatever the last probe resolved for it. An
 * update with no windows leaves `previous` untouched unless it explicitly
 * revokes main-bucket permission. Sparse updates never grant permission.
 *
 * An `unsupported` snapshot stays unsupported: an account that cannot have
 * subscription windows will not start reporting them mid-turn.
 */
export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update } = input;
  const negative = update.ordinaryUsageAllowed === false || update.spendControlReached === true;
  const creditNegative = update.nativeCreditDenied === true;
  if (
    (!negative && !creditNegative && update.windows.length === 0) ||
    (previous?.unavailable?.reason === "unsupported" &&
      !(negative && update.nativeDenialRequiresFullRead))
  ) {
    return previous;
  }
  const merged = new Map(previous?.windows.map((window) => [window.id, window] as const));
  // Codex sends this notification beside every token-usage tick, almost
  // always with unchanged numbers. Decide "nothing changed" per window on
  // the way through so the no-op case never allocates a new snapshot.
  let changed = negative || creditNegative;
  for (const window of update.windows) {
    const existing = merged.get(window.id);
    const next: ServerProviderUsageWindow = {
      ...window,
      usedPercent: clampPercent(window.usedPercent),
      ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
      ...(window.modelScope === undefined && existing?.modelScope !== undefined
        ? { modelScope: existing.modelScope }
        : {}),
    };
    if (existing === undefined || !usageWindowEquals(existing, next)) {
      merged.set(window.id, next);
      changed = true;
    }
  }
  if (!changed && previous !== undefined && previous.unavailable === undefined) {
    return previous;
  }
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows: merged.values() }),
    // A sparse event cannot repair evidence missing from a failed full probe.
    ...(previous?.unavailable?.invalidResponse ? { unavailable: previous.unavailable } : {}),
    ...(previous?.nativeAllowanceObservedAt !== undefined
      ? { nativeAllowanceObservedAt: previous.nativeAllowanceObservedAt }
      : {}),
    ...(previous?.nativeDenialObservedAt !== undefined
      ? { nativeDenialObservedAt: previous.nativeDenialObservedAt }
      : {}),
    ...(previous?.nativeDenialRequiresFullRead || (negative && update.nativeDenialRequiresFullRead)
      ? { nativeDenialRequiresFullRead: true as const }
      : {}),
    ...denialResetsAt(previous, update, negative),
    ...(previous?.nativeCreditDenialObservedAt !== undefined
      ? { nativeCreditDenialObservedAt: previous.nativeCreditDenialObservedAt }
      : {}),
    ...(previous?.ordinaryUsageAllowed !== undefined
      ? { ordinaryUsageAllowed: previous.ordinaryUsageAllowed }
      : {}),
    ...(previous?.spendControlReached !== undefined
      ? { spendControlReached: previous.spendControlReached }
      : {}),
    ...(previous?.rateLimitReachedType !== undefined
      ? { rateLimitReachedType: previous.rateLimitReachedType }
      : {}),
    ...(previous?.credits !== undefined ? { credits: previous.credits } : {}),
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
    ...(previous?.quotaPoolId !== undefined ? { quotaPoolId: previous.quotaPoolId } : {}),
    ...(previous?.quotaPoolObservedAt !== undefined
      ? { quotaPoolObservedAt: previous.quotaPoolObservedAt }
      : {}),
    ...(previous?.nativeRouteVerified !== undefined
      ? { nativeRouteVerified: previous.nativeRouteVerified }
      : {}),
    ...(previous?.nativeRouteObservedAt !== undefined
      ? { nativeRouteObservedAt: previous.nativeRouteObservedAt }
      : {}),
    ...(negative
      ? {
          nativeDenialObservedAt: input.checkedAt,
          ...(update.ordinaryUsageAllowed === false
            ? { ordinaryUsageAllowed: false as const }
            : {}),
          ...(update.spendControlReached === true ? { spendControlReached: true as const } : {}),
          ...(update.rateLimitReachedType !== undefined
            ? { rateLimitReachedType: update.rateLimitReachedType }
            : {}),
        }
      : {}),
    ...(creditNegative
      ? {
          nativeCreditDenialObservedAt: latestCreditDenial(
            previous?.nativeCreditDenialObservedAt,
            input.checkedAt,
          ),
          ...(update.rateLimitReachedType !== undefined
            ? { rateLimitReachedType: update.rateLimitReachedType }
            : {}),
        }
      : {}),
  };
}

/**
 * When the published Claude denial lapses. A new denial without a reset
 * cannot lapse; with one it keeps the later of the two, since every window
 * that rejected must reset before the account is usable again.
 */
function denialResetsAt(
  previous: ServerProviderUsageLimits | undefined,
  update: ProviderUsageLimitsUpdate,
  negative: boolean,
): { readonly nativeDenialResetsAt?: string } {
  if (!negative) {
    return previous?.nativeDenialResetsAt !== undefined
      ? { nativeDenialResetsAt: previous.nativeDenialResetsAt }
      : {};
  }
  const next = update.nativeDenialResetsAt;
  if (next === undefined || !Number.isFinite(Date.parse(next))) return {};
  const prior = previous?.nativeDenialResetsAt;
  const priorAt = prior === undefined ? NaN : Date.parse(prior);
  return {
    nativeDenialResetsAt:
      prior !== undefined && Number.isFinite(priorAt) && priorAt > Date.parse(next) ? prior : next,
  };
}

/** The account-wide windows a reading shows spent and not yet reset. */
function spentAccountWideWindows(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  now: number,
): ReadonlyArray<ServerProviderUsageWindow> {
  return windows.filter(
    (window) =>
      windowModelScope(window) === null && window.usedPercent >= 100 && isLiveWindow(window, now),
  );
}

/**
 * Whether the Claude denial has lapsed by `now`: its reported reset passed
 * and no account-wide window it carries is still spent, so a weekly the
 * rejection did not name cannot lapse with the session's reset.
 */
export function nativeDenialResetPassed(
  limits: Pick<ServerProviderUsageLimits, "nativeDenialResetsAt" | "windows"> | undefined,
  now: number,
): boolean {
  const at = Date.parse(limits?.nativeDenialResetsAt ?? "");
  return (
    Number.isFinite(at) &&
    Number.isFinite(now) &&
    at <= now &&
    spentAccountWideWindows(limits?.windows ?? [], now).length === 0
  );
}

/**
 * A valid read that keeps the denial but shows an account-wide window still
 * spent moves the lapse to that window's reset; one without a reset means
 * the denial no longer lapses on its own.
 */
function carryDenialReset(
  published: ServerProviderUsageLimits,
  probed: ServerProviderUsageLimits,
  probeAt: number,
): ServerProviderUsageLimits {
  if (published.nativeDenialResetsAt === undefined) return published;
  const spent = spentAccountWideWindows(probed.windows, probeAt);
  if (spent.length === 0) return published;
  let latest: string | undefined = published.nativeDenialResetsAt;
  for (const window of spent) {
    const at = Date.parse(window.resetsAt ?? "");
    if (!Number.isFinite(at)) {
      latest = undefined;
      break;
    }
    if (at > Date.parse(latest ?? "")) latest = window.resetsAt;
  }
  if (latest === published.nativeDenialResetsAt) return published;
  const { nativeDenialResetsAt: _lapsed, ...rest } = published;
  return {
    ...rest,
    windows: probed.windows,
    ...(latest !== undefined ? { nativeDenialResetsAt: latest } : {}),
  };
}

/** Delayed negative notifications cannot roll back an existing withdrawal fence. */
function latestCreditDenial(previous: string | undefined, observedAt: string): string {
  if (previous === undefined) return observedAt;
  const previousAt = Date.parse(previous);
  const nextAt = Date.parse(observedAt);
  if (!Number.isFinite(previousAt)) return previous;
  return Number.isFinite(nextAt) && previousAt > nextAt ? previous : observedAt;
}

function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins &&
    a.modelScope === b.modelScope
  );
}

/**
 * Choose what to publish after a status probe finishes. A probe that failed
 * this time must not wipe bars a previous probe or a turn already
 * established, so the last good snapshot stays. Claude's unsupported lookup
 * retains prior evidence; other providers retain their replacement semantics.
 *
 * A main denial received during a probe remains authoritative until a
 * supported complete read started and observed strictly after that denial.
 * Ties and unorderable timestamps cannot restore permission. Retain the
 * published snapshot rather than stamping older probe windows as current.
 */
export function resolveUsageLimitsAfterProbe(input: {
  readonly driver?: ProviderDriverKind;
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  const invalidEvidence = probed?.unavailable?.invalidResponse
    ? probed.unavailable
    : published?.unavailable?.invalidResponse
      ? published.unavailable
      : undefined;
  if (input.driver === "claudeAgent" && published) {
    if (
      published.unavailable?.reason === "unsupported" &&
      !hasNativeUsageEvidence(published) &&
      (probed === undefined || probed.unavailable?.reason === "probeFailed")
    ) {
      // A failed follow-up cannot reuse a successful empty lookup to admit a
      // manual retry. Keep failures explicit until another successful read.
      return { ...published, unavailable: invalidEvidence ?? { reason: "probeFailed" } };
    }
    if (probed === undefined) return published;
    if (probed.unavailable?.reason === "probeFailed" && published.unavailable)
      return { ...published, unavailable: invalidEvidence ?? published.unavailable };
  }
  if (
    input.driver === "claudeAgent" &&
    probed?.unavailable?.reason === "unsupported" &&
    published
  ) {
    // A lookup without quota data cannot erase Claude's last observed windows,
    // malformed response, or denial. Keep that history until a valid full read;
    // checkedAt records this lookup, not a new native allowance observation.
    return {
      ...published,
      checkedAt: probed.checkedAt,
      unavailable: invalidEvidence ?? probed.unavailable,
    };
  }
  if (probed === undefined && invalidEvidence) return published;
  if (
    probed?.unavailable?.reason === "probeFailed" &&
    published &&
    (!published.unavailable || invalidEvidence)
  ) {
    if (probed.nativeRouteVerified !== undefined || invalidEvidence)
      return {
        ...published,
        ...(invalidEvidence ? { unavailable: invalidEvidence } : {}),
        ...(probed.nativeRouteVerified !== undefined
          ? { nativeRouteVerified: probed.nativeRouteVerified }
          : {}),
        ...(probed.nativeRouteObservedAt !== undefined
          ? { nativeRouteObservedAt: probed.nativeRouteObservedAt }
          : {}),
      };
    return published;
  }
  const denialObservations = [
    published?.nativeCreditDenialObservedAt,
    published?.ordinaryUsageAllowed === false || published?.spendControlReached === true
      ? published?.nativeDenialObservedAt
      : undefined,
  ].filter((value): value is string => value !== undefined);
  if (
    published &&
    denialObservations.length > 0 &&
    (probed?.unavailable?.reason !== "unsupported" || published.nativeDenialRequiresFullRead)
  ) {
    const probeAt = probed ? Date.parse(probed.checkedAt) : NaN;
    const fullAt = probed?.nativeAllowanceObservedAt
      ? Date.parse(probed.nativeAllowanceObservedAt)
      : NaN;
    const laterValidRead =
      probed !== undefined &&
      probed.unavailable === undefined &&
      Number.isFinite(probeAt) &&
      denialObservations.every((observedAt) => {
        const denialAt = Date.parse(observedAt);
        return Number.isFinite(denialAt) && probeAt > denialAt;
      });
    const fullRead =
      Number.isFinite(fullAt) &&
      denialObservations.every((observedAt) => fullAt > Date.parse(observedAt));
    // Once the denial's reported reset has passed, a valid later read with
    // room in every account-wide window replaces it even when it is not a
    // complete allowance; failed or unsupported reads still keep it.
    const resetPassed =
      laterValidRead &&
      published.nativeCreditDenialObservedAt === undefined &&
      nativeDenialResetPassed(published, probeAt) &&
      spentAccountWideWindows(probed.windows, probeAt).length === 0;
    // A model weekly spent in both readings is what a scoped rejection fenced,
    // so a read that still shows it spent cannot clear that rejection.
    const stillSpent =
      probed?.windows.some(
        (window) =>
          window.usedPercent >= 100 &&
          isLiveWindow(window, probeAt) &&
          published.windows.some(
            (prior) =>
              prior.id === window.id && prior.usedPercent >= 100 && isLiveWindow(prior, probeAt),
          ),
      ) ?? false;
    if (!laterValidRead || !(fullRead || resetPassed) || stillSpent) {
      const kept = laterValidRead ? carryDenialReset(published, probed, probeAt) : published;
      // An explicit denied route remains a fence even on an older probe.
      if (probed?.nativeRouteVerified === false)
        return {
          ...kept,
          nativeRouteVerified: false,
          ...(probed.nativeRouteObservedAt !== undefined
            ? { nativeRouteObservedAt: probed.nativeRouteObservedAt }
            : {}),
        };
      return kept;
    }
  }
  return probed;
}
