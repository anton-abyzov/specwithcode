/**
 * Asks every connection waiting to retry to try now. A machine that restarted (an update,
 * a reboot) can sit behind a long retry delay while the window stays focused, so nothing
 * else cuts it short; a page showing that machine as offline asks here instead.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

export function onConnectionRetryRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Cuts short pending retries; the platform throttles it like a window focus. */
export function requestConnectionRetry(): void {
  for (const listener of listeners) listener();
}
