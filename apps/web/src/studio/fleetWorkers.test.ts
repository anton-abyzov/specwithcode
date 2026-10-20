import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";
import type {
  StudioFleetSnapshot,
  StudioFleetWorkers,
} from "@specweave-studio/contracts/studioFleet";
import {
  sentSecretsWarning,
  fleetRemoveNotice,
  fleetWorkersView,
  workerMachineChoices,
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
    const choices = workerMachineChoices(snapshot, here, null);
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

  it("keeps a chosen machine listed, with its pinned project, even once its grant lapses", () => {
    const current = {
      machineId: "m3",
      environmentId: EnvironmentId.make("env-m3"),
      projectId: null,
    };
    expect(workerMachineChoices(snapshot, here, current)[2]).toMatchObject({
      value: "m3",
      disabled: false,
    });
    expect(
      workerMachineChoices(snapshot, here, { ...current, machineId: "gone" }).at(-1),
    ).toMatchObject({
      value: "gone",
      label: expect.stringContaining("not in this server's fleet"),
    });
    // While the machines are still being read, a saved one is not called missing.
    expect(workerMachineChoices(null, here, { ...current, machineId: "m3" }).at(-1)).toMatchObject({
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
