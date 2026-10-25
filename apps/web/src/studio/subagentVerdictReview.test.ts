// The r5 review's reproductions for F3 and F4, run against the fixed behavior.
import { subagentExecutionStatus } from "@specweave-studio/client-runtime/state/models";
import {
  deriveProviderSubagentStatus,
  deriveRunlessWorkStartedAt,
  formatProviderSubagentStatus,
} from "@specweave-studio/client-runtime/state/thread-execution";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { listedRunningSubagents, threadSubagentEntries } from "./threadSubagents";

const now = DateTime.makeUnsafe("2026-10-24T12:00:00Z");
const child = {
  id: "receipt-1",
  threadId: "parent",
  childThreadId: "child",
  origin: "provider_native",
  status: "completed",
  prompt: "Read only review",
  result: "SHIP revision 2",
  updatedAt: now,
  startedAt: now,
  completedAt: now,
} as const;
const parent = { id: "parent", environmentId: "env", runtime: null, pendingBackgroundTasks: [] };
const shell = {
  id: "child",
  environmentId: "env",
  deletedAt: null,
  lineage: { parentThreadId: "parent", relationshipToParent: "subagent", rootThreadId: "parent" },
  createdAt: "2026-10-24T12:00:00Z",
  modelSelection: { instanceId: "claudeAgent", model: "opus" },
  runtime: { status: "running" },
  latestRun: null,
  source: { creationSource: "provider" },
};

/** Before selection, while selected and after: the parent's "Working · N" count. */
function counts(live: boolean, childShell: object) {
  const p = { ...parent, runtime: live ? { status: "running" } : null } as never;
  const shells = [p, childShell] as never[];
  const entries = threadSubagentEntries({ parent: p, shells, projected: [child] as never });
  const forSelection = (selected: never | null) =>
    listedRunningSubagents({
      threads: [p],
      shells,
      coordinatorIds: new Set(),
      selected,
      selectedEntries: selected ? entries : [],
    }).get("env:parent") ?? 0;
  return [forSelection(null), forSelection(p), forSelection(null)];
}

describe("r5 review reproductions", () => {
  it("F3: a completed native child counts nowhere, whether its parent is idle or working", () => {
    // Idle parent: the child's stale root is outlived by its parent.
    expect(counts(false, shell)).toEqual([0, 0, 0]);
    // Working parent: the receipt's write closed the child's root, so its
    // shell streams without a runtime (NativeChildReceiptIngestion.test.ts).
    expect(counts(true, { ...shell, runtime: null })).toEqual([0, 0, 0]);
  });

  it("F4: an unreachable native child is Unknown in rows and header, with no clock", () => {
    const running = { ...child, status: "running" } as never;
    const unreachable = new Set(["env"]);
    expect(subagentExecutionStatus({ record: running, thread: shell as never, unreachable })).toBe(
      "unknown",
    );
    const projection = {
      thread: {
        id: "child",
        creationSource: "provider",
        lineage: { relationshipToParent: "subagent", parentThreadId: "parent" },
      },
      nodes: [
        { kind: "root_turn", runId: null, status: "running", startedAt: now, completedAt: null },
      ],
    } as never;
    const execution = { thread: shell, parent, unreachable } as never;
    const status = deriveProviderSubagentStatus(projection, [running], execution);
    expect(status?.status).toBe("unknown");
    expect(deriveRunlessWorkStartedAt(projection, [running], execution)).toBeNull();
    expect(formatProviderSubagentStatus(status, 0)).toBe("Unknown (machine unreachable)");
    expect(deriveProviderSubagentStatus(projection, [child] as never, execution)?.status).toBe(
      "completed",
    );
  });
});
