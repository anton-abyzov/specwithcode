/**
 * What follows the system a person is on, in one place: key names, the
 * modifier, button order, the file manager's name and the word for the device.
 * The app keeps one design; these are the details that read as foreign when wrong.
 */
export type Platform = "macos" | "windows" | "linux";

/** From `navigator.platform` (and the user agent, for phones that report a desktop platform). */
export function platformOf(navigatorPlatform: string, userAgent = ""): Platform {
  if (/android/i.test(userAgent)) return "linux";
  if (/mac|iphone|ipad|ipod/i.test(navigatorPlatform)) return "macos";
  if (/^win/i.test(navigatorPlatform)) return "windows";
  return "linux";
}

/** Marks the document, so styles can follow the system: `[data-platform="windows"] …`. */
export function applyPlatform(root: HTMLElement, platform: Platform): void {
  root.dataset.platform = platform;
}

/** The platform the document was marked with, or the browser's own when it was not. */
export function currentPlatform(): Platform {
  if (typeof document !== "undefined") {
    const marked = document.documentElement.dataset.platform;
    if (marked === "macos" || marked === "windows" || marked === "linux") return marked;
  }
  return typeof navigator === "undefined"
    ? "linux"
    : platformOf(navigator.platform, navigator.userAgent);
}

export type KeyName = "enter" | "tab" | "escape" | "backspace";

const MAC_KEYS: Record<KeyName, string> = {
  enter: "↵",
  tab: "⇥",
  escape: "esc",
  backspace: "⌫",
};
const WORD_KEYS: Record<KeyName, string> = {
  enter: "Enter",
  tab: "Tab",
  escape: "Esc",
  backspace: "Backspace",
};

/** A key as the system's own menus print it: a symbol on macOS, a word elsewhere. */
export function keyLabel(key: KeyName, platform: Platform): string {
  return (platform === "macos" ? MAC_KEYS : WORD_KEYS)[key];
}

/** A shortcut with the main modifier: "⌘O" on macOS, "Ctrl+O" elsewhere. */
export function shortcutLabel(key: string, platform: Platform): string {
  return platform === "macos" ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`;
}

/** True when the event carries the system's main modifier and not the other one. */
export function hasMainModifier(
  event: { readonly metaKey: boolean; readonly ctrlKey: boolean },
  platform: Platform,
): boolean {
  return platform === "macos" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function fileManagerName(platform: Platform): string {
  return platform === "macos" ? "Finder" : platform === "windows" ? "File Explorer" : "Files";
}

/** The button that opens the system's folder dialog. */
export function systemDialogLabel(platform: Platform): string {
  return platform === "macos" ? "Choose…" : "Browse…";
}

/** macOS and Linux desktops put the default button last; Windows puts it first. */
export function defaultButtonLast(platform: Platform): boolean {
  return platform !== "windows";
}

/**
 * Where a dialog footer draws its default button. A footer carries this as
 * `data-default-button`; the styles flip the drawing order only, so the source
 * order (and with it the button a confirm opens on) is the same on every system.
 */
export function defaultButtonPlacement(platform: Platform): "first" | "last" {
  return defaultButtonLast(platform) ? "last" : "first";
}

/** The word for the device in a sentence: "this Mac", "this PC", "this computer". */
export function deviceWord(platform: Platform): string {
  return platform === "macos" ? "Mac" : platform === "windows" ? "PC" : "computer";
}
