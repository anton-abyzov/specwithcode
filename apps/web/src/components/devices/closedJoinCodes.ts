/**
 * Which machines' join code card the owner closed on this device, kept across
 * code changes, reloads, reconnects and restarts. A waiting device keeps asking
 * in the background and its code changes every 30 minutes at most; a card
 * closed per code came back each time. Closing is remembered per machine and
 * per this device's own ID, never with the code, which is not stored anywhere.
 *
 * The card comes back by itself only when something real changed: this device
 * has a new key (a new ID, so the machine sees a new device), the machine let
 * this device in and it has to ask again later, or the owner starts a join or
 * presses Connect for that machine. "Show code" always brings it back.
 * Display only: the request, its expiry and the typed code are untouched.
 */
import { makeLaterStore } from "./laterStore";
import { loadOwnDeviceShortId } from "./ownDeviceId";

export const CLOSED_JOIN_CODES_STORAGE_KEY = "specwithcode:join-code-closed";

const appStorage = () => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};
let store = makeLaterStore(appStorage, Date.now, CLOSED_JOIN_CODES_STORAGE_KEY);

/** This device as closing remembers it; a new key gives a new ID. */
const deviceKey = (id: string | null) => (id === null ? "device:none" : `device:${id}`);

// This device's ID: undefined until it was read once.
let ownId: string | null | undefined;
// Closed in this session, with the device it was closed as (undefined: not read yet).
let closedNow: ReadonlyMap<string, string | undefined> = new Map();
let version = 0;
const listeners = new Set<() => void>();
const changed = () => {
  version += 1;
  for (const listener of listeners) listener();
};

export const subscribeClosedJoinCodes = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const closedJoinCodesVersion = () => version;

/**
 * Reads this device's ID again. Called while a machine waits, so a key made or
 * replaced after the window opened counts: the card then shows for the new device.
 */
export async function readOwnDeviceForJoinCodes(): Promise<void> {
  const id = await loadOwnDeviceShortId();
  const first = ownId === undefined;
  if (!first && id === ownId) return;
  ownId = id;
  if (first) {
    // Cards closed before the ID was known were closed as this device.
    const key = deviceKey(id);
    const next = new Map(closedNow);
    for (const [machine, closedAs] of closedNow) {
      if (closedAs !== undefined) continue;
      next.set(machine, key);
      store.add(machine, [key]);
    }
    closedNow = next;
  }
  changed();
}

/** Whether the owner closed the card for this machine as the device this is now. */
export function joinCodeClosed(machine: string): boolean {
  if (closedNow.has(machine)) {
    const closedAs = closedNow.get(machine);
    if (closedAs === undefined || ownId === undefined || closedAs === deviceKey(ownId)) return true;
  }
  const kept = store.keys(machine);
  // Until the ID is read, a machine closed before stays closed: no flash on start.
  return ownId === undefined ? kept.size > 0 : kept.has(deviceKey(ownId));
}

/** Close the card for these machines; the join itself stays pending. */
export function closeJoinCodes(machines: ReadonlyArray<string>) {
  if (machines.length === 0) return;
  const key = ownId === undefined ? undefined : deviceKey(ownId);
  const next = new Map(closedNow);
  for (const machine of machines) {
    next.set(machine, key);
    if (key !== undefined) store.add(machine, [key]);
  }
  closedNow = next;
  changed();
}

/**
 * Let the card show again for these machines: "Show code", a join the owner
 * starts, or a machine that let this device in (the next wait is a new ask).
 */
export function reopenJoinCodes(machines: ReadonlyArray<string>) {
  const closed = machines.filter(
    (machine) => closedNow.has(machine) || store.keys(machine).size > 0,
  );
  if (closed.length === 0) return;
  const next = new Map(closedNow);
  for (const machine of closed) {
    next.delete(machine);
    store.remove(machine);
  }
  closedNow = next;
  changed();
}

/** Test hook: a restart of the app. Storage keeps what was closed; memory does not. */
export function restartClosedJoinCodesForTest() {
  store = makeLaterStore(appStorage, Date.now, CLOSED_JOIN_CODES_STORAGE_KEY);
  ownId = undefined;
  closedNow = new Map();
  changed();
}
