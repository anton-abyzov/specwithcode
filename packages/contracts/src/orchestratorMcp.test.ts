import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpFailure,
  OrchestratorMcpMachineListResult,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadDetail,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadWaitInput,
} from "./orchestratorMcp.ts";

const decodeCreateThreadsInput = Schema.decodeUnknownSync(OrchestratorMcpCreateThreadsInput);
const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);
const decodeThreadInterruptInput = Schema.decodeUnknownSync(OrchestratorMcpThreadInterruptInput);
const decodeThreadListInput = Schema.decodeUnknownSync(OrchestratorMcpThreadListInput);
const decodeThreadReadInput = Schema.decodeUnknownSync(OrchestratorMcpThreadReadInput);
const decodeThreadSendInput = Schema.decodeUnknownSync(OrchestratorMcpThreadSendInput);
const decodeThreadWaitInput = Schema.decodeUnknownSync(OrchestratorMcpThreadWaitInput);

const encodeFailure = Schema.encodeSync(OrchestratorMcpFailure);
const decodeFailure = Schema.decodeUnknownSync(OrchestratorMcpFailure);
const decodeMachineList = Schema.decodeUnknownSync(OrchestratorMcpMachineListResult);

describe("orchestrator MCP contracts", () => {
  it("decodes cross-provider delegated task requests and durable results", () => {
    const request = decodeDelegateTaskInput({
      task: "Inspect the workspace and report the result.",
      target: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      mode: "wait",
      timeoutMs: 5_000,
      clientRequestId: "delegate-1",
      runtimeMode: "inherit",
      interactionMode: "inherit",
    });
    const result = decodeDelegateTaskResult({
      taskId: "node-task-1",
      childThreadId: "thread-child-1",
      threadLink: "[Inspect the workspace](studio://thread/thread-child-1)",
      childRunId: "run-child-1",
      childNodeId: "node-task-1",
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      summary: "Workspace inspected.",
      resultContextTransferId: "context-transfer-result-1",
      latestTerminalRunId: "run-child-1",
      latestTerminalStatus: "completed",
      latestTerminalSummary: "Workspace inspected.",
      latestTerminalResultContextTransferId: "context-transfer-result-1",
      waitTimedOut: false,
    });

    expect(request.target?.providerInstanceId).toBe("claudeAgent");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Workspace inspected.");
    expect(result.threadLink).toBe("[Inspect the workspace](studio://thread/thread-child-1)");
  });

  it("decodes target model options in canonical and shorthand shapes", () => {
    const canonical = decodeDelegateTaskInput({
      task: "Say hello.",
      target: {
        providerInstanceId: "codex",
        model: "gpt-5.6-luna",
        options: [{ id: "reasoning", value: "low" }],
      },
    });
    const shorthand = decodeDelegateTaskInput({
      task: "Say hello.",
      target: {
        providerInstanceId: "codex",
        model: "gpt-5.6-luna",
        options: { reasoning: "low", fastMode: true },
      },
    });

    expect(canonical.target?.options).toEqual([{ id: "reasoning", value: "low" }]);
    expect(shorthand.target?.options).toEqual([
      { id: "reasoning", value: "low" },
      { id: "fastMode", value: true },
    ]);
  });

  it("rejects target model options that are not strings or booleans", () => {
    expect(() =>
      decodeDelegateTaskInput({
        task: "Say hello.",
        target: {
          providerInstanceId: "codex",
          model: "gpt-5.6-luna",
          // Must fail loudly instead of being dropped like legacy persistence.
          options: { reasoning: 3 },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeDelegateTaskInput({
        task: "Say hello.",
        target: {
          providerInstanceId: "codex",
          model: "gpt-5.6-luna",
          options: [{ id: "reasoning", value: null }],
        },
      }),
    ).toThrow();
  });

  it("decodes mixed prompted and empty thread batches", () => {
    const request = decodeCreateThreadsInput({
      clientRequestId: "threads-1",
      threads: [
        { title: "Inherited empty thread" },
        {
          prompt: "Review the API.",
          target: { driverKind: "claudeAgent" },
          runtimeMode: "approval-required",
        },
      ],
    });

    expect(request.threads).toHaveLength(2);
    expect(request.threads[0]?.prompt).toBeUndefined();
    expect(request.threads[1]?.target?.driverKind).toBe("claudeAgent");
  });

  it("decodes project-scoped thread orchestration requests", () => {
    expect(
      decodeThreadListInput({
        statuses: ["running", "completed"],
        includeSubagents: false,
        limit: 25,
      }).statuses,
    ).toEqual(["running", "completed"]);
    expect(
      decodeThreadReadInput({
        threadId: "thread-loop-1",
        view: "activity",
        afterPosition: 10,
      }).afterPosition,
    ).toBe(10);
    expect(
      decodeThreadSendInput({
        threadId: "thread-loop-1",
        message: "Continue with the next iteration.",
        mode: "steer",
        clientRequestId: "send-loop-2",
      }).mode,
    ).toBe("steer");
    expect(
      decodeThreadWaitInput({
        threadId: "thread-loop-1",
        runId: "run-loop-2",
        timeoutMs: 5_000,
      }).runId,
    ).toBe("run-loop-2");
    expect(
      decodeThreadInterruptInput({
        threadId: "thread-loop-1",
        reason: "Loop converged.",
      }).reason,
    ).toBe("Loop converged.");
  });

  it("accepts a machine on remote-capable thread tools", () => {
    expect(decodeThreadReadInput({ threadId: "thread-1", machine: "M1" }).machine).toBe("M1");
    expect(decodeThreadWaitInput({ threadId: "thread-1", machine: "m1" }).machine).toBe("m1");
    expect(
      decodeThreadSendInput({ threadId: "thread-1", message: "go", machine: "m1" }).machine,
    ).toBe("m1");
    expect(decodeThreadInterruptInput({ threadId: "thread-1", machine: "local" }).machine).toBe(
      "local",
    );
    expect(decodeThreadListInput({ machine: "m1" }).machine).toBe("m1");
    expect(decodeDelegateTaskInput({ task: "do it", machine: "local" }).machine).toBe("local");
    expect(() => decodeThreadReadInput({ threadId: "thread-1", machine: "" })).toThrow();
  });

  it("round-trips the new machine failure codes", () => {
    const codes = [
      "unknown_machine",
      "machine_unreachable",
      "machine_identity_mismatch",
      "machine_not_authorized",
      "machine_unsupported",
      "project_unavailable_on_machine",
      "project_ambiguous_on_machine",
      "model_unavailable_on_machine",
      "remote_launch_unconfirmed",
      "delegation_is_local",
      "worker_machine_set",
    ] as const;
    for (const code of codes) {
      const failure = new OrchestratorMcpFailure({ code, message: code });
      expect(decodeFailure(encodeFailure(failure)).code).toBe(code);
    }
  });

  it("decodes a machine list", () => {
    const decoded = decodeMachineList({
      local: { id: "local", label: "M4", environmentId: "env-m4" },
      machines: [
        {
          id: "m1",
          label: "M1",
          environmentId: "env-m1",
          status: "ready",
          access: "auto",
          grantExpiresAt: "2026-11-11T00:00:00.000Z",
          project: { match: "identity", projectId: "project-1", title: "App" },
          providers: [
            {
              providerInstanceId: "codex",
              driverKind: "codex",
              models: ["gpt-5.4"],
              available: true,
            },
          ],
        },
      ],
      projectWorkerMachine: "m1",
    });
    expect(decoded.machines[0]?.project?.match).toBe("identity");
  });

  it("takes an increment ref on launches and reports the bound increment", () => {
    expect(decodeDelegateTaskInput({ task: "Fix it.", increment: " 0996 " }).increment).toBe(
      "0996",
    );
    expect(
      decodeCreateThreadsInput({ threads: [{ prompt: "Fix it.", increment: "new" }] }).threads[0]
        ?.increment,
    ).toBe("new");
    expect(() => decodeDelegateTaskInput({ task: "Fix it.", increment: "" })).toThrow();
    expect(() =>
      decodeDelegateTaskInput({ task: "Fix it.", increment: "x".repeat(121) }),
    ).toThrow();
    const result = decodeDelegateTaskResult({
      taskId: "node-task-1",
      childThreadId: "thread-child-1",
      threadLink: "[Fix](studio://thread/thread-child-1)",
      childRunId: null,
      childNodeId: "node-task-1",
      status: "running",
      workState: "working",
      hasPendingChildRuns: false,
      providerInstanceId: "codex",
      model: null,
      summary: null,
      resultContextTransferId: null,
      latestTerminalRunId: null,
      latestTerminalStatus: null,
      latestTerminalSummary: null,
      latestTerminalResultContextTransferId: null,
      waitTimedOut: false,
      increment: {
        incrementId: "0996-connect",
        title: null,
        specPath: "/repo/.specweave/increments/0996-connect/spec.md",
        inheritedFrom: "thread-parent",
      },
      warning: "Pass increment next time.",
    });
    expect(result.increment?.inheritedFrom).toBe("thread-parent");
    expect(result.warning).toBe("Pass increment next time.");
  });
});

it("thread detail keeps optional goal evidence backwards-compatible", () => {
  const decodeGoal = Schema.decodeUnknownSync(OrchestratorMcpThreadDetail.fields.goal);
  expect(decodeGoal(undefined)).toBeUndefined();
  const goal = {
    id: "disk-goal",
    scope: "Cleanup",
    scopeRevision: "goal-1",
    obligations: [
      {
        id: "cleanup",
        kind: "dependency",
        reason: "Retire worktrees",
        owner: "HOME-DISK",
        nextEvent: "Removal receipt",
        needsUserOutput: false,
        completion: { status: "pending", reason: "Still open" },
      },
    ],
  };
  expect(decodeGoal(JSON.parse(JSON.stringify(goal)))).toEqual(goal);
  expect(() => decodeGoal({ ...goal, obligations: [] })).toThrow();
});
