import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";

import {
  chooseCoordinatorView,
  coordinatorMachineKey,
  orchestratorCopies,
  SUPERSEDED_COORDINATOR_PROBLEM,
  unloadedMachineRef,
  unloadedMachineRefs,
  WORKERS_ONLY_PROBLEM,
} from "./projectCoordinatorMachine";
import { COORDINATOR_PENDING_PROBLEM } from "./projectDomain";

const plain = (environmentId: string, id: string) =>
  ({ environmentId, id }) as unknown as EnvironmentProject;
const m4 = plain("env-m4", "proj-a");
const m1 = plain("env-m1", "proj-b");
const m3 = plain("env-m3", "proj-c");

type BindingState = "active" | "transferring" | "transferred";
const linked = (
  environmentId: string,
  id: string,
  state: BindingState,
  epoch = 0,
  predecessor?: { environmentId: string; projectId: string },
) =>
  ({
    environmentId,
    id,
    workspaceSettings: {
      logicalProject: { id: "logical:one", title: "One", coordinatorId: "c", members: [] },
      coordinatorBinding: { epoch, state, ...(predecessor ? { predecessor } : {}) },
    },
  }) as unknown as EnvironmentProject;

describe("chooseCoordinatorView", () => {
  it("shows the last viewed checkout when it is listed", () => {
    expect(
      chooseCoordinatorView({
        members: [m4, m1, m3],
        lastViewed: coordinatorMachineKey(m1),
        primaryEnvironmentId: "env-m4",
      }),
    ).toEqual({ member: m1, missing: false, problem: null });
  });

  it("follows the last viewed machine when the project was re-added there", () => {
    const readded = plain("env-m1", "proj-new");
    expect(
      chooseCoordinatorView({
        members: [m4, readded],
        lastViewed: coordinatorMachineKey(m1),
        primaryEnvironmentId: "env-m4",
      }).member,
    ).toBe(readded);
  });

  it("starts on this computer's checkout when nothing was viewed", () => {
    expect(
      chooseCoordinatorView({ members: [m1, m3, m4], primaryEnvironmentId: "env-m4" }).member,
    ).toBe(m4);
    expect(
      chooseCoordinatorView({ members: [m1, m3], primaryEnvironmentId: "env-m4" }).member,
    ).toBe(m1);
  });

  it("reports a last viewed machine that is not listed instead of hiding it", () => {
    expect(
      chooseCoordinatorView({
        members: [m4, m3],
        lastViewed: coordinatorMachineKey(m1),
        primaryEnvironmentId: "env-m4",
      }),
    ).toEqual({ member: m4, missing: true, problem: null });
  });

  it("never stands another machine in for an unreachable last viewed one", () => {
    expect(
      chooseCoordinatorView({
        members: [m4, m1, m3],
        lastViewed: coordinatorMachineKey(m1),
        primaryEnvironmentId: "env-m4",
        unreachable: new Set(["env-m1"]),
      }),
    ).toEqual({ member: m1, missing: false, problem: null });
  });

  it("keeps an explicit route checkout, or reports it missing with nothing in its place", () => {
    expect(
      chooseCoordinatorView({
        members: [m4, m1],
        checkoutKey: coordinatorMachineKey(m1),
        lastViewed: coordinatorMachineKey(m4),
        primaryEnvironmentId: "env-m4",
        unreachable: new Set(["env-m1"]),
      }).member,
    ).toBe(m1);
    expect(
      chooseCoordinatorView({
        members: [m4],
        checkoutKey: coordinatorMachineKey(m1),
        primaryEnvironmentId: "env-m4",
      }),
    ).toEqual({ member: undefined, missing: true, problem: null });
  });

  it("skips an unreachable first checkout when nothing was viewed", () => {
    expect(
      chooseCoordinatorView({
        members: [m1, m3],
        primaryEnvironmentId: "env-m4",
        unreachable: new Set(["env-m1"]),
      }).member,
    ).toBe(m3);
  });

  it("returns nothing for a project with no checkouts", () => {
    expect(
      chooseCoordinatorView({ members: [], lastViewed: "env-m1:x", primaryEnvironmentId: null }),
    ).toEqual({ member: undefined, missing: false, problem: null });
  });
});

