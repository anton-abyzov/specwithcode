/**
 * Windows console process list lookup for node-pty's kill().
 *
 * node-pty's WindowsPtyAgent.kill() forks `conpty_console_list_agent` to list the
 * processes attached to the shell's console, then kills each of them. The
 * upstream lookup only settles on the helper's IPC reply or a 5s timeout: a
 * helper that exits without replying makes every close wait the full timeout,
 * a spawn failure emits an unhandled `error` that crashes the server, and a
 * non-object reply throws. The reviewed node-pty patch must stay as it is
 *, so Studio replaces the
 * lookup on each agent instance instead.
 */

/** The parts of the forked helper's ChildProcess this lookup uses. */
export interface ConsoleListHelper {
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "error" | "close", listener: () => void): unknown;
  kill(): boolean;
}

export type ForkConsoleListHelper = (innerPid: number) => ConsoleListHelper;

/** Same bound as node-pty's own lookup. */
export const CONSOLE_LIST_TIMEOUT_MS = 5000;

const consoleProcessListOf = (message: unknown): ReadonlyArray<number> | undefined => {
  if (typeof message !== "object" || message === null) return undefined;
  const list: unknown = (message as { readonly consoleProcessList?: unknown }).consoleProcessList;
  return Array.isArray(list) ? list : undefined;
};

/**
 * Lists the console's processes, falling back to the shell PID as soon as the
 * helper fails to spawn, closes without replying, or exceeds the timeout.
 */
export const getConsoleProcessList = (
  innerPid: number,
  fork: ForkConsoleListHelper,
  timeoutMs: number = CONSOLE_LIST_TIMEOUT_MS,
): Promise<ReadonlyArray<number>> => {
  if (innerPid <= 0) return Promise.resolve([]);
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (list: ReadonlyArray<number>) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      resolve(list);
    };
    let helper: ConsoleListHelper;
    try {
      helper = fork(innerPid);
    } catch {
      finish([innerPid]);
      return;
    }
    helper.on("message", (message) => {
      const list = consoleProcessListOf(message);
      if (list !== undefined) finish(list);
    });
    helper.on("error", () => finish([innerPid]));
    // `close` follows the last IPC message, unlike `exit`, so a reply is never lost.
    helper.on("close", () => finish([innerPid]));
    // @effect-diagnostics-next-line globalTimers:off -- node-pty calls this as a Promise-returning method, outside any Effect runtime.
    timeout = setTimeout(() => {
      try {
        helper.kill();
      } catch {
        // The helper is already gone.
      }
      finish([innerPid]);
    }, timeoutMs);
  });
};

/**
 * Replaces the console process lookup on a spawned node-pty Windows process's
 * private agent. Returns false when this node-pty build has no such agent.
 */
export const installConsoleProcessListLookup = (
  nativeProcess: object,
  fork: ForkConsoleListHelper,
): boolean => {
  if (!("_agent" in nativeProcess)) return false;
  const agent = nativeProcess._agent;
  if (
    typeof agent !== "object" ||
    agent === null ||
    !("_getConsoleProcessList" in agent) ||
    typeof agent._getConsoleProcessList !== "function"
  ) {
    return false;
  }
  const target = agent as { _innerPid?: unknown; _getConsoleProcessList: unknown };
  target._getConsoleProcessList = () =>
    getConsoleProcessList(typeof target._innerPid === "number" ? target._innerPid : 0, fork);
  return true;
};
