import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessUserId,
} from "@specweave-studio/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { BOOT_SERVICE_UNIT_ENV, withUnitDelegation } from "../cloud/bootService.ts";
import { ServiceLauncherHostProcess } from "../cloud/serviceLauncherClient.ts";
import { SERVICE_LAUNCHER_CONTEXT_ENV } from "../cloud/serviceProtocol.ts";
import { isUserOpenedApp } from "../process/userOpenedApps.ts";
import { isSafeCgroupPath, parseUnifiedCgroupPath } from "../provider/acp/AcpSessionRuntime.ts";
import { userBusCandidates, userBusEnv } from "../systemdUserBus.ts";
import { setAgentWorkCgroup } from "./agentWorkCgroup.ts";
import { parseMemory, parseProcessStat, type ProcessEntry } from "./MemoryGuard.ts";

/**
 * On a Linux service, agent commands that exhaust memory made the whole machine
 * thrash for minutes before the kernel killed anything; the server stalled and
 * the tunnel dropped. The unit's own limit covers the server and the agents
 * together, so it never helped.
 *
 * The server divides the unit's cgroup (the unit has `Delegate=yes`):
 *
 *   server  the launcher, this process and the tunnel; never swapped out
 *   agents  everything else the server starts; `memory.max`, no swap
 *   apps    apps the user opened; no limit
 *
 * A child starts in `server` because it inherits it, and is moved out on the
 * next pass. The limit on `agents` follows what the machine has spare, so a
 * command that passes it is killed by the kernel inside `agents` in seconds,
 * largest process first, instead of taking the machine down with it.
 *
 * Nothing here needs root. Where any step is unavailable the server logs one
 * line and runs as before.
 */

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const PASS_INTERVAL = "2 seconds";
const SETUP_RETRY_MS = 60_000;
const SETUP_RETRIES = 5;
/** A limit that vanished (the controller was taken away) is set up again, this often at most. */
const REPAIR_INTERVAL_MS = 30_000;
/** Children can fork while the unit's own group is being emptied. */
const EMPTY_ROOT_ATTEMPTS = 5;
/** Smaller changes of the limit are not written. */
const LIMIT_STEP_BYTES = 8 * MIB;
/** What agent work may still grow by when the machine has nothing spare. */
const PIN_SLACK_BYTES = 64 * MIB;
const MIN_CEILING_BYTES = 256 * MIB;
const SYSTEMCTL_TIMEOUT = "10 seconds";
/** Argument 0 of the shell that moves an ACP session into its own group. */
const ACP_WRAPPER = "studio-acp-cgroup-wrapper";
const LAUNCHER_COMMAND = "__service-launcher";
const AGENT_MEMORY_LIMIT_ENV = "STUDIO_AGENT_MEMORY_LIMIT";

const floorMib = (bytes: number) => Math.floor(bytes / MIB) * MIB;
const ceilMib = (bytes: number) => Math.ceil(bytes / MIB) * MIB;

export interface AgentMemoryPlan {
  /** Agent work never gets more than this. */
  readonly ceilingBytes: number;
  /** Agent work always keeps this much, however little the machine has spare. */
  readonly shareBytes: number;
  /** Available memory agent work may not take from the rest of the machine. */
  readonly headroomBytes: number;
  /** Reserved for the server when the unit reaches its own limit. */
  readonly serverReserveBytes: number;
}

/**
 * The fixed numbers for a machine. `unitMaxBytes` is the unit's own
 * `memory.max`, null when it has none. Null when there is too little to divide.
 */
export function planAgentMemory(
  totalBytes: number,
  unitMaxBytes: number | null,
): AgentMemoryPlan | null {
  if (!(totalBytes > 0)) return null;
  const serverReserveBytes = Math.min(2 * GIB, totalBytes / 8);
  const machineReserveBytes = Math.max(6 * GIB, totalBytes / 4);
  let ceilingBytes = Math.max(totalBytes - machineReserveBytes, totalBytes / 2);
  if (unitMaxBytes !== null) ceilingBytes = Math.min(ceilingBytes, unitMaxBytes - serverReserveBytes);
  if (ceilingBytes < MIN_CEILING_BYTES) return null;
  return {
    ceilingBytes: floorMib(ceilingBytes),
    shareBytes: floorMib(Math.min(ceilingBytes, Math.max(4 * GIB, totalBytes / 4))),
    headroomBytes: floorMib(Math.max(GIB, totalBytes * 0.08)),
    serverReserveBytes: floorMib(serverReserveBytes),
  };
}

