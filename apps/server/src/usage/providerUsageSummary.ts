// @effect-diagnostics nodeBuiltinImport:off -- Hash a non-secret account identity for the fleet.
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import type { OrchestratorMcpProviderUsage, ServerProvider } from "@specweave-studio/contracts";
import {
  providerUsedPercent,
  usageDeniesTurn,
  usageResetAt,
} from "@specweave-studio/shared/providerFallback";

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const FINGERPRINT_SALT = "specwithcode-account-pool:v1:";

/**
 * The account pool key this provider's usage is billed to, or null when the
 * provider names no account. Only identities, never credentials: the
 * signed-in email first, then the provider's own hashed account id. Two
 * machines with the same key share one allowance.
 */
export function accountPoolKey(provider: ServerProvider): string | null {
  const email = provider.auth.email?.trim().toLowerCase();
  if (email) return `${provider.driver}:${email}`;
  const pool = provider.usageLimits?.quotaPoolId;
  return pool ? `${provider.driver}:pool:${pool}` : null;
}

export const accountFingerprint = (key: string) =>
  `sha256:${NodeCrypto.createHash("sha256").update(`${FINGERPRINT_SALT}${key}`).digest("hex")}`;

/**
 * `STUDIO_SIMULATE_PROVIDER_USAGE` lists `instanceId=percent@account`
 * entries (comma separated) whose usage this machine reports instead of the
 * real reading, for two-server tests. `percent` may be `?` for unknown usage
 * and `@account` may be left out for an unknown account.
 */
export function simulatedProviderUsage(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlyMap<string, { readonly usedPercent: number | null; readonly account: string | null }> {
  const entries = new Map<string, { usedPercent: number | null; account: string | null }>();
  for (const entry of (env.STUDIO_SIMULATE_PROVIDER_USAGE ?? "").split(",")) {
    const match = /^\s*([^=\s]+)=(\?|\d{1,3})(?:@([^,\s]+))?\s*$/.exec(entry);
    if (!match) continue;
    const used = match[2] === "?" ? null : Math.min(100, Number(match[2]));
    entries.set(match[1]!, { usedPercent: used, account: match[3] ?? null });
  }
  return entries;
}

/**
 * What this machine shares about one provider's usage: the fullest live
 * window, when it resets, sign-in state, when it was read, and the account
 * fingerprint. Nothing that could sign in anywhere.
 */
export function providerUsageSummary(
  provider: ServerProvider,
  nowMs: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): OrchestratorMcpProviderUsage {
  const now = isoAt(nowMs);
  const simulated = simulatedProviderUsage(env).get(provider.instanceId);
  if (simulated)
    return {
      accountFingerprint:
        simulated.account === null
          ? null
          : accountFingerprint(`${provider.driver}:sim:${simulated.account}`),
      usedPercent: simulated.usedPercent,
      resetsAt: isoAt(nowMs + 5 * 60 * 60_000),
      signedIn: true,
      observedAt: now,
      ...(simulated.usedPercent !== null && simulated.usedPercent >= 100 ? { limited: true } : {}),
    };
  const key = accountPoolKey(provider);
  const limits = provider.usageLimits;
  const read = limits && !limits.unavailable;
  const usedPercent = read ? providerUsedPercent(provider, nowMs) : null;
  const resetAt = usedPercent === null ? null : usageResetAt(provider, usedPercent, nowMs);
  const observed = read ? Date.parse(limits.nativeAllowanceObservedAt ?? limits.checkedAt) : NaN;
  return {
    accountFingerprint: key === null ? null : accountFingerprint(key),
    usedPercent:
      usedPercent === null || !Number.isFinite(usedPercent)
        ? null
        : Math.max(0, Math.min(100, usedPercent)),
    resetsAt: resetAt === null ? null : isoAt(resetAt),
    // "unknown" is a provider that cannot say (ACP agents); its turns still run.
    signedIn: provider.auth.status !== "unauthenticated",
    observedAt: Number.isFinite(observed) ? isoAt(observed) : null,
    ...(usageDeniesTurn(provider) ? { limited: true } : {}),
  };
}

const SIMULATED_WINDOW_MS = 5 * 60 * 60_000;

/**
 * The providers with the usage `STUDIO_SIMULATE_PROVIDER_USAGE` names, so
 * the limit sweep's threshold sees it as a real reading would: one session
 * window at that share, resetting at a fixed time (between 5 and 10 hours
 * off, the same all through a 5-hour block, so a usage window keeps one key).
 * Unknown (`?`) entries and providers it doesn't list are returned as they
 * are; without the variable this is the identity.
 */
export function withSimulatedUsage(
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlyArray<ServerProvider> {
  const simulated = simulatedProviderUsage(env);
  if (simulated.size === 0) return providers;
  const now = isoAt(nowMs);
  const resetsAt = isoAt(
    Math.floor(nowMs / SIMULATED_WINDOW_MS) * SIMULATED_WINDOW_MS + 2 * SIMULATED_WINDOW_MS,
  );
  return providers.map((provider): ServerProvider => {
    const usedPercent = simulated.get(provider.instanceId)?.usedPercent ?? null;
    if (usedPercent === null) return provider;
    return {
      ...provider,
      usageLimits: {
        checkedAt: now,
        nativeAllowanceObservedAt: now,
        windows: [{ id: "simulated", kind: "session", label: "Simulated", usedPercent, resetsAt }],
      },
    };
  });
}
