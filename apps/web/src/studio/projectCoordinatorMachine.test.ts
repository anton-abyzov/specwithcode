import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";

import {
  checkoutKeyEnvironmentId,
  checkoutUnavailableReason,
  chooseCoordinatorView,
  coordinatorElsewhere,
  coordinatorMachineKey,
  heldCheckoutKey,
  keptCoordinatorCopies,
  orchestratorCopies,
  COORDINATOR_NEEDS_UPDATE_PROBLEM,
  unloadedMachineRef,
  unloadedMachineRefs,
  unconfirmedCoordinatorProblem,
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
    // A machine still on a version from before equal coordinators cannot take messages yet.
    expect(view(m3Workers, [m4Coordinator, m3Workers])).toBe(COORDINATOR_NEEDS_UPDATE_PROBLEM);
    expect(view(pending, [pending])).toBe(COORDINATOR_PENDING_PROBLEM);
    // An older record that claims to have taken over stops nobody.
    expect(view(old, [old, successor])).toBeNull();
    expect(view(successor, [old, successor])).toBeNull();
  });

  it("sends what is typed on a machine to that machine's own coordinator (AC-35)", () => {
    // m3 followed m4 before the update and is active after it; m5 was added after it.
    const formerlyTransferred = linked("env-m3", "c", "active", 0);
    const freshlyAdded = linked("env-m5", "e", "active", 1);
    // A machine on the old version reconnects, claiming it took over from m3.
    const oldPeer = linked("env-old", "o", "active", 7, { environmentId: "env-m3", projectId: "c" });
    for (const members of [
      [m4Coordinator, formerlyTransferred, freshlyAdded],
      [m4Coordinator, formerlyTransferred, freshlyAdded, oldPeer],
    ])
      for (const shown of [m4Coordinator, formerlyTransferred, freshlyAdded])
        for (const primaryEnvironmentId of ["env-m4", "env-m3", "env-m5", "env-old"])
          // The page shows the machine asked for, with nothing between its box and its coordinator.
          expect(
            chooseCoordinatorView({
              members,
              checkoutKey: coordinatorMachineKey(shown),
              primaryEnvironmentId,
            }),
          ).toEqual({ member: shown, missing: false, problem: null });
  });
});

