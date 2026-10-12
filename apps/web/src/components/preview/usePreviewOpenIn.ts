/**
 * Sending the in-app browser's page to a browser outside SpecWithCode: the
 * address bar's button follows "Open links in", and the more-menu's
 * "Open in" submenu picks a specific installed browser profile.
 *
 * @module usePreviewOpenIn
 */
import type { ExternalBrowserTarget } from "@specweave-studio/contracts";
import { useCallback, useMemo, useState } from "react";

import {
  externalBrowserChoices,
  openOutsideAppLabel,
  type ExternalBrowserChoice,
} from "~/browser/externalBrowserOptions";
import {
  canUseExternalBrowsers,
  openLinkOutsideApp,
  openUrlInExternalBrowser,
  useExternalBrowsers,
} from "~/browser/externalBrowsers";
import { useClientSettings } from "~/hooks/useSettings";

export interface PreviewOpenInMenu {
  /** Empty until the list loads or when no supported browser is installed. */
  readonly choices: ReadonlyArray<ExternalBrowserChoice>;
  /** Null opens the OS default browser. */
  readonly onOpen: (target: ExternalBrowserTarget | null) => void;
  /** Re-reads installed browsers, so a profile made since launch shows up. */
  readonly refresh: () => void;
}

export function usePreviewOpenIn(url: string | null | undefined): {
  readonly openInBrowser: (() => void) | undefined;
  /** What the open-outside button does, for its tooltip and accessible name. */
  readonly openInBrowserLabel: string;
  readonly openInMenu: PreviewOpenInMenu | undefined;
} {
  const supported = canUseExternalBrowsers();
  const [refreshCount, setRefreshCount] = useState(0);
  const browsers = useExternalBrowsers({
    enabled: supported,
    refreshKey: refreshCount === 0 ? undefined : refreshCount,
  });
  const linkTarget = useClientSettings((settings) => settings.browserLinkTarget);
  const externalTarget = useClientSettings((settings) => settings.browserExternalTarget);
  const openInBrowser = useCallback(() => {
    if (!url) return;
    void openLinkOutsideApp(url).catch(() => undefined);
  }, [url]);
  const onOpen = useCallback(
    (target: ExternalBrowserTarget | null) => {
      if (!url) return;
      void openUrlInExternalBrowser(url, target).catch(() => undefined);
    },
    [url],
  );
  const refresh = useCallback(() => setRefreshCount((count) => count + 1), []);
  const openInMenu = useMemo<PreviewOpenInMenu | undefined>(() => {
    if (!url || !supported) return undefined;
    return { choices: browsers ? externalBrowserChoices(browsers) : [], onOpen, refresh };
  }, [browsers, onOpen, refresh, supported, url]);
  const openInBrowserLabel = openOutsideAppLabel({
    browsers,
    linkTarget,
    // Without the desktop shell a saved profile cannot be launched.
    externalTarget: supported ? externalTarget : null,
  });
  return { openInBrowser: url ? openInBrowser : undefined, openInBrowserLabel, openInMenu };
}
