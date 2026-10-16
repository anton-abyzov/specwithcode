import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { OrchestrationV2TurnItem } from "@specweave-studio/contracts";

import { threadWorkflowEntries } from "./threadSubagents";

const at = DateTime.makeUnsafe("2026-10-15T20:00:00Z");
const workflowCall = (id: string, script: string) =>
  ({
    id,
    type: "dynamic_tool",
    status: "completed",
    toolName: "Workflow",
    input: { script },
    startedAt: at,
    updatedAt: at,
  }) as unknown as OrchestrationV2TurnItem;

describe("threadWorkflowEntries", () => {
  it("lists a thread's workflows by name, running while the provider still runs them", () => {
    const entries = threadWorkflowEntries({
      turnItems: [
        workflowCall(
          "a",
          "export const meta = { name: 'review-changes', description: 'Review each changed file' }",
        ),
        workflowCall("b", "export const meta = { name: 'verify-findings' }"),
      ],
      pendingBackgroundTasks: [
        { taskId: "t1", kind: "workflow", description: "review-changes", progress: "Verify" },
      ],
    });
    expect(entries.map((entry) => [entry.title, entry.status, entry.result, entry.kind])).toEqual([
      ["review-changes", "running", "Verify", "workflow"],
      ["verify-findings", "completed", null, "workflow"],
    ]);
    expect(entries[0]?.prompt).toBe("Review each changed file");
    expect(entries.every((entry) => entry.childThreadId === null)).toBe(true);
  });

  it("keeps a running workflow whose call is not loaded yet", () => {
    const entries = threadWorkflowEntries({
      turnItems: [],
      pendingBackgroundTasks: [{ taskId: "t9", kind: "workflow", description: "audit" }],
    });
    expect(entries).toMatchObject([{ key: "workflow:t9", title: "audit", status: "running" }]);
  });
});
