import type { EnvironmentId, ServerProviderResetCredits, ProviderInstanceId } from "@specweave-studio/contracts";
import { limitAccountKey, providersWithLimits, type LimitPresentations } from "@specweave-studio/shared/usageLimits";

const WARNING_MS = 48 * 60 * 60_000;

export function expiringFullResets(credits: ServerProviderResetCredits, now: number) {
  if (credits.availableCount <= 0) return [];
  const seen = new Set<string>();
  return (credits.fullResetExpiries ?? []).filter(({ id, expiresAt }) => {
    const left = Date.parse(expiresAt) - now;
    if (!(left > 0 && left <= WARNING_MS) || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).toSorted((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
}

export function resetExpiryMessage(count: number, first: string) {
  const at = new Date(first);
  const date = at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return count === 1
    ? `1 full reset expires ${date} at ${time}. Use it or lose it.`
    : `${count} full resets expire within 48 hours. The first expires ${date} at ${time}.`;
}

export function resetExpiryWarnings(presentations: LimitPresentations, now: number) {
  const latest = new Map<string, {
    environmentId: EnvironmentId;
    instanceId: ProviderInstanceId;
    credits: ServerProviderResetCredits;
    checkedAt: string;
    label: string;
  }>();
  for (const [environmentId, host] of presentations) {
    if (host.connection && host.connection.phase !== "connected") continue;
    for (const provider of providersWithLimits(host.serverConfig?.providers ?? [])) {
      const limits = provider.usageLimits;
      if (provider.driver !== "codex" || !limits?.resetCredits || limits.unavailable) continue;
      const key = limitAccountKey(provider.driver, provider.auth.email, limits) ?? JSON.stringify([environmentId, provider.instanceId]);
      const previous = latest.get(key);
      if (previous && (previous.checkedAt > limits.checkedAt ||
        (previous.checkedAt === limits.checkedAt && previous.environmentId <= environmentId))) continue;
      latest.set(key, { environmentId, instanceId: provider.instanceId, credits: limits.resetCredits, checkedAt: limits.checkedAt,
        label: provider.auth.email ?? provider.displayName ?? host.entry.target.label });
    }
  }
  return [...latest].flatMap(([key, account]) => {
    const expiring = expiringFullResets(account.credits, now);
    const first = expiring[0];
    return first ? [{ ...account, key, expiring, message: resetExpiryMessage(expiring.length, first.expiresAt) }] : [];
  });
}

export function resetExpiryNotice(credit: { id: string; expiresAt: string }) {
  // The id identifies a single grant for its lifetime, even if its expiry is revised.
  return { key: `full-reset|${credit.id}`, periodEnd: 0, title: "A full reset expires soon", body: resetExpiryMessage(1, credit.expiresAt) };
}
