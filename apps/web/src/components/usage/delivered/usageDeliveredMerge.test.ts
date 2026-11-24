import { describe, expect, it } from "vite-plus/test";

import { deliveredReportMarkdown } from "./deliveredReport";
import { cost, group, increment, model, report } from "./deliveredFixtures";
import { isWeakBinding, mergeDelivered, stateLabel } from "./usageDeliveredMerge";

const all = { drivers: new Set<string>(), modelQuery: "", projects: new Set<string>() };
const day = (iso: string) => iso.slice(5, 10);

describe("mergeDelivered", () => {
  it("adds the parts up to the measured total and computes the strip", () => {
    const view = mergeDelivered(
      [
        {
          machineId: "m1",
          name: "Laptop",
          answer: {
            kind: "report",
            report: report({
              increments: [
                increment({
                  incrementId: "1357-usage-by-machine",
                  state: "closed",
                  closedAt: "2026-11-20T10:00:00.000Z",
                }),
                increment({
                  incrementId: "1455-acp-registry",
                  state: "merged",
                  mergedAt: "2026-11-24T01:00:00.000Z",
                  byModel: [model("claudeAgent", "claude-opus-5-5", 300, "claude")],
                }),
                increment({
                  incrementId: "1448-percy",
                  byModel: [model("codex", "gpt-6.2-sol", 50, "codex")],
                }),
              ],
              coordinators: group(40),
              otherThreads: group(200),
              outsideApp: group(60),
            }),
          },
        },
      ],
      all,
    );
    expect(view.attributed.costUsd).toBe(450);
    expect(view.measured.costUsd).toBe(750);
    expect(view.deliveredCount).toBe(2);
    expect(view.tasksDone).toBe(6);
    expect(view.medianDeliveredUsd).toBe(200);
    expect(view.highest?.number).toBe("1455");
    expect(view.increments.map((entry) => entry.number)).toEqual(["1455", "1357", "1448"]);
  });

  it("merges one increment across machines by project and folder, most advanced state first", () => {
    const view = mergeDelivered(
      [
        {
          machineId: "a",
          name: "Laptop",
          answer: {
            kind: "report",
            report: report({ increments: [increment({ incrementId: "1390-sync" })] }),
          },
        },
        {
          machineId: "b",
          name: "Server",
          answer: {
            kind: "report",
            report: report({
              projects: [{ projectId: "other-id", title: "specweave", specweave: true }],
              increments: [
                increment({
                  incrementId: "1390-sync",
                  projectId: "other-id",
                  state: "merged",
                  mergedAt: "2026-11-21T00:00:00.000Z",
                  tasks: { total: 24, done: 9, doneInRange: 9 },
                }),
              ],
            }),
          },
        },
      ],
      all,
    );
    expect(view.increments).toHaveLength(1);
    const [only] = view.increments;
    expect(only!.state).toBe("merged");
    expect(only!.cost.costUsd).toBe(200);
    expect(only!.tasks).toEqual({ total: 24, done: 9, doneInRange: 9 });
    expect(only!.threadCount).toBe(2);
    expect(only!.machines).toEqual(["Laptop", "Server"]);
  });

  it("narrows costs to the selected provider and model and drops increments with none", () => {
    const view = mergeDelivered(
      [
        {
          machineId: "a",
          name: "Laptop",
          answer: {
            kind: "report",
            report: report({
              increments: [
                increment({
                  incrementId: "1357-x",
                  byModel: [
                    model("claudeAgent", "claude-opus-5-5", 100, "claude"),
                    model("codex", "gpt-6.2-sol", 30, "codex"),
                  ],
                }),
                increment({
                  incrementId: "1400-y",
                  byModel: [model("claudeAgent", "claude-sonnet-5-5", 10, "claude")],
                }),
              ],
              otherThreads: group(70, "codex"),
            }),
          },
        },
      ],
      { ...all, drivers: new Set(["codex"]) },
    );
    expect(view.increments.map((entry) => [entry.number, entry.cost.costUsd])).toEqual([
      ["1357", 30],
    ]);
    expect(view.otherThreads.cost.costUsd).toBe(70);
    expect(view.measured.costUsd).toBe(100);
    const byModelQuery = mergeDelivered(
      [
        {
          machineId: "a",
          name: "Laptop",
          answer: {
            kind: "report",
            report: report({
              increments: [
                increment({
                  incrementId: "1400-y",
                  byModel: [model("claudeAgent", "claude-sonnet-5-5", 10)],
                }),
              ],
            }),
          },
        },
      ],
      { ...all, modelQuery: "opus" },
    );
    expect(byModelQuery.increments).toEqual([]);
  });

  it("hides the groups under a project filter, since they carry no project", () => {
    const view = mergeDelivered(
      [
        {
          machineId: "a",
          name: "Laptop",
          answer: {
            kind: "report",
            report: report({
              increments: [increment({ incrementId: "1357-x" })],
              otherThreads: group(500),
            }),
          },
        },
      ],
      { ...all, projects: new Set(["specweave"]) },
    );
    expect(view.groupsHidden).toBe(true);
    expect(view.otherThreads.cost.costUsd).toBe(0);
    expect(view.measured.costUsd).toBe(100);
    expect(view.projects).toEqual(["specweave"]);
  });

  it("names machines that did not answer and counts a shared home once", () => {
    const shared = report({
      increments: [increment({ incrementId: "1357-x" })],
      sourceKeys: ["home-1"],
    });
    const view = mergeDelivered(
      [
        { machineId: "a", name: "Laptop", answer: { kind: "report", report: shared } },
        { machineId: "b", name: "Laptop again", answer: { kind: "report", report: shared } },
        { machineId: "c", name: "win", answer: { kind: "unsupported" } },
        { machineId: "d", name: "m1", answer: { kind: "unreachable" } },
        { machineId: "e", name: "locked", answer: { kind: "forbidden" } },
      ],
      all,
    );
    expect(view.attributed.costUsd).toBe(100);
    expect(view.duplicates).toEqual([["Laptop", "Laptop again"]]);
    expect(view.missing).toEqual([
      { name: "win", reason: "runs a version that cannot report Delivered yet" },
      { name: "m1", reason: "is out of reach" },
      {
        name: "locked",
        reason: "does not let this app read its diagnostics and files (both are needed)",
      },
    ]);
  });

  it("warns when two machines share some transcript folders", () => {
    const view = mergeDelivered(
      [
        {
          machineId: "a",
          name: "Laptop",
          answer: { kind: "report", report: report({ sourceKeys: ["home-1"] }) },
        },
        {
          machineId: "b",
          name: "Server",
          answer: {
            kind: "report",
            report: report({ sourceKeys: ["home-1", "home-2"], cursorHistoryExcluded: true }),
          },
        },
      ],
      all,
    );
    expect(view.answered).toEqual(["Laptop", "Server"]);
    expect(view.overlaps).toEqual([["Laptop", "Server"]]);
    expect(view.cursorHistoryExcluded).toBe(true);
  });

  it("counts only increments closed or merged inside the range, and leaves unpriced ones out of dollar figures", () => {
    const view = mergeDelivered(
      [
        {
          machineId: "a",
          name: "Laptop",
          answer: {
            kind: "report",
            report: report({
              increments: [
                increment({ incrementId: "0001-later", state: "closed", deliveredInRange: false }),
                increment({
                  incrementId: "0002-unpriced",
                  state: "merged",
                  byModel: [
                    { ...model("claudeAgent", "new-model", 0), records: 2, unpricedRecords: 2 },
                  ],
                  cost: cost(0, 2, 2),
                }),
                increment({
                  incrementId: "0003-priced",
                  state: "merged",
                  byModel: [model("claudeAgent", "claude-opus-5-5", 80, "claude")],
                }),
              ],
            }),
          },
        },
      ],
      all,
    );
    expect(view.deliveredCount).toBe(2);
    expect(view.medianDeliveredUsd).toBe(80);
    expect(view.unpricedDelivered).toBe(1);
    expect(view.medianPartial).toBe(false);
    expect(view.highest?.incrementId).toBe("0003-priced");
  });

  it("flags increments created before the range began", () => {
    const view = mergeDelivered(
      [
        {
          machineId: "a",
          name: "Laptop",
          answer: {
            kind: "report",
            report: report({
              increments: [
                increment({ incrementId: "1390-x", createdAt: "2026-10-01T00:00:00.000Z" }),
              ],
            }),
          },
        },
      ],
      all,
    );
    expect(view.increments[0]!.startedBeforeRange).toBe(true);
  });
});

