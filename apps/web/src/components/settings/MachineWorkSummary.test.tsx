import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import type { StudioWorkGrant } from "@specweave-studio/contracts/studioFleet";
import { MachineLimits, MachineWorkSummary, machineLimitsOpen } from "./MachineWorkSummary";
import type { MachineWorkerGrant, MachineWorkHere } from "./machinesSettings.logic";

const m5 = EnvironmentId.make("env-m5");
const workers = (over: Partial<MachineWorkerGrant["workers"]> = {}): MachineWorkerGrant => ({
  status: "allowed",
  label: "Allowed",
  detail: "",
  workers: {
    status: "allowed",
    access: "full-access",
    expiresAt: "2026-12-13T12:00:00Z" as never,
    renewable: true,
    problem: null,
    ...over,
  },
});
const grant: StudioWorkGrant = {
  coordinatorEnvironmentId: m5,
  machineLabel: "M5",
  projects: { kind: "all" },
  accounts: { kind: "all" },
  owner: "self",
  hopLimit: 2,
  runtimeCap: "full-access",
  expiresAt: "2026-12-13T12:00:00Z" as never,
  status: "active",
  revokedAt: null,
  interruptAt: null,
  runningThreads: 0,
  legacy: false,
  routines: true,
  kind: "own",
};
const here = (value: StudioWorkGrant): MachineWorkHere => ({
  status: value.status,
  label: "Allowed",
  detail: "",
  grant: value,
  projects: [{ id: ProjectId.make("p"), title: "specweave", linkedTo: [] }],
  projectsUnreadable: false,
});
const render = (props: Parameters<typeof MachineWorkSummary>[0]) =>
  renderToStaticMarkup(<MachineWorkSummary {...props} />);

describe("a machine card's work summary", () => {
  it("says both directions in a few words, the renewal on hover", () => {
    const html = render({
      hereLabel: "M4",
      thereLabel: "M5",
      workers: workers(),
      workHere: here(grant),
    });
    expect(html).toContain(">Full access<");
    expect(html).toContain(">All projects<");
    expect(html).toContain("Agents on M4 can start work on M5. Renews automatically.");
    expect(html).toContain("Agents on M5 can start work on M4.");
  });

  it("gives a date only when the grant will not renew", () => {
    const html = render({
      hereLabel: "M4",
      thereLabel: "M5",
      workers: workers({ renewable: false }),
      workHere: null,
    });
    expect(html).toMatch(/>Full access, until [^<]+</);
    expect(html).not.toContain("Renews automatically");
    // Not set up that way yet.
    expect(html).toContain(">Not allowed<");
  });

  it("flags a grant that allows no project here", () => {
    const html = render({
      hereLabel: "M4",
      thereLabel: "M1",
      workers: null,
      workHere: here({ ...grant, projects: { kind: "linked" } }),
    });
    expect(html).toContain(">No projects allowed<");
    expect(html).toContain(">Not set up<");
  });

  it("folds the limits, opening them while a choice is needed", () => {
    expect(renderToStaticMarkup(<MachineLimits open={false}>x</MachineLimits>)).not.toContain(
      'open=""',
    );
    expect(renderToStaticMarkup(<MachineLimits open>x</MachineLimits>)).toContain('open=""');
  });

  it("opens Limits by itself while a choice is pending or access runs out", () => {
    const base = {
      workers: workers(),
      workHere: here(grant),
      addForAgents: false,
      allowBack: false,
    };
    expect(machineLimitsOpen(base)).toBe(false);
    expect(machineLimitsOpen({ ...base, workers: { ...workers(), status: "expiring" } })).toBe(
      true,
    );
    expect(machineLimitsOpen({ ...base, workers: { ...workers(), status: "not-allowed" } })).toBe(
      true,
    );
    expect(machineLimitsOpen({ ...base, workers: null, addForAgents: true })).toBe(true);
    expect(machineLimitsOpen({ ...base, workHere: null, allowBack: true })).toBe(true);
    expect(machineLimitsOpen({ ...base, addForAgents: true, allowBack: true })).toBe(false);
  });
});
