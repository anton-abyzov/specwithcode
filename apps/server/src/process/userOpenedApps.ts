/**
 * Apps the user asked to open (an editor, a browser) stay the service's children
 * unless they daemonize. They are not agent work, and nothing else in a process
 * tree tells them apart: thread terminals and some harnesses are detached too.
 */
const opened = new Set<number>();

export const recordUserOpenedApp = (pid: number) => void opened.add(pid);

export const isUserOpenedApp = (pid: number) => opened.has(pid);

/** Pids are reused: a later process must not inherit the exemption. */
export function forgetExitedUserApps(isAlive: (pid: number) => boolean) {
  for (const pid of opened) if (!isAlive(pid)) opened.delete(pid);
}
