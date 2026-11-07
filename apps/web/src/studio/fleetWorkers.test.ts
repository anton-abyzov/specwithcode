import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, projectWorkerMachineOrder } from "@specweave-studio/contracts";
import type {
  StudioFleetSnapshot,
  StudioFleetWorkers,
} from "@specweave-studio/contracts/studioFleet";
import {
  DEFAULT_FLEET_WORKER_ACCESS,
  sentSecretsWarning,
  fleetRemoveNotice,
  fleetWorkerDraftAccess,
  fleetInviteCommand,
  fleetWorkersHelp,
  fleetWorkersView,
  moveWorkerMachine,
  workerMachineChoices,
  workerMachineListView,
  workerMachinesPatch,
} from "./fleetWorkers";

const base: StudioFleetWorkers = {
  status: "not_allowed",
  access: null,
  expiresAt: null,
  renewable: true,
  problem: null,
};

describe("fleet workers row", () => {
  it("offers Allow without a code when this server can pair there itself", () => {
    expect(fleetWorkersView(base)).toMatchObject({ action: "allow", codeNeeded: false });
  });

  it("asks for a pasted code when this server holds no pairing permission there", () => {
    expect(fleetWorkersView({ ...base, renewable: false })).toMatchObject({ codeNeeded: true });
    const rejected = fleetWorkersView({ ...base, problem: "pairing_code_rejected" });
    expect(rejected.codeNeeded).toBe(true);
    expect(rejected.problem).toContain("did not accept the pairing code");
  });

  it("shows the access ceiling and offers Stop once allowed", () => {
    const view = fleetWorkersView({
      ...base,
      status: "allowed",
      access: "auto-accept-edits",
      expiresAt: "2026-11-10T12:00:00.000Z",
    });
    expect(view.action).toBe("stop");
    // The composer's own name for the mode.
    expect(view.summary).toContain("Auto-accept edits");
    expect(view.summary).toContain("Renews on its own.");
  });

  it("says when workers there run below Full access, and not at Full access", () => {
    const lowered = fleetWorkersView({ ...base, status: "allowed", access: "approval-required" });
    expect(lowered.accessHint).toBe(
      "Workers there run at most at Supervised, even when their coordinator has Full access.",
    );
    expect(lowered.changeCodeNeeded).toBe(false);
    expect(
      fleetWorkersView({ ...base, status: "expiring", access: "full-access", renewable: false }),
    ).toMatchObject({ accessHint: null, changeCodeNeeded: true });
    expect(fleetWorkersView(base).accessHint).toBeNull();
  });

  it("starts the access choice at Full access, or at the grant's access once allowed", () => {
    expect(DEFAULT_FLEET_WORKER_ACCESS).toBe("full-access");
    expect(fleetWorkerDraftAccess(base)).toBe("full-access");
    expect(fleetWorkerDraftAccess(undefined)).toBe("full-access");
    expect(fleetWorkerDraftAccess({ ...base, status: "allowed", access: "auto" })).toBe("auto");
    // A lapsed grant's old access is not reused: allowing again starts at Full access.
    expect(fleetWorkerDraftAccess({ ...base, status: "expired", access: "auto" })).toBe(
      "full-access",
    );
  });

  it("says a revoked grant needs the user to allow it again", () => {
    expect(fleetWorkersView({ ...base, status: "revoked" })).toMatchObject({
      action: "allow",
      summary: expect.stringContaining("revoked"),
    });
  });
});

describe("worker machine choices", () => {
  const here = EnvironmentId.make("env-m4");
  const snapshot: StudioFleetSnapshot = {
    configured: true,
    connectPermission: "access:write",
    observedAt: "2026-10-12T00:00:00.000Z",
    listener: "loopback",
    machines: [
      {
        id: "m4",
        label: "M4",
        environmentId: here,
        url: "https://m4.fixture.ts.net",
        status: "reachable",
        pairingConfigured: true,
        workers: base,
      },
      {
        id: "m1",
        label: "M1",
        environmentId: EnvironmentId.make("env-m1"),
        url: "https://m1.fixture.ts.net",
        status: "reachable",
        pairingConfigured: true,
        workers: { ...base, status: "allowed", access: "auto" },
      },
      {
        id: "m3",
        label: "M3",
        environmentId: EnvironmentId.make("env-m3"),
        url: "https://m3.fixture.ts.net",
        status: "reachable",
        pairingConfigured: true,
        workers: base,
      },
    ],
  };

  it("lists this machine and allowed machines, and points to Connections for the rest", () => {
    const choices = workerMachineChoices(snapshot, here, []);
    expect(choices.map((choice) => [choice.value, choice.disabled])).toEqual([
      ["local", false],
      ["m1", false],
      ["m3", true],
    ]);
    expect(choices[1]?.machine).toEqual({
      machineId: "m1",
      environmentId: EnvironmentId.make("env-m1"),
      projectId: null,
    });
    expect(choices[2]?.label).toContain("Settings > Connections");
  });

  it("names each machine by its nickname when one is set", () => {
    const nickname = (environmentId: EnvironmentId, hostLabel: string) =>
      environmentId === EnvironmentId.make("env-m1") ? "M1" : hostLabel;
    const choices = workerMachineChoices(snapshot, here, [], nickname);
    expect(choices[1]?.label).toBe("M1");
    expect(choices[2]?.label).not.toContain("M1");
  });

  it("keeps a chosen machine listed, with its pinned project, even once its grant lapses", () => {
    const current = {
      machineId: "m3",
      environmentId: EnvironmentId.make("env-m3"),
      projectId: null,
    };
    expect(workerMachineChoices(snapshot, here, [current])[2]).toMatchObject({
      value: "m3",
      disabled: false,
    });
    expect(
      workerMachineChoices(snapshot, here, [{ ...current, machineId: "gone" }]).at(-1),
    ).toMatchObject({
      value: "gone",
      label: expect.stringContaining("not in this server's fleet"),
    });
    // While the machines are still being read, a saved one is not called missing.
    expect(
      workerMachineChoices(null, here, [{ ...current, machineId: "m3" }]).at(-1),
    ).toMatchObject({
      value: "m3",
      label: "m3",
    });
  });
});

