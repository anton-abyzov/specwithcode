import { useEffect, useRef, type ReactNode } from "react";

import { AppSheet } from "../ui/app-sheet";
import { readSettingsOpener, restoreSettingsFocus } from "./settingsReturnFocus";

/**
 * Settings as a centered sheet over the dimmed app, like the native settings
 * windows: section nav on the left, the page on the right, a close button in
 * the corner. Escape, the close button and a click on the dimmed area close
 * it, and focus goes back to what opened it.
 */
export function SettingsDialog({
  nav,
  header,
  children,
  onClose,
}: {
  nav: ReactNode;
  header: ReactNode;
  children: ReactNode;
  onClose: () => void;
}) {
  const opener = useRef(readSettingsOpener());
  useEffect(() => {
    const returnTo = opener.current;
    return () => restoreSettingsFocus(returnTo);
  }, []);

  return (
    <AppSheet
      title="Settings"
      closeLabel="Close settings"
      slot="settings"
      popupProps={{ "data-settings-dialog": "" }}
      nav={nav}
      header={header}
      onClose={onClose}
    >
      {children}
    </AppSheet>
  );
}