describe("a workers-only copy whose coordinator is on another machine", () => {
  const ref = (environmentId: string, projectId: string) => ({
    environmentId,
    projectId,
    coordinatorThreadId: `project-coordinator:${projectId}`,
  });
  const copyOf = (
    environmentId: string,
    id: string,
    binding: { state: BindingState; successor?: ReturnType<typeof ref> },
  ) =>
    ({
      environmentId,
      id,
      workspaceSettings: {
        logicalProject: { id: "logical:one", title: "One", coordinatorId: "c", members: [] },
        coordinatorBinding: { epoch: 1, ...binding },
      },
    }) as unknown as EnvironmentProject;
  const m4 = copyOf("env-m4", "a", { state: "active" });
  // "Copy files only" leaves the new copy transferred to the machine it was copied from.
  const minis = copyOf("env-minis", "b", { state: "transferred", successor: ref("env-m4", "a") });

  it("names the coordinator's checkout to start work from", () => {
    expect(coordinatorElsewhere(minis, [m4, minis])).toEqual(ref("env-m4", "a"));
    // Known even before that machine's copy loads here.
    expect(coordinatorElsewhere(minis, [minis])).toEqual(ref("env-m4", "a"));
  });

  it("follows the coordinator along later moves", () => {
    const moved = copyOf("env-m4", "a", { state: "transferred", successor: ref("env-m1", "c") });
    const m1 = copyOf("env-m1", "c", { state: "active" });
    expect(coordinatorElsewhere(minis, [moved, m1, minis])).toEqual(ref("env-m1", "c"));
  });

  it("is null for a coordinator, a copy with no successor, a loop or the same machine", () => {
    expect(coordinatorElsewhere(m4, [m4, minis])).toBeNull();
    expect(coordinatorElsewhere(linked("env-m3", "c", "transferred"), [m4])).toBeNull();
    const back = copyOf("env-m4", "a", { state: "transferred", successor: ref("env-minis", "b") });
    expect(coordinatorElsewhere(minis, [back, minis])).toBeNull();
    const sameMachine = copyOf("env-minis", "z", {
      state: "transferred",
      successor: ref("env-minis", "y"),
    });
    expect(coordinatorElsewhere(sameMachine, [sameMachine])).toBeNull();
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
    // Each is a separate project in the menu, never a coordinator of this one.
    expect(copies.map((copy) => [copy.rowRole, copy.main, copy.label])).toEqual([
      ["independent", false, { text: "Separate project" }],
      ["independent", false, { text: "Separate project" }],
    ]);
  });

  it("lists a lone checkout as its own coordinator, with no role word in the menu", () => {
    const [lone] = orchestratorCopies([withRoot(m4, "/a")], machine, () => true);
    expect(lone?.role).toBe("coordinator");
    expect([lone?.rowRole, lone?.main, lone?.label]).toEqual(["single", false, { text: "" }]);
  });

  it("lists every linked machine the same: no role word and no row role but linked (AC-01)", () => {
    const first = linked("env-m4", "proj-a", "active", 2);
    const second = linked("env-minis", "proj-m", "active", 0);
    const old = linked("env-m3", "proj-c", "transferred", 0);
    const copies = orchestratorCopies([first, second, old], machine, () => true);
    expect(copies.map((copy) => [copy.key, copy.rowRole, copy.label.text])).toEqual([
      ["env-m4:proj-a", "linked", ""],
      ["env-minis:proj-m", "linked", ""],
      ["env-m3:proj-c", "linked", ""],
    ]);
    // One machine is still where project-wide settings are read from.
    expect(copies.filter((copy) => copy.main).map((copy) => copy.key)).toEqual(["env-m4:proj-a"]);
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
    const copies = orchestratorCopies([moving, minis], machine, () => true);
    expect(copies.map((c) => c.role)).toEqual(["pending", "workers"]);
    expect(copies.map((c) => [c.rowRole, c.label.text])).toEqual([
      ["linked", ""],
      ["linked", ""],
    ]);
  });
});

describe("checkoutUnavailableReason", () => {
  const environments = [
    { environmentId: "env-m4", connection: { phase: "connected" } },
    { environmentId: "env-m1", connection: { phase: "backoff" } },
    { environmentId: "env-m3", connection: { phase: "connecting" } },
    { environmentId: "env-m5", connection: { phase: "error" } },
    { environmentId: "env-m6", connection: { phase: "unsupported" } },
  ];
  const reason = (
    environmentId: string,
    unreachable: readonly string[] = [],
    projectsLive = true,
  ) =>
    checkoutUnavailableReason({
      environmentId,
      environments,
      unreachable: new Set(unreachable),
      projectsLive,
    });

  it("names a machine this device is not paired with", () => {
    expect(reason("env-m2")).toBe("host-unknown");
  });
  it("names an unreachable machine as offline", () => {
    expect(reason("env-m1", ["env-m1"])).toBe("host-offline");
  });
  it("waits on a machine that has not answered yet", () => {
    expect(reason("env-m3")).toBe("host-loading");
  });
  it("waits on a reconnected machine until it sends its projects", () => {
    expect(reason("env-m4", [], false)).toBe("host-loading");
  });
  it.each(["env-m5", "env-m6"])("never promises a refused machine %s comes back", (id) => {
    expect(reason(id, [id])).toBe("host-refused");
  });
  it("names an online machine with no such project", () => {
    expect(reason("env-m4")).toBe("not-registered");
  });
  it("reads the machine from a saved checkout key", () => {
    expect(checkoutKeyEnvironmentId("env-m4:proj-a")).toBe("env-m4");
    expect(checkoutKeyEnvironmentId("env-m4")).toBe("env-m4");
  });
});

