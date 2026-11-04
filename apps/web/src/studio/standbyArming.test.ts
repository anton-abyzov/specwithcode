import { describe, expect, it } from "vite-plus/test";
import type {
  StudioFleetMachine,
  StudioFleetSnapshot,
  StudioFleetWorkers,
  StudioWorkGrant,
} from "@specweave-studio/contracts/studioFleet";
import {
  armStandby,
  disarmStandby,
  ensureStandbyGrant,
  rearmGrantPairs,
  rearmReadiness,
  saveRearmList,
  standbyArmingProblem,
  standbyGrantScope,
  standbyWorkerMachines,
  type StandbyArmingCommands,
  type StandbyProjectCommands,
  type StandbySide,
  type StandbyWorkerMachine,
} from "./standbyArming";

const M4 = "m4" as never;
const M1 = "m1" as never;
const M3 = "m3" as never;
const M2 = "m2" as never;
const LABELS: Record<string, string> = { m4: "M4", m1: "M1", m3: "M3", m2: "M2" };
const label = (id: string) => LABELS[id] ?? id;

const workers = (overrides: Partial<StudioFleetWorkers> = {}): StudioFleetWorkers => ({
  status: "allowed",
  access: "auto",
  expiresAt: "2026-11-25T00:00:00.000Z",
  renewable: true,
  problem: null,
  ...overrides,
});
const machine = (
  environmentId: string,
  id: string,
  machineWorkers?: StudioFleetWorkers,
): StudioFleetMachine => ({
  id,
  label: label(environmentId),
  environmentId: environmentId as never,
  url: `https://${environmentId}.example.ts.net`,
  status: "reachable",
  pairingConfigured: true,
  ...(machineWorkers ? { workers: machineWorkers } : {}),
});
const fleet = (machines: StudioFleetMachine[]): StudioFleetSnapshot => ({
  configured: true,
  connectPermission: "access:write",
  observedAt: "2026-10-26T12:00:00.000Z",
  listener: "network",
  machines,
});
const grant = (overrides: Partial<StudioWorkGrant> = {}): StudioWorkGrant => ({
  coordinatorEnvironmentId: M1,
  machineLabel: "M1",
  projects: { kind: "linked" },
  accounts: { kind: "all" },
  owner: "self",
  hopLimit: 2,
  runtimeCap: null,
  expiresAt: "2026-11-25T00:00:00.000Z",
  status: "active",
  revokedAt: null,
  interruptAt: null,
  runningThreads: 0,
  legacy: false,
  ...overrides,
});
const member = (environmentId: string, projectId: string) => ({
  environmentId: environmentId as never,
  projectId: projectId as never,
  coordinatorThreadId: `project-coordinator:${projectId}` as never,
});
const side = (environmentId: string, projectId: string): StandbySide => ({
  environmentId: environmentId as never,
  projectId: projectId as never,
  member: member(environmentId, projectId),
  label: label(environmentId),
});
const m3Worker: StandbyWorkerMachine = {
  environmentId: M3,
  projectId: "p-m3" as never,
  label: "M3",
  access: "auto-accept-edits",
};

