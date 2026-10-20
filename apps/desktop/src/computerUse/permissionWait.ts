/**
 * Holds an action until a macOS permission reads as granted. Resolves true
 * exactly once when the grant appears, false when the wait expires. The
 * deadline is fixed at start: the server stops waiting for the action
 * `waitMs` plus the action's own time after the agent asked, so a longer
 * hold would perform an action whose result nobody reads, after the agent
 * may already have retried it.
 */
export async function waitForPermission(options: {
  readonly granted: () => Promise<boolean>;
  readonly waitMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<unknown>;
  readonly intervalMs?: number;
}): Promise<boolean> {
  const deadline = options.now() + options.waitMs;
  while (options.now() < deadline) {
    await options.sleep(options.intervalMs ?? 1_000);
    if (await options.granted()) return true;
  }
  return false;
}

/** tccutil's name for each permission's Privacy & Security list. */
export const TCC_SERVICE = {
  "screen-recording": "ScreenCapture",
  accessibility: "Accessibility",
} as const;

/**
 * Only the app's own release or development bundle may be reset, never
 * Electron's or another app's entry.
 */
export function isResettableBundleId(bundleId: string): boolean {
  // Development builds add a checkout suffix: com.specweave.studio.dev.<repo>.
  return /^com\.specweave\.studio(\.dev(\.[a-z0-9]+)?)?$/.test(bundleId);
}
