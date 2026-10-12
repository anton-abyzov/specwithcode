/**
 * Microphone access for app windows. A window gets the microphone only while
 * it has told the main process that a voice call is running, only for audio,
 * and only for its own page (never an embedded frame from another origin).
 * Every other permission keeps Electron's default.
 */
export type MediaPermissionRequest = {
  readonly permission: string;
  readonly mediaTypes: ReadonlyArray<string> | undefined;
  readonly requestingUrl: string | undefined;
  readonly pageUrl: string;
  readonly callActive: boolean;
};

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    // Custom schemes (studio://app) report "null" as origin; compare scheme and host.
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

export function allowMediaPermission(request: MediaPermissionRequest): boolean {
  const mediaTypes = request.mediaTypes ?? [];
  // Only microphone requests are gated. Screen capture arrives as "media" with
  // no device types and is already limited by the display-media handler.
  if (request.permission !== "media" || !mediaTypes.includes("audio")) return true;
  if (!request.callActive) return false;
  if (mediaTypes.some((type) => type !== "audio")) return false;
  const requesting = originOf(request.requestingUrl);
  return requesting !== null && requesting === originOf(request.pageUrl);
}

/** System Settings › Privacy & Security › Microphone. */
export const MICROPHONE_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
