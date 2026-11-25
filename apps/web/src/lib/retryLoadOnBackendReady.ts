import { useEffect } from "react";

import { isArtifactAppWindow } from "./projectWindow";

/**
 * How often an installed page's window retries a failed load. The shell tells
 * only app windows that the backend is back, so that window asks again itself.
 */
export const ARTIFACT_APP_LOAD_RETRY_MS = 5_000;

/**
 * Retries a route load that failed, once the desktop's own backend answers
 * again: a first load that ran while the desktop restarted it (a failed
 * install does) recovers as Try again would. A render error is not retried;
 * loading again would only fail the same way.
 */
export function useRetryLoadOnBackendReady(loadFailed: boolean, retry: () => void): void {
  useEffect(() => {
    if (!loadFailed) return;
    const stopListening = window.desktopBridge?.onBackendReady?.(retry);
    const timer = isArtifactAppWindow()
      ? window.setInterval(retry, ARTIFACT_APP_LOAD_RETRY_MS)
      : undefined;
    return () => {
      stopListening?.();
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [loadFailed, retry]);
}
