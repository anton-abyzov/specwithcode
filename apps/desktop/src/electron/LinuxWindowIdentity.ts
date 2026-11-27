/**
 * Which app a Linux window belongs to in the dock and the app switcher.
 *
 * Electron gives a window its Wayland app id and its X11 WM_CLASS from the
 * `CHROME_DESKTOP` variable (set by `app.setDesktopName`), read while the
 * window is constructed (`shell/browser/native_window_views.cc`, Electron 44).
 * There is no per-window option, so a window that belongs to another desktop
 * entry is constructed with the variable pointing at that entry and the
 * app's own value put back straight after. Construction is synchronous, so no
 * other window can be made in between.
 */

const DESKTOP_NAME_PATTERN = /^[A-Za-z0-9._-]{1,200}\.desktop$/;

export function isLinuxDesktopName(value: string): boolean {
  return DESKTOP_NAME_PATTERN.test(value);
}

export function withLinuxDesktopName<T>(
  desktopName: string,
  construct: () => T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  if (!isLinuxDesktopName(desktopName)) throw new Error("Invalid desktop entry name.");
  const previous = env.CHROME_DESKTOP;
  env.CHROME_DESKTOP = desktopName;
  try {
    return construct();
  } finally {
    if (previous === undefined) delete env.CHROME_DESKTOP;
    else env.CHROME_DESKTOP = previous;
  }
}
