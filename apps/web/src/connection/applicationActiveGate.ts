/**
 * When a window that was hidden should wake its connections. A wakeup probes the
 * socket and resubscribes the shell list and every open thread, which marks them
 * synchronizing and renders them again.
 *
 * Desktop windows keep their socket and keep handling its events while hidden.
 * macOS also reports a window hidden while another window covers it, so moving
 * between windows would otherwise resubscribe everything each time. A desktop
 * window shown again after a brief hide therefore does not wake. A browser tab
 * can be suspended with its socket dropped silently, so it always wakes. Shows
 * in quick succession wake once either way.
 */
export const DESKTOP_BRIEF_HIDE_MS = 30_000;
export const APPLICATION_ACTIVE_MIN_INTERVAL_MS = 2_000;

export function createApplicationActiveGate(options: {
  readonly desktop: boolean;
  readonly now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let hiddenAt: number | null = null;
  let lastWakeAt: number | null = null;
  return {
    hidden(): void {
      hiddenAt ??= now();
    },
    /** Whether this show should wake the connections. */
    shown(): boolean {
      const at = now();
      const hiddenFor = hiddenAt === null ? null : at - hiddenAt;
      hiddenAt = null;
      if (options.desktop && hiddenFor !== null && hiddenFor < DESKTOP_BRIEF_HIDE_MS) return false;
      if (lastWakeAt !== null && at - lastWakeAt < APPLICATION_ACTIVE_MIN_INTERVAL_MS) return false;
      lastWakeAt = at;
      return true;
    },
  };
}