/** A fake fleet: what each machine holds, and every call in order. */
function fakeFleet(
  options: {
    standbyMachines?: StudioFleetMachine[];
    grantsOn?: Record<string, StudioWorkGrant[]>;
    allowResult?: StudioFleetWorkers | Error;
    revokeFails?: boolean;
    setFails?: Error;
    /** Machines whose consent write fails. */
    consentFails?: string[];
    /** The line goes over SpecWithCode Connect: it names its session only once redeemed. */
    overConnect?: boolean;
    /** add fails after the line was redeemed, or its answer is lost. */
    addFails?: Error;
  } = {},
) {
  const calls: string[] = [];
  const pending = new Map<string, string[]>();
  const commands: StandbyArmingCommands & StandbyProjectCommands = {
    fleet: async (environmentId) => {
      calls.push(`fleet ${environmentId}`);
      return fleet(options.standbyMachines ?? []);
    },
    workGrants: async (environmentId) => {
      calls.push(`grants ${environmentId}`);
      return { grants: options.grantsOn?.[environmentId] ?? [], projects: [], accounts: [] };
    },
    invite: async (environmentId, input) => {
      calls.push(`invite ${environmentId} for ${input.coordinatorEnvironmentId}`);
      return options.overConnect
        ? { code: `code-${environmentId}` }
        : { code: `code-${environmentId}`, sessionId: `mgmt-${environmentId}` };
    },
    add: async (environmentId, invitation) => {
      calls.push(`add ${environmentId} ${invitation}`);
      if (options.addFails) throw options.addFails;
      return options.overConnect
        ? { id: "machine-w", sessionId: `redeemed-${invitation}` }
        : { id: "machine-w" };
    },
    allow: async (environmentId, input) => {
      calls.push(`allow ${environmentId} ${input.id} ${input.access}`);
      if (options.allowResult instanceof Error) throw options.allowResult;
      return options.allowResult ?? workers({ access: input.access });
    },
    updateGrant: async (environmentId, input) => {
      calls.push(`update ${environmentId} ${JSON.stringify(input)}`);
      return grant();
    },
    revokeSession: async (environmentId, sessionId) => {
      calls.push(`revoke ${environmentId} ${sessionId}`);
      if (options.revokeFails) throw new Error("offline");
    },
    redeemedSessions: async (environmentId, coordinatorEnvironmentId) => {
      calls.push(`sessions ${environmentId} for ${coordinatorEnvironmentId}`);
      return options.overConnect ? [`redeemed-code-${environmentId}`] : [];
    },
    pendingRevocations: {
      read: (environmentId) => pending.get(environmentId) ?? [],
      write: (environmentId, ids) => void pending.set(environmentId, [...ids]),
    },
    acceptStandby: async (environmentId, input) => {
      if (input.rearm !== undefined) {
        calls.push(
          `consent ${environmentId} ${
            input.rearm === null
              ? "null"
              : `${input.rearm.chainId} ${input.rearm.members.map((m) => m.environmentId).join(",")} from ${input.rearm.fromEpoch}`
          }`,
        );
        if (options.consentFails?.includes(environmentId)) throw new Error("Unreachable.");
        return;
      }
      calls.push(`accept ${environmentId} ${JSON.stringify(input.standby)}`);
    },
    setStandby: async (environmentId, input) => {
      calls.push(`set ${environmentId} ${JSON.stringify(input.standby)}`);
      if (options.setFails && input.standby !== null) throw options.setFails;
    },
  };
  return { commands, calls, pending };
}

describe("standbyWorkerMachines", () => {
  it("lists only machines the coordinator runs workers on that hold a copy, never M4 or M1", () => {
    const machines = standbyWorkerMachines({
      coordinatorEnvironmentId: M4,
      standbyEnvironmentId: M1,
      coordinatorFleet: fleet([
        machine("m1", "a", workers()),
        machine("m3", "b", workers({ access: "auto-accept-edits" })),
        machine("m2", "c", workers({ status: "not_allowed", access: null })),
        machine("m4", "d", workers()),
      ]),
      members: [
        { environmentId: M4, id: "p-m4" as never },
        { environmentId: M1, id: "p-m1" as never },
        { environmentId: M3, id: "p-m3" as never },
        { environmentId: M2, id: "p-m2" as never },
      ],
      label,
    });
    expect(machines).toEqual([m3Worker]);
  });

  it("skips a worker machine without a copy of the project", () => {
    expect(
      standbyWorkerMachines({
        coordinatorEnvironmentId: M4,
        standbyEnvironmentId: M1,
        coordinatorFleet: fleet([machine("m3", "b", workers())]),
        members: [{ environmentId: M4, id: "p-m4" as never }],
        label,
      }),
    ).toEqual([]);
  });
});

describe("standbyArmingProblem", () => {
  const base = {
    desktop: true,
    standbyLabel: "M1",
    standbyCapable: true,
    fullAccess: () => true,
    label,
    coordinatorEnvironmentId: M4,
    standbyEnvironmentId: M1,
    workers: [m3Worker],
  };
  it("runs only in the desktop app", () => {
    expect(standbyArmingProblem({ ...base, desktop: false })).toBe(
      "Set this up in the SpecWithCode desktop app.",
    );
  });
  it("needs a standby that can take over", () => {
    expect(standbyArmingProblem({ ...base, standbyCapable: false })).toBe(
      "Update SpecWithCode on M1 to take over automatically.",
    );
  });
  it("needs full access to every machine involved", () => {
    expect(standbyArmingProblem({ ...base, fullAccess: (id) => id !== M3 })).toBe(
      "This app needs full access to M3 to set this up.",
    );
    expect(standbyArmingProblem(base)).toBeNull();
  });
});