/**
 * The limit for now. `heldBytes` is what agent work holds that cannot simply
 * be dropped (its memory without file cache); `lastBytes` is the limit in
 * force, null when none is.
 */
export function agentLimitBytes(
  plan: AgentMemoryPlan,
  heldBytes: number,
  availableBytes: number,
  lastBytes: number | null,
): number {
  const spareBytes = Math.max(0, availableBytes - plan.headroomBytes);
  const wanted = Math.min(
    plan.ceilingBytes,
    Math.max(plan.shareBytes, heldBytes + Math.max(spareBytes, PIN_SLACK_BYTES)),
  );
  // With nothing spare the limit only comes down: following `held` up would
  // let a slow leak take the headroom a few megabytes at a time.
  const limit =
    spareBytes < PIN_SLACK_BYTES && lastBytes !== null
      ? Math.min(wanted, Math.max(lastBytes, plan.shareBytes))
      : wanted;
  if (floorMib(limit) >= heldBytes) return floorMib(limit);
  // Agent work is above the ceiling, which only happens when the limit is
  // first set. Writing a limit below what is held ends a process at once, so
  // hold it where it is: it cannot grow, and the limit follows it down.
  return ceilMib(Math.min(heldBytes, Math.max(limit, lastBytes ?? heldBytes)));
}

/**
 * The unit's cgroup, from this process's own: the unit's itself before the
 * groups exist, `server` under it after. Anywhere else (a server an agent
 * started from its shell) is not ours to divide.
 */
export function unitCgroupOf(ownCgroup: string, unit: string): string | undefined {
  if (!isSafeCgroupPath(ownCgroup) || unit === "" || unit.includes("/")) return undefined;
  if (ownCgroup.endsWith(`/${unit}`)) return ownCgroup;
  if (ownCgroup.endsWith(`/${unit}/server`)) return ownCgroup.slice(0, -"/server".length);
  return undefined;
}

export type AgentMemoryGroup = "server" | "agents" | "apps";

/**
 * Where a process the service started belongs. `table` holds the processes
 * read in the same pass, to find an app the user opened above it.
 */
export function groupOf(
  entry: ProcessEntry,
  table: ReadonlyMap<number, ProcessEntry>,
  ids: { readonly selfPid: number; readonly launcherPid: number },
  isUserApp: (pid: number) => boolean = isUserOpenedApp,
): AgentMemoryGroup {
  // The launcher's other children are servers too: one being replaced, or its trial.
  if (
    entry.pid === ids.selfPid ||
    entry.pid === ids.launcherPid ||
    entry.ppid === ids.launcherPid
  ) {
    return "server";
  }
  if (entry.comm === "cloudflared" && entry.ppid === ids.selfPid) return "server";
  let at: ProcessEntry | undefined = entry;
  for (let hops = 0; at !== undefined && at.pid !== ids.selfPid && hops < 64; hops++) {
    if (isUserApp(at.pid)) return "apps";
    at = table.get(at.ppid);
  }
  return "agents";
}

const parsePids = (procs: string) =>
  procs.split("\n").flatMap((line) => (/^\d+$/.test(line) ? [Number(line)] : []));

/** `memory.current` without the file cache the kernel drops before it kills. */
export function heldBytesOf(current: string, stat: string): number | null {
  const total = Number(current.trim());
  if (current.trim() === "" || !Number.isFinite(total)) return null;
  const field = (name: string) => Number(new RegExp(`^${name} (\\d+)$`, "m").exec(stat)?.[1] ?? 0);
  return Math.max(0, total - field("inactive_file") - field("active_file"));
}

class AgentMemoryLimitUnavailable extends Schema.TaggedError<AgentMemoryLimitUnavailable>()(
  "AgentMemoryLimitUnavailable",
  {
    reason: Schema.String,
    /** False when another try cannot help (not a service, no cgroup v2). */
    retry: Schema.Boolean,
  },
) {}

const unavailable = (reason: string, retry = false) =>
  new AgentMemoryLimitUnavailable({ reason, retry });

interface Layout {
  readonly serverPath: string;
  readonly serverRelative: string;
  readonly agentsPath: string;
  readonly agentsRelative: string;
  readonly appsPath: string;
  readonly plan: AgentMemoryPlan;
}

