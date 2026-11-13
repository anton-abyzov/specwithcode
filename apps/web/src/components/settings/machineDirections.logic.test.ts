import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";
import type { StudioWorkGrant } from "@specweave-studio/contracts/studioFleet";
import { incomingLine, outgoingLine } from "./machineDirections.logic";
import type { MachineWorkerGrant, MachineWorkHere } from "./machinesSettings.logic";

const m4 = EnvironmentId.make("env-m4");
const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const grant = (extra: Partial<StudioWorkGrant> = {}): StudioWorkGrant =>
  ({
    coordinatorEnvironmentId: m4,
    machineLabel: "m4",
    projects: { kind: "all" },
    accounts: { kind: "all" },
    owner: "self",
    hopLimit: 2,
    runtimeCap: "auto",
    expiresAt: null,
    status: "active",
    revokedAt: null,
    interruptAt: null,
    runningThreads: 0,
    legacy: false,
    ...extra,
  }) as StudioWorkGrant;

const here = (extra: Partial<StudioWorkGrant> = {}): MachineWorkHere => ({
  status: extra.status ?? "active",
  label: "",
  detail: "",
  grant: grant(extra),
  projects: [],
  projectsUnreadable: false,
});

describe("incomingLine", () => {
  const line = (workHere: MachineWorkHere | null, durations = true) =>
    incomingLine({ there: "m4", workHere, durations, canSetUp: true });

  it("says one sentence with its time limit and Stop", () => {
    const endsAt = "2026-11-20T15:00:00.000Z";
    expect(line(here({ endsAt }))).toEqual({
      allowed: true,
      sentence: "m4 can start work here",
      facts: ["All projects", `until ${day(endsAt)}`],
      note: null,
      action: "stop",
    });
    expect(line(here()).facts).toEqual(["All projects", "until you stop it"]);
    // A machine from before time limits names no end for a renewing grant.
    expect(line(here({ renews: true }), false).facts).toEqual(["All projects"]);
  });

  it("says what happened when it ended or was stopped, and offers Allow…", () => {
    const endsAt = "2026-11-20T15:00:00.000Z";
    expect(line(here({ status: "revoked", ended: true, endsAt, revokedAt: endsAt }))).toEqual({
      allowed: false,
      sentence: "m4 can't start work here",
      facts: [],
      note: `Time limit ended ${day(endsAt)}.`,
      action: "allow",
    });
    const stopped = line(
      here({
        status: "revoked",
        revokedAt: "2026-11-14T10:00:00.000Z",
        interruptAt: "2026-11-14T10:02:00.000Z",
        runningThreads: 2,
      }),
    );
    expect(stopped.note).toMatch(/^Stopped Nov 14\. 2 running threads stop at .+\.$/u);
    expect(stopped.action).toBe("allow");
  });

  it("offers the first-time setup for a machine never allowed", () => {
    expect(line(null)).toMatchObject({
      sentence: "m4 can't start work here",
      facts: ["Not set up"],
      action: "allow-setup",
    });
  });
});

describe("outgoingLine", () => {
  const workers = (
    status: MachineWorkerGrant["status"],
    extra: Partial<MachineWorkerGrant["workers"]> = {},
  ): MachineWorkerGrant => ({
    status,
    label: "",
    detail: "",
    workers: {
      status: status === "not-allowed" ? "revoked" : "allowed",
      access: "full-access",
      expiresAt: null,
      renewable: true,
      problem: null,
      ...extra,
    } as MachineWorkerGrant["workers"],
  });

  it("names the access this machine has there and offers Change…", () => {
    expect(outgoingLine({ there: "m4", workers: workers("allowed"), canSetUp: true })).toEqual({
      allowed: true,
      sentence: "This machine can start work on m4",
      facts: ["Full access"],
      note: null,
      action: "change",
    });
  });

  it("says Not set up with Set up…, and who stopped it", () => {
    expect(outgoingLine({ there: "m4", workers: null, canSetUp: true })).toMatchObject({
      sentence: "This machine can't start work on m4",
      facts: ["Not set up"],
      action: "set-up",
    });
    expect(
      outgoingLine({ there: "m4", workers: workers("not-allowed"), canSetUp: false }),
    ).toMatchObject({ note: "m4 stopped it.", action: null });
  });
});