describe("labels", () => {
  it("names the state with its date", () => {
    expect(
      stateLabel({ state: "closed", closedAt: "2026-11-20T00:00:00Z", mergedAt: null }, day),
    ).toBe("Closed 11-20");
    expect(stateLabel({ state: "in_progress", closedAt: null, mergedAt: null }, day)).toBe(
      "In progress",
    );
  });
  it("treats title matches as the weakest binding", () => {
    expect(isWeakBinding("name")).toBe(true);
    expect(isWeakBinding("checkpoint")).toBe(true);
    expect(isWeakBinding("claim")).toBe(false);
  });
});

describe("deliveredReportMarkdown", () => {
  it("writes range, filters, the strip, increments and the non-increment rows", () => {
    const view = mergeDelivered(
      [
        {
          machineId: "a",
          name: "Laptop",
          answer: {
            kind: "report",
            report: report({
              increments: [
                increment({
                  incrementId: "1357-usage-by-machine",
                  title: "Usage by machine",
                  state: "closed",
                  closedAt: "2026-11-20T00:00:00Z",
                }),
              ],
              otherThreads: group(50),
              outsideApp: { ...group(0), cost: cost(5, 2, 2) },
            }),
          },
        },
        { machineId: "b", name: "win", answer: { kind: "unsupported" } },
      ],
      all,
    );
    const markdown = deliveredReportMarkdown({
      view,
      rangeLabel: "Nov 1 – Nov 15",
      filters: ["Providers: Claude Code"],
      formatDay: day,
    });
    expect(markdown).toContain("Range: Nov 1 – Nov 15. Filters: Providers: Claude Code.");
    expect(markdown).toContain("API-equivalent estimate, not a bill.");
    expect(markdown).toContain(
      "| 1357 Usage by machine | specweave | Closed 11-20 | 2 of 4 | 1 | claude-opus-5-5 |",
    );
    expect(markdown).toContain("| Other threads |");
    expect(markdown).toContain("| Outside the app |");
    expect(markdown).toContain("Unpriced");
    expect(markdown).toContain("Incomplete: win runs a version that cannot report Delivered yet.");
  });
});
