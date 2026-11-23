import type {
  EnvironmentId,
  ServerProviderResetCredits,
  ProviderInstanceId,
} from "@specweave-studio/contracts";
import {
  collectLimitAccounts,
  limitAccountKey,
  providersWithLimits,
  type LimitPresentations,
} from "@specweave-studio/shared/usageLimits";

const WARNING_MS = 48 * 60 * 60_000;

export function expiringFullResets(credits: ServerProviderResetCredits, now: number) {
  if (credits.availableCount <= 0) return [];
  const seen = new Set<string>();
  return (credits.fullResetExpiries ?? [])
    .filter(({ id, expiresAt }) => {
      const left = Date.parse(expiresAt) - now;
      if (!(left > 0 && left <= WARNING_MS) || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .toSorted((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
}

export function resetExpiryMessage(count: number, first: string) {
  const at = new Date(first);
  const date = at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return count === 1
    ? `1 full reset expires ${date} at ${time}. Use it or lose it.`
    : `${count} full resets expire within 48 hours. The first expires ${date} at ${time}.`;
}

export function resetExpiryAccounts(presentations: LimitPresentations, now: number) {
  const latest = new Map<
    string,
    {
      environmentId: EnvironmentId;
      instanceId: ProviderInstanceId;
      credits: ServerProviderResetCredits;
      checkedAt: number;
      label: string;
    }
  >();
  for (const [environmentId, host] of presentations) {
    if (host.connection && host.connection.phase !== "connected") continue;
    for (const provider of providersWithLimits(host.serverConfig?.providers ?? [])) {
      const limits = provider.usageLimits;
      if (provider.driver !== "codex" || !limits?.resetCredits || limits.unavailable) continue;
      const key =
        limitAccountKey(provider.driver, provider.auth.email, limits) ??
        JSON.stringify([environmentId, provider.instanceId]);
      const checkedAt = Date.parse(limits.checkedAt);
      const previous = latest.get(key);
      if (
        previous &&
        (previous.checkedAt > checkedAt ||
          (previous.checkedAt === checkedAt && previous.environmentId <= environmentId))
      )
        continue;
      latest.set(key, {
        environmentId,
        instanceId: provider.instanceId,
        credits: limits.resetCredits,
        checkedAt,
        label: provider.auth.email ?? provider.displayName ?? host.entry.target.label,
      });
    }
  }
  const connected = new Map(
    [...presentations].filter(
      ([, host]) => !host.connection || host.connection.phase === "connected",
    ),
  );
  const merged = new Map(
    collectLimitAccounts(connected).map((account) => [
      limitAccountKey(account.driver, account.email, account.limits),
      account,
    ]),
  );
  return [...latest].map(([key, account]) => {
    const pooled = merged.get(key);
    const credits =
      pooled?.limits.resetCredits?.availableCount === 0 &&
      Date.parse(pooled.limits.checkedAt) >= account.checkedAt
        ? pooled.limits.resetCredits
        : account.credits;
    const expiring = expiringFullResets(credits, now);
    const first = expiring[0];
    const target = pooled?.redeem;
    const redeem =
      target && "sourceId" in target.input && first
        ? { environmentId: target.environmentId, input: { ...target.input, creditId: first.id } }
        : { environmentId: account.environmentId, input: { instanceId: account.instanceId } };
    return {
      key,
      credits,
      expiring,
      redeem,
      label: account.label,
      message: first ? resetExpiryMessage(expiring.length, first.expiresAt) : null,
    };
  });
}

export function resetExpiryNotice(credit: { id: string; expiresAt: string }) {
  // The id identifies a single grant for its lifetime, even if its expiry is revised.
  return {
    key: `full-reset|${credit.id}`,
    periodEnd: 0,
    title: "A full reset expires soon",
    body: resetExpiryMessage(1, credit.expiresAt),
  };
}

/** The original 24-hour alert still handles hosts that only send the aggregate. */
export function replacesBankedNotice(
  alert: { kind: string; accountKey: string; periodEnd: number },
  warnings: ReadonlyArray<{ key: string; expiring: ReadonlyArray<{ expiresAt: string }> }>,
) {
  return (
    alert.kind === "bankedReset" &&
    warnings.some(
      (warning) =>
        warning.key === alert.accountKey &&
        warning.expiring.some((credit) => Date.parse(credit.expiresAt) === alert.periodEnd),
    )
  );
}
