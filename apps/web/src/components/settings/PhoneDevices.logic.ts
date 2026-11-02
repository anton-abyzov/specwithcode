import type { RelayPhoneRecord } from "@specweave-studio/contracts/relay";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** The phone this request came from first, then the most recently seen. */
export function sortPhones(phones: ReadonlyArray<RelayPhoneRecord>): Array<RelayPhoneRecord> {
  return phones.toSorted((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    return Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt);
  });
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

export function lastSeenLabel(lastSeenAt: string, nowMs: number): string {
  const seenMs = Date.parse(lastSeenAt);
  if (Number.isNaN(seenMs)) return "Last seen unknown";
  const elapsed = Math.max(0, nowMs - seenMs);
  if (elapsed < 2 * MINUTE_MS) return "Active now";
  if (elapsed < HOUR_MS)
    return `Last seen ${plural(Math.floor(elapsed / MINUTE_MS), "minute")} ago`;
  if (elapsed < DAY_MS) return `Last seen ${plural(Math.floor(elapsed / HOUR_MS), "hour")} ago`;
  if (elapsed < 7 * DAY_MS) return `Last seen ${plural(Math.floor(elapsed / DAY_MS), "day")} ago`;
  return `Last seen ${dateFormatter.format(new Date(seenMs))}`;
}

/** The marketing model; builds before November 2026 could only report "iPhone" for newer phones. */
function knownModel(phone: RelayPhoneRecord): string | null {
  return phone.model && phone.model !== "iPhone" ? phone.model : null;
}

/** The name the person chose, else the model: most phones can only report "iPhone" as their name. */
export function phoneTitle(phone: RelayPhoneRecord): string {
  const generic = phone.label === "iPhone" || phone.label === phone.model;
  if (!generic) return phone.label;
  return knownModel(phone) ?? (phone.platform === "ios" ? "iPhone" : "Android phone");
}

/** Model, OS, app version and last seen, e.g. "iPhone Duo · iOS 27 · App 0.1.4 · Active now". */
export function phoneDetail(phone: RelayPhoneRecord, nowMs: number): string {
  const model = knownModel(phone);
  const parts: Array<string> = [];
  if (phone.platform === "ios" && model === null) parts.push("Model shows after the app updates");
  else if (model !== null && phoneTitle(phone) !== model) parts.push(model);
  if (phone.iosMajorVersion != null) parts.push(`iOS ${phone.iosMajorVersion}`);
  if (phone.appVersion) {
    parts.push(`App ${phone.appVersion}${phone.bundleId?.endsWith(".dev") ? " (dev build)" : ""}`);
  }
  parts.push(lastSeenLabel(phone.lastSeenAt, nowMs));
  return parts.join(" · ");
}

export function removePhoneDialogCopy(phone: RelayPhoneRecord): {
  readonly title: string;
  readonly description: string;
} {
  return {
    title: `Remove ${phoneTitle(phone)}?`,
    description:
      "It stops getting alerts and can no longer reach your computers. To use it again, sign in to SpecWithCode Connect on that phone.",
  };
}

export function removedPhoneToast(
  phone: RelayPhoneRecord,
  result: { readonly removed: boolean },
): { readonly title: string; readonly description: string } {
  return result.removed
    ? {
        title: "Phone removed",
        description: `${phoneTitle(phone)} is signed out and can no longer reach your computers.`,
      }
    : {
        title: "Phone already removed",
        description: `${phoneTitle(phone)} is no longer on your account.`,
      };
}

/** Hides phones removed in this window until the next listing drops them too. */
export function visiblePhones(
  phones: ReadonlyArray<RelayPhoneRecord>,
  removedDeviceIds: ReadonlySet<string>,
): Array<RelayPhoneRecord> {
  return sortPhones(phones.filter((phone) => !removedDeviceIds.has(phone.deviceId)));
}
