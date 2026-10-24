import * as Context from "effect/Context";
import * as Electron from "electron";

/** A system notification about a release of the app. */
export interface DesktopUpdateNotice {
  readonly kind: "available" | "downloaded";
  readonly version: string;
  readonly title: string;
  readonly body: string;
}

/** Posts `notice`; `onClick` runs when the person clicks it. */
export type DesktopUpdateNoticePoster = (notice: DesktopUpdateNotice, onClick: () => void) => void;

// A notification Electron garbage-collects no longer reports its click, so
// each one stays referenced until it is clicked or closed.
const shownUpdateNotifications = new Set<Electron.Notification>();

const postNativeUpdateNotice: DesktopUpdateNoticePoster = (notice, onClick) => {
  if (typeof Electron.Notification?.isSupported !== "function") return;
  if (!Electron.Notification.isSupported()) return;
  const notification = new Electron.Notification({ title: notice.title, body: notice.body });
  shownUpdateNotifications.add(notification);
  notification.on("click", () => {
    shownUpdateNotifications.delete(notification);
    onClick();
  });
  notification.on("close", () => shownUpdateNotifications.delete(notification));
  notification.on("failed", () => shownUpdateNotifications.delete(notification));
  notification.show();
};

/** How update notices reach the system; tests replace it. */
export const DesktopUpdateNotifier = Context.Reference<DesktopUpdateNoticePoster>(
  "@specweave-studio/desktop/updates/DesktopUpdateNotifier",
  { defaultValue: () => postNativeUpdateNotice },
);

export function describeUpdateNotice(
  kind: DesktopUpdateNotice["kind"],
  version: string,
  downloadsAutomatically: boolean,
): DesktopUpdateNotice {
  if (kind === "downloaded") {
    return {
      kind,
      version,
      title: `SpecWithCode ${version} is ready to install`,
      body: "Restart the app to update. Click to open Settings.",
    };
  }
  return {
    kind,
    version,
    title: `SpecWithCode ${version} is available`,
    body: downloadsAutomatically
      ? "It is downloading in the background. Click to open Settings."
      : "Click to open Settings and download it.",
  };
}
