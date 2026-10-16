import { assert, describe, it } from "@effect/vitest";
import { RunId, ThreadId } from "@specweave-studio/contracts";

import { bulkContinueTargets, bulkStopTargets } from "./OrchestratorMcpBulkThreads.ts";

type Shell = Parameters<typeof bulkStopTargets>[0][number];

function shell(id: string, overrides: Partial<Shell> = {}): Shell {
  return {
    id: ThreadId.make(id),
    status: "idle",
    activityRunStatus: null,
    activeRunId: null,
    latestRunId: null,
    archivedAt: null,
    deletedAt: null,
    lineage: { parentThreadId: null, relationshipToParent: null } as unknown as Shell["lineage"],
    ...overrides,
  };
}

const run = (id: string) => RunId.make(id);

describe("bulk thread selection", () => {
  const caller = ThreadId.make("coordinator");
  const shells = [
    shell("coordinator", { status: "running", activeRunId: run("r-c"), latestRunId: run("r-c") }),
    shell("running", { status: "running", activeRunId: run("r-1"), latestRunId: run("r-1") }),
    shell("waiting-wake", {
      status: "completed",
      activityRunStatus: "waiting",
      activeRunId: run("r-2"),
      latestRunId: run("r-2"),
    }),
    shell("stopped", { status: "interrupted", latestRunId: run("r-3") }),
    shell("done", { status: "completed", latestRunId: run("r-4") }),
    shell("child", {
      status: "running",
      activeRunId: run("r-5"),
      latestRunId: run("r-5"),
      lineage: { relationshipToParent: "subagent" } as unknown as Shell["lineage"],
    }),
    shell("archived", {
      status: "interrupted",
      latestRunId: run("r-6"),
      archivedAt: new Date() as unknown as Shell["archivedAt"],
    }),
  ];

  it("stops running threads but never the caller, subagents or archived threads", () => {
    assert.deepEqual(
      bulkStopTargets(shells, caller).map(({ shell, runId }) => [shell.id, runId]),
      [
        ["running", "r-1"],
        ["waiting-wake", "r-2"],
      ],
    );
  });

  it("continues interrupted threads, user stops included, from their interrupted run", () => {
    assert.deepEqual(
      bulkContinueTargets(shells, caller).map(({ shell, runId }) => [shell.id, runId]),
      [["stopped", "r-3"]],
    );
  });

  it("does not continue the calling thread", () => {
    const self = shell("coordinator", { status: "interrupted", latestRunId: run("r-9") });
    assert.deepEqual(bulkContinueTargets([self], caller), []);
  });
});