describe("standbyGrantScope", () => {
  it("scopes a new grant to W's copy only", () => {
    expect(standbyGrantScope(undefined, "p-m3" as never)).toEqual({
      kind: "listed",
      projectIds: ["p-m3"],
    });
  });
  it("adds the copy to a listed grant and leaves broader ones as the owner set them", () => {
    expect(
      standbyGrantScope(
        grant({ projects: { kind: "listed", projectIds: ["other" as never] } }),
        "p-m3" as never,
      ),
    ).toEqual({ kind: "listed", projectIds: ["other", "p-m3"] });
    expect(
      standbyGrantScope(
        grant({ projects: { kind: "listed", projectIds: ["p-m3" as never] } }),
        "p-m3" as never,
      ),
    ).toBeNull();
    expect(standbyGrantScope(grant(), "p-m3" as never)).toBeNull();
  });
});

describe("ensureStandbyGrant", () => {
  const input = { standbyEnvironmentId: M1, standbyLabel: "M1", worker: m3Worker };

  it("runs invite, add, allow at M4's access, narrow, then revokes the management session", async () => {
    const { commands, calls, pending } = fakeFleet();
    expect(await ensureStandbyGrant(commands, input)).toEqual({ status: "ready" });
    expect(calls).toEqual([
      "fleet m1",
      "grants m3",
      "invite m3 for m1",
      "add m1 code-m3",
      "allow m1 machine-w auto-accept-edits",
      `update m3 ${JSON.stringify({ coordinatorEnvironmentId: "m1", projects: { kind: "listed", projectIds: ["p-m3"] } })}`,
      "revoke m3 mgmt-m3",
    ]);
    expect(pending.get("m3") ?? []).toEqual([]);
    // Nothing is minted for M1 on M4.
    expect(calls.some((call) => call.startsWith("invite m4") || call.startsWith("add m4"))).toBe(
      false,
    );
  });

  it("over Connect, revokes the session the line was redeemed for", async () => {
    const { commands, calls, pending } = fakeFleet({ overConnect: true });
    expect(await ensureStandbyGrant(commands, input)).toEqual({ status: "ready" });
    expect(calls.at(-1)).toBe("revoke m3 redeemed-code-m3");
    expect(pending.get("m3") ?? []).toEqual([]);
  });

  it("over Connect, finds and revokes the redeemed session when add fails", async () => {
    const { commands, calls } = fakeFleet({
      overConnect: true,
      addFails: new Error("M1 did not answer in time."),
    });
    expect(await ensureStandbyGrant(commands, input)).toEqual({
      status: "failed",
      message: "M1 did not answer in time.",
    });
    expect(calls.slice(-2)).toEqual(["sessions m3 for m1", "revoke m3 redeemed-code-m3"]);
  });

  it("reuses a live grant without a new credential and only narrows a listed one", async () => {
    const { commands, calls } = fakeFleet({
      standbyMachines: [machine("m3", "machine-w", workers())],
      grantsOn: { m3: [grant({ projects: { kind: "listed", projectIds: ["other" as never] } })] },
    });
    expect(await ensureStandbyGrant(commands, input)).toEqual({ status: "ready" });
    expect(calls).toEqual([
      "fleet m1",
      "grants m3",
      `update m3 ${JSON.stringify({ coordinatorEnvironmentId: "m1", projects: { kind: "listed", projectIds: ["other", "p-m3"] } })}`,
    ]);
  });

  it("revokes the management session even when allow fails, and reports the reason", async () => {
    const { commands, calls } = fakeFleet({
      allowResult: new Error("Wait a minute before allowing workers on this machine again."),
    });
    expect(await ensureStandbyGrant(commands, input)).toEqual({
      status: "failed",
      message: "Wait a minute before allowing workers on this machine again.",
    });
    expect(calls.at(-1)).toBe("revoke m3 mgmt-m3");
    expect(calls.some((call) => call.startsWith("update"))).toBe(false);
  });

  it("says when W did not answer the standby", async () => {
    const { commands } = fakeFleet({
      allowResult: workers({ status: "not_allowed", access: null, problem: "unreachable" }),
    });
    expect(await ensureStandbyGrant(commands, input)).toEqual({
      status: "failed",
      message: "M3 did not answer M1. Check that both are on and connected.",
    });
  });

  it("keeps a failed revoke and retries it first next time", async () => {
    const first = fakeFleet({ revokeFails: true });
    expect(await ensureStandbyGrant(first.commands, input)).toEqual({
      status: "failed",
      message: "Could not remove the setup access on M3. Try again.",
    });
    expect(first.pending.get("m3")).toEqual(["mgmt-m3"]);
    const { commands: _commands, ...retry } = fakeFleet({
      standbyMachines: [machine("m3", "machine-w", workers())],
      grantsOn: { m3: [grant({ projects: { kind: "listed", projectIds: ["p-m3" as never] } })] },
    });
    const commands = {
      ..._commands,
      pendingRevocations: first.commands.pendingRevocations,
    };
    expect(await ensureStandbyGrant(commands, input)).toEqual({ status: "ready" });
    expect(retry.calls[0]).toBe("revoke m3 mgmt-m3");
    expect(first.pending.get("m3")).toEqual([]);
  });

  it("does not undo a stop the owner made on W", async () => {
    const { commands, calls } = fakeFleet({ grantsOn: { m3: [grant({ status: "revoked" })] } });
    expect(await ensureStandbyGrant(commands, input)).toEqual({
      status: "failed",
      message: "M3 stopped M1's access. Restore it on M3 first.",
    });
    expect(calls.some((call) => call.startsWith("invite"))).toBe(false);
  });
});

