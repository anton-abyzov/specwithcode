import type { EnvironmentId, PersonalShareStatus } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  confirmedMachinesOf,
  newestBeforeLinkRestorePoint,
  shareConfirmCalls,
  shareRestoreAction,
  shareMachineRows,
  shareMachineStateText,
  shareStartPlan,
} from "./personalShare";

// Fictional machines.
const id = (value: string) => value as EnvironmentId;
const seat = (
  environmentId: string,
  title: string,
  memoryFileCount: number | null,
  linked = false,
) => ({
  environmentId,
  title,
  linked,
  memoryFileCount,
});

describe("shareStartPlan (1448 D-15)", () => {
  it("has nothing to choose once a link exists", () => {
    expect(
      shareStartPlan({
        ownEnvironmentId: "studio",
        seats: [seat("studio", "Percy", 3), seat("laptop", "Percy", 9, true)],
      }),
    ).toEqual({ kind: "join" });
  });

  it("starts from the only assistant, or makes the first one here", () => {
    expect(
      shareStartPlan({ ownEnvironmentId: "studio", seats: [seat("laptop", "Percy", 2)] }),
    ).toEqual({ kind: "single", environmentId: "laptop" });
    expect(shareStartPlan({ ownEnvironmentId: "studio", seats: [] })).toEqual({
      kind: "new",
      environmentId: "studio",
    });
  });

  it("leads with the most memory files; this machine wins a tie", () => {
    const plan = shareStartPlan({
      ownEnvironmentId: "studio",
      seats: [seat("laptop", "Percy", 5), seat("studio", "Percy", 5), seat("tower", "Percy", null)],
    });
    expect(plan).toMatchObject({
      kind: "choose",
      defaultEnvironmentId: "studio",
      defaultName: "Percy",
    });
    expect(
      shareStartPlan({
        ownEnvironmentId: "studio",
        seats: [seat("studio", "Ada", 1), seat("laptop", "Ada", 8)],
      }),
    ).toMatchObject({ kind: "choose", defaultEnvironmentId: "laptop", defaultName: "Ada" });
  });

  it("picks the default start only among this machine and machines the window can change", () => {
    expect(
      shareStartPlan({
        ownEnvironmentId: "studio",
        seats: [seat("studio", "Percy", 1), seat("laptop", "Percy", 3), seat("tower", "Percy", 9)],
        writable: new Set(["laptop"]),
      }),
    ).toMatchObject({ kind: "choose", defaultEnvironmentId: "laptop" });
  });

  it("names the link Percy when the assistants' names differ", () => {
    expect(
      shareStartPlan({
        ownEnvironmentId: "studio",
        seats: [seat("studio", "Percy", 1), seat("laptop", "PercyLaptop", 1)],
      }),
    ).toMatchObject({ defaultName: "Percy" });
  });
});

