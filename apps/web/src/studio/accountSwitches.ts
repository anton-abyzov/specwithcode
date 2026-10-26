/**
 * Which account a provider instance is signed in to, as far as this client can
 * tell from the snapshots it holds, and when it saw that account change.
 *
 * Mirrors the server's rule in `apps/server/src/provider/subscriptionIdentity.ts`:
 * keys are compared only with keys and emails only with emails, and a value
 * missing on either side is no proof of a switch. A failed status probe drops
 * the email but keeps the published limits and their key; that is the same
 * account, not another one.
 *
 * @module studio/accountSwitches
 */
import type { ProviderInstanceId, ServerProvider } from "@specweave-studio/contracts";

const CODEX_POOL = /^codex:sha256:[a-f0-9]{64}$/;

/** A signed-in identity: the subscription key and the email, either may be unknown. */
export interface AccountIdentity {
  readonly key?: string | undefined;
  readonly email?: string | undefined;
}

/**
 * Who a snapshot says is signed in, or undefined when it does not say: not
 * authenticated (a failed or unfinished probe included), billed to an API
 * key, or neither a key nor an email.
 */
export function accountIdentityOf(snapshot: ServerProvider): AccountIdentity | undefined {
  const auth = snapshot.auth;
  if (auth.status !== "authenticated") return undefined;
  if (auth.apiKeyBilling === true || auth.type === "apiKey") return undefined;
  const limits = snapshot.usageLimits;
  const pool = limits?.quotaPoolId;
  const key = limits?.subscriptionKey || (pool && CODEX_POOL.test(pool) ? pool : undefined);
  const email = auth.email?.trim().toLowerCase() || undefined;
  if (!key && !email) return undefined;
  return { ...(key ? { key } : {}), ...(email ? { email } : {}) };
}

/**
 * Whether two known identities are different accounts. Keys decide when both
 * are known; otherwise emails do. Nothing known in common is no proof.
 */
export function identitiesDiffer(a: AccountIdentity, b: AccountIdentity): boolean {
  if (a.key && b.key) return a.key !== b.key;
  return a.email !== undefined && b.email !== undefined && a.email !== b.email;
}

/** The identity to remember after a read, keeping what the read left out for the same person. */
function mergeIdentity(previous: AccountIdentity, probed: AccountIdentity): AccountIdentity {
  const key = probed.key ?? previous.key;
  const email = probed.email ?? previous.email;
  return { ...(key ? { key } : {}), ...(email ? { email } : {}) };
}

/** What the client remembers about one instance between snapshots. */
export interface SeenAccount {
  readonly identity: AccountIdentity;
  /** The newest usage read held for that identity, in ms. */
  readonly readAt: number;
}

export interface AccountSwitchEntry {
  readonly instanceId: ProviderInstanceId;
  readonly snapshot: ServerProvider;
}

/** The time of a snapshot's usage read in ms, 0 when it has none. */
export function usageReadMs(snapshot: ServerProvider): number {
  const limits = snapshot.usageLimits;
  const at = Date.parse(limits?.nativeAllowanceObservedAt ?? limits?.checkedAt ?? "");
  return Number.isFinite(at) ? at : 0;
}

/**
 * Folds one batch of snapshots into what the client has seen. `seen` is
 * updated in place. Returns the new switch map when an instance changed
 * account (each switched instance maps to the last read it held before the
 * change), or null when nothing switched.
 */
export function foldAccountSwitches(
  seen: Map<ProviderInstanceId, SeenAccount>,
  switched: ReadonlyMap<ProviderInstanceId, number>,
  entries: ReadonlyArray<AccountSwitchEntry>,
): Map<ProviderInstanceId, number> | null {
  let next: Map<ProviderInstanceId, number> | null = null;
  for (const entry of entries) {
    const previous = seen.get(entry.instanceId);
    const readAt = usageReadMs(entry.snapshot);
    const identity = accountIdentityOf(entry.snapshot);
    if (identity === undefined) {
      // The probe named nobody; limits it kept are the last known account's.
      if (previous !== undefined && readAt > previous.readAt) {
        seen.set(entry.instanceId, { ...previous, readAt });
      }
      continue;
    }
    if (previous === undefined) {
      seen.set(entry.instanceId, { identity, readAt });
      continue;
    }
    if (!identitiesDiffer(previous.identity, identity)) {
      seen.set(entry.instanceId, {
        identity: mergeIdentity(previous.identity, identity),
        readAt: Math.max(previous.readAt, readAt),
      });
      continue;
    }
    seen.set(entry.instanceId, { identity, readAt });
    next ??= new Map(switched);
    next.set(entry.instanceId, previous.readAt);
  }
  return next;
}

/** One map per machine: the same instance id on two machines is two separate histories. */
export type MachineAccountSwitches = ReadonlyMap<string, ReadonlyMap<ProviderInstanceId, number>>;

/**
 * `foldAccountSwitches` scoped to one machine. A picker that follows threads
 * across machines sees `claudeAgent` on M4 and on M1, which can be signed in
 * to different accounts; that is two accounts, not a switch. Returns the new
 * per-machine map when this machine's instance changed account, else null.
 */
export function foldMachineAccountSwitches(
  seen: Map<string, Map<ProviderInstanceId, SeenAccount>>,
  switched: MachineAccountSwitches,
  machine: string,
  entries: ReadonlyArray<AccountSwitchEntry>,
): Map<string, ReadonlyMap<ProviderInstanceId, number>> | null {
  let machineSeen = seen.get(machine);
  if (machineSeen === undefined) {
    machineSeen = new Map();
    seen.set(machine, machineSeen);
  }
  const next = foldAccountSwitches(machineSeen, switched.get(machine) ?? new Map(), entries);
  return next === null ? null : new Map(switched).set(machine, next);
}

/**
 * The plan an auth label names (`Claude Max`), or null when the label is not
 * a plan: a status message from a failed or unverified probe, an API key or a
 * cloud backend.
 */
export function planLabel(auth: ServerProvider["auth"]): string | null {
  if (auth.status !== "authenticated") return null;
  const label = auth.label?.trim();
  if (!label || !/\sSubscription$/i.test(label)) return null;
  return label.replace(/\s+Subscription$/i, "").trim() || null;
}
