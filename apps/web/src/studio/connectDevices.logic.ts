import type {
  ConnectDevice,
  ConnectDeviceRequest,
  ConnectDevicesApproveResult,
  ConnectDevicesSnapshot,
} from "@specweave-studio/contracts/connectDevices";

export type { ConnectDevice, ConnectDeviceRequest, ConnectDevicesSnapshot };

/** True when a typed code has six of the characters codes are made of. */
export function isCompleteApprovalCode(code: string): boolean {
  return /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(code.replace(/[\s-]/g, "").toUpperCase());
}

/** "Anton's iPhone (phone)": the name the device gave, and what it is. */
export function describeConnectDevice(
  device: Pick<ConnectDevice, "label" | "kind" | "deviceType">,
) {
  const what =
    device.deviceType === "mobile"
      ? "phone"
      : device.deviceType === "tablet"
        ? "tablet"
        : device.kind === "phone"
          ? "phone"
          : "computer";
  return `${device.label} (${what})`;
}

export function approveOutcomeMessage(result: ConnectDevicesApproveResult, machine: string) {
  switch (result.status) {
    case "approved":
      return null;
    case "not-found":
      return `No device is waiting with that code. Check the code shown on the device that asked for ${machine}.`;
    case "self":
      return "A device cannot approve itself. Type this code on another device or on the machine.";
    case "paused":
      return `Too many wrong codes. Type the code on ${machine} itself, or wait 10 minutes.`;
  }
}

export type ConnectDevicesNotice = ConnectDevicesSnapshot["notices"][number];

/**
 * The notices this device has not shown yet, each once, and the seen ids to keep.
 * The machine already leaves out approvals this device made or was let in by.
 */
export function takeUnseenNotices(
  seen: ReadonlyArray<string>,
  notices: ReadonlyArray<ConnectDevicesNotice>,
  keep = 100,
): { readonly fresh: ReadonlyArray<ConnectDevicesNotice>; readonly seen: ReadonlyArray<string> } {
  const known = new Set(seen);
  const fresh: Array<ConnectDevicesNotice> = [];
  for (const notice of notices) {
    if (known.has(notice.id)) continue;
    known.add(notice.id);
    fresh.push(notice);
  }
  if (fresh.length === 0) return { fresh, seen };
  return { fresh, seen: [...seen, ...fresh.map((notice) => notice.id)].slice(-keep) };
}

/** Where seen notice ids are kept between reloads; localStorage in the app. */
export interface SeenNoticeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const SEEN_NOTICES_KEY = "specwithcode:connect-device-notices-seen";

/**
 * Remembers which notices this device has shown, per machine. Storage keeps
 * them across reloads; an in-memory copy keeps them when storage cannot be
 * read or saved (private mode, quota), so a notice still shows once a session
 * instead of on every poll.
 */
export function makeSeenNotices(storage: () => SeenNoticeStorage | null) {
  const memory = new Map<string, ReadonlyArray<string>>();
  const read = (): Record<string, ReadonlyArray<string>> => {
    try {
      const value: unknown = JSON.parse(storage()?.getItem(SEEN_NOTICES_KEY) ?? "{}");
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, ReadonlyArray<string>>)
        : {};
    } catch {
      return {};
    }
  };
  return (
    environmentId: string,
    notices: ReadonlyArray<ConnectDevicesNotice>,
  ): ReadonlyArray<ConnectDevicesNotice> => {
    if (notices.length === 0) return [];
    const all = read();
    const stored = Array.isArray(all[environmentId]) ? all[environmentId] : [];
    const before = [...new Set([...(memory.get(environmentId) ?? []), ...stored])];
    const { fresh, seen } = takeUnseenNotices(before, notices);
    if (fresh.length === 0) return fresh;
    memory.set(environmentId, seen);
    try {
      storage()?.setItem(SEEN_NOTICES_KEY, JSON.stringify({ ...all, [environmentId]: seen }));
    } catch {
      // Kept in memory: shown again after a reload at most, never on every poll.
    }
    return fresh;
  };
}
