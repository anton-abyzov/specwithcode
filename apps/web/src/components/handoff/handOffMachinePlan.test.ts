import type {
  EnvironmentId,
  HandoffPlanView,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { initialHandoffTicks } from "./handOffMachineRows";
import { pickDestination } from "./HandoffResults";
import {
  automaticDestinations,
  folderWorkRowId,
  folderWorkTicked,
  handoffUsageLines,
  movablePlanIds,
  planHandoffRows,
} from "./handOffMachinePlan";

const DESK = "env-desk" as EnvironmentId;
const atlas = "project-atlas" as ProjectId;

const view = (patch: Partial<HandoffPlanView> = {}): HandoffPlanView => ({
  destinationEnvironmentId: DESK,
  destinationLabel: "Desk",
  sourceLabel: "M4",
  unreachable: null,
  usage: [],
  items: [],
  ...patch,
});

const row = (patch: Partial<HandoffPlanView["items"][number]>) => ({
  kind: "thread" as const,
  id: "t-1",
  title: "Fix the build",
  projectId: atlas,
  group: "running" as const,
  ticked: true,
  canTick: true,
  disposition: "resume" as const,
  stay: null,
  reason: null,
  ...patch,
});

describe("the target picker's usage lines (AC-22)", () => {
  it("names each provider's account as the machine confirmed it", () => {
    expect(
      handoffUsageLines(
        view({
          usage: [
            { providerName: "Claude", kind: "different-account", percentLeft: 60, automatic: true },
            { providerName: "Codex", kind: "same-account", percentLeft: null, automatic: false },
            { providerName: "Gemini", kind: "usage-unknown", percentLeft: null, automatic: false },
          ],
        }),
      ),
    ).toEqual([
      "Different Claude account · 60% left",
      "Same Codex account as M4: adds no usage",
      "Usage unknown",
    ]);
  });

  it("says nothing about usage for a machine that could not be asked", () => {
    expect(handoffUsageLines(view({ unreachable: "Desk: offline" }))).toEqual([]);
  });
});

describe("the dialog's rows from the plan (AC-17)", () => {
  it("keeps every group, and what cannot be ticked is never ticked", () => {
    const rows = planHandoffRows(
      view({
        items: [
          row({ id: "t-run" }),
          row({
            id: "t-queued",
            group: "queued",
            ticked: false,
            canTick: false,
            reason: "Its queued messages do not travel in a hand off by hand yet.",
          }),
          row({ id: "t-unsaved", group: "unsaved", disposition: "ready" }),
          row({
            id: "t-review",
            group: "stays",
            ticked: false,
            canTick: false,
            disposition: "stays",
            stay: "review",
            reason: "Desk has no reviewer from another family.",
          }),
          row({
            kind: "folder-work",
            id: atlas,
            title: "atlas",
            group: "folder-work",
            disposition: "ready",
            reason: "1 branch only on M4",
          }),
        ],
      }),
    );
    expect(rows.map((entry) => [entry.threadId, entry.group])).toEqual([
      ["t-run", "running"],
      ["t-queued", "queued"],
      ["t-unsaved", "unsaved"],
      [folderWorkRowId(atlas), "folder-work"],
      ["t-review", "stays"],
    ]);
    const ticks = initialHandoffTicks(rows).ticks;
    expect([...ticks].toSorted()).toEqual(
      ["t-run", "t-unsaved", folderWorkRowId(atlas)].toSorted() as Array<ThreadId>,
    );
    expect(folderWorkTicked(ticks)).toEqual([atlas]);
    expect(rows.find((entry) => entry.threadId === "t-review")?.reason).toBe(
      "Desk has no reviewer from another family.",
    );
  });
});

describe("the destination the dialog picks for the person (AC-22)", () => {
  const MINI = "env-mini" as EnvironmentId;
  const RACK = "env-rack" as EnvironmentId;
  const machines = [
    { environmentId: DESK, label: "Desk", state: "reachable" as const },
    { environmentId: MINI, label: "Mini", state: "reachable" as const },
    { environmentId: RACK, label: "Rack", state: "reachable" as const },
  ];
  const usageOf = (usage: HandoffPlanView["usage"]) => view({ usage });

  it("picks nothing on same-account or unknown usage until the person clicks", () => {
    const plans = new Map([
      [
        DESK,
        usageOf([
          { providerName: "Claude", kind: "same-account", percentLeft: null, automatic: false },
        ]),
      ],
      [
        MINI,
        usageOf([
          { providerName: "Claude", kind: "usage-unknown", percentLeft: null, automatic: false },
        ]),
      ],
    ]);
    const evidence = automaticDestinations(plans);
    expect(pickDestination(machines.slice(0, 2), null, evidence)).toBeNull();
    // A click still picks it: by hand a same-account machine is allowed.
    expect(pickDestination(machines.slice(0, 2), DESK, evidence)).toBe(DESK);
    // A different account with room is picked for the person.
    plans.set(
      RACK,
      usageOf([
        { providerName: "Claude", kind: "different-account", percentLeft: 60, automatic: true },
      ]),
    );
    expect(pickDestination(machines, null, automaticDestinations(plans))).toBe(RACK);
  });
});

describe("what a hand off may send (AC-17)", () => {
  it("is only what the measured plan lets go, never a row it puts under Stays", () => {
    const plan = view({
      items: [
        row({ id: "t-ok" }),
        row({
          id: "t-big",
          group: "stays",
          ticked: false,
          canTick: false,
          disposition: "stays",
          stay: "limit",
          reason: "data/dump.bin is 12 MB, over the 10 MB limit for one file",
        }),
      ],
    });
    expect([...movablePlanIds(plan)]).toEqual(["t-ok"]);
  });
});