describe("shareConfirmCalls (1448 D-12)", () => {
  it("calls this machine first, then each ticked machine the window can change, each with the others", () => {
    expect(
      shareConfirmCalls({
        ownEnvironmentId: id("studio"),
        ticked: [id("laptop"), id("tower"), id("laptop"), id("studio")],
        writable: new Set(["laptop"]),
        remoteMachines: new Map([["laptop", []]]),
        startEnvironmentId: "laptop",
        name: " Percy ",
      }),
    ).toEqual({
      calls: [
        {
          environmentId: "studio",
          input: { enabled: true, machines: ["laptop", "tower"], start: false },
        },
        {
          environmentId: "laptop",
          input: { enabled: true, machines: ["studio", "tower"], start: true, name: "Percy" },
        },
      ],
      manual: ["tower"],
      unread: [],
    });
  });

  it("keeps every machine another machine confirmed and adds the ticked ones; this machine gets exactly the ticks", () => {
    // Laptop confirmed Win on its own, which this window does not know.
    const { calls, unread } = shareConfirmCalls({
      ownEnvironmentId: id("studio"),
      ticked: [id("laptop"), id("desktop")],
      writable: new Set(["laptop", "desktop"]),
      remoteMachines: new Map([
        ["laptop", [id("win"), id("studio")]],
        ["desktop", []],
      ]),
      startEnvironmentId: null,
      name: null,
    });
    expect(calls.map((call) => [call.environmentId, call.input.machines])).toEqual([
      ["studio", ["laptop", "desktop"]],
      ["laptop", ["win", "studio", "desktop"]],
      ["desktop", ["studio", "laptop"]],
    ]);
    expect(unread).toEqual([]);
  });

  it("leaves a machine as it is when its list could not be read", () => {
    const { calls, unread } = shareConfirmCalls({
      ownEnvironmentId: id("studio"),
      ticked: [id("laptop")],
      writable: new Set(["laptop"]),
      remoteMachines: new Map(),
      startEnvironmentId: null,
      name: null,
    });
    expect(calls.map((call) => call.environmentId)).toEqual(["studio"]);
    expect(unread).toEqual(["laptop"]);
  });

  it("reads a machine's confirmed list from its status, leaving out one not added there", () => {
    expect(
      confirmedMachinesOf({
        machines: [
          { environmentId: id("win"), label: "Win", state: "offline" },
          { environmentId: id("mini"), label: "Mini", state: "waiting" },
          { environmentId: id("guest"), label: "Guest", state: "not_confirmed" },
          { environmentId: id("studio"), label: "Studio", state: "joined" },
        ],
      } as unknown as PersonalShareStatus),
    ).toEqual(["win", "mini", "studio"]);
  });

  it("takes the machine's own stored list when its status sends one", () => {
    expect(
      confirmedMachinesOf({
        machines: [
          { environmentId: id("mini"), label: "Mini", state: "not_confirmed" },
          { environmentId: id("guest"), label: "Guest", state: "waiting" },
        ],
        confirmedMachines: [id("mini")],
      } as unknown as PersonalShareStatus),
    ).toEqual(["mini"]);
  });

  it("never sends a start the window cannot apply: no start: false here, no name", () => {
    const { calls, manual } = shareConfirmCalls({
      ownEnvironmentId: id("studio"),
      ticked: [id("tower")],
      writable: new Set(),
      remoteMachines: new Map(),
      startEnvironmentId: "tower",
      name: "Ada",
    });
    expect(calls).toEqual([
      { environmentId: "studio", input: { enabled: true, machines: ["tower"] } },
    ]);
    expect(manual).toEqual(["tower"]);
  });

  it("leaves start out when joining an existing link, so each machine keeps its value", () => {
    const { calls } = shareConfirmCalls({
      ownEnvironmentId: id("studio"),
      ticked: [],
      writable: new Set(),
      remoteMachines: new Map(),
      startEnvironmentId: null,
      name: null,
    });
    expect(calls).toEqual([{ environmentId: "studio", input: { enabled: true, machines: [] } }]);
  });
});