describe("armStandby", () => {
  const input = {
    logicalProjectId: "logical:1",
    coordinator: side("m4", "p-m4"),
    epoch: 3,
    standby: side("m1", "p-m1"),
    previousStandby: null,
    afterMinutes: 15 as const,
    workers: [m3Worker],
    operationId: "7307ab55-fc59-4e07-abeb-de54be69215f",
    changeAnyway: false,
  };

  it("grants first, then the standby accepts, then the coordinator names it", async () => {
    const { commands, calls } = fakeFleet();
    const result = await armStandby(commands, input);
    expect(result.armed).toBe(true);
    expect(result.machines.get(M3)).toEqual({ status: "ready" });
    expect(calls.slice(-2)).toEqual([
      `accept m1 ${JSON.stringify({ coordinator: member("m4", "p-m4"), epoch: 3, afterMinutes: 15 })}`,
      `set m4 ${JSON.stringify({ member: member("m1", "p-m1"), afterMinutes: 15 })}`,
    ]);
  });

  it("arms nothing while a worker machine is not ready", async () => {
    const { commands, calls } = fakeFleet({ allowResult: new Error("Unreachable.") });
    const result = await armStandby(commands, input);
    expect(result.armed).toBe(false);
    expect(result.machines.get(M3)).toEqual({ status: "failed", message: "Unreachable." });
    expect(calls.some((call) => call.startsWith("accept") || call.startsWith("set"))).toBe(false);
  });

  it("disarms the standby again when the coordinator refuses", async () => {
    const { commands, calls } = fakeFleet({ setFails: new Error("standby_unreachable") });
    await expect(armStandby(commands, input)).rejects.toThrow("standby_unreachable");
    expect(calls.at(-1)).toBe("accept m1 null");
  });

  it("clears the previous standby's registration after a change", async () => {
    const { commands, calls } = fakeFleet();
    await armStandby(commands, {
      ...input,
      workers: [],
      previousStandby: side("m3", "p-m3"),
      changeAnyway: true,
    });
    expect(calls).toEqual([
      `accept m1 ${JSON.stringify({ coordinator: member("m4", "p-m4"), epoch: 3, afterMinutes: 15 })}`,
      `set m4 ${JSON.stringify({ member: member("m1", "p-m1"), afterMinutes: 15 })}`,
      "accept m3 null",
    ]);
  });
});

describe("disarmStandby", () => {
  it("releases on the coordinator first, then clears the standby", async () => {
    const { commands, calls } = fakeFleet();
    await disarmStandby(commands, {
      logicalProjectId: "logical:1",
      coordinator: side("m4", "p-m4"),
      standby: side("m1", "p-m1"),
      operationId: "7307ab55-fc59-4e07-abeb-de54be69215f",
      changeAnyway: false,
    });
    expect(calls).toEqual(["set m4 null", "accept m1 null"]);
  });
});

