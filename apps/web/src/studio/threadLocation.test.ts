import { describe, expect, it } from "vite-plus/test";

import { threadLocation } from "./threadLocation";

const NAMES: Record<string, string> = { "env-m4": "M4", "env-minis": "Minis" };
const name = (id: string, fallback?: string | null) => NAMES[id] ?? fallback ?? id;

describe("threadLocation", () => {
  it("names one machine for a thread that never moved", () => {
    const location = threadLocation({ summary: {}, servingEnvironmentId: "env-m4", name });
    expect(location).toMatchObject({
      label: "M4",
      description: "Lives and runs on M4",
      moved: false,
      state: "running",
      ownerMachineId: "env-m4",
      executionMachineId: "env-m4",
    });
  });

  it("names both machines once execution moved", () => {
    const location = threadLocation({
      summary: {
        ownerMachineId: "env-m4" as never,
        executionMachineId: "env-minis" as never,
        executionState: "running",
      },
      servingEnvironmentId: "env-minis",
      name,
    });
    expect(location.label).toBe("M4 → Minis");
    expect(location.description).toBe("Lives on M4 · runs on Minis");
    expect(location.moved).toBe(true);
  });

  it("says a handed-off copy no longer runs here", () => {
    const location = threadLocation({
      summary: {
        ownerMachineId: "env-m4" as never,
        executionMachineId: "env-minis" as never,
        executionState: "fenced",
      },
      servingEnvironmentId: "env-m4",
      name,
    });
    expect(location.label).toBe("M4 → Minis");
    expect(location.description).toBe("Lives on M4 · handed off, Minis runs it now");
    expect(location.state).toBe("fenced");
  });

  it("reads Unknown when the execution machine is unreachable, never idle", () => {
    const location = threadLocation({
      summary: {
        ownerMachineId: "env-m4" as never,
        executionMachineId: "env-minis" as never,
        executionState: "running",
        executionLastSeenAt: "2026-10-20T21:14:00.000Z" as never,
      },
      servingEnvironmentId: "env-m4",
      name,
      unreachable: new Set(["env-minis"]),
      formatTime: () => "2:14 PM",
    });
    expect(location.state).toBe("unknown");
    expect(location.label).toBe("M4 → Minis");
    expect(location.description).toBe("Lives on M4 · Unknown · Minis last seen 2:14 PM");
  });

  it("does not guess a last-seen time it was never given", () => {
    const location = threadLocation({
      summary: {
        ownerMachineId: "env-m4" as never,
        executionMachineId: "env-minis" as never,
        executionState: "unknown",
      },
      servingEnvironmentId: "env-m4",
      name,
    });
    expect(location.description).toBe("Lives on M4 · Unknown · Minis not reached yet");
  });

  it("leaves the serving machine's own reachability to the row", () => {
    const location = threadLocation({
      summary: {},
      servingEnvironmentId: "env-minis",
      name,
      unreachable: new Set(["env-minis"]),
    });
    expect(location.state).toBe("running");
    expect(location.label).toBe("Minis");
  });

  it("uses the label the server sent for a machine this device has no name for", () => {
    const location = threadLocation({
      summary: {
        ownerMachineId: "env-m4" as never,
        executionMachineId: "env-studio" as never,
        executionMachineLabel: "Studio",
        executionState: "running",
      },
      servingEnvironmentId: "env-m4",
      name,
    });
    expect(location.label).toBe("M4 → Studio");
  });
});
