import { useEffect } from "react";

/**
 * Retries a route load that failed, once the desktop's own backend answers
 * again: a first load that ran while the desktop restarted it (a failed
 * install does) recovers as Try again would. A render error is not retried;
 * loading again would only fail the same way.
 */
export function useRetryLoadOnBackendReady(loadFailed: boolean, retry: () => void): void {
  useEffect(() => {
    if (!loadFailed) return;
    return window.desktopBridge?.onBackendReady?.(retry);
  }, [loadFailed, retry]);
}