export interface AgentMemoryLimitOptions {
  readonly procRoot?: string;
  readonly cgroupRoot?: string;
  readonly selfPid?: number;
  readonly launcherPid?: number;
  /** Stands in for `systemctl --user`: whether the unit has `Delegate=yes` afterwards. */
  readonly ensureDelegation?: Effect.Effect<boolean>;
}

export const makeAgentMemoryLimit = Effect.fn("makeAgentMemoryLimit")(function* (
  options: AgentMemoryLimitOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* HostProcessEnvironment;
  const launcherHost = yield* ServiceLauncherHostProcess;
  const uid = yield* HostProcessUserId;
  const procRoot = options.procRoot ?? "/proc";
  const cgroupRoot = options.cgroupRoot ?? "/sys/fs/cgroup";
  const ids = {
    selfPid: options.selfPid ?? process.pid,
    launcherPid: options.launcherPid ?? process.ppid,
  };
  const unit = environment[BOOT_SERVICE_UNIT_ENV] ?? "";

  const state: {
    layout: Layout | undefined;
    limitBytes: number | null;
    nextSetupAt: number;
    failures: number;
    reported: string | undefined;
  } = { layout: undefined, limitBytes: null, nextSetupAt: 0, failures: 0, reported: undefined };

  const readText = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  /** True when the kernel took the write. */
  const write = (file: string, value: string, flag: "w" | "a" = "w") =>
    fs.writeFileString(file, value, { flag }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  const readEntry = (pid: number) =>
    readText(`${procRoot}/${pid}/stat`).pipe(Effect.map((stat) => parseProcessStat(stat)));

  const systemctl = Effect.fn("AgentMemoryLimit.systemctl")(function* (
    args: ReadonlyArray<string>,
  ) {
    const present = new Set<string>();
    for (const candidate of userBusCandidates(environment, uid)) {
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        present.add(candidate);
      }
    }
    return yield* spawner
      .string(
        ChildProcess.make("systemctl", ["--user", ...args], {
          stdin: "ignore",
          stderr: "ignore",
          env: userBusEnv(environment, uid, (candidate) => present.has(candidate)),
          extendEnv: true,
        }),
      )
      .pipe(
        Effect.timeout(SYSTEMCTL_TIMEOUT),
        Effect.orElseSucceed(() => ""),
      );
  });

  /**
   * In-app and fleet updates swap the server under the running launcher and
   * never rewrite the unit, so a unit installed before this has no `Delegate`.
   * Without it the next `daemon-reload` takes the memory controller away from
   * the groups. The line is added to the installed unit and the user manager
   * reloads; nothing restarts.
   */
  const ensureDelegation =
    options.ensureDelegation ??
    Effect.gen(function* () {
      const show = systemctl(["show", unit, "--property=Delegate", "--property=FragmentPath"]);
      const before = yield* show;
      if (/^Delegate=yes$/m.test(before)) return true;
      const unitFile = /^FragmentPath=(\/.+)$/m.exec(before)?.[1];
      if (unitFile === undefined) return false;
      const installed = yield* readText(unitFile);
      // Only the unit this build's installer writes is edited.
      if (!new RegExp(`^ExecStart=.*${LAUNCHER_COMMAND}`, "m").test(installed)) return false;
      const delegated = withUnitDelegation(installed);
      if (delegated !== undefined) {
        const written = yield* Effect.scoped(
          Effect.gen(function* () {
            const temporary = yield* fs.makeTempFileScoped({
              directory: path.dirname(unitFile),
              prefix: ".service-write-",
            });
            yield* fs.writeFileString(temporary, delegated, { mode: 0o600 });
            yield* fs.rename(temporary, unitFile);
          }),
        ).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (!written) return false;
      }
      yield* systemctl(["daemon-reload"]);
      return /^Delegate=yes$/m.test(yield* show);
    });

  /**
   * Moves processes out of `fromRelative`. The list came from that group, and
   * each is checked to still be in it right before the write, so a recycled
   * pid that now belongs to something else is left alone.
   */
  const relocate = Effect.fn("AgentMemoryLimit.relocate")(function* (
    pids: ReadonlyArray<number>,
    fromRelative: string,
    paths: Readonly<Record<AgentMemoryGroup, string>>,
    keepInPlace: AgentMemoryGroup | undefined,
  ) {
    const entries = yield* Effect.forEach(pids, readEntry, { concurrency: 8 });
    const table = new Map(entries.flatMap((entry) => (entry === null ? [] : [[entry.pid, entry] as const])));
    for (const entry of table.values()) {
      const group = groupOf(entry, table, ids);
      if (group === keepInPlace) continue;
      // It is moving itself into its own session group; the two moves must not cross.
      if ((yield* readText(`${procRoot}/${entry.pid}/cmdline`)).includes(ACP_WRAPPER)) continue;
      const now = parseUnifiedCgroupPath(yield* readText(`${procRoot}/${entry.pid}/cgroup`));
      if (now !== fromRelative) continue;
      yield* write(`${paths[group]}/cgroup.procs`, `${entry.pid}\n`, "a");
    }
  });

  const setup = Effect.gen(function* () {
    if (environment[SERVICE_LAUNCHER_CONTEXT_ENV] === undefined || !launcherHost.connected) {
      return yield* unavailable("the server was not started by the service launcher");
    }
    if (!(yield* readText(`${procRoot}/${ids.launcherPid}/cmdline`)).includes(LAUNCHER_COMMAND)) {
      return yield* unavailable("the server's parent is not the service launcher");
    }
    const own = parseUnifiedCgroupPath(yield* readText(`${procRoot}/self/cgroup`));
    const unitRelative = own === undefined ? undefined : unitCgroupOf(own, unit);
    if (unitRelative === undefined) {
      return yield* unavailable("the server does not run in the service unit's cgroup (cgroup v2)");
    }
    const unitPath = `${cgroupRoot}${unitRelative}`;
    const controllers = (yield* readText(`${unitPath}/cgroup.controllers`)).trim().split(/\s+/);
    if (!controllers.includes("memory")) {
      return yield* unavailable("the service's cgroup has no memory controller");
    }
    const memory = parseMemory(yield* readText(`${procRoot}/meminfo`), "");
    const unitMax = Number((yield* readText(`${unitPath}/memory.max`)).trim());
    const plan =
      memory === null
        ? null
        : planAgentMemory(memory.totalKb * 1024, Number.isFinite(unitMax) ? unitMax : null);
    if (plan === null) return yield* unavailable("the machine has too little memory to divide");
    if (!(yield* ensureDelegation)) {
      return yield* unavailable("the service unit could not be given Delegate=yes", true);
    }

    const paths = {
      server: `${unitPath}/server`,
      agents: `${unitPath}/agents`,
      apps: `${unitPath}/apps`,
    };
    for (const group of Object.values(paths)) {
      yield* fs.makeDirectory(group).pipe(Effect.ignore);
    }
    // A cgroup with processes of its own cannot hand a controller to its
    // children, so the unit's own group is emptied first: this process and the
    // launcher, then whatever else is there.
    const serverRelative = `${unitRelative}/server`;
    for (const pid of [ids.selfPid, ids.launcherPid]) {
      const at = parseUnifiedCgroupPath(yield* readText(`${procRoot}/${pid}/cgroup`));
      if (at === serverRelative) continue;
      if (at !== unitRelative || !(yield* write(`${paths.server}/cgroup.procs`, `${pid}\n`, "a"))) {
        return yield* unavailable("the server could not move into its own group", true);
      }
    }
    let divided = false;
    for (let attempt = 0; attempt < EMPTY_ROOT_ATTEMPTS && !divided; attempt++) {
      const left = parsePids(yield* readText(`${unitPath}/cgroup.procs`)).filter(
        (pid) => pid !== ids.selfPid && pid !== ids.launcherPid,
      );
      yield* relocate(left, unitRelative, paths, undefined);
      divided = yield* write(`${unitPath}/cgroup.subtree_control`, "+memory\n");
    }
    if (!divided) {
      return yield* unavailable("the memory controller could not be given to the groups", true);
    }

    // Best effort: the limit on agent work is what protects the machine.
    yield* write(`${paths.server}/memory.min`, `${plan.serverReserveBytes}\n`);
    yield* write(`${paths.server}/memory.swap.max`, "0\n");
    yield* write(`${paths.agents}/memory.swap.max`, "0\n");
    return {
      serverPath: paths.server,
      serverRelative,
      agentsPath: paths.agents,
      agentsRelative: `${unitRelative}/agents`,
      appsPath: paths.apps,
      plan,
    } satisfies Layout;
  });

  /** False when the group has no memory files any more. */
  const applyLimit = Effect.fn("AgentMemoryLimit.applyLimit")(function* (layout: Layout) {
    const held = heldBytesOf(
      yield* readText(`${layout.agentsPath}/memory.current`),
      yield* readText(`${layout.agentsPath}/memory.stat`),
    );
    const memory = parseMemory(yield* readText(`${procRoot}/meminfo`), "");
    if (held === null || memory === null) return false;
    const limit = agentLimitBytes(layout.plan, held, memory.availableKb * 1024, state.limitBytes);
    if (state.limitBytes !== null && Math.abs(limit - state.limitBytes) < LIMIT_STEP_BYTES) {
      return true;
    }
    if (!(yield* write(`${layout.agentsPath}/memory.max`, `${limit}\n`))) return false;
    state.limitBytes = limit;
    setAgentWorkCgroup({
      relativePath: layout.agentsRelative,
      path: layout.agentsPath,
      limitBytes: limit,
    });
    return true;
  });

  const turnOff = (now: number, retryInMs: number | undefined) => {
    state.layout = undefined;
    state.limitBytes = null;
    state.nextSetupAt = retryInMs === undefined ? Number.POSITIVE_INFINITY : now + retryInMs;
    setAgentWorkCgroup(undefined);
  };

  const start = Effect.fn("AgentMemoryLimit.start")(function* (now: number) {
    const layout = yield* setup;
    state.limitBytes = null;
    if (!(yield* applyLimit(layout))) {
      return yield* unavailable("the limit on agent work could not be written", true);
    }
    state.layout = layout;
    state.failures = 0;
    state.reported = undefined;
    // Not sooner than this again, should the limit vanish straight away.
    state.nextSetupAt = now + REPAIR_INTERVAL_MS;
    yield* Effect.logInfo("agent memory limit is on", {
      limitBytes: state.limitBytes,
      ceilingBytes: layout.plan.ceilingBytes,
      shareBytes: layout.plan.shareBytes,
      headroomBytes: layout.plan.headroomBytes,
      serverReserveBytes: layout.plan.serverReserveBytes,
    });
  });

  /** One pass: set the groups up when they are not, else move strays and follow memory. */
  const pass = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (state.layout === undefined) {
      if (now < state.nextSetupAt) return;
      yield* start(now).pipe(
        Effect.catchTag("AgentMemoryLimitUnavailable", (error) =>
          Effect.gen(function* () {
            const retry = error.retry && state.failures++ < SETUP_RETRIES;
            turnOff(now, retry ? SETUP_RETRY_MS : undefined);
            if (state.reported === error.reason) return;
            state.reported = error.reason;
            yield* Effect.logWarning("agent memory limit is off; the service runs as before", {
              reason: error.reason,
            });
          }),
        ),
      );
      return;
    }
    const layout = state.layout;
    const strays = parsePids(yield* readText(`${layout.serverPath}/cgroup.procs`));
    yield* relocate(
      strays,
      layout.serverRelative,
      { server: layout.serverPath, agents: layout.agentsPath, apps: layout.appsPath },
      "server",
    );
    if (yield* applyLimit(layout)) return;
    // A `daemon-reload` of a unit that lost its Delegate line takes the memory
    // controller away: the groups and processes stay, the limit is gone.
    turnOff(now, Math.max(0, state.nextSetupAt - now));
  });

  return { pass, state };
});

export function runLimitPasses<E, R>(pass: Effect.Effect<void, E, R>) {
  return pass.pipe(
    Effect.catchCause((cause) => Effect.logWarning("agent memory limit pass failed", { cause })),
    Effect.andThen(Effect.sleep(PASS_INTERVAL)),
    Effect.forever,
  );
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const environment = yield* HostProcessEnvironment;
    // Only a service installed by `specweave-studio service install` has a unit to divide.
    if (platform !== "linux" || (environment[BOOT_SERVICE_UNIT_ENV] ?? "") === "") return;
    if (environment[AGENT_MEMORY_LIMIT_ENV] === "off") {
      yield* Effect.logInfo(`agent memory limit is turned off (${AGENT_MEMORY_LIMIT_ENV}=off)`);
      return;
    }
    const limit = yield* makeAgentMemoryLimit();
    yield* runLimitPasses(limit.pass).pipe(Effect.forkScoped);
  }),
);
