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
}

let active: AgentWorkCgroup | undefined;

export const setAgentWorkCgroup = (group: AgentWorkCgroup | undefined) => {
  active = group;
};

export const agentWorkCgroup = () => active;
