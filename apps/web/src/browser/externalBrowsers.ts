/**
 * Installed browsers and their profiles, as the desktop shell reports them,
 * and opening a URL in one of them.
 *
 * Only the desktop app can see or launch other browsers. In the web build (or
 * an older desktop shell without these methods) the list is `null`, the
 * profile choices are hidden, and links go wherever `openExternal` sends them.
 *
 * @module externalBrowsers
 */
import type { ExternalBrowser, ExternalBrowserTarget } from "@specweave-studio/contracts";
import { useEffect, useState } from "react";

import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { readLocalApi } from "~/localApi";

/** Whether this client can list and launch installed browsers. */
export function canUseExternalBrowsers(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window.desktopBridge;
  return Boolean(bridge?.listExternalBrowsers && bridge.openInExternalBrowser);
}

let cachedList: Promise<ReadonlyArray<ExternalBrowser>> | null = null;

/**
 * The installed browsers, or null where this client cannot launch them.
 * Cached for the session; pass `refresh` to read the disk again, e.g. when a
 * menu opens after the user created a new Chrome profile.
 */
export async function listExternalBrowsers(
  options: { readonly refresh?: boolean } = {},
): Promise<ReadonlyArray<ExternalBrowser> | null> {
  if (!canUseExternalBrowsers()) return null;
  const list = window.desktopBridge?.listExternalBrowsers;
  if (!list) return null;
  if (options.refresh || cachedList === null) {
    cachedList = list().catch(() => {
      cachedList = null;
      return [];
    });
  }
  return cachedList;
}

/** Test seam: forget the cached browser list. */
export function resetExternalBrowsersCache(): void {
  cachedList = null;
}

/** React view of {@link listExternalBrowsers}; null until loaded or when unsupported. */
export function useExternalBrowsers(
  options: { readonly enabled?: boolean; readonly refreshKey?: unknown } = {},
): ReadonlyArray<ExternalBrowser> | null {
  const enabled = options.enabled ?? true;
  const [browsers, setBrowsers] = useState<ReadonlyArray<ExternalBrowser> | null>(null);
  const { refreshKey } = options;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void listExternalBrowsers({ refresh: refreshKey !== undefined }).then((next) => {
      if (!cancelled) setBrowsers(next);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshKey]);
  return browsers;
}

/**
 * Opens the URL in the given browser profile, or the OS default browser when
 * there is no target, the shell cannot launch browsers, or the launch fails.
 * Rejects only when the default browser cannot be opened either.
 */
export async function openUrlInExternalBrowser(
  url: string,
  target: ExternalBrowserTarget | null | undefined,
): Promise<void> {
  const openInBrowser = window.desktopBridge?.openInExternalBrowser;
  if (target && openInBrowser) {
    const opened = await openInBrowser({ url, target }).catch(() => false);
    if (opened) return;
  }
  const api = readLocalApi();
  if (!api) throw new Error("Link opening is unavailable.");
  await api.shell.openExternal(url);
}

/** The configured external target, once client settings have loaded. */
export async function resolveExternalBrowserTargetPreference(): Promise<ExternalBrowserTarget | null> {
  await ensureClientSettingsHydrated();
  const settings = getClientSettings();
  return settings.browserLinkTarget === "system" ? settings.browserExternalTarget : null;
}

/**
 * Opens a link outside SpecWithCode where "Open links in" says: the chosen
 * browser profile if one is set, else the OS default browser.
 */
export async function openLinkOutsideApp(url: string): Promise<void> {
  const target = await resolveExternalBrowserTargetPreference().catch(() => null);
  await openUrlInExternalBrowser(url, target);
}
