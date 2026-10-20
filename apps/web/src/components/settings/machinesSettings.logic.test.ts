import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@specweave-studio/contracts";
import type {
  StudioFleetMachine,
  StudioFleetSnapshot,
} from "@specweave-studio/contracts/studioFleet";

import {
  buildMachineRows,
  connectBothWaysInstruction,
  pairingLinkBaseUrl,
  sharedProjectRole,
  unseenFleetMachines,
  type MachineProjectInput,
} from "./machinesSettings.logic";

const m4 = EnvironmentId.make("env-m4");
const m3 = EnvironmentId.make("env-m3");
const m1 = EnvironmentId.make("env-m1");
const laptop = EnvironmentId.make("env-laptop");

const fleetMachine = (
  environmentId: EnvironmentId,
  label: string,
  extra: Partial<StudioFleetMachine> = {},
): StudioFleetMachine => ({
  id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  environmentId,
  label,
  url: `https://${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.tailnet.ts.net`,
  status: "reachable",
  pairingConfigured: true,
  ...extra,
});

const fleet = (machines: StudioFleetMachine[]): StudioFleetSnapshot => ({
  configured: true,
  connectPermission: "access:write",
  observedAt: "2026-10-19T12:00:00Z",
  listener: "network",
  machines,
});

const member = (environmentId: EnvironmentId, projectId: string) => ({
  environmentId,
  projectId: ProjectId.make(projectId),
  coordinatorThreadId: ThreadId.make(`project-coordinator:${projectId}`),
});

const easyChamp = (
  environmentId: EnvironmentId,
  projectId: string,
  workspaceRoot: string,
  binding?: "active" | "transferring" | "transferred",
): MachineProjectInput => ({
  environmentId,
  id: projectId,
  title: "easychamp checkout",
  workspaceRoot,
  workspaceSettings: {
    kind: "code",
    logicalProject: {
      id: "logical-easychamp",
      title: "EasyChamp",
      coordinatorId: "coordinator",
      members: [member(m4, "p-m4"), member(m3, "p-m3")],
    },
    ...(binding ? { coordinatorBinding: { epoch: 1, state: binding } } : {}),
  },
});

const env = (environmentId: EnvironmentId, label: string, phase = "connected") => ({
  environmentId,
  label,
  phase,
  statusText: phase === "connected" ? "Connected" : "Connecting…",
});

