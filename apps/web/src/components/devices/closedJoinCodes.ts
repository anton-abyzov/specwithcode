/**
 * Which machines' join code card the owner closed on this device, kept across
 * code changes, reloads, reconnects and restarts. A waiting device keeps asking
 * in the background and its code changes every 30 minutes at most; a card
 * closed per code came back each time. Closing is remembered per machine and
 * per this device's own ID, never with the code, which is not stored anywhere.
 *
 * The card comes back by itself only when something real changed: this device
 * has a new key (a new ID, so the machine sees a new device), or the owner
 * starts a join or presses Connect for that machine. "Show code" always brings
 * it back, and a card closed 30 days ago may show once more. Being connected
 * is no sign of a change: a machine can connect over another route while its
 * Connect route still waits, so a connection never forgets a closed card.
 * Display only: the request, its expiry and the typed code are untouched.
 */
import { makeLaterStore } from "./laterStore";
import { readOwnDeviceShortId } from "./ownDeviceId";

export const CLOSED_JOIN_CODES_STORAGE_KEY = "specwithcode:join-code-closed";

const appStorage = () => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};
const makeStore = () => makeLaterStore(appStorage, () => Date.now(), CLOSED_JOIN_CODES_STORAGE_KEY);
// The one record of what was closed: storage, or the store's own memory when
// storage cannot be used. Read on every ask, so the 30 days and another
// window's "Show code" count in a window that stays open.
let store = makeStore();

/** This device as closing remembers it; a new key gives a new ID. */
const deviceKey = (id: string | null) => (id === null ? "device:none" : `device:${id}`);

// This device's ID: undefined until it was read once.
let ownId: string | null | undefined;
// Closed before the ID was read; saved under it once it is known.
let closedUnread: ReadonlySet<string> = new Set();
let version = 0;
const listeners = new Set<() => void>();
const changed = () => {
  version += 1;
  for (const listener of listeners) listener();
};
/** Another window of this app closed or reopened a card. */
const onStorage = (event: StorageEvent) => {
  if (event.key === null || event.key === CLOSED_JOIN_CODES_STORAGE_KEY) changed();
};

export const subscribeClosedJoinCodes = (listener: () => void) => {
  if (listeners.size === 0 && typeof window !== "undefined")
    window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined")
      window.removeEventListener("storage", onStorage);
  };
};
export const closedJoinCodesVersion = () => version;

/**
 * Reads this device's ID again. Called while a machine waits, so a key made or
 * replaced after the window opened counts: the card then shows for the new
 * device. A read that fails changes nothing: only a key that was read and is
 * another one makes this a new device.
 */
export async function readOwnDeviceForJoinCodes(): Promise<void> {
  const read = await readOwnDeviceShortId();
  if (!read.ok) return;
  const first = ownId === undefined;
  if (!first && read.id === ownId) return;
  ownId = read.id;
  if (closedUnread.size > 0) {
    // Cards closed before the ID was known were closed as this device.
    const key = deviceKey(read.id);
    for (const machine of closedUnread) store.add(machine, [key]);
    closedUnread = new Set();
  }
  changed();
}

/** Whether the owner closed the card for this machine as the device this is now. */
export function joinCodeClosed(machine: string): boolean {
  if (closedUnread.has(machine)) return true;
  const kept = store.keys(machine);
  // Until the ID is read, a machine closed before stays closed: no flash on start.
  return ownId === undefined ? kept.size > 0 : kept.has(deviceKey(ownId));
}

/** Close the card for these machines; the join itself stays pending. */
export function closeJoinCodes(machines: ReadonlyArray<string>) {
  if (machines.length === 0) return;
  if (ownId === undefined) closedUnread = new Set([...closedUnread, ...machines]);
  else for (const machine of machines) store.add(machine, [deviceKey(ownId)]);
  changed();
}

/**
 * Let the card show again for these machines: "Show code", or a join or
 * Connect press the owner starts.
 */
export function reopenJoinCodes(machines: ReadonlyArray<string>) {
  const closed = machines.filter(
    (machine) => closedUnread.has(machine) || store.keys(machine).size > 0,
  );
  if (closed.length === 0) return;
  closedUnread = new Set([...closedUnread].filter((machine) => !closed.includes(machine)));
  for (const machine of closed) store.remove(machine);
  changed();
}

/** Test hook: a restart of the app. Storage keeps what was closed; memory does not. */
export function restartClosedJoinCodesForTest() {
  store = makeStore();
  ownId = undefined;
  closedUnread = new Set();
  changed();
}