describe("the machines table", () => {
  const status = (overrides: Partial<PersonalShareStatus> = {}): PersonalShareStatus =>
    ({
      enabled: true,
      environmentId: "studio",
      machineLabel: "Studio",
      connectLinked: true,
      linkId: "logical:percy:fixture",
      projectId: null,
      assistantName: "Percy",
      linked: true,
      members: [],
      routineOwner: true,
      start: true,
      machines: [],
      restorePoints: [],
      refusal: null,
      ...overrides,
    }) as PersonalShareStatus;

  it("says every state in a person's words", () => {
    expect(shareMachineStateText("waiting", "Laptop")).toEqual({
      text: "Waiting for {machine} to answer",
      values: { machine: "Laptop" },
    });
    for (const state of [
      "joined",
      "switch_off",
      "not_confirmed",
      "no_grant",
      "legacy_grant",
      "other_account",
      "older_version",
      "offline",
    ] as const) {
      const said = shareMachineStateText(state, "Laptop").text;
      expect(said).not.toMatch(/_|grant$|^[a-z]/);
    }
  });

  it("leads with this machine, names the runner once, and offers Turn on only where the window can", () => {
    const rows = shareMachineRows({
      status: status({
        machines: [
          {
            environmentId: id("laptop"),
            label: "Laptop",
            state: "joined",
            lastSyncedAt: "2026-11-24T09:00:00.000Z",
          },
          { environmentId: id("desktop"), label: null, state: "switch_off" },
          { environmentId: id("tower"), label: "Tower", state: "not_confirmed" },
          {
            environmentId: id("mini"),
            label: "Mini",
            state: "offline",
            detail: "Last seen November 22",
          },
        ],
      }),
      labelOf: (environmentId, fallback) => fallback ?? environmentId,
      runnerEnvironmentId: "laptop",
      canTurnOn: (environmentId) => environmentId === "desktop",
    });
    expect(rows.map((row) => [row.label, row.own, row.runsRoutines, row.action])).toEqual([
      ["Studio", true, true, null],
      ["Laptop", false, false, null],
      ["desktop", false, false, "turn-on"],
      ["Tower", false, false, "manual"],
      ["Mini", false, false, null],
    ]);
    expect(rows[0]!.lastSyncedAt).toBe("2026-11-24T09:00:00.000Z");
    expect(rows[4]!.detail).toBe("Last seen November 22");
  });

  it("names another machine as the runner when this one is not", () => {
    const rows = shareMachineRows({
      status: status({
        routineOwner: false,
        machines: [{ environmentId: id("laptop"), label: "Laptop", state: "joined" }],
      }),
      labelOf: (environmentId, fallback) => fallback ?? environmentId,
      runnerEnvironmentId: "laptop",
      canTurnOn: () => false,
    });
    expect(rows.map((row) => row.runsRoutines)).toEqual([false, true]);
  });

  it("undoes to the newest copy saved before a link, never one saved before an undo", () => {
    expect(newestBeforeLinkRestorePoint(null)).toBeNull();
    expect(
      newestBeforeLinkRestorePoint(
        status({
          restorePoints: [
            {
              id: "a",
              savedAt: "2026-11-20T00:00:00.000Z",
              reason: "before-link",
              memoryFileCount: 1,
            },
            {
              id: "c",
              savedAt: "2026-11-25T00:00:00.000Z",
              reason: "before-undo",
              memoryFileCount: 3,
            },
            {
              id: "b",
              savedAt: "2026-11-24T00:00:00.000Z",
              reason: "before-link",
              memoryFileCount: 2,
            },
          ],
        }),
      )?.id,
    ).toBe("b");
    expect(
      newestBeforeLinkRestorePoint(
        status({
          restorePoints: [
            {
              id: "c",
              savedAt: "2026-11-25T00:00:00.000Z",
              reason: "before-undo",
              memoryFileCount: 3,
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("undoes the merge while on or linked, and after an undo puts back what it replaced", () => {
    const point = (id: string, savedAt: string, reason: "before-link" | "before-undo") => ({
      id,
      savedAt,
      reason,
      memoryFileCount: 1,
    });
    const link = point("link", "2026-11-24T00:00:00.000Z", "before-link");
    const undo = point("undo", "2026-11-25T00:00:00.000Z", "before-undo");
    const older = point("older", "2026-11-20T00:00:00.000Z", "before-undo");
    const action = (overrides: Partial<PersonalShareStatus>) => {
      const found = shareRestoreAction(status(overrides));
      return found ? [found.kind, found.point.id] : null;
    };
    expect(shareRestoreAction(null)).toBeNull();
    expect(action({ restorePoints: [] })).toBeNull();
    // On, or still linked: the merge, whatever came before.
    expect(action({ enabled: true, linked: false, restorePoints: [link, undo] })).toEqual([
      "undo-merge",
      "link",
    ]);
    expect(action({ enabled: false, linked: true, restorePoints: [undo, link] })).toEqual([
      "undo-merge",
      "link",
    ]);
    // Off and alone after an undo: put back what the undo replaced.
    expect(action({ enabled: false, linked: false, restorePoints: [link, undo] })).toEqual([
      "put-back",
      "undo",
    ]);
    // Off with no undo since the link: the merge can still be undone.
    expect(action({ enabled: false, linked: false, restorePoints: [older, link] })).toEqual([
      "undo-merge",
      "link",
    ]);
    expect(action({ enabled: true, linked: true, restorePoints: [undo] })).toBeNull();
  });
});
