import type { AccountOwners, PendingOwnerSave } from "@specweave-studio/client-runtime/connection";

/**
 * Where this window keeps which SpecWithCode Connect account saved each machine
 * (1434, D-01). The registry plans and applies the owners
 * (`planAccountOwners`); this is only its storage, beside the Connect session
 * record, so a restart or a crash mid-cleanup still finds the previous account
 * and finishes the job.
 */
export const CONNECT_MACHINE_OWNERS_KEY = "specwithcode.connect.machine-owners.v1";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readConnectMachineOwners(store: Storage | null = storage()): AccountOwners | null {
  try {
    const raw = store?.getItem(CONNECT_MACHINE_OWNERS_KEY) ?? null;
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { lastAccount, machines, saving } = value as Record<string, unknown>;
    if (lastAccount !== null && (typeof lastAccount !== "string" || lastAccount.length === 0)) {
      return null;
    }
    if (typeof machines !== "object" || machines === null) return null;
    const owners: Record<string, string> = {};
    for (const [id, owner] of Object.entries(machines)) {
      if (typeof owner === "string") owners[id] = owner;
    }
    const pending: Record<string, PendingOwnerSave> = {};
    if (typeof saving === "object" && saving !== null) {
      for (const [id, entry] of Object.entries(saving)) {
        const { owner, fingerprint, takes } = (entry ?? {}) as Record<string, unknown>;
        if (typeof owner === "string" && typeof fingerprint === "string") {
          pending[id] = { owner, fingerprint, ...(takes === true ? { takes } : {}) };
        }
      }
    }
    return {
      lastAccount,
      machines: owners,
      ...(Object.keys(pending).length > 0 ? { saving: pending } : {}),
    };
  } catch {
    return null;
  }
}

/** Returns false when the record could not be stored (no storage, or it is full). */
export function writeConnectMachineOwners(
  owners: AccountOwners,
  store: Storage | null = storage(),
): boolean {
  if (store === null) return false;
  try {
    store.setItem(CONNECT_MACHINE_OWNERS_KEY, JSON.stringify(owners));
    return true;
  } catch {
    return false;
  }
}
