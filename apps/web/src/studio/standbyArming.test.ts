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
