import type {
  ConnectDevice,
  ConnectDeviceRequest,
  ConnectDevicesApproveResult,
  ConnectDevicesSnapshot,
} from "@specweave-studio/contracts/connectDevices";

import { isReservedDeviceName } from "@specweave-studio/shared/reservedDeviceNames";

import { englishPhrase, type TranslatePhrase } from "../i18n";

export type { ConnectDevice, ConnectDeviceRequest, ConnectDevicesSnapshot };

/** True when a typed code has six of the characters codes are made of. */
export function isCompleteApprovalCode(code: string): boolean {
  return /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(code.replace(/[\s-]/g, "").toUpperCase());
}

/** Labels every client of one kind shares, as older machines sent them: they name no device. */
const SHARED_LABELS: ReadonlySet<string> = new Set([
  "SpecWithCode Connect connect",
  "SpecWithCode Connect device",
  "SpecWithCode Desktop",
  "SpecWithCode Web",
  "SpecWithCode Mobile",
  "Phone",
]);

/** Words the list uses for the owner and the update; never a device's own name. */
type DeviceFacts = Pick<ConnectDevice, "label" | "kind" | "deviceType" | "named" | "system">;

/** The English stand-in for a device that gave no name; each window translates it. */
export function standInDeviceName(device: Pick<DeviceFacts, "kind" | "deviceType" | "system">) {
  const deviceType = device.deviceType ?? (device.kind === "phone" ? "mobile" : undefined);
  const os = device.system;
  if (deviceType === "mobile")
    return os === "iOS" ? "An iPhone" : os === "Android" ? "An Android phone" : "A phone";
  if (deviceType === "tablet")
    return os === "iOS" ? "An iPad" : os === "Android" ? "An Android tablet" : "A tablet";
  switch (os) {
    case "macOS":
      return "A Mac";
    case "Windows":
      return "A Windows PC";
    case "Linux":
      return "A Linux computer";
    default:
      return "A computer";
  }
}

/**
 * The name the device gave itself, or a translated stand-in ("A Mac"). Never
 * the label every Connect window used to share (1327). A hint for the owner:
 * the typed code is what approves.
 */
export function connectDeviceName(device: DeviceFacts, tx: TranslatePhrase = englishPhrase) {
  const label = device.label.trim();
  const own =
    device.named !== false &&
    label.length > 0 &&
    !SHARED_LABELS.has(label) &&
    !isReservedDeviceName(label);
  return own ? label : tx(standInDeviceName(device));
}

/** "ID 7K3Q", or nothing for a machine that sends no short ID yet (1406). */
export function connectDeviceIdLabel(
  device: { readonly shortId?: string | undefined },
  tx: TranslatePhrase = englishPhrase,
) {
  const id = device.shortId?.trim();
  return id ? tx("ID {id}", { id }) : "";
}

/**
 * "iPhone · ID 7K3Q": the name with the four characters that tell two devices
 * of one name apart. The device shows the same ID. Both are hints for the
 * owner; the typed code is what approves.
 */
export function connectDeviceTitle(
  device: DeviceFacts & { readonly shortId?: string | undefined },
  tx: TranslatePhrase = englishPhrase,
) {
  const name = connectDeviceName(device, tx);
  const id = connectDeviceIdLabel(device, tx);
  return id ? `${name} · ${id}` : name;
}

/**
 * What Later remembers a hidden request by: the device, not the request, so the
 * same device asking again after its request ran out stays hidden. Never the
 * short ID, which another device can share: that one would stay hidden too.
 * An older machine sends no device reference, so its requests are remembered
 * one by one. Later only hides the pop-up; the device stays listed in Settings.
 */
export const laterKey = (request: Pick<ConnectDeviceRequest, "id" | "device">) =>
  request.device ? `device:${request.device}` : request.id;

/**
 * The pop-up's waiting list: every request while at least one of them was not
 * put off with Later, else none. A new device brings the hidden ones back with it.
 */
export function requestsToPrompt(
  pending: ReadonlyArray<ConnectDeviceRequest>,
  later: ReadonlySet<string>,
): ReadonlyArray<ConnectDeviceRequest> {
  return pending.some((request) => !later.has(laterKey(request))) ? pending : [];
}

