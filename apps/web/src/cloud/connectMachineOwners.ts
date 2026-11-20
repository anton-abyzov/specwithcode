/**
 * Which SpecWithCode Connect account was signed in when this window saved each
 * machine (1363, D-01). When the window's account changes, the machines saved
 * under the previous account leave with it: their routes, saved credentials and
 * cached projects and chats on this window. Project folders on any machine are
 * never touched; only this window's saved connection and its cache go.
 *
 * Kept in local storage beside the Connect session record, so a restart, a
 * reload after a sign-in through another site, or a crash mid-cleanup still
 * finds the previous account and finishes the job.
 */
export const CONNECT_MACHINE_OWNERS_KEY = "specwithcode.connect.machine-owners.v1";

/** Saved while no Connect account was signed in. Such a machine stays on a switch. */
export const SAVED_SIGNED_OUT = "";
/** Saved before this window recorded owners. Counted as the previous account's. */
export const SAVED_BY_UNKNOWN = "?";

export interface ConnectMachineOwners {
  /** The last account signed in to this window; a sign-out does not clear it. */
  readonly lastAccount: string | null;
  /** Environment id to the account that saved it, or one of the two markers. */
  readonly machines: Readonly<Record<string, string>>;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readConnectMachineOwners(
  store: Storage | null = storage(),
): ConnectMachineOwners | null {
  try {
    const raw = store?.getItem(CONNECT_MACHINE_OWNERS_KEY) ?? null;
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { lastAccount, machines } = value as Record<string, unknown>;
    if (lastAccount !== null && (typeof lastAccount !== "string" || lastAccount.length === 0)) {
      return null;
    }
    if (typeof machines !== "object" || machines === null) return null;
    const owners: Record<string, string> = {};
    for (const [id, owner] of Object.entries(machines)) {
      if (typeof owner === "string") owners[id] = owner;
    }
    return { lastAccount, machines: owners };
  } catch {
    return null;
  }
}

export function writeConnectMachineOwners(
  owners: ConnectMachineOwners,
  store: Storage | null = storage(),
): void {
  try {
    store?.setItem(CONNECT_MACHINE_OWNERS_KEY, JSON.stringify(owners));
  } catch {
    // Without storage every machine reads as saved by an unknown account next time.
  }
}

export interface OwnerSyncInput {
  /** What storage holds now; null before this window ever recorded owners. */
  readonly stored: ConnectMachineOwners | null;
  /** The settled Connect account, or null when signed out. */
  readonly account: string | null;
  /** Machines this window saved (never its own local machine). */
  readonly savedMachines: ReadonlyArray<string>;
  /** Machines the signed-in account lists on Connect; only used to adopt unknown ones. */
  readonly accountMachines: ReadonlySet<string>;
}

export interface OwnerSyncPlan {
  /** Saved machines to forget on this window before the account settles in. */
  readonly drop: ReadonlyArray<string>;
  /** Owners to store once every drop succeeded. */
  readonly next: ConnectMachineOwners;
}

function isAccount(owner: string | undefined): owner is string {
  return owner !== undefined && owner !== SAVED_SIGNED_OUT && owner !== SAVED_BY_UNKNOWN;
}

/**
 * The pure step: which saved machines leave, and who owns the rest. A switch is
 * any signed-in account other than the last one. On a switch every machine not
 * saved by the new account or while signed out leaves, including ones saved
 * before owners were recorded. Without a switch, only machines another account
 * saved leave. A sign-out drops nothing: it keeps today's rule, where only the
 * Connect routes go.
 */
export function planConnectMachineOwners(input: OwnerSyncInput): OwnerSyncPlan {
  const { account, savedMachines, accountMachines } = input;
  const firstRecord = input.stored === null;
  const stored = input.stored ?? { lastAccount: null, machines: {} };
  const switched =
    account !== null && stored.lastAccount !== null && stored.lastAccount !== account;

  const drop: Array<string> = [];
  const machines: Record<string, string> = {};
  for (const id of savedMachines) {
    // Machines already saved when owners are first recorded have no known owner.
    const owner = stored.machines[id] ?? (firstRecord ? SAVED_BY_UNKNOWN : undefined);
    if (account !== null) {
      const leaves = switched
        ? owner !== undefined && owner !== account && owner !== SAVED_SIGNED_OUT
        : isAccount(owner) && owner !== account;
      if (leaves) {
        drop.push(id);
        continue;
      }
    }
    if (owner === undefined) {
      // Saved since the last look: it belongs to whoever is signed in now.
      machines[id] = account ?? SAVED_SIGNED_OUT;
    } else if (owner === SAVED_BY_UNKNOWN && account !== null && accountMachines.has(id)) {
      // An unknown machine that is on the signed-in account is that account's.
      machines[id] = account;
    } else {
      machines[id] = owner;
    }
  }
  return {
    drop,
    next: { lastAccount: account ?? stored.lastAccount, machines },
  };
}

/** Whether a plan changes anything worth writing. */
export function connectMachineOwnersChanged(
  stored: ConnectMachineOwners | null,
  next: ConnectMachineOwners,
): boolean {
  if (stored === null || stored.lastAccount !== next.lastAccount) return true;
  const before = Object.entries(stored.machines);
  const after = Object.entries(next.machines);
  return (
    before.length !== after.length || after.some(([id, owner]) => stored.machines[id] !== owner)
  );
}
