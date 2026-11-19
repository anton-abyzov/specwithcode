/**
 * Path rules shared by both sides of a folder copy. Every path that crosses the
 * machine boundary is relative, uses `/`, and is checked again on arrival: the
 * destination never trusts the source to have validated it.
 */

/** The longest relative path a copy carries. */
export const MAX_RELATIVE_PATH = 4096;

/**
 * True when `value` names something strictly inside the copied folder: no empty,
 * `.` or `..` segment, no leading `/`, no control bytes. Backslashes are refused
 * on Windows, where they separate folders.
 */
export function isSafeRelativePath(value: string, platform: NodeJS.Platform = process.platform) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RELATIVE_PATH)
    return false;
  // eslint-disable-next-line no-control-regex -- Control bytes are never valid in a copied path.
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (platform === "win32" && /[\\:]/.test(value)) return false;
  if (value.startsWith("/")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** The longest name a destination takes, in UTF-8 bytes: the bound of byte-limited file systems. */
export const MAX_PART_BYTES = 255;

/** Names Windows gives to devices, with or without an extension; a port's digit may be superscript. */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|(?:com|lpt)[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/i;

/**
 * The rule a destination applies to a path it is about to create. On top of
 * `isSafeRelativePath`: no part over 255 bytes, and on Windows no device name and
 * no part ending in a dot or a space, which Windows silently maps to another name.
 */
export function isSafeDestinationPath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!isSafeRelativePath(value, platform)) return false;
  return value
    .split("/")
    .every(
      (part) =>
        Buffer.byteLength(part) <= MAX_PART_BYTES &&
        (platform !== "win32" || !(WINDOWS_DEVICE_NAME.test(part) || /[. ]$/.test(part))),
    );
}

/** Every proper ancestor of a relative path, outermost first: `a/b/c` gives `a`, `a/b`. */
export function ancestorsOf(relative: string): Array<string> {
  const parts = relative.split("/");
  const result: Array<string> = [];
  for (let index = 1; index < parts.length; index += 1)
    result.push(parts.slice(0, index).join("/"));
  return result;
}

/**
 * The key two names share on a case-insensitive, normalization-insensitive file
 * system such as default APFS: `README.md` and `Readme.md` land on one file.
 */
export function foldedPathKey(relative: string): string {
  return relative.normalize("NFC").toLowerCase();
}

/**
 * The key two names share on the destination volume. macOS volumes treat the
 * composed and decomposed spelling of a name as one file even when case matters.
 */
export function destinationPathKey(
  relative: string,
  volume: { readonly platform: NodeJS.Platform; readonly caseInsensitive: boolean },
): string {
  if (volume.caseInsensitive) return foldedPathKey(relative);
  return volume.platform === "darwin" ? relative.normalize("NFC") : relative;
}

/**
 * Where a symbolic link's target resolves, relative to the copied folder, or null
 * when it leaves the folder. The link itself is always copied as a link; this only
 * tells the preview whether it points outside.
 */
export function symlinkTargetInside(linkPath: string, target: string): string | null {
  if (target.startsWith("/") || /^[A-Za-z]:/.test(target)) return null;
  const parts = linkPath.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/**
 * A link target as the copy carries it: Windows reports targets with `\`, the
 * copy always uses `/`, which Windows also accepts when the link is created.
 */
export function linkTargetOnWire(raw: string, platform: NodeJS.Platform = process.platform) {
  return platform === "win32" ? raw.replaceAll("\\", "/") : raw;
}

/** Human-readable byte counts for previews, refusals and logs. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