describe("re-arm list", () => {
  const all = () => true;
  const access = () => "auto" as const;

  it("pairs every listed machine with every other listed machine and each worker", () => {
    const pairs = rearmGrantPairs({
      members: [side("m1", "p-m1"), side("m2", "p-m2"), side("m4", "p-m4")],
      workers: [m3Worker],
      access,
    });
    expect(pairs.map((pair) => `${pair.from.environmentId}>${pair.on.environmentId}`)).toEqual([
      "m1>m3",
      "m1>m2",
      "m1>m4",
      "m2>m3",
      "m2>m1",
      "m2>m4",
      "m4>m3",
      "m4>m1",
      "m4>m2",
    ]);
    // A worker keeps the coordinator's access; a listed machine gets the access given for it.
    expect(pairs[0]!.on).toEqual(m3Worker);
    expect(pairs[1]!.on).toEqual({
      environmentId: M2,
      projectId: "p-m2",
      label: "M2",
      access: "auto",
    });
  });

  it("flags an old server, another list, a missing grant and one that cannot renew", () => {
    const grants: Record<string, StudioFleetWorkers | null> = {
      "m1>m3": workers(),
      "m1>m2": workers(),
      "m2>m3": workers({ status: "expiring", renewable: false }),
      "m2>m1": workers(),
      "m4>m3": null,
    };
    const readiness = rearmReadiness({
      members: [side("m1", "p-m1"), side("m2", "p-m2"), side("m4", "p-m4"), side("m3", "p-m3")],
      workers: [],
      capable: (environmentId) => environmentId !== "m3",
      grants: (from, on) => grants[`${from}>${on}`],
      consents: new Map([
        [M1, "chain-a"],
        [M2, "chain-a"],
        [M4, "chain-b"],
      ]),
      chainId: "chain-a",
    });
    expect(readiness.map((entry) => [entry.member.environmentId, entry.problem])).toEqual([
      ["m1", null],
      ["m2", "expiring"],
      ["m4", "no_consent"],
      ["m3", "needs_update"],
    ]);
    const missing = rearmReadiness({
      members: [side("m1", "p-m1"), side("m4", "p-m4")],
      workers: [],
      capable: all,
      grants: (from) => (from === "m4" ? null : undefined),
      consents: new Map(),
      chainId: "chain-a",
    });
    expect(missing.map((entry) => entry.problem)).toEqual([null, "needs_grant"]);
  });

  it("grants, then writes the consent on each listed machine, then clears the dropped ones", async () => {
    const { commands, calls } = fakeFleet();
    const results = await saveRearmList(commands, {
      logicalProjectId: "logical:1",
      standby: side("m1", "p-m1"),
      afterMinutes: 15,
      chainId: "7307ab55-fc59-4e07-abeb-de54be69215f",
      workers: [],
      plan: {
        order: [side("m2", "p-m2")],
        previous: [side("m1", "p-m1"), side("m3", "p-m3")],
        fromEpoch: 4,
        capable: all,
        access,
      },
    });
    expect(calls.filter((call) => call.startsWith("consent"))).toEqual([
      "consent m1 7307ab55-fc59-4e07-abeb-de54be69215f m1,m2 from 4",
      "consent m2 7307ab55-fc59-4e07-abeb-de54be69215f m1,m2 from 4",
      "consent m3 null",
    ]);
    expect(calls.indexOf("invite m2 for m1")).toBeLessThan(
      calls.indexOf(calls.find((c) => c.startsWith("consent"))!),
    );
    expect(calls).toContain("invite m1 for m2");
    expect([...results]).toEqual([
      [M1, { status: "ready" }],
      [M2, { status: "ready" }],
    ]);
  });
});

