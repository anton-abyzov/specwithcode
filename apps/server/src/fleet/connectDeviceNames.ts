/**
 * How a device asking to use this machine is named (1327). Each Connect
 * session used to carry the pairing link's fixed label, so every computer
 * read "SpecWithCode Connect connect" and the owner could not tell a known
 * window from a stranger. The name is the device's own word: a hint for the
 * owner, never what approves (the typed code does).
 */

import { isReservedDeviceName } from "@specweave-studio/shared/reservedDeviceNames";

/** Labels every client of one kind shares: they name no device. */
const SHARED_LABELS: ReadonlySet<string> = new Set([
  "SpecWithCode Connect connect",
  "SpecWithCode Connect device",
  "SpecWithCode Desktop",
  "SpecWithCode Web",
  "SpecWithCode Mobile",
  "Phone",
]);

/**
 * Words the device list uses for the owner and the update. A device may not
 * take them as its name, or its approvals would read as the owner's (1327).
 */
const MAX_NAME_LENGTH = 80;

export interface DeviceClientFacts {
  readonly label?: string | undefined;
  readonly deviceType?: string | undefined;
  readonly os?: string | undefined;
  readonly browser?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface DeviceDescription {
  /** The device's own name, or an English stand-in when it gave none. */
  readonly label: string;
  /** False when `label` is a stand-in, so a window can show its own words. */
  readonly named: boolean;
  readonly system?: string;
  readonly app?: string;
}

/** True when a label names one device rather than a kind of client. */
export const isOwnDeviceName = (label: string | undefined): label is string => {
  const trimmed = label?.trim();
  return (
    trimmed !== undefined &&
    trimmed.length > 0 &&
    !SHARED_LABELS.has(trimmed) &&
    !isReservedDeviceName(trimmed)
  );
};

const APP_VERSION = /(?:SpecWithCode|SpecWeaveStudio(?:\(Alpha\))?)\/(\d+\.\d+\.\d+)/;

/** The app and its version when the client told: "SpecWithCode 1.0.337", "Chrome". */
export const deviceApp = (facts: DeviceClientFacts): string | undefined => {
  const version = facts.userAgent === undefined ? null : APP_VERSION.exec(facts.userAgent);
  if (version?.[1] !== undefined) return `SpecWithCode ${version[1]}`;
  const browser = facts.browser?.trim();
  if (browser !== undefined && browser.length > 0 && browser !== "Electron") return browser;
  if (browser === "Electron" || facts.label?.trim() === "SpecWithCode Desktop")
    return "SpecWithCode";
  if (facts.deviceType === "mobile" || facts.deviceType === "tablet")
    return /^SpecWithCode\//.test(facts.userAgent ?? "") ? "SpecWithCode" : undefined;
  return undefined;
};

/** An English stand-in when the device gave no name of its own. */
export const standInName = (deviceType: string | undefined, os: string | undefined): string => {
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
};

export const describeDeviceClient = (facts: DeviceClientFacts): DeviceDescription => {
  const os = facts.os?.trim() || undefined;
  const app = deviceApp(facts);
  const named = isOwnDeviceName(facts.label);
  return {
    label: named
      ? facts.label!.trim().slice(0, MAX_NAME_LENGTH)
      : standInName(facts.deviceType, os),
    named,
    ...(os === undefined ? {} : { system: os }),
    ...(app === undefined ? {} : { app }),
  };
};
