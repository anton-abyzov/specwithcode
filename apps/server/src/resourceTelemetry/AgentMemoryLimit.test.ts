// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessUserId } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as BootService from "../cloud/bootService.ts";
import { ServiceLauncherHostProcess } from "../cloud/serviceLauncherClient.ts";
import { forgetExitedUserApps, recordUserOpenedApp } from "../process/userOpenedApps.ts";
import {
  agentLimitBytes,
  groupOf,
  heldBytesOf,
  makeAgentMemoryLimit,
  planAgentMemory,
  unitCgroupOf,
} from "./AgentMemoryLimit.ts";
import { agentWorkCgroup, setAgentWorkCgroup } from "./agentWorkCgroup.ts";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const UNIT = "/user.slice/user-1000.slice/user@1000.service/app.slice/studio.service";
const LAUNCHER = 2;
const SELF = 3;

describe("planAgentMemory", () => {
  it("keeps the larger of 6 GB and a quarter of memory from agent work", () => {
    // 28.65 GiB with the unit's MemoryMax=75%: the unit limit less the server's 2 GiB is lower.
    const total = 30_044_996 * 1024;
    assert.deepEqual(planAgentMemory(total, 23_074_553_856), {
      ceilingBytes: Math.floor((23_074_553_856 - 2 * GIB) / MIB) * MIB,
      shareBytes: Math.floor(total / 4 / MIB) * MIB,
      headroomBytes: Math.floor((total * 0.08) / MIB) * MIB,
      serverReserveBytes: 2 * GIB,
    });
    assert.equal(planAgentMemory(64 * GIB, null)?.ceilingBytes, 48 * GIB);
    assert.equal(planAgentMemory(16 * GIB, null)?.ceilingBytes, 10 * GIB);
  });

  it("never goes under half of a small machine, and gives up on a tiny one", () => {
    assert.deepEqual(planAgentMemory(8 * GIB, null), {
      ceilingBytes: 4 * GIB,
      shareBytes: 4 * GIB,
      headroomBytes: GIB,
      serverReserveBytes: GIB,
    });
    assert.equal(planAgentMemory(4 * GIB, 3 * GIB)?.shareBytes, 2 * GIB);
    assert.isNull(planAgentMemory(256 * MIB, null));
    assert.isNull(planAgentMemory(0, null));
  });
});

describe("agentLimitBytes", () => {
  const plan = {
    ceilingBytes: 20 * GIB,
    shareBytes: 7 * GIB,
    headroomBytes: 2 * GIB,
    serverReserveBytes: 2 * GIB,
  };

  it("lets agent work take what is spare, up to the ceiling", () => {
    assert.equal(agentLimitBytes(plan, 5 * GIB, 10 * GIB, null), 13 * GIB);
    assert.equal(agentLimitBytes(plan, 5 * GIB, 30 * GIB, null), 20 * GIB);
    // Growing into the spare memory does not move the limit.
    assert.equal(agentLimitBytes(plan, 9 * GIB, 6 * GIB, 13 * GIB), 13 * GIB);
  });

  it("always leaves agent work its share", () => {
    assert.equal(agentLimitBytes(plan, GIB, 0, null), 7 * GIB);
    assert.equal(agentLimitBytes(plan, GIB, 0, 12 * GIB), 7 * GIB);
  });

  it("with nothing spare holds agent work where it is and never follows it up", () => {
    const first = agentLimitBytes(plan, 10 * GIB, GIB, 15 * GIB);
    assert.equal(first, 10 * GIB + 64 * MIB);
    assert.equal(agentLimitBytes(plan, first, GIB, first), first);
    assert.equal(agentLimitBytes(plan, 9 * GIB, GIB, first), 9 * GIB + 64 * MIB);
    assert.equal(agentLimitBytes(plan, 9 * GIB, 6 * GIB, first), 13 * GIB);
  });

  it("does not set a first limit under what agent work already holds", () => {
    assert.equal(agentLimitBytes(plan, 22 * GIB + 5, 30 * GIB, null), 22 * GIB + MIB);
    assert.equal(agentLimitBytes(plan, 21 * GIB, 30 * GIB, 22 * GIB + MIB), 21 * GIB);
    assert.equal(agentLimitBytes(plan, 19 * GIB, 30 * GIB, 21 * GIB), 20 * GIB);
  });
});