describe("chooseCoordinatorView for linked copies", () => {
  const m4Coordinator = linked("env-m4", "a", "active", 1);
  const minisCoordinator = linked("env-minis", "b", "active", 0);
  const m3Workers = linked("env-m3", "c", "transferred", 0);

  it("lets each machine's coordinator be viewed and take messages", () => {
    for (const member of [m4Coordinator, minisCoordinator])
      expect(
        chooseCoordinatorView({
          members: [m4Coordinator, minisCoordinator, m3Workers],
          lastViewed: coordinatorMachineKey(member),
          primaryEnvironmentId: "env-m4",
        }),
      ).toEqual({ member, missing: false, problem: null });
  });

  it("opens this computer's coordinator first, then a reachable one", () => {
    const members = [minisCoordinator, m3Workers, m4Coordinator];
    expect(chooseCoordinatorView({ members, primaryEnvironmentId: "env-m4" }).member).toBe(
      m4Coordinator,
    );
    expect(
      chooseCoordinatorView({
        members: [m3Workers, linked("env-m4", "a", "active", 2), minisCoordinator],
        primaryEnvironmentId: "env-m3",
        unreachable: new Set(["env-m4"]),
      }).member,
    ).toBe(minisCoordinator);
  });

  it("names why a viewed copy cannot take messages", () => {
    const pending = linked("env-m3", "c", "transferring", 0);
    const old = linked("env-m1", "d", "active", 0);
    const successor = linked("env-minis", "b", "active", 1, {
      environmentId: "env-m1",
      projectId: "d",
    });
    const view = (member: EnvironmentProject, members: EnvironmentProject[]) =>
      chooseCoordinatorView({
        members,
        lastViewed: coordinatorMachineKey(member),
        primaryEnvironmentId: "env-m4",
      }).problem;
    expect(view(m3Workers, [m4Coordinator, m3Workers])).toBe(WORKERS_ONLY_PROBLEM);
    expect(view(pending, [pending])).toBe(COORDINATOR_PENDING_PROBLEM);
    expect(view(old, [old, successor])).toBe(SUPERSEDED_COORDINATOR_PROBLEM);
    expect(view(successor, [old, successor])).toBeNull();
  });
});

describe("unloadedMachineRef", () => {
  const minis = { environmentId: "env-minis", projectId: "proj-minis", coordinatorThreadId: "t" };
  const withRefs = {
    environmentId: "env-m4",
    id: "proj-a",
    workspaceSettings: {
      logicalProject: {
        id: "logical:one",
        title: "One",
        coordinatorId: "c",
        members: [
          { environmentId: "env-m4", projectId: "proj-a", coordinatorThreadId: "t" },
          minis,
        ],
      },
      coordinatorBinding: { epoch: 0, state: "active" },
    },
  } as unknown as EnvironmentProject;

  it("names a linked machine this device never synced", () => {
    expect(unloadedMachineRef([withRefs], "env-minis:proj-minis")).toEqual(minis);
  });

  it("is null for a loaded checkout, no key, or a key outside the project", () => {
    expect(unloadedMachineRef([withRefs], "env-m4:proj-a")).toBeNull();
    expect(unloadedMachineRef([withRefs], null)).toBeNull();
    expect(unloadedMachineRef([withRefs], "env-other:proj-x")).toBeNull();
  });

  it("lists every linked machine not loaded here, once", () => {
    const twin = { ...withRefs, id: "proj-a" } as EnvironmentProject;
    expect(unloadedMachineRefs([withRefs, twin])).toEqual([minis]);
    expect(unloadedMachineRefs([m4, m1])).toEqual([]);
  });
});

describe("orchestratorCopies", () => {
  const withRoot = (member: EnvironmentProject, workspaceRoot: string) =>
    ({ ...member, workspaceRoot }) as EnvironmentProject;
  const machine = (member: EnvironmentProject) => member.environmentId;

  it("calls unlinked checkouts of one repository independent", () => {
    const copies = orchestratorCopies(
      [withRoot(m4, "/a"), withRoot(m1, "/b")],
      machine,
      () => true,
    );
    expect(copies.map((copy) => [copy.key, copy.role, copy.canStart])).toEqual([
      ["env-m4:proj-a", "independent", false],
      ["env-m1:proj-b", "independent", false],
    ]);
  });

  it("lists a lone checkout as its own coordinator", () => {
    expect(orchestratorCopies([withRoot(m4, "/a")], machine, () => true)[0]?.role).toBe(
      "coordinator",
    );
  });

  it("offers a start only on a ready workers-only linked copy", () => {
    const main = linked("env-m4", "proj-a", "active", 1);
    const minis = linked("env-minis", "proj-m", "transferred", 0);
    const ready = orchestratorCopies([main, minis], machine, (id) => id === "env-minis");
    expect(ready.map((copy) => [copy.role, copy.canStart])).toEqual([
      ["coordinator", false],
      ["workers", true],
    ]);
    const notReady = orchestratorCopies([main, minis], machine, () => false);
    expect(notReady[1]?.canStart).toBe(false);
  });

  it("marks a copy whose coordinator move is not confirmed as pending", () => {
    const moving = linked("env-m4", "proj-a", "transferring", 1);
    const minis = linked("env-minis", "proj-m", "transferred", 0);
    expect(orchestratorCopies([moving, minis], machine, () => true).map((c) => c.role)).toEqual([
      "pending",
      "workers",
    ]);
  });
});
