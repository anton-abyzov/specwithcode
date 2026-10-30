import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { RelayClientEnvironmentRecord } from "@specweave-studio/contracts/relay";
import { describe, expect, it } from "vite-plus/test";

import { linkedMachinesToConnect, sharedProjectBadge } from "./linkedMachines";

const M4 = "4d73e481-1b03-4ee8-b4c1-87a448431538";
const MINISTORM = "ministorm-env";

const member = (environmentId: string, projectId: string) => ({
  environmentId,
  projectId,
  coordinatorThreadId: `${projectId}-coordinator`,
});

// The ministorm copy of a project the M4 handed off, whose coordinator went back to the M4.
const workersCopy = {
  environmentId: MINISTORM,
  id: "p-ministorm",
  workspaceRoot: "/home/anton/specweave",
  workspaceSettings: {
    logicalProject: {
      id: "logical",
      title: "specweave",
      coordinatorId: "c",
      members: [member(M4, "p-m4"), member(MINISTORM, "p-ministorm")],
    },
    coordinatorBinding: { state: "transferred", successor: member(M4, "p-m4") },
  },
} as unknown as EnvironmentProject;

const record = (environmentId: string, label: string) =>
  ({ environmentId, label }) as unknown as RelayClientEnvironmentRecord;

describe("linkedMachinesToConnect", () => {
  const discovered = new Map([[M4, { environment: record(M4, "M4 Max") }]]);

  it("connects the machine a handed-off project came from when Connect lists it", () => {
    expect(
      linkedMachinesToConnect({
        projects: [workersCopy],
        savedEnvironmentIds: new Set([MINISTORM]),
        discovered,
        skip: new Set(),
      }).map((machine) => machine.environmentId),
    ).toEqual([M4]);
  });

  it("leaves saved, removed and unlisted machines alone", () => {
    const run = (saved: string[], skip: string[], found = discovered) =>
      linkedMachinesToConnect({
        projects: [workersCopy],
        savedEnvironmentIds: new Set(saved),
        discovered: found,
        skip: new Set(skip),
      });
    expect(run([MINISTORM, M4], [])).toEqual([]);
    expect(run([MINISTORM], [M4])).toEqual([]);
    expect(run([MINISTORM], [], new Map())).toEqual([]);
  });

  it("ignores projects that are not linked", () => {
    expect(
      linkedMachinesToConnect({
        projects: [{ environmentId: MINISTORM, id: "solo" } as unknown as EnvironmentProject],
        savedEnvironmentIds: new Set([MINISTORM]),
        discovered,
        skip: new Set(),
      }),
    ).toEqual([]);
  });
});

describe("sharedProjectBadge", () => {
  const nameOf = (id: string) => (id === M4 ? "m4" : id === MINISTORM ? "ministorm" : id);

  it("marks a handed-off copy with where its coordinator runs", () => {
    expect(sharedProjectBadge(workersCopy, [workersCopy], nameOf)).toEqual({
      role: "workers",
      label: "Handed off: coordinator on m4, ministorm runs workers",
    });
  });

  it("follows the coordinator along later moves", () => {
    // ministorm handed off to m4, and m4 later handed the coordinator back to ministorm.
    const m4Copy = {
      ...workersCopy,
      environmentId: M4,
      id: "p-m4",
      workspaceSettings: {
        ...workersCopy.workspaceSettings,
        coordinatorBinding: { state: "transferred", successor: member(MINISTORM, "p-ministorm") },
      },
    } as unknown as EnvironmentProject;
    const thirdCopy = {
      ...workersCopy,
      environmentId: "m1",
      id: "p-m1",
    } as unknown as EnvironmentProject;
    expect(sharedProjectBadge(thirdCopy, [thirdCopy, m4Copy], nameOf)?.label).toBe(
      "Handed off: coordinator on ministorm, m1 runs workers",
    );
  });

  it("marks the coordinator's copy as shared", () => {
    const coordinatorCopy = {
      ...workersCopy,
      environmentId: M4,
      id: "p-m4",
      workspaceSettings: { ...workersCopy.workspaceSettings, coordinatorBinding: undefined },
    } as unknown as EnvironmentProject;
    expect(sharedProjectBadge(coordinatorCopy, [coordinatorCopy], nameOf)).toEqual({
      role: "coordinator",
      label: "Shared from m4 with ministorm",
    });
  });

  it("shows nothing for a project on one machine", () => {
    expect(
      sharedProjectBadge(
        { environmentId: M4, id: "solo" } as unknown as EnvironmentProject,
        [],
        nameOf,
      ),
    ).toBeNull();
  });
});
