export const MAC_PERMISSION_SETTINGS_URLS = {
  "screen-recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "full-disk-access":
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
  "app-data":
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AppData",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
};

export type MacPermission = keyof typeof MAC_PERMISSION_SETTINGS_URLS;

export const MAC_PERMISSION_TITLES: Record<MacPermission, string> = {
  "screen-recording": "Screen Recording",
  accessibility: "Accessibility",
  "full-disk-access": "Full Disk Access",
  "app-data": "App Data",
  automation: "Automation",
};

/**
 * Panes whose list takes a dragged item. Automation has no "+" and no drop
 * target: its rows appear only after macOS's own prompt, then the user turns
 * the switch on, so the helper shows an instruction there instead.
 */
export const MAC_PERMISSION_ACCEPTS_DRAG: Record<MacPermission, boolean> = {
  "screen-recording": true,
  accessibility: true,
  "full-disk-access": true,
  "app-data": true,
  automation: false,
};