describe("armStandby with a re-arm list", () => {
  const input = {
    logicalProjectId: "logical:1",
    coordinator: side("m4", "p-m4"),
    epoch: 3,
    standby: side("m1", "p-m1"),
    previousStandby: null,
    afterMinutes: 15 as const,
    workers: [] as StandbyWorkerMachine[],
    operationId: "7307ab55-fc59-4e07-abeb-de54be69215f",
    changeAnyway: false,
  };
  const plan = (capable: (environmentId: string) => boolean = () => true) => ({
    order: [side("m2", "p-m2"), side("m3", "p-m3")],
    previous: [],
    fromEpoch: 3,
    capable,
    access: () => "auto" as const,
  });

  it("writes the consent on every listed machine before the standby accepts and is named", async () => {
    const { commands, calls } = fakeFleet();
    const result = await armStandby(commands, { ...input, rearm: plan() });
    expect(result.armed).toBe(true);
    const lifecycle = calls.filter((call) => /^(consent|accept|set) /.test(call));
    expect(lifecycle).toEqual([
      "consent m1 7307ab55-fc59-4e07-abeb-de54be69215f m1,m2,m3 from 3",
      "consent m2 7307ab55-fc59-4e07-abeb-de54be69215f m1,m2,m3 from 3",
      "consent m3 7307ab55-fc59-4e07-abeb-de54be69215f m1,m2,m3 from 3",
      `accept m1 ${JSON.stringify({ coordinator: member("m4", "p-m4"), epoch: 3, afterMinutes: 15 })}`,
      `set m4 ${JSON.stringify({ member: member("m1", "p-m1"), afterMinutes: 15 })}`,
    ]);
    expect([...result.rearm.values()].every((entry) => entry.status === "ready")).toBe(true);
  });

  it("still arms the pair when a list machine is not ready, and says which", async () => {
    const { commands } = fakeFleet({ consentFails: ["m3"] });
    const result = await armStandby(commands, { ...input, rearm: plan() });
    expect(result.armed).toBe(true);
    expect(result.rearm.get(M3)).toEqual({
      status: "failed",
      message: "Could not save the list on M3: Unreachable.",
    });
    expect(result.rearm.get(M1)).toEqual({ status: "ready" });
  });

  it("marks a standby that cannot hold the list, and still arms it", async () => {
    const { commands, calls } = fakeFleet();
    const result = await armStandby(commands, {
      ...input,
      rearm: plan((environmentId) => environmentId !== "m1"),
    });
    expect(result.armed).toBe(true);
    expect(result.rearm.get(M1)).toEqual({ status: "needs_update" });
    expect(calls.some((call) => call.startsWith("consent m1"))).toBe(false);
  });
});

describe("saveRearmList syncs member lists first", () => {
  const coordinator = {
    environmentId: M4,
    logicalProjectId: "logical:1",
    member: member("m4", "p-m4"),
    epoch: 4,
    members: [member("m4", "p-m4"), member("m1", "p-m1"), member("m2", "p-m2")],
  };
  const save = (
    commands: StandbyArmingCommands & StandbyProjectCommands,
    membersSyncCapable: (environmentId: string) => boolean,
  ) =>
    saveRearmList(commands, {
      logicalProjectId: "logical:1",
      standby: side("m1", "p-m1"),
      afterMinutes: 15,
      chainId: "7307ab55-fc59-4e07-abeb-de54be69215f",
      workers: [],
      plan: {
        order: [side("m2", "p-m2")],
        previous: [],
        fromEpoch: 4,
        capable: () => true,
        access: () => "auto",
        coordinator,
        membersSyncCapable,
      },
    });

  it("syncs members on capable listed machines before granting and writing consent", async () => {
    const { commands, calls } = fakeFleet();
    const synced: string[] = [];
    const results = await save(
      {
        ...commands,
        syncMembers: async (environmentId, input) => {
          calls.push(
            `sync ${environmentId} ${input.members.length} from ${input.from.environmentId} at ${input.fromEpoch}`,
          );
          synced.push(environmentId);
        },
      },
      () => true,
    );
    expect(synced).toEqual(["m1", "m2"]);
    // Both syncs come before any grant or consent call.
    expect(calls.slice(0, 2).toSorted()).toEqual([
      "sync m1 3 from m4 at 4",
      "sync m2 3 from m4 at 4",
    ]);
    expect(calls.length).toBeGreaterThan(2);
    expect([...results.values()].every((result) => result.status === "ready")).toBe(true);
  });

  it("skips machines without linkedMembersSync, and a refusal never blocks the consent", async () => {
    const { commands, calls } = fakeFleet();
    const synced: string[] = [];
    const results = await save(
      {
        ...commands,
        syncMembers: async (environmentId) => {
          synced.push(environmentId);
          throw new Error("Refused.");
        },
      },
      (environmentId) => environmentId !== "m2",
    );
    expect(synced).toEqual(["m1"]);
    expect(calls.filter((call) => call.startsWith("consent"))).toHaveLength(2);
    expect(results.get(M1)).toEqual({ status: "ready" });
  });
});

describe("disarmStandby with a re-arm list", () => {
  it("removes the consent from every list machine after turning it off", async () => {
    const { commands, calls } = fakeFleet();
    await disarmStandby(commands, {
      logicalProjectId: "logical:1",
      coordinator: side("m4", "p-m4"),
      standby: side("m1", "p-m1"),
      operationId: "7307ab55-fc59-4e07-abeb-de54be69215f",
      changeAnyway: false,
      rearmMembers: [side("m1", "p-m1"), side("m2", "p-m2")],
    });
    expect(calls).toEqual(["set m4 null", "accept m1 null", "consent m1 null", "consent m2 null"]);
  });
});
