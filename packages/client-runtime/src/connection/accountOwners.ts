/**
 * Which SpecWithCode Connect account was signed in when this client saved each
 * machine (1434, D-01). When the client's account changes, the machines saved
 * under the previous account leave with it: their routes, saved credentials and
 * cached projects and chats on this client. Nothing on the machines themselves
 * changes, and no project folder is touched.
 *
 * The registry applies the plan under each machine's lease, so a save and a
 * removal for one machine never interleave.
 */

/** Saved while no Connect account was signed in. Such a machine stays on a switch. */
export const SAVED_SIGNED_OUT = "";
/** Saved before this client recorded owners. Counted as the previous account's. */
export const SAVED_BY_UNKNOWN = "?";

export interface AccountOwners {
  /** The last account whose machines this client settled; a sign-out does not clear it. */
  readonly lastAccount: string | null;
  /** Environment id to the account that saved it, or one of the two markers. */
  readonly machines: Readonly<Record<string, string>>;
  /**
   * Saves written down before the catalog write and cleared after it. One left
   * here means the app stopped in between; the next plan settles it.
   */
  readonly saving?: Readonly<Record<string, PendingOwnerSave>>;
}

export interface PendingOwnerSave {
  /** The owner the save records once it is in the catalog. */
  readonly owner: string;
  /**
   * A fingerprint of the exact routes the save writes. Finding them in the
   * catalog after a stop means the save landed.
   */
  readonly fingerprint: string;
}

export interface AccountOwnersInput {
  /** What storage holds now; null before this client ever recorded owners. */
  readonly stored: AccountOwners | null;
  /** The settled Connect account, or null when signed out. */
  readonly account: string | null;
  /** Machines this client saved (never platform-managed ones). */
  readonly savedMachines: ReadonlyArray<string>;
  /**
   * Machines whose removal failed for this account in this session. They keep
   * their owner and are not tried again until the next start or account change.
   */
  readonly pending?: ReadonlySet<string>;
}

export interface AccountOwnersPlan {
  /** Saved machines to forget on this client. */
  readonly drop: ReadonlyArray<string>;
  /** Owners to store now; dropped machines keep theirs until they are gone. */
  readonly next: AccountOwners;
}

function isAccount(owner: string | undefined): owner is string {
  return owner !== undefined && owner !== SAVED_SIGNED_OUT && owner !== SAVED_BY_UNKNOWN;
}

/**
 * Which saved machines leave, and who owns the rest. A switch is any signed-in
 * account other than the last one: every machine not saved by the new account
 * or while signed out leaves, including ones saved before owners were
 * recorded. Without a switch, only machines another account saved leave. A
 * sign-out drops nothing; only the Connect routes go, as before.
 *
 * While any removal is owed, the previous account stays recorded, so a restart
 * finishes the switch.
 */
export function planAccountOwners(input: AccountOwnersInput): AccountOwnersPlan {
  const { account, savedMachines } = input;
  const firstRecord = input.stored === null;
  const stored = input.stored ?? { lastAccount: null, machines: {} };
  const pending = input.pending ?? new Set<string>();
  const switched =
    account !== null && stored.lastAccount !== null && stored.lastAccount !== account;

  const drop: Array<string> = [];
  const machines: Record<string, string> = {};
  let owed = false;
  for (const id of savedMachines) {
    // Machines already saved when owners are first recorded have no known owner.
    const owner = stored.machines[id] ?? (firstRecord ? SAVED_BY_UNKNOWN : undefined);
    if (account !== null && owner !== undefined) {
      const leaves = switched
        ? owner !== account && owner !== SAVED_SIGNED_OUT
        : isAccount(owner) && owner !== account;
      if (leaves) {
        machines[id] = owner;
        owed = true;
        if (!pending.has(id)) drop.push(id);
        continue;
      }
    }
    // Saved since the last look: it belongs to whoever is signed in now.
    machines[id] = owner ?? account ?? SAVED_SIGNED_OUT;
  }
  return {
    drop,
    next: {
      lastAccount: owed ? stored.lastAccount : (account ?? stored.lastAccount),
      machines,
      ...(stored.saving === undefined ? {} : { saving: stored.saving }),
    },
  };
}

/** Notes a save before it is written to the catalog. */
export function beginPendingSave(
  stored: AccountOwners,
  environmentId: string,
  pending: PendingOwnerSave,
): AccountOwners {
  return { ...stored, saving: { ...stored.saving, [environmentId]: pending } };
}

/** The save is in the catalog: its owner is recorded. */
export function finishPendingSave(stored: AccountOwners, environmentId: string): AccountOwners {
  const pending = stored.saving?.[environmentId];
  const next = cancelPendingSave(stored, environmentId);
  if (pending === undefined) return next;
  return { ...next, machines: { ...next.machines, [environmentId]: pending.owner } };
}

/** The save failed or was undone: the machine keeps the owner it had. */
export function cancelPendingSave(stored: AccountOwners, environmentId: string): AccountOwners {
  if (stored.saving?.[environmentId] === undefined) return stored;
  const { [environmentId]: _cancelled, ...rest } = stored.saving;
  const { saving: _saving, ...withoutSaving } = stored;
  return Object.keys(rest).length === 0 ? withoutSaving : { ...withoutSaving, saving: rest };
}

/**
 * Settles saves the app stopped in the middle of. A save counts when the
 * catalog holds exactly the routes it wrote; otherwise it never landed and the
 * machine keeps the owner it had. A save identical to what was already saved
 * counts too: it carried nothing new, and a save that takes a machine from
 * another account clears that account's cached data before writing.
 */
export function settlePendingSaves(
  stored: AccountOwners,
  savedFingerprints: ReadonlyMap<string, string>,
): AccountOwners {
  let next = stored;
  for (const [environmentId, pending] of Object.entries(stored.saving ?? {})) {
    next =
      savedFingerprints.get(environmentId) === pending.fingerprint
        ? finishPendingSave(next, environmentId)
        : cancelPendingSave(next, environmentId);
  }
  return next;
}

/**
 * Whether a save by `owner` takes the machine from another account, whose
 * cached projects, chats and drafts must go before the save is written.
 */
export function saveTakesMachineFrom(prior: string | undefined, owner: string): boolean {
  return prior !== undefined && prior !== SAVED_SIGNED_OUT && prior !== owner;
}

/** The owner a save records for a machine that has none yet. */
export function ownerForNewSave(account: string | null | undefined): string | undefined {
  if (account === undefined) return undefined;
  return account ?? SAVED_SIGNED_OUT;
}

/** Whether two records differ. */
export function accountOwnersChanged(stored: AccountOwners | null, next: AccountOwners): boolean {
  if (stored === null || stored.lastAccount !== next.lastAccount) return true;
  if (JSON.stringify(stored.saving ?? {}) !== JSON.stringify(next.saving ?? {})) return true;
  const before = Object.entries(stored.machines);
  const after = Object.entries(next.machines);
  return (
    before.length !== after.length || after.some(([id, owner]) => stored.machines[id] !== owner)
  );
}
