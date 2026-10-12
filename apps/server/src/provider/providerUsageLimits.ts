import type {
  ProviderDriverKind,
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@specweave-studio/contracts";

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
  return limits.windows.length > 0 || [limits.nativeAllowanceObservedAt, limits.nativeDenialObservedAt,
    limits.nativeDenialRequiresFullRead, limits.nativeCreditDenialObservedAt,
    limits.ordinaryUsageAllowed, limits.spendControlReached, limits.rateLimitReachedType,
    limits.credits, limits.resetCredits].some((value) => value !== undefined);
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
    (previous?.unavailable?.reason === "unsupported" && !(negative && update.nativeDenialRequiresFullRead))
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
      ? { nativeDenialRequiresFullRead: true as const } : {}),
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
    a.windowDurationMins === b.windowDurationMins
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
  const invalidEvidence = probed?.unavailable?.invalidResponse ? probed.unavailable
    : published?.unavailable?.invalidResponse ? published.unavailable : undefined;
  if (input.driver === "claudeAgent" && published) {
    if (published.unavailable?.reason === "unsupported" && !hasNativeUsageEvidence(published)
      && (probed === undefined || probed.unavailable?.reason === "probeFailed")) {
      // A failed follow-up cannot reuse a successful empty lookup to admit a
      // manual retry. Keep failures explicit until another successful read.
      return { ...published, unavailable: invalidEvidence ?? { reason: "probeFailed" } };
    }
    if (probed === undefined) return published;
    if (probed.unavailable?.reason === "probeFailed" && published.unavailable)
      return { ...published, unavailable: invalidEvidence ?? published.unavailable };
  }
  if (input.driver === "claudeAgent" && probed?.unavailable?.reason === "unsupported" && published) {
    // A lookup without quota data cannot erase Claude's last observed windows,
    // malformed response, or denial. Keep that history until a valid full read;
    // checkedAt records this lookup, not a new native allowance observation.
    return { ...published, checkedAt: probed.checkedAt, unavailable: invalidEvidence ?? probed.unavailable };
  }
  if (probed === undefined && invalidEvidence) return published;
  if (probed?.unavailable?.reason === "probeFailed" && published && (!published.unavailable || invalidEvidence)) {
    if (probed.nativeRouteVerified !== undefined || invalidEvidence)
      return {
        ...published,
        ...(invalidEvidence ? { unavailable: invalidEvidence } : {}),
        ...(probed.nativeRouteVerified !== undefined ? { nativeRouteVerified: probed.nativeRouteVerified } : {}),
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
  if (published && denialObservations.length > 0
    && (probed?.unavailable?.reason !== "unsupported" || published.nativeDenialRequiresFullRead)) {
    const probeAt = probed ? Date.parse(probed.checkedAt) : NaN;
    const fullAt = probed?.nativeAllowanceObservedAt
      ? Date.parse(probed.nativeAllowanceObservedAt)
      : NaN;
    const laterFullRead =
      probed !== undefined &&
      probed.unavailable === undefined &&
      Number.isFinite(probeAt) &&
      Number.isFinite(fullAt) &&
      denialObservations.every((observedAt) => {
        const denialAt = Date.parse(observedAt);
        return Number.isFinite(denialAt) && probeAt > denialAt && fullAt > denialAt;
      });
    if (!laterFullRead) {
      // An explicit denied route remains a fence even on an older probe.
      if (probed?.nativeRouteVerified === false)
        return {
          ...published,
          nativeRouteVerified: false,
          ...(probed.nativeRouteObservedAt !== undefined
            ? { nativeRouteObservedAt: probed.nativeRouteObservedAt }
            : {}),
        };
      return published;
    }
  }
  return probed;
}
