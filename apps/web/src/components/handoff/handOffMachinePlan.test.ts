import type {
  EnvironmentId,
  HandoffPlanView,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { initialHandoffTicks } from "./handOffMachineRows";
import {
  folderWorkRowId,
  folderWorkTicked,
  handoffUsageLines,
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
            { providerName: "Claude", kind: "different-account", percentLeft: 60 },
            { providerName: "Codex", kind: "same-account", percentLeft: null },
            { providerName: "Gemini", kind: "usage-unknown", percentLeft: null },
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