/** "macOS · SpecWithCode 1.0.338 · First seen November 17, 2026": what tells devices apart. */
export function connectDeviceDetails(
  device: Partial<Pick<ConnectDevice, "system" | "app" | "firstSeenAt">> & {
    readonly askedAt?: string;
  },
  tx: TranslatePhrase = englishPhrase,
  locale?: string,
) {
  const parts: Array<string> = [];
  if (device.system) parts.push(device.system);
  if (device.app) parts.push(device.app);
  if (device.firstSeenAt)
    parts.push(tx("First seen {date}", { date: longDate(device.firstSeenAt, locale) }));
  else if (device.askedAt)
    parts.push(
      tx("Asked at {time}", {
        time: new Date(device.askedAt).toLocaleTimeString(locale, {
          hour: "numeric",
          minute: "2-digit",
        }),
      }),
    );
  return parts.join(" · ");
}

/** "November 17, 2026" in the window's language. */
export function longDate(iso: string, locale?: string) {
  return new Date(iso).toLocaleDateString(locale, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** Who approved a device, as the machine recorded it, in the window's language. */
export function approverName(approvedBy: string, tx: TranslatePhrase = englishPhrase) {
  if (approvedBy === "this machine") return tx("this machine");
  if (approvedBy === "the update") return tx("the update");
  return SHARED_LABELS.has(approvedBy) ? tx("another device") : approvedBy;
}

export function approveOutcomeMessage(
  result: ConnectDevicesApproveResult,
  machine: string,
  tx: TranslatePhrase = englishPhrase,
) {
  switch (result.status) {
    case "approved":
      return null;
    case "not-found":
      return tx(
        "No device is waiting with that code. Check the code shown on the device that asked for {machine}.",
        { machine },
      );
    case "self":
      return tx(
        "A device cannot approve itself. Type this code on another device or on the machine.",
      );
    case "paused":
      return tx("Too many wrong codes. Type the code on {machine} itself, or wait 10 minutes.", {
        machine,
      });
  }
}

/** "New device approved on m4 by Anton's MacBook", from the notice's parts when it has them. */
export function noticeMessage(notice: ConnectDevicesNotice, tx: TranslatePhrase = englishPhrase) {
  if (notice.machine === undefined || notice.approvedBy === undefined) return notice.message;
  return tx("New device approved on {machine} by {approver}", {
    machine: notice.machine,
    approver: approverName(notice.approvedBy, tx),
  });
}

export type ConnectDevicesNotice = ConnectDevicesSnapshot["notices"][number];

/**
 * The device gate's refusals come from the machine in English (1327). Said
 * again here in this window's language; any other text passes through.
 */
const DEVICE_REFUSALS: ReadonlyArray<
  readonly [RegExp, (match: RegExpExecArray, tx: TranslatePhrase) => string]
> = [
  [
    /^Open SpecWithCode on (.+) and type this code: ([A-Z0-9]+)$/,
    (m, tx) =>
      `${tx("Open SpecWithCode on {machine} and type this code:", { machine: m[1]! })} ${m[2]}`,
  ],
  [
    /^(.+) no longer lets this device in\. Approve it again in SpecWithCode on (.+)\.$/,
    (m, tx) =>
      tx(
        "{machine} no longer lets this device in. Approve it again in SpecWithCode on {machine}.",
        {
          machine: m[1]!,
        },
      ),
  ],
  [
    /^The device list on (.+) is damaged\. Open SpecWithCode on (.+) to repair it\.$/,
    (m, tx) =>
      tx("The device list on {machine} is damaged. Open SpecWithCode on {machine} to repair it.", {
        machine: m[1]!,
      }),
  ],
  [
    /^Sign in to SpecWithCode Connect again on this device to ask (.+) for approval\.$/,
    (m, tx) =>
      tx("Sign in to SpecWithCode Connect again on this device to ask {machine} for approval.", {
        machine: m[1]!,
      }),
  ],
  [
    /^This machine cannot check new devices yet\. Open SpecWithCode on it and update\.$/,
    (_m, tx) =>
      tx("This machine cannot check new devices yet. Open SpecWithCode on it and update."),
  ],
  [/^Approve this device on the machine\.$/, (_m, tx) => tx("Approve this device on the machine.")],
  [
    /^(.+) turned this device away\. Ask again tomorrow, or approve it in SpecWithCode on (.+)\.$/,
    (m, tx) =>
      tx(
        "{machine} turned this device away. Ask again tomorrow, or approve it in SpecWithCode on {machine}.",
        { machine: m[1]! },
      ),
  ],
  [
    /^Too many devices are waiting for approval on (.+)\. Try again in a few minutes\.$/,
    (m, tx) =>
      tx("Too many devices are waiting for approval on {machine}. Try again in a few minutes.", {
        machine: m[1]!,
      }),
  ],
];

export function translateDeviceRefusal(message: string, tx: TranslatePhrase): string {
  for (const [pattern, say] of DEVICE_REFUSALS) {
    const match = pattern.exec(message);
    if (match) return say(match, tx);
  }
  return message;
}

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