describe("the service's groups", () => {
  it("finds the unit's cgroup from the server's own", () => {
    assert.equal(unitCgroupOf(UNIT, "studio.service"), UNIT);
    assert.equal(unitCgroupOf(`${UNIT}/server`, "studio.service"), UNIT);
    assert.isUndefined(unitCgroupOf(`${UNIT}/agents`, "studio.service"));
    assert.isUndefined(unitCgroupOf("/user.slice/session-3.scope", "studio.service"));
    assert.isUndefined(unitCgroupOf(`${UNIT} (deleted)`, "studio.service"));
    assert.isUndefined(unitCgroupOf(UNIT, ""));
  });

  it("keeps the launcher, servers and the tunnel together and sends the rest to agents", () => {
    const entry = (pid: number, comm: string, ppid: number) => ({
      pid,
      ppid,
      comm,
      rssBytes: 0,
      startTime: "1",
    });
    const all = [
      entry(LAUNCHER, "node", 1),
      entry(SELF, "node", LAUNCHER),
      entry(4, "cloudflared", SELF),
      entry(5, "node", LAUNCHER),
      entry(10, "claude", SELF),
      entry(11, "cloudflared", 10),
      entry(20, "code", SELF),
      entry(21, "code", 20),
    ];
    const table = new Map(all.map((each) => [each.pid, each] as const));
    const ids = { selfPid: SELF, launcherPid: LAUNCHER };
    const groups = all.map((each) => groupOf(each, table, ids, (pid) => pid === 20));
    assert.deepEqual(groups, [
      "server",
      "server",
      "server",
      "server",
      "agents",
      "agents",
      "apps",
      "apps",
    ]);
  });

  it("counts agent memory without the file cache", () => {
    assert.equal(
      heldBytesOf("1000\n", "anon 500\nfile 400\ninactive_file 250\nactive_file 50\nshmem 100\n"),
      700,
    );
    // Some kernels keep shared memory on the file lists; without swap it stays.
    assert.equal(
      heldBytesOf("1000\n", "anon 100\nfile 800\ninactive_file 500\nactive_file 300\nshmem 600\n"),
      800,
    );
    assert.equal(heldBytesOf("1000\n", ""), 1000);
    assert.isNull(heldBytesOf("", ""));
  });
});

const stat = (pid: number, comm: string, ppid: number) =>
  `${pid} (${comm}) S ${ppid} 1 1 0 -1 4194304 1 0 0 0 1 1 0 0 20 0 1 0 100 1000 10 18446744073709551615`;

type FakeProcess = readonly [
  pid: number,
  comm: string,
  ppid: number,
  cgroup?: string,
  cmdline?: string,
];

const meminfo = (availableGib: number) =>
  `MemTotal: ${32 * 1024 * 1024} kB\nMemAvailable: ${Math.round(availableGib * 1024 * 1024)} kB\n`;

/** A /proc and a cgroup tree in a temp folder; the unit's own group holds every process. */
function fakeMachine(processes: ReadonlyArray<FakeProcess>, own = UNIT) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agent-memory-"));
  const proc = NodePath.join(root, "proc");
  const cgroup = NodePath.join(root, "cgroup");
  const unit = NodePath.join(cgroup, UNIT);
  const addProcess = ([pid, comm, ppid, at = UNIT, cmdline = comm]: FakeProcess) => {
    NodeFS.mkdirSync(NodePath.join(proc, String(pid)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(proc, String(pid), "stat"), stat(pid, comm, ppid));
    NodeFS.writeFileSync(NodePath.join(proc, String(pid), "cgroup"), `0::${at}\n`);
    NodeFS.writeFileSync(NodePath.join(proc, String(pid), "cmdline"), cmdline);
  };
  NodeFS.mkdirSync(NodePath.join(proc, "self"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(proc, "self/cgroup"), `0::${own}\n`);
  NodeFS.writeFileSync(NodePath.join(proc, "meminfo"), meminfo(12));
  for (const each of processes) addProcess(each);
  // What the kernel puts in a cgroup directory; mkdir on a real one makes them.
  NodeFS.mkdirSync(NodePath.join(unit, "agents"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(unit, "cgroup.controllers"), "memory pids\n");
  NodeFS.writeFileSync(
    NodePath.join(unit, "cgroup.procs"),
    processes.map(([pid]) => `${pid}\n`).join(""),
  );
  NodeFS.writeFileSync(NodePath.join(unit, "memory.max"), `${24 * GIB}\n`);
  NodeFS.writeFileSync(NodePath.join(unit, "agents/memory.current"), `${6 * GIB}\n`);
  NodeFS.writeFileSync(NodePath.join(unit, "agents/memory.stat"), `inactive_file ${GIB}\n`);
  const read = (file: string) => {
    try {
      return NodeFS.readFileSync(NodePath.join(unit, file), "utf8");
    } catch {
      return undefined;
    }
  };
  return {
    proc,
    cgroup,
    unit,
    read,
    addProcess,
    write: (file: string, value: string) => NodeFS.writeFileSync(NodePath.join(unit, file), value),
    setAvailable: (gib: number) =>
      NodeFS.writeFileSync(NodePath.join(proc, "meminfo"), meminfo(gib)),
  };
}

const SERVICE: ReadonlyArray<FakeProcess> = [
  [LAUNCHER, "node", 1, UNIT, "/x/specweave-studio\0__service-launcher\0"],
  [SELF, "node", LAUNCHER, UNIT, "/x/specweave-studio\0serve\0"],
  [4, "cloudflared", SELF],
  [10, "claude", SELF],
  [11, "tsc", 10],
  [20, "code", SELF],
];

const asService = (connected = true) =>
  Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
    return yield* effect.pipe(
      Effect.provideService(HostProcessEnvironment, {
        STUDIO_BOOT_SERVICE_UNIT: "studio.service",
        STUDIO_SERVICE_LAUNCHER_CONTEXT: "{}",
      }),
      Effect.provideService(HostProcessUserId, 1000),
      Effect.provideService(ServiceLauncherHostProcess, {
        connected,
        send: () => true,
        on: () => {},
        off: () => {},
      }),
    );
  });