describe("heldCheckoutKey", () => {
  const held = { projectKey: "logical:one", checkout: "env-m4:a" };
  const source = linked("env-m4", "a", "transferred", 1);
  const destination = linked("env-m1", "b", "active", 1, {
    environmentId: "env-m4",
    projectId: "a",
  });

  it("keeps the page on the checkout an open move dialog holds after the coordinator moved", () => {
    const members = [source, destination];
    // Without the hold the page follows the coordinator to the destination.
    expect(
      chooseCoordinatorView({ members, primaryEnvironmentId: "env-m4" }).member?.environmentId,
    ).toBe("env-m1");
    const checkoutKey = heldCheckoutKey(held, "logical:one", members);
    expect(checkoutKey).toBe("env-m4:a");
    expect(
      chooseCoordinatorView({ members, checkoutKey, primaryEnvironmentId: "env-m4" }).member
        ?.environmentId,
    ).toBe("env-m4");
  });

  it("lets go for another project, with no hold, and once the held checkout is gone", () => {
    expect(heldCheckoutKey(held, "logical:two", [source, destination])).toBeNull();
    expect(heldCheckoutKey(null, "logical:one", [source, destination])).toBeNull();
    expect(heldCheckoutKey(held, "logical:one", [destination])).toBeNull();
  });
});

describe("keptCoordinatorCopies", () => {
  const machine = (member: EnvironmentProject) => member.environmentId;
  // A copy as the server leaves it: transferred, naming where its coordinator went.
  const handedOver = (environmentId: string, id: string, successorEnvironmentId: string) =>
    ({
      environmentId,
      id,
      workspaceRoot: "/w/atlas",
      workspaceSettings: {
        logicalProject: { id: "logical:one", title: "One", coordinatorId: "c", members: [] },
        coordinatorBinding: {
          epoch: 1,
          state: "transferred",
          successor: {
            environmentId: successorEnvironmentId,
            projectId: "next",
            coordinatorThreadId: "project-coordinator:next",
          },
        },
      },
    }) as unknown as EnvironmentProject;
  const main = linked("env-m4", "proj-a", "active", 2);
  const startable = (members: EnvironmentProject[], threads: string[]) =>
    keptCoordinatorCopies(
      orchestratorCopies(members, machine, () => true),
      members,
      (environmentId, threadId) => threads.includes(`${environmentId}/${threadId}`),
    ).map((copy) => [copy.key, copy.canStart]);

  it("keeps Open for a copy whose own coordinator conversation moved to another machine", () => {
    const m1Copy = handedOver("env-m1", "proj-b", "env-m4");
    expect(startable([main, m1Copy], ["env-m1/project-coordinator:proj-b"])).toEqual([
      ["env-m4:proj-a", false],
      ["env-m1:proj-b", true],
    ]);
  });

  it("offers no Open on a copy that joined as workers only and never had a conversation", () => {
    const joined = handedOver("env-m1", "proj-b", "env-m4");
    expect(startable([main, joined], [])).toEqual([
      ["env-m4:proj-a", false],
      ["env-m1:proj-b", false],
    ]);
  });

  it("offers no Open on the copy a worktree move left behind on its own machine", () => {
    const registered = handedOver("env-m1", "proj-b", "env-m1");
    expect(startable([main, registered], ["env-m1/project-coordinator:proj-b"])).toEqual([
      ["env-m4:proj-a", false],
      ["env-m1:proj-b", false],
    ]);
  });
});

describe("roles with a machine that joined again", () => {
  it("never lets the old record of a re-joined machine be the coordinator in the menu", () => {
    // m1's old record kept a higher epoch; m1 joined again as a new machine.
    const old = linked("env-m1-old", "proj-old", "active", 9);
    const current = linked("env-m4", "proj-a", "active", 3);
    const name = (member: EnvironmentProject) => member.environmentId;
    const without = orchestratorCopies([old, current], name, () => true);
    expect(without.find((copy) => copy.main)?.key).toBe("env-m1-old:proj-old");
    const retired = new Map([["env-m1-old", "env-m1"]]);
    const copies = orchestratorCopies([old, current], name, () => true, retired);
    expect(copies.find((copy) => copy.main)?.key).toBe("env-m4:proj-a");
  });
});

it("names the unconfirmed machine as a phrase with a slot, so it translates", () => {
  expect(unconfirmedCoordinatorProblem("m4")).toEqual({
    text: "{machine} has not confirmed where the coordinator is yet. Reconnect it to send messages.",
    values: { machine: "m4" },
  });
});