describe("removing a machine", () => {
  const removed = {
    id: "m1",
    label: "Mac M1",
    managementToken: "revoked",
    workerAccess: "none",
    managementSessionId: "session-1",
  } as const;
  it("says it revoked what this machine held there", () => {
    expect(fleetRemoveNotice(removed)).toBe(
      "Removed Mac M1 and revoked what this machine held there.",
    );
  });
  it("says what stays valid there, and how to revoke it, when that machine was offline", () => {
    const notice = fleetRemoveNotice({ ...removed, managementToken: "kept", workerAccess: "kept" });
    expect(notice).toContain("worker access and management token there stays valid");
    expect(notice).toContain("On Mac M1, revoke it in Settings > Connections (session session-1)");
  });
});

describe("sentSecretsWarning", () => {
  const entry = (path: string) => ({ folder: "/p/app", path, sentAt: "2026-10-20T01:00:00Z" });
  it("says nothing when no secret file went there", () => {
    expect(sentSecretsWarning([], "M3")).toBeNull();
  });
  it("names the files to rotate, a few at a time", () => {
    expect(sentSecretsWarning([entry(".env")], "M3")).toBe(
      "A folder copy sent a secret file to M3: /p/app/.env. Rotate it if M3 should no longer hold it.",
    );
    const many = sentSecretsWarning(
      Array.from({ length: 7 }, (_, index) => entry(`.env.${index}`)),
      "M3",
    );
    expect(many).toContain("7 secret files to M3");
    expect(many).toContain("/p/app/.env.4 and 2 more. Rotate them");
  });
});

describe("worker machine lists", () => {
  const here = EnvironmentId.make("env-here");
  const local = { machineId: "local", environmentId: here, projectId: null };
  const m3 = { machineId: "m3", environmentId: EnvironmentId.make("env-m3"), projectId: null };
  const m1 = { machineId: "m1", environmentId: EnvironmentId.make("env-m1"), projectId: null };

  it("saves nothing for this machine alone, and keeps the first other machine for older hosts", () => {
    expect(workerMachinesPatch([local])).toEqual({ workerMachines: null, workerMachine: null });
    expect(workerMachinesPatch([])).toEqual({ workerMachines: null, workerMachine: null });
    expect(workerMachinesPatch([local, m3, m1])).toEqual({
      workerMachines: [local, m3, m1],
      workerMachine: m3,
    });
  });

  it("reads an older single choice as that machine, then this one", () => {
    expect(projectWorkerMachineOrder({ workerMachine: m3 }, here)).toEqual([m3, local]);
    expect(projectWorkerMachineOrder({ workerMachine: m3, workerMachines: [m1] }, here)).toEqual([
      m1,
    ]);
    expect(projectWorkerMachineOrder(null, here)).toEqual([local]);
  });

  it("moves entries within bounds and offers only machines not yet listed", () => {
    expect(moveWorkerMachine([local, m3, m1], 2, -1)).toEqual([local, m1, m3]);
    expect(moveWorkerMachine([local, m3], 0, -1)).toEqual([local, m3]);
    const choices = workerMachineChoices(null, here, [local, m3]);
    const view = workerMachineListView(choices, [m3, local]);
    expect(view.rows.map((row) => row.label)).toEqual(["m3", "This machine"]);
    expect(view.addable).toEqual([]);
  });
});

describe("fleetWorkersHelp", () => {
  it("defines the word, says what Stop leaves running, and exempts a person's typing", () => {
    const help = fleetWorkersHelp("M3").join(" ");
    expect(help).toContain("A worker is a thread that a coordinator starts");
    expect(help).toContain("start those threads on M3");
    expect(help).toContain("Moving your threads there needs it too.");
    expect(help).toContain("Workers already running there keep running");
    expect(help).toContain("What you type in a thread yourself does not need it.");
  });
});

describe("fleetInviteCommand", () => {
  it("leaves out quotes that cmd would pass through literally", () => {
    expect(fleetInviteCommand("2cd57c57-eecc-4be4-8e94-b783c2ca0d5c")).toBe(
      "specwithcode fleet invite --coordinator 2cd57c57-eecc-4be4-8e94-b783c2ca0d5c",
    );
  });
  it("quotes anything else", () => {
    expect(fleetInviteCommand("odd id")).toBe('specwithcode fleet invite --coordinator "odd id"');
  });
});
