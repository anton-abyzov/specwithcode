// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

/**
 * The cgroup agent work runs in once the server has divided the service's
 * cgroup (AgentMemoryLimit); undefined everywhere else. Module state, like
 * userOpenedApps: the ACP runtime makes its per-session groups from plain
 * synchronous code and must make them inside this one.
 */
export interface AgentWorkCgroup {
  /** As /proc/<pid>/cgroup names it. */
  readonly relativePath: string;
  /** Its directory under the cgroup mount. */
  readonly path: string;
  /** What `memory.max` was last set to. */
  readonly limitBytes: number;
  /** The group for apps the user opened, which has no limit. */
  readonly appsPath: string;
}

let active: AgentWorkCgroup | undefined;

export const setAgentWorkCgroup = (group: AgentWorkCgroup | undefined) => {
  active = group;
};

export const agentWorkCgroup = () => active;

/**
 * Puts an app the user just opened in the unlimited group at once, before it
 * forks: an editor's launcher often starts the real app and exits, and the
 * app would then look like agent work. Best effort; the next pass also looks.
 */
export function placeUserOpenedApp(pid: number) {
  if (active === undefined || !(pid > 0)) return;
  try {
    NodeFS.appendFileSync(`${active.appsPath}/cgroup.procs`, `${pid}\n`);
  } catch {
    // It exited already, or the groups are gone.
  }
}
