import { SYSTEM_RESUME_CHANNEL } from "../ipc/channels.ts";

/** The part of a window the broadcast needs; a BrowserWindow fits. */
export interface ResumeTarget {
  readonly isDestroyed: () => boolean;
  readonly webContents: { readonly send: (channel: string) => void };
}

/**
 * Tells every window the computer woke from sleep or was unlocked. A socket
 * to another machine opened before the sleep is usually dead without a close
 * event, and a window left in the background gets no focus change to notice:
 * before this, its retry wait (up to ten minutes) ran on after the wake.
 */
export function broadcastSystemResume(windows: ReadonlyArray<ResumeTarget>): number {
  let sent = 0;
  for (const window of windows) {
    // A frame disposed mid-reload checks its connections when it loads again.
    try {
      if (window.isDestroyed()) continue;
      window.webContents.send(SYSTEM_RESUME_CHANNEL);
      sent += 1;
    } catch {
      // Same as above: that window reconnects when it loads.
    }
  }
  return sent;
}
