/**
 * What this window last knew about its SpecWithCode Connect sign-in (1417,
 * AC-16): whose it was and when Clerk ends it. It decides whether a sign-out
 * keeps the machines reached through Connect. A sign-in that ran out, or one
 * the person is renewing, keeps them, so the window can say "Needs sign-in"
 * instead of forgetting them. Every other sign-out removes them, as before:
 * a person signing out, a session revoked elsewhere, or a window with no
 * record. Local storage, because a sign-in through another site reloads the
 * window, and an expiry often lands while the app is closed.
 */
export const CONNECT_SESSION_RECORD_KEY = "specwithcode.connect.session-record";

/** Clerk may end a session a little before `expireAt` by this window's clock. */
export const CONNECT_SESSION_EXPIRY_SKEW_MS = 60_000;

export interface ConnectSessionRecord {
  readonly accountId: string;
  /** When Clerk ends the session, in epoch milliseconds. */
  readonly expireAt: number;
  /** Set when the person chose Sign in again now; the sign-out that follows keeps the machines. */
  readonly renewStartedAt?: number;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readConnectSessionRecord(): ConnectSessionRecord | null {
  try {
    const raw = storage()?.getItem(CONNECT_SESSION_RECORD_KEY) ?? null;
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { accountId, expireAt, renewStartedAt } = value as Record<string, unknown>;
    if (typeof accountId !== "string" || accountId.length === 0) return null;
    if (typeof expireAt !== "number" || !Number.isFinite(expireAt)) return null;
    return {
      accountId,
      expireAt,
      ...(typeof renewStartedAt === "number" && Number.isFinite(renewStartedAt)
        ? { renewStartedAt }
        : {}),
    };
  } catch {
    return null;
  }
}

export function writeConnectSessionRecord(record: ConnectSessionRecord): void {
  try {
    storage()?.setItem(CONNECT_SESSION_RECORD_KEY, JSON.stringify(record));
  } catch {
    // Without storage the window keeps today's behaviour: a sign-out removes the machines.
  }
}

export function clearConnectSessionRecord(): void {
  try {
    storage()?.removeItem(CONNECT_SESSION_RECORD_KEY);
  } catch {
    // Nothing to remove.
  }
}

/** Notes that the person is renewing this account's sign-in, just before the sign-out. */
export function markConnectRenewStarted(accountId: string, now = Date.now()): void {
  const record = readConnectSessionRecord();
  if (record === null || record.accountId !== accountId) return;
  writeConnectSessionRecord({ ...record, renewStartedAt: now });
}

/** Undoes {@link markConnectRenewStarted} when the renew's sign-out failed. */
export function clearConnectRenewStarted(accountId: string): void {
  const record = readConnectSessionRecord();
  if (record === null || record.accountId !== accountId || record.renewStartedAt === undefined)
    return;
  writeConnectSessionRecord({ accountId: record.accountId, expireAt: record.expireAt });
}

/**
 * Whether a settled sign-out keeps the machines reached through Connect: only
 * when the record says the sign-in ran out or the person is renewing it.
 */
export function keepsConnectMachinesAtSignOut(
  record: ConnectSessionRecord | null,
  now = Date.now(),
): boolean {
  if (record === null) return false;
  if (record.renewStartedAt !== undefined) return true;
  return now >= record.expireAt - CONNECT_SESSION_EXPIRY_SKEW_MS;
}

/**
 * Whether machines kept for another account must go before `accountId`'s
 * session starts. A record left by a sign-out that kept them names that account.
 */
export function keptConnectMachinesBelongToAnother(
  record: ConnectSessionRecord | null,
  accountId: string,
): boolean {
  return record !== null && record.accountId !== accountId;
}
