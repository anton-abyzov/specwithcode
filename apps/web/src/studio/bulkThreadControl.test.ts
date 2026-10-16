import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";

import {
  bulkResultMessage,
  bulkStatusSummary,
  bulkThreadTargets,
  interruptedRunId,
  stopAllConfirmMessage,
  threadIsRunning,
} from "./bulkThreadControl";

type Shell = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "archivedAt" | "lineage" | "latestRun" | "runtime"
>;

function shell(id: string, status: string | null, overrides: Partial<Shell> = {}): Shell {
  const latestRun =
    status === null
      ? null
      : ({
          runId: `run-${id}`,
          status,
          requestedAt: null,
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        } as unknown as Shell["latestRun"]);
  return {
    id: id as Shell["id"],
    environmentId: "host-1" as Shell["environmentId"],
    archivedAt: null,
    lineage: { relationshipToParent: null } as Shell["lineage"],
    latestRun,
    runtime:
      status === null ? null : ({ status, activeRunId: null } as unknown as Shell["runtime"]),
    ...overrides,
  };
}

describe("bulkThreadTargets", () => {
  it("splits running, interrupted and idle threads", () => {
    const targets = bulkThreadTargets([
      shell("a", "running"),
      shell("b", "waiting"),
      shell("c", "interrupted"),
      shell("d", "completed"),
      shell("e", null),
      shell("f", "queued"),
    ]);
    expect(targets.running.map((thread) => thread.id)).toEqual(["a", "b"]);
    expect(targets.interrupted.map((thread) => [thread.id, thread.resumeRunId])).toEqual([
      ["c", "run-c"],
    ]);
    expect(targets.idle).toBe(3);
  });

  it("leaves out the caller, archived threads and delegated subagents", () => {
    const targets = bulkThreadTargets(
      [
        shell("self", "running"),
        shell("archived", "running", { archivedAt: "2026-10-15T00:00:00.000Z" }),
        shell("child", "interrupted", {
          lineage: { relationshipToParent: "subagent" } as Shell["lineage"],
        }),
        shell("other", "interrupted"),
      ],
      "self",
    );
    expect(targets.running).toEqual([]);
    expect(targets.interrupted.map((thread) => thread.id)).toEqual(["other"]);
  });

  it("does not continue a thread that started again after its stop", () => {
    const resumed = shell("a", "interrupted", {
      runtime: { status: "running", activeRunId: "run-2" } as unknown as Shell["runtime"],
    });
    expect(threadIsRunning(resumed)).toBe(true);
    expect(interruptedRunId(resumed)).toBeNull();
  });
});

describe("bulk copy", () => {
  it("asks with a count", () => {
    expect(stopAllConfirmMessage(4)).toBe("Stop 4 running threads?");
    expect(stopAllConfirmMessage(1)).toBe("Stop 1 running thread?");
  });

  it("summarizes the project and the outcome", () => {
    expect(bulkStatusSummary({ running: [1, 2], interrupted: [1], idle: 5 })).toBe(
      "2 running, 1 interrupted, 5 idle",
    );
    expect(bulkResultMessage("Stopped", 3, 0)).toBe("Stopped 3 threads.");
    expect(bulkResultMessage("Continued", 1, 2)).toBe(
      "Continued 1 thread. 2 could not be continued.",
    );
  });
});