describe("machine rows", () => {
  it("names the role a shared project's copy has from its coordinator binding", () => {
    expect(sharedProjectRole(undefined)).toBe("coordinator");
    expect(sharedProjectRole({ state: "active" })).toBe("coordinator");
    expect(sharedProjectRole({ state: "transferred" })).toBe("runs-workers");
    expect(sharedProjectRole({ state: "transferring" })).toBe("handoff-pending");
  });

  it("puts this machine first, then connected machines, then private machines this app cannot see", () => {
    const rows = buildMachineRows({
      environments: [env(m3, "MacBook Pro"), env(m4, "M4MAX")],
      primaryEnvironmentId: m4,
      fleet: fleet([fleetMachine(m3, "MacBook Pro"), fleetMachine(m1, "M1Max")]),
      canPair: true,
      projects: [],
      hostBlocks: [],
    });
    expect(rows.map((row) => [row.label, row.seen.state, row.seen.text])).toEqual([
      ["M4MAX", "this-machine", "This machine"],
      ["MacBook Pro", "connected", "This app can see it"],
      ["M1Max", "not-connected", "This app cannot see it"],
    ]);
    // Connect only for the machine this app cannot see; both ways only for a connected private machine.
    expect(rows.map((row) => row.connect?.label ?? null)).toEqual([null, null, "Connect"]);
    expect(rows.map((row) => row.connectBothWays)).toEqual([false, true, false]);
  });

  it("explains why Connect cannot be pressed yet", () => {
    const rows = buildMachineRows({
      environments: [env(m4, "M4MAX")],
      primaryEnvironmentId: m4,
      fleet: fleet([
        fleetMachine(m3, "MacBook Pro", { status: "unreachable" }),
        fleetMachine(m1, "M1Max", { pairingConfigured: false }),
        fleetMachine(laptop, "Laptop"),
      ]),
      canPair: false,
      projects: [],
      hostBlocks: [],
    });
    expect(rows.slice(1).map((row) => row.connect)).toEqual([
      { enabled: false, label: "Unreachable" },
      { enabled: false, label: "Pairing needs setup" },
      { enabled: false, label: "Pairing permission required" },
    ]);
  });

  it("shows the worker grant this server holds on each private machine", () => {
    const workers = (status: "allowed" | "expiring" | "not_allowed" | "revoked") => ({
      status,
      access: status === "allowed" || status === "expiring" ? ("auto" as const) : null,
      expiresAt: null,
      renewable: true,
      problem: null,
    });
    const rows = buildMachineRows({
      environments: [env(m4, "M4MAX"), env(m3, "MacBook Pro")],
      primaryEnvironmentId: m4,
      fleet: fleet([
        fleetMachine(m3, "MacBook Pro", { workers: workers("allowed") }),
        fleetMachine(m1, "M1Max", { workers: workers("expiring") }),
        fleetMachine(laptop, "Laptop", { workers: workers("revoked") }),
      ]),
      canPair: true,
      projects: [],
      hostBlocks: [],
    });
    expect(rows.map((row) => row.workers?.status ?? null)).toEqual([
      null,
      "allowed",
      "expiring",
      "not-allowed",
    ]);
    expect(rows[1]?.workers?.label).toBe("Workers allowed");
    expect(rows[3]?.workers?.label).toBe("Workers not allowed");
  });

  it("lists shared projects with role and folder, and names them on a hidden machine without guessing", () => {
    const solo: MachineProjectInput = {
      environmentId: m4,
      id: "p-solo",
      title: "Solo",
      workspaceRoot: "/Users/a/solo",
      workspaceSettings: {
        logicalProject: {
          id: "logical-solo",
          title: "Solo",
          coordinatorId: "c",
          members: [member(m4, "p-solo")],
        },
      },
    };
    const rows = buildMachineRows({
      environments: [env(m4, "M4MAX"), env(m3, "MacBook Pro")],
      primaryEnvironmentId: m4,
      fleet: fleet([fleetMachine(m3, "MacBook Pro")]),
      canPair: true,
      projects: [
        easyChamp(m4, "p-m4", "/Users/a/Projects/sw-easychamp"),
        easyChamp(m3, "p-m3", "/Users/a/easychamp", "transferred"),
        solo,
      ],
      hostBlocks: [],
    });
    expect(rows[0]?.sharedProjects).toEqual([
      {
        key: "logical-easychamp",
        title: "EasyChamp",
        role: "coordinator",
        roleLabel: "Coordinator",
        folder: "/Users/a/Projects/sw-easychamp",
      },
    ]);
    expect(rows[1]?.sharedProjects.map((project) => project.roleLabel)).toEqual(["Runs workers"]);

    const hidden = buildMachineRows({
      environments: [env(m4, "M4MAX")],
      primaryEnvironmentId: m4,
      fleet: fleet([fleetMachine(m3, "MacBook Pro")]),
      canPair: true,
      projects: [easyChamp(m4, "p-m4", "/Users/a/Projects/sw-easychamp", "transferring")],
      hostBlocks: [],
    });
    expect(hidden[0]?.sharedProjects[0]?.roleLabel).toBe("Handoff pending");
    expect(hidden[1]?.sharedProjects).toEqual([
      {
        key: "logical-easychamp",
        title: "EasyChamp",
        role: null,
        roleLabel: "Connect to see its role",
        folder: null,
      },
    ]);
    expect(hidden[1]?.accounts).toBeNull();
  });

  it("reuses the limits model's accounts and also on", () => {
    const rows = buildMachineRows({
      environments: [env(m4, "M4MAX"), env(m3, "MacBook Pro")],
      primaryEnvironmentId: m4,
      fleet: null,
      canPair: true,
      projects: [],
      hostBlocks: [
        {
          environmentId: m3,
          providers: [
            {
              key: "codex",
              driver: ProviderDriverKind.make("codex"),
              label: "Codex",
              iconUrl: undefined,
              identity: "someone@example.com",
              plan: null,
              sharedWith: ["M4MAX"],
              windows: [],
              peak: null,
              bankedResets: 0,
              notice: null,
              checkedAt: null,
            },
          ],
        },
      ],
    });
    expect(rows[0]?.accounts).toEqual([]);
    expect(rows[1]?.accounts).toEqual([
      { key: "codex", provider: "Codex", identity: "someone@example.com", alsoOn: ["M4MAX"] },
    ]);
    // Not a private machine of this server: no worker grant, no both-ways step.
    expect(rows[1]?.workers).toBeNull();
    expect(rows[1]?.connectBothWays).toBe(false);
  });

  it("finds private machines this app cannot see, including one saved at an address it left", () => {
    const moved = fleetMachine(m3, "MacBook Pro");
    expect(
      unseenFleetMachines({
        fleet: fleet([moved, fleetMachine(m1, "M1Max"), fleetMachine(m4, "M4MAX")]),
        primaryEnvironmentId: m4,
        savedEnvironmentIds: new Set([m4, m3, m1]),
        savedOrigins: new Map([
          [m3, new Set(["https://old.example.ts.net"])],
          [m1, new Set(["https://m1max.tailnet.ts.net"])],
        ]),
      }).map((machine) => machine.label),
    ).toEqual(["MacBook Pro"]);
  });
});

describe("connect both ways", () => {
  it("prefers the address the other machine already uses, and never a loopback or app origin", () => {
    expect(
      pairingLinkBaseUrl({
        addressSeenThere: "https://m4max.tailnet.ts.net/",
        pageUrl: "http://localhost:8319",
        directEndpoints: [],
        advertisedEndpoints: [],
      }),
    ).toBe("https://m4max.tailnet.ts.net");
    expect(
      pairingLinkBaseUrl({
        addressSeenThere: null,
        pageUrl: "studio://app",
        directEndpoints: [{ httpBaseUrl: "http://127.0.0.1:8319" }],
        advertisedEndpoints: [{ httpBaseUrl: "http://100.64.0.4:8319" }],
      }),
    ).toBe("http://100.64.0.4:8319");
    expect(
      pairingLinkBaseUrl({
        addressSeenThere: null,
        pageUrl: "http://localhost:8319",
        directEndpoints: [],
        advertisedEndpoints: [],
      }),
    ).toBeNull();
  });

  it("names the exact place to paste the link", () => {
    expect(connectBothWaysInstruction("MacBook Pro")).toBe(
      "On MacBook Pro, open Settings > Connections > Add environment > Remote link and paste this link.",
    );
  });
});
