/**
 * How the Linux update proof quits the desktop app between phases.
 *
 * Electron shuts down in order on its first SIGTERM and then restores the default handler, so a
 * second SIGTERM kills it at once, before it has stopped the backend it started. The proof used
 * to repeat the signal every second, which hid a backend that outlived its stop signal behind a
 * later "port not released" timeout. Each process is signalled once, and the quit only counts
 * when nothing running the app's binary is left.
 */
export interface AppQuitInput {
  /** The app's main process, or null once it is gone. */
  readonly appPid: () => number | null;
  /** Every process still running the app's binary, described for a failure message. */
  readonly leftovers: () => ReadonlyArray<string>;
  readonly signal: (pid: number) => void;
  /** Polls `read` until it returns a truthy value; a throw counts as "not yet". */
  readonly until: (
    what: string,
    timeoutMs: number,
    read: () => boolean | Promise<boolean>,
  ) => Promise<unknown>;
}

export const quitApp = async (input: AppQuitInput): Promise<void> => {
  // A running update can relaunch the app after the signal; that process is a new one.
  const signalled = new Set<number>();
  await input.until("the app to quit", 60_000, () => {
    const pid = input.appPid();
    if (pid === null) return true;
    if (!signalled.has(pid)) {
      signalled.add(pid);
      input.signal(pid);
    }
    return false;
  });
  // The app stops its backend before it exits. One left behind keeps the app's ports, and the
  // next launch cannot start.
  await input.until("the app's own processes to exit", 30_000, () => {
    const left = input.leftovers();
    if (left.length === 0) return true;
    throw new Error(`the app quit and left ${left.join(", ")} running`);
  });
};
