import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { EnvironmentId } from "./baseSchemas.ts";
import { OrchestrationV2AppThread, OrchestrationV2ThreadShell } from "./orchestrationV2.ts";
import { OrchestratorMcpThreadDetail, OrchestratorMcpThreadListItem } from "./orchestratorMcp.ts";
import {
  THREAD_EXECUTION_HISTORY_MAX,
  ThreadExecutionRecord,
  appendThreadExecutionHistory,
  formatUnknownExecution,
  resolveThreadExecution,
  threadExecutionSummary,
  threadTurnKey,
  type ThreadExecutionHistoryEntry,
} from "./threadExecution.ts";

const m4 = EnvironmentId.make("env-m4");
const minis = EnvironmentId.make("env-minis");

const record: ThreadExecutionRecord = {
  ownerMachineId: m4,
  ownerMachineLabel: "M4",
  executionMachineId: minis,
  executionMachineLabel: "Minis",
  epoch: 2,
  sourceRoot: {
    environmentId: m4,
    machineLabel: "M4",
    projectId: "project-1" as never,
    threadId: "thread-1" as never,
    workspaceRoot: "/Users/a/Projects/app",
    branch: "feat/x",
  },
  history: [
    {
      machine: m4,
      from: "2026-10-20T20:00:00.000Z",
      to: "2026-10-20T21:00:00.000Z",
      reason: "created",
      epoch: 1,
    },
    { machine: minis, from: "2026-10-20T21:00:00.000Z", to: null, reason: "handoff", epoch: 2 },
  ],
};

describe("threadExecutionSummary", () => {
  it("is empty for a thread that never moved", () => {
    expect(threadExecutionSummary({})).toEqual({});
    expect(threadExecutionSummary({ execution: null, movedTo: null })).toEqual({});
  });

  it("names owner and execution machines from the record", () => {
    expect(threadExecutionSummary({ execution: record })).toEqual({
      ownerMachineId: m4,
      executionMachineId: minis,
      executionMachineLabel: "Minis",
      executionState: "running",
    });
  });

  it("reads a handed-off copy as fenced and points at the machine that runs it", () => {
    expect(
      threadExecutionSummary({
        movedTo: { kind: "handoff", environmentId: minis, machineLabel: "Minis" },
      }),
    ).toEqual({
      executionMachineId: minis,
      executionMachineLabel: "Minis",
      executionState: "fenced",
    });
  });

  it("does not fence a project move", () => {
    expect(threadExecutionSummary({ movedTo: { kind: "project" } })).toEqual({});
    expect(threadExecutionSummary({ movedTo: {} })).toEqual({});
  });
});

describe("resolveThreadExecution", () => {
  it("defaults owner and execution to the serving machine", () => {
    expect(resolveThreadExecution({}, m4)).toEqual({
      ownerMachineId: m4,
      executionMachineId: m4,
      executionMachineLabel: null,
      executionState: "running",
      executionLastSeenAt: null,
    });
  });

  it("reads an unreachable execution machine as unknown with its last-seen time", () => {
    const resolved = resolveThreadExecution(
      threadExecutionSummary({ execution: record }),
      m4,
      () => ({
        reachable: false,
        lastSeenAt: "2026-10-20T21:14:00.000Z",
      }),
    );
    expect(resolved.executionState).toBe("unknown");
    expect(resolved.executionLastSeenAt).toBe("2026-10-20T21:14:00.000Z");
    expect(resolved.executionMachineId).toBe(minis);
  });

  it("keeps fenced even when the destination is unreachable", () => {
    const resolved = resolveThreadExecution(
      { executionState: "fenced", executionMachineId: minis },
      m4,
      () => ({
        reachable: false,
        lastSeenAt: null,
      }),
    );
    expect(resolved.executionState).toBe("fenced");
  });

  it("keeps a server-reported unknown state", () => {
    const resolved = resolveThreadExecution(
      { executionState: "unknown", executionLastSeenAt: "2026-10-20T21:14:00.000Z" },
      m4,
    );
    expect(resolved).toMatchObject({
      executionState: "unknown",
      executionLastSeenAt: "2026-10-20T21:14:00.000Z",
    });
  });
});

describe("execution history", () => {
  it("closes the current stretch and caps the length", () => {
    const next: ThreadExecutionHistoryEntry = {
      machine: m4,
      from: "2026-10-20T22:00:00.000Z",
      to: null,
      reason: "continue-here",
      epoch: 3,
    };
    const appended = appendThreadExecutionHistory(record.history, next);
    expect(appended.at(-2)?.to).toBe("2026-10-20T22:00:00.000Z");
    expect(appended.at(-1)).toEqual(next);

    const long = Array.from({ length: THREAD_EXECUTION_HISTORY_MAX }, (_, index) => ({
      ...next,
      epoch: index,
      to: "2026-10-20T22:00:00.000Z",
    }));
    const capped = appendThreadExecutionHistory(long, { ...next, epoch: 99 });
    expect(capped).toHaveLength(THREAD_EXECUTION_HISTORY_MAX);
    expect(capped.at(-1)?.epoch).toBe(99);
  });
});

describe("wire compatibility", () => {
  it("decodes a stored thread without an execution record", () => {
    const decode = Schema.decodeUnknownSync(ThreadExecutionRecord);
    expect(decode(record)).toEqual(record);
    expect(OrchestrationV2AppThread.fields.execution).toBeDefined();
  });

  it("keeps every new shell and list field optional for older servers", () => {
    for (const fields of [
      OrchestrationV2ThreadShell.fields,
      OrchestratorMcpThreadListItem.fields,
      OrchestratorMcpThreadDetail.fields,
    ]) {
      for (const name of [
        "ownerMachineId",
        "executionMachineId",
        "executionMachineLabel",
        "executionState",
        "executionLastSeenAt",
      ] as const) {
        expect(fields[name].ast.context?.isOptional, name).toBe(true);
      }
    }
  });

  it("formats the unknown label", () => {
    expect(formatUnknownExecution("Minis", "2:14 PM")).toBe("Unknown · Minis last seen 2:14 PM");
    expect(formatUnknownExecution("Minis", null)).toBe("Unknown · Minis not reached yet");
  });

  it("keys a turn by thread and run", () => {
    expect(threadTurnKey("thread-1", "run-1")).toBe("thread-1/run-1");
  });
});