const machineOptions = (machine: ReturnType<typeof fakeMachine>, delegated = true) => ({
  procRoot: machine.proc,
  cgroupRoot: machine.cgroup,
  selfPid: SELF,
  launcherPid: LAUNCHER,
  ensureDelegation: Effect.succeed(delegated),
});

describe("makeAgentMemoryLimit", () => {
  it.effect("divides the unit's cgroup, reserves the server and limits agent work", () =>
    Effect.gen(function* () {
      const machine = fakeMachine(SERVICE);
      recordUserOpenedApp(20);
      try {
        const limit = yield* makeAgentMemoryLimit(machineOptions(machine));
        yield* limit.pass;

        assert.equal(machine.read("server/cgroup.procs"), `${SELF}\n${LAUNCHER}\n4\n`);
        assert.equal(machine.read("agents/cgroup.procs"), "10\n11\n");
        assert.equal(machine.read("apps/cgroup.procs"), "20\n");
        assert.equal(machine.read("cgroup.subtree_control"), "+memory\n");
        assert.equal(machine.read("server/memory.min"), `${2 * GIB}\n`);
        assert.equal(machine.read("server/memory.swap.max"), "0\n");
        assert.equal(machine.read("agents/memory.swap.max"), "0\n");
        // 32 GiB: 5 GiB held without its cache, 12 available, 2.56 kept back for the machine.
        const expected = 17 * GIB - Math.floor((32 * GIB * 0.08) / MIB) * MIB;
        assert.equal(machine.read("agents/memory.max"), `${expected}\n`);
        assert.deepEqual(agentWorkCgroup(), {
          relativePath: `${UNIT}/agents`,
          path: NodePath.join(machine.unit, "agents"),
          limitBytes: expected,
          appsPath: NodePath.join(machine.unit, "apps"),
        });
        // An app opened now goes to its group before it can fork.
        recordUserOpenedApp(41);
        assert.equal(machine.read("apps/cgroup.procs"), "20\n41\n");
      } finally {
        forgetExitedUserApps(() => false);
        setAgentWorkCgroup(undefined);
      }
    }).pipe(asService(), Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("moves what the server starts out of its group, and follows memory", () =>
    Effect.gen(function* () {
      const server = `${UNIT}/server`;
      const machine = fakeMachine(
        [
          [LAUNCHER, "node", 1, server, "/x/specweave-studio\0__service-launcher\0"],
          [SELF, "node", LAUNCHER, server],
        ],
        server,
      );
      try {
        const limit = yield* makeAgentMemoryLimit(machineOptions(machine));
        yield* limit.pass;
        assert.equal(machine.read("server/cgroup.procs"), undefined, "nothing had to move");
        const before = machine.read("agents/memory.max");

        machine.addProcess([4, "cloudflared", SELF, server]);
        machine.addProcess([5, "node", LAUNCHER, server]);
        machine.addProcess([30, "bash", SELF, server]);
        machine.addProcess([31, "zsh", 30, server]);
        // A pid from the list that is something else by now.
        machine.addProcess([32, "firefox", 1, "/user.slice/session-3.scope"]);
        machine.addProcess([33, "sh", SELF, server, "/bin/sh\0-c\0x\0studio-acp-cgroup-wrapper\0"]);
        machine.write("server/cgroup.procs", `${LAUNCHER}\n${SELF}\n4\n5\n30\n31\n32\n33\n`);
        NodeFS.rmSync(NodePath.join(machine.unit, "agents/cgroup.procs"), { force: true });
        machine.setAvailable(12.004);
        yield* limit.pass;
        assert.equal(machine.read("agents/cgroup.procs"), "30\n31\n");
        assert.equal(machine.read("agents/memory.max"), before, "a few megabytes are not written");

        machine.setAvailable(4);
        yield* limit.pass;
        assert.equal(machine.read("agents/memory.max"), `${8 * GIB}\n`);
        assert.equal(agentWorkCgroup()?.limitBytes, 8 * GIB, "the share: a quarter of 32 GiB");

        machine.setAvailable(30);
        yield* limit.pass;
        assert.equal(machine.read("agents/memory.max"), `${22 * GIB}\n`, "the unit's 24 less 2");
      } finally {
        setAgentWorkCgroup(undefined);
      }
    }).pipe(asService(), Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves everything alone when the server is not the launcher's child", () =>
    Effect.gen(function* () {
      const machine = fakeMachine(SERVICE);
      const limit = yield* makeAgentMemoryLimit(machineOptions(machine));
      yield* limit.pass;
      yield* TestClock.adjust("10 minutes");
      yield* limit.pass;
      assert.equal(limit.state.reported, "the server was not started by the service launcher");
      assert.equal(limit.state.nextSetupAt, Number.POSITIVE_INFINITY);
      assert.isUndefined(machine.read("server/cgroup.procs"));
      assert.isUndefined(machine.read("cgroup.subtree_control"));
      assert.isUndefined(agentWorkCgroup());
    }).pipe(asService(false), Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves everything alone without the memory controller or in another cgroup", () =>
    Effect.gen(function* () {
      const noController = fakeMachine(SERVICE);
      noController.write("cgroup.controllers", "pids\n");
      const first = yield* makeAgentMemoryLimit(machineOptions(noController));
      yield* first.pass;
      assert.equal(first.state.reported, "the service's cgroup has no memory controller");
      assert.isUndefined(noController.read("server/cgroup.procs"));

      // A server an agent started from its shell inherits the service's environment.
      const fromAgent = fakeMachine(SERVICE, `${UNIT}/agents`);
      const second = yield* makeAgentMemoryLimit(machineOptions(fromAgent));
      yield* second.pass;
      assert.equal(
        second.state.reported,
        "the server does not run in the service unit's cgroup (cgroup v2)",
      );
      assert.isUndefined(fromAgent.read("server/cgroup.procs"));
    }).pipe(asService(), Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("moves nothing without delegation, and tries again a few times", () =>
    Effect.gen(function* () {
      const machine = fakeMachine(SERVICE);
      let asked = 0;
      const limit = yield* makeAgentMemoryLimit({
        ...machineOptions(machine),
        ensureDelegation: Effect.sync(() => {
          asked++;
          return false;
        }),
      });
      yield* limit.pass;
      yield* limit.pass;
      assert.equal(asked, 1, "not again before the retry is due");
      assert.isUndefined(machine.read("server/cgroup.procs"));
      for (let retry = 0; retry < 8; retry++) {
        yield* TestClock.adjust("1 minute");
        yield* limit.pass;
      }
      assert.equal(asked, 6);
      assert.equal(limit.state.nextSetupAt, Number.POSITIVE_INFINITY);
      assert.isUndefined(agentWorkCgroup());
    }).pipe(asService(), Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("sets the groups up again when the limit vanishes", () =>
    Effect.gen(function* () {
      const machine = fakeMachine(SERVICE);
      let asked = 0;
      try {
        const limit = yield* makeAgentMemoryLimit({
          ...machineOptions(machine),
          ensureDelegation: Effect.sync(() => {
            asked++;
            return true;
          }),
        });
        yield* limit.pass;
        // What a daemon-reload does to a unit without Delegate: the memory files go.
        NodeFS.rmSync(NodePath.join(machine.unit, "agents/memory.current"));
        yield* limit.pass;
        assert.isUndefined(agentWorkCgroup(), "ACP sessions stop using the group");
        yield* limit.pass;
        assert.equal(asked, 1, "not more often than every 30 seconds");

        machine.write("agents/memory.current", `${6 * GIB}\n`);
        yield* TestClock.adjust("30 seconds");
        yield* limit.pass;
        assert.equal(asked, 2);
        assert.equal(agentWorkCgroup()?.relativePath, `${UNIT}/agents`);
      } finally {
        setAgentWorkCgroup(undefined);
      }
    }).pipe(asService(), Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

const linuxPlan = {
  program: ["/home/dev/.specweave-studio/runtime/versions/1.0.0/specweave-studio", "__service-launcher"],
  baseDir: "/home/dev/.specweave-studio",
  logPath: "/home/dev/.specweave-studio/userdata/logs/boot-service.log",
  unitPath: "/home/dev/.config/systemd/user/studio.service",
};

/** `systemctl --user`: reports the unit file as the user manager would after a reload. */
function systemctlFake(unitFile: string) {
  const calls: Array<string> = [];
  let loaded = NodeFS.readFileSync(unitFile, "utf8");
  const encoder = new TextEncoder();
  const spawner = ChildProcessSpawner.make((command) => {
    const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
    calls.push(args.join(" "));
    if (args[1] === "daemon-reload") loaded = NodeFS.readFileSync(unitFile, "utf8");
    const output =
      args[1] === "show"
        ? `Delegate=${/^Delegate=yes$/m.test(loaded) ? "yes" : "no"}\nFragmentPath=${unitFile}\n`
        : "";
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(output)),
        stderr: Stream.make(encoder.encode("")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { spawner, calls };
}

describe("an installation from before the limit", () => {
  const installUnit = (text: string) => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agent-memory-unit-"));
    const unitFile = NodePath.join(directory, "studio.service");
    NodeFS.writeFileSync(unitFile, text);
    return unitFile;
  };
  const withoutSystemctl = (machine: ReturnType<typeof fakeMachine>) => ({
    procRoot: machine.proc,
    cgroupRoot: machine.cgroup,
    selfPid: SELF,
    launcherPid: LAUNCHER,
  });

  it.effect("gets Delegate=yes added to its unit and one reload, then its groups", () => {
    const current = BootService.renderBootServiceUnit(linuxPlan);
    const unitFile = installUnit(current.replace("Delegate=yes\n", ""));
    const systemctl = systemctlFake(unitFile);
    return Effect.gen(function* () {
      const machine = fakeMachine(SERVICE);
      try {
        const limit = yield* makeAgentMemoryLimit(withoutSystemctl(machine));
        yield* limit.pass;
        assert.equal(NodeFS.readFileSync(unitFile, "utf8"), current);
        assert.deepEqual(systemctl.calls, [
          "--user show studio.service --property=Delegate --property=FragmentPath",
          "--user daemon-reload",
          "--user show studio.service --property=Delegate --property=FragmentPath",
        ]);
        assert.equal(machine.read("cgroup.subtree_control"), "+memory\n");
        assert.isDefined(agentWorkCgroup());

        // The next server under the same launcher finds the unit ready.
        const next = yield* makeAgentMemoryLimit(withoutSystemctl(machine));
        yield* next.pass;
        assert.equal(systemctl.calls.length, 4);
        assert.equal(NodeFS.readFileSync(unitFile, "utf8"), current);
      } finally {
        setAgentWorkCgroup(undefined);
      }
    }).pipe(
      asService(),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, systemctl.spawner),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("does not edit a unit that is not the service launcher's", () => {
    const foreign = "[Unit]\nDescription=x\n\n[Service]\nExecStart=/usr/bin/other serve\n";
    const unitFile = installUnit(foreign);
    const systemctl = systemctlFake(unitFile);
    return Effect.gen(function* () {
      const machine = fakeMachine(SERVICE);
      const limit = yield* makeAgentMemoryLimit(withoutSystemctl(machine));
      yield* limit.pass;
      assert.equal(NodeFS.readFileSync(unitFile, "utf8"), foreign);
      assert.equal(limit.state.reported, "the service unit could not be given Delegate=yes");
      assert.isUndefined(machine.read("server/cgroup.procs"));
    }).pipe(
      asService(),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, systemctl.spawner),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });
});
