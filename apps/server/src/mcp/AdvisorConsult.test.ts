import {
  DEFAULT_ADVISOR_SETTINGS,
  type AdvisorSettings,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Subagent,
  type OrchestratorMcpDelegateTaskResult,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@specweave-studio/contracts";
import { resolveAdvisor } from "@specweave-studio/shared/advisor";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { describe, expect, it } from "vite-plus/test";

import type { AdvisorBrief } from "../orchestration-v2/AdvisorBrief.ts";
import {
  ADVISOR_CLAUDE_WAIT_MS,
  ADVISOR_DEFAULT_WAIT_MS,
  type AdvisorCaller,
  type AdvisorConsultPorts,
  advisorConsultGate,
  advisorConsultResult,
  advisorConsultsUsed,
  advisorFromResolution,
  advisorTaskTitle,
  advisorWaitMs,
  consultAdvisor,
  inFlightAdvisorTask,
  queuedAdvisorDeliveries,
  settledAdvisorChildren,
} from "./AdvisorConsult.ts";

const callerId = ThreadId.make("thread:caller");
const runId = RunId.make("run:caller:1");
const at = DateTime.makeUnsafe("2026-11-16T08:00:00.000Z");
const fable: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-fable-5-2",
};
const on: AdvisorSettings = { ...DEFAULT_ADVISOR_SETTINGS, enabled: true };

function task(id: string, over: Partial<OrchestrationV2Subagent> = {}): OrchestrationV2Subagent {
  return {
    id: NodeId.make(id),
    threadId: callerId,
    runId,
    parentNodeId: NodeId.make("node:caller"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: fable.instanceId,
    providerThreadId: null,
    childThreadId: ThreadId.make(`thread:child:${id}`),
    nativeTaskRef: null,
    prompt: "brief",
    title: "Advisor: caller",
    model: fable.model,
    purpose: "advisor",
    status: "running",
    result: null,
    startedAt: at,
    completedAt: null,
    updatedAt: at,
    ...over,
  };
}

function taskResult(
  taskId: string,
  status: OrchestratorMcpDelegateTaskResult["status"],
  summary: string | null = null,
): OrchestratorMcpDelegateTaskResult {
  return {
    taskId: NodeId.make(taskId),
    childThreadId: ThreadId.make(`thread:child:${taskId}`),
    threadLink: "link",
    childRunId: null,
    childNodeId: NodeId.make(taskId),
    status,
    workState: summary === null ? "working" : "result_available",
    hasPendingChildRuns: false,
    providerInstanceId: fable.instanceId,
    model: fable.model,
    summary,
    resultContextTransferId: null,
    latestTerminalRunId: null,
    latestTerminalStatus: null,
    latestTerminalSummary: null,
    latestTerminalResultContextTransferId: null,
    waitTimedOut: summary === null,
  } as OrchestratorMcpDelegateTaskResult;
}

describe("advisorWaitMs", () => {
  it("waits 4 minutes on Claude Code and 45 seconds on every other driver", () => {
    expect(advisorWaitMs("claudeAgent")).toBe(ADVISOR_CLAUDE_WAIT_MS);
    expect(ADVISOR_CLAUDE_WAIT_MS).toBe(240_000);
    for (const driver of ["codex", "acpRegistry", "muse", "opencode", "pi", undefined, null])
      expect(advisorWaitMs(driver)).toBe(ADVISOR_DEFAULT_WAIT_MS);
    expect(ADVISOR_DEFAULT_WAIT_MS).toBe(45_000);
  });
});

describe("advisorConsultGate", () => {
  const thread = { id: callerId };
  const gate = (
    over: {
      thread?: Parameters<typeof advisorConsultGate>[0]["thread"];
      settings?: AdvisorSettings;
      subagents?: ReadonlyArray<OrchestrationV2Subagent>;
    } = {},
  ) =>
    advisorConsultGate({
      thread: over.thread ?? thread,
      settings: over.settings ?? on,
      subagents: over.subagents ?? [],
      runId,
    });

  it("refuses an advisor child before anything else", () => {
    const result = gate({ thread: { id: callerId, purpose: "advisor", advisorMode: "on" } });
    expect(result.kind === "refused" && result.result.refusal).toBe("advisor-thread");
  });

  it("refuses when the advisor is off, saying where to turn it on", () => {
    const off = gate({ settings: DEFAULT_ADVISOR_SETTINGS });
    expect(off.kind).toBe("refused");
    if (off.kind !== "refused") return;
    expect(off.result).toMatchObject({ status: "refused", refusal: "off" });
    expect(off.result.message).toContain("Settings > Models > Advisor");
    const threadOff = gate({ thread: { id: callerId, advisorMode: "off" } });
    expect(threadOff.kind === "refused" && threadOff.result.refusal).toBe("off");
  });

  it("lets a thread that turned its advisor on consult while settings are off", () => {
    const result = gate({
      thread: { id: callerId, advisorMode: "on" },
      settings: DEFAULT_ADVISOR_SETTINGS,
    });
    expect(result).toEqual({ kind: "start", ordinal: 1, consultsRemaining: 2 });
  });

  it("counts this run's consults from the task records and refuses past the limit", () => {
    const done = [1, 2, 3].map((n) => task(`a${n}`, { status: "completed" }));
    const result = gate({ subagents: done });
    expect(result.kind === "refused" && result.result).toMatchObject({
      refusal: "limit",
      consultsRemaining: 0,
    });
    // Another run's consults, other delegated work and another thread's do not count.
    const others = [
      task("old", { status: "completed", runId: RunId.make("run:caller:0") }),
      task("work", { status: "completed", purpose: undefined }),
      task("foreign", { status: "completed", threadId: ThreadId.make("thread:other") }),
      task("native", { status: "completed", origin: "provider_native" }),
    ];
    expect(advisorConsultsUsed(others, callerId, runId)).toBe(0);
    expect(gate({ subagents: [...done.slice(0, 2), ...others] })).toEqual({
      kind: "start",
      ordinal: 3,
      consultsRemaining: 0,
    });
  });

  it("picks up a consult still running instead of starting another, even at the limit", () => {
    const running = task("a3");
    const done = [task("a1", { status: "completed" }), task("a2", { status: "failed" })];
    const result = gate({ subagents: [...done, running] });
    expect(result).toEqual({ kind: "pick-up", task: running, consultsRemaining: 0 });
    expect(inFlightAdvisorTask([...done, running], callerId)).toBe(running);
    expect(inFlightAdvisorTask(done, callerId)).toBeUndefined();
  });

  it("picks up a consult that finished after its call said working, before its wake-up went out", () => {
    const undelivered = task("a1", {
      status: "completed",
      result: "Advice",
      completionDelivery: { state: "pending", observedByRunId: null },
    });
    expect(gate({ subagents: [undelivered] })).toEqual({
      kind: "pick-up",
      task: undelivered,
      consultsRemaining: 2,
    });
    const delivered = {
      ...undelivered,
      completionDelivery: { state: "delivered" as const, observedByRunId: null },
    };
    expect(gate({ subagents: [delivered] })).toEqual({
      kind: "start",
      ordinal: 2,
      consultsRemaining: 1,
    });
  });
});

describe("a consult whose advice is queued behind the caller's turn", () => {
  const claimed = task("a1", {
    status: "completed",
    result: "Advice",
    completionDelivery: { state: "claimed", observedByRunId: null },
  });

  it("is picked up while its wake-up message is still queued, not started again", () => {
    const gate = (queued: ReadonlySet<string>) =>
      advisorConsultGate({
        thread: { id: callerId },
        settings: on,
        subagents: [claimed],
        runId,
        queuedDeliveries: queued,
      });
    expect(gate(new Set(["a1"]))).toEqual({ kind: "pick-up", task: claimed, consultsRemaining: 2 });
    // Once the wake-up's turn started, that turn carries the advice.
    expect(gate(new Set())).toEqual({ kind: "start", ordinal: 2, consultsRemaining: 1 });
  });

  it("finds queued deliveries from the caller's runs", () => {
    const runs = [
      {
        status: "running",
        userMessageId: "message:1",
        delegatedCompletion: { delivery: { messageId: "message:wake", taskIds: ["a1", "a2"] } },
      },
      { status: "queued", userMessageId: "message:wake" },
      {
        status: "completed",
        userMessageId: "message:0",
        delegatedCompletion: { delivery: { messageId: "message:started", taskIds: ["a0"] } },
      },
      { status: "running", userMessageId: "message:started" },
      { status: "completed", userMessageId: "message:x", delegatedCompletion: { delivery: null } },
    ];
    expect([...queuedAdvisorDeliveries(runs)]).toEqual(["a1", "a2"]);
  });
});

describe("settledAdvisorChildren", () => {
  it("lists finished consults whose result is not waiting for delivery", () => {
    const subagents = [
      task("read", {
        status: "completed",
        completionDelivery: { state: "acknowledged", observedByRunId: null },
      }),
      task("legacy", { status: "failed" }),
      task("pending", {
        status: "completed",
        completionDelivery: { state: "pending", observedByRunId: null },
      }),
      task("live"),
      task("work", { status: "completed", purpose: undefined }),
    ];
    expect(settledAdvisorChildren(subagents, callerId)).toEqual([
      ThreadId.make("thread:child:read"),
      ThreadId.make("thread:child:legacy"),
    ]);
  });
});

describe("advisorConsultResult", () => {
  const shape = (result: OrchestratorMcpDelegateTaskResult) =>
    advisorConsultResult({
      task: result,
      advisor: "Claude Fable 5.2 on Claude",
      advisorModel: fable,
      consultsRemaining: 2,
      briefTokens: 1_000,
      leftOut: 3,
    });

  it("returns the advice with who gave it and what is left", () => {
    expect(shape(taskResult("a1", "completed", "  Check the migration first.  "))).toEqual({
      status: "advice",
      message: "Claude Fable 5.2 on Claude reviewed this thread's work.",
      advice: "Check the migration first.",
      advisor: "Claude Fable 5.2 on Claude",
      advisorModel: fable,
      consultsRemaining: 2,
      briefTokens: 1_000,
      leftOut: 3,
    });
  });

  it("says working with the task id while the advisor runs", () => {
    for (const status of ["running", "queued"] as const)
      expect(shape(taskResult("a1", status))).toMatchObject({
        status: "working",
        taskId: "a1",
      });
  });

  it("reports a child that failed, stopped or gave nothing as failed", () => {
    for (const status of ["failed", "cancelled", "interrupted"] as const)
      expect(shape(taskResult("a1", status, "provider error"))).toMatchObject({
        status: "failed",
        taskId: "a1",
      });
    expect(shape(taskResult("a1", "completed", "   ")).status).toBe("failed");
  });
});

describe("advisorFromResolution", () => {
  const now = Date.parse("2026-11-16T08:00:00.000Z");
  const fresh = DateTime.formatIso(DateTime.makeUnsafe(now));
  const provider = (id: string, driver: string, slugs: ReadonlyArray<string>): ServerProvider => ({
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: fresh,
    version: null,
    models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: fresh,
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 20,
          resetsAt: "2026-11-20T00:00:00.000Z",
        },
      ],
    },
  });
  const claude = provider("claudeAgent", "claudeAgent", ["claude-fable-5-2", "claude-opus-5-5"]);
  const codex = provider("codex", "codex", ["gpt-6.1-sol"]);
  const label = (selection: ModelSelection) => `${selection.model} on ${selection.instanceId}`;
  const resolve = (providers: ReadonlyArray<ServerProvider>, thread: ModelSelection) =>
    resolveAdvisor({ providers, model: null, reviewers: [], tier: "regular", thread, nowMs: now });

  it("moves a thread already on the advisor's model to the next entry", () => {
    const picked = advisorFromResolution(resolve([claude, codex], fable), label);
    expect(picked.kind).toBe("ok");
    if (picked.kind !== "ok") return;
    expect(picked.value.model).not.toBe(fable.model);
  });

  it("refuses with each skipped entry and its reason when nothing can advise", () => {
    const fableOnly = provider("claudeAgent", "claudeAgent", ["claude-fable-5-2"]);
    const picked = advisorFromResolution(resolve([fableOnly], fable), label);
    expect(picked.kind).toBe("refused");
    if (picked.kind !== "refused") return;
    expect(picked.result.refusal).toBe("no-advisor");
    expect(picked.result.message).toContain("claude-fable-5-2 on claudeAgent");
    expect(picked.result.message).toContain("the model this thread runs on");
    const none = advisorFromResolution({ advisor: null, skipped: [] }, label);
    expect(none.kind === "refused" && none.result.message).toContain("Settings > Models > Advisor");
  });
});

describe("advisorTaskTitle", () => {
  it("names the reviewed thread and stays short", () => {
    expect(advisorTaskTitle("Fix login")).toBe("Advisor: Fix login");
    expect(advisorTaskTitle("x".repeat(300)).length).toBeLessThanOrEqual(120);
  });
});

// ── A consult through fake ports ─────────────────────────────────────

interface Fake {
  readonly calls: {
    starts: number;
    waits: Array<{ taskId: string; timeoutMs: number }>;
    archived: Array<ReadonlyArray<string>>;
    briefs: Array<{ focus: string | undefined; budgetTokens: number }>;
    abandoned: Array<{ taskId: string; childThreadId: string }>;
  };
  readonly ports: AdvisorConsultPorts<null, { readonly advisor: AdvisorSettings }, never>;
}

function fake(input: {
  readonly driver?: string;
  readonly thread?: Partial<AdvisorCaller<null>["thread"]> & { interactionMode?: string };
  readonly settings?: AdvisorSettings;
  readonly subagents?: () => ReadonlyArray<OrchestrationV2Subagent>;
  readonly noRun?: boolean;
  readonly noAdvisor?: boolean;
  readonly queuedDeliveries?: ReadonlySet<string>;
  /** Child threads waiting on an approval or a question. */
  readonly blocked?: ReadonlySet<string>;
  readonly results: Array<OrchestratorMcpDelegateTaskResult>;
}): Fake {
  const calls: Fake["calls"] = { starts: 0, waits: [], archived: [], briefs: [], abandoned: [] };
  const brief: AdvisorBrief = { text: "brief", tokens: 1_234, leftOut: 2, sinceLastConsult: false };
  const ports: Fake["ports"] = {
    caller: Effect.sync(() =>
      input.noRun === true
        ? {
            kind: "refused" as const,
            result: { status: "refused" as const, refusal: "no-run" as const, message: "No run." },
          }
        : {
            kind: "ok" as const,
            value: {
              thread: { id: callerId, title: "Caller", ...input.thread },
              runId,
              driver: input.driver,
              subagents: input.subagents?.() ?? [],
              queuedDeliveries: input.queuedDeliveries,
              context: null,
            },
          },
    ),
    settings: () => Effect.succeed({ advisor: input.settings ?? on }),
    pickAdvisor: () =>
      Effect.succeed(
        input.noAdvisor === true
          ? {
              kind: "refused" as const,
              result: {
                status: "refused" as const,
                refusal: "no-advisor" as const,
                message: "None.",
              },
            }
          : {
              kind: "ok" as const,
              value: { selection: fable, label: "Claude Fable 5.2 on Claude" },
            },
      ),
    buildBrief: (_caller, options) =>
      Effect.sync(() => {
        calls.briefs.push(options);
        return brief;
      }),
    start: () =>
      Effect.sync(() => {
        calls.starts += 1;
        return NodeId.make(`a${calls.starts}`);
      }),
    wait: (taskId, timeoutMs) =>
      Effect.sync(() => {
        calls.waits.push({ taskId, timeoutMs });
        return input.results.shift()!;
      }),
    label: (_caller, selection) => `${selection.model} label`,
    archive: (ids) =>
      Effect.sync(() => {
        calls.archived.push(ids);
      }),
    blocked: (childThreadId) => Effect.succeed(input.blocked?.has(childThreadId) ?? false),
    serialize: (effect) => effect,
    abandon: (task) =>
      Effect.sync(() => {
        calls.abandoned.push(task);
      }),
  };
  return { calls, ports };
}

describe("consultAdvisor", () => {
  it("advises a Codex-shaped caller inside a 45 second wait and archives the child", async () => {
    const { calls, ports } = fake({
      driver: "codex",
      results: [taskResult("a1", "completed", "Looks right; test the edge case.")],
    });
    const result = await Effect.runPromise(consultAdvisor(ports, { focus: "  the schema  " }));
    expect(result).toMatchObject({
      status: "advice",
      advice: "Looks right; test the edge case.",
      advisor: "Claude Fable 5.2 on Claude",
      advisorModel: fable,
      consultsRemaining: 2,
      briefTokens: 1_234,
      leftOut: 2,
    });
    expect(calls.starts).toBe(1);
    expect(calls.waits).toEqual([{ taskId: "a1", timeoutMs: 45_000 }]);
    expect(calls.briefs).toEqual([{ focus: "the schema", budgetTokens: 24_000 }]);
    expect(calls.archived).toEqual([["thread:child:a1"]]);
  });

  it("waits 45 seconds for an ACP-shaped caller and 4 minutes for a Claude one", async () => {
    for (const [driver, timeoutMs] of [
      ["acpRegistry", 45_000],
      ["muse", 45_000],
      ["claudeAgent", 240_000],
    ] as const) {
      const { calls, ports } = fake({ driver, results: [taskResult("a1", "completed", "ok")] });
      await Effect.runPromise(consultAdvisor(ports, {}));
      expect(calls.waits[0]?.timeoutMs).toBe(timeoutMs);
    }
  });

  it("lets a plan-mode caller consult", async () => {
    const { calls, ports } = fake({
      driver: "codex",
      thread: { interactionMode: "plan" },
      results: [taskResult("a1", "completed", "Plan is sound.")],
    });
    const result = await Effect.runPromise(consultAdvisor(ports, {}));
    expect(result.status).toBe("advice");
    expect(calls.starts).toBe(1);
  });

  it("returns refusals without starting anything", async () => {
    const cases = [
      { setup: { noRun: true }, refusal: "no-run" },
      { setup: { thread: { purpose: "advisor" as const } }, refusal: "advisor-thread" },
      { setup: { settings: DEFAULT_ADVISOR_SETTINGS }, refusal: "off" },
      { setup: { noAdvisor: true }, refusal: "no-advisor" },
      {
        setup: {
          subagents: () => [1, 2, 3].map((n) => task(`old${n}`, { status: "completed" })),
        },
        refusal: "limit",
      },
    ];
    for (const { setup, refusal } of cases) {
      const { calls, ports } = fake({ driver: "codex", results: [], ...setup });
      const result = await Effect.runPromise(consultAdvisor(ports, {}));
      expect(result).toMatchObject({ status: "refused", refusal });
      expect(calls.starts).toBe(0);
      expect(calls.waits).toEqual([]);
    }
  });

  it("returns working, then a second call picks up the same consult without a new child", async () => {
    const subagents: Array<OrchestrationV2Subagent> = [];
    const { calls, ports } = fake({
      driver: "codex",
      subagents: () => subagents,
      results: [taskResult("a1", "running"), taskResult("a1", "completed", "Use the cache.")],
    });
    const first = await Effect.runPromise(consultAdvisor(ports, {}));
    expect(first).toMatchObject({ status: "working", taskId: "a1", consultsRemaining: 2 });
    expect(calls.archived).toEqual([]);
    // The record the first call's dispatch created, still running.
    subagents.push(task("a1"));
    const second = await Effect.runPromise(consultAdvisor(ports, {}));
    expect(second).toMatchObject({
      status: "advice",
      advice: "Use the cache.",
      advisor: "claude-fable-5-2 label",
      consultsRemaining: 2,
    });
    expect(calls.starts).toBe(1);
    expect(calls.waits.map((wait) => wait.taskId)).toEqual(["a1", "a1"]);
    expect(calls.archived).toEqual([["thread:child:a1"]]);
  });

  it("reports a failed child, keeps it counted and archives settled children on the next consult", async () => {
    const { calls, ports } = fake({
      driver: "codex",
      results: [taskResult("a1", "failed", "Provider error: overloaded")],
    });
    const failed = await Effect.runPromise(consultAdvisor(ports, {}));
    expect(failed).toMatchObject({ status: "failed", taskId: "a1", consultsRemaining: 2 });
    expect(calls.archived).toEqual([]);

    const next = fake({
      driver: "codex",
      subagents: () => [task("a1", { status: "failed" })],
      results: [taskResult("a2", "completed", "Retry with backoff.")],
    });
    const result = await Effect.runPromise(consultAdvisor(next.ports, {}));
    expect(result).toMatchObject({ status: "advice", consultsRemaining: 1 });
    expect(next.calls.archived).toEqual([["thread:child:a1"], ["thread:child:a2"]]);
  });
  it("returns the same advice, with no second child or count, while a finished consult's record is not final yet", async () => {
    // The first call read the advice (acknowledging it); the record turns
    // final a moment later, so a call in between still sees it running.
    const answered = task("a1", {
      completionDelivery: { state: "acknowledged", observedByRunId: runId },
    });
    const { calls, ports } = fake({
      driver: "codex",
      subagents: () => [answered],
      results: [taskResult("a1", "completed", "Use the cache.")],
    });
    const result = await Effect.runPromise(consultAdvisor(ports, {}));
    expect(result).toMatchObject({
      status: "advice",
      advice: "Use the cache.",
      consultsRemaining: 2,
      message:
        "claude-fable-5-2 label gave this advice to your previous call; no new consult was started.",
    });
    expect(calls.starts).toBe(0);
    expect(calls.briefs).toEqual([]);
    // One record for this run: the next consult is number 2 of 3, not 3.
    expect(
      advisorConsultGate({
        thread: { id: callerId },
        settings: on,
        subagents: [{ ...answered, status: "completed", result: "Use the cache." }],
        runId,
      }),
    ).toEqual({ kind: "start", ordinal: 2, consultsRemaining: 1 });
  });

  it("ends a new consult whose child waits on a request nobody answers, instead of saying working", async () => {
    const { calls, ports } = fake({
      driver: "opencode",
      blocked: new Set(["thread:child:a1"]),
      results: [taskResult("a1", "running")],
    });
    const result = await Effect.runPromise(consultAdvisor(ports, {}));
    expect(result).toMatchObject({ status: "failed", taskId: "a1", consultsRemaining: 2 });
    expect(result.message).toContain("approval or an answer");
    expect(calls.abandoned).toEqual([{ taskId: "a1", childThreadId: "thread:child:a1" }]);
  });

  it("keeps saying working while an unblocked child is still thinking", async () => {
    const { calls, ports } = fake({ driver: "codex", results: [taskResult("a1", "running")] });
    const result = await Effect.runPromise(consultAdvisor(ports, {}));
    expect(result.status).toBe("working");
    expect(calls.abandoned).toEqual([]);
  });

  it("ends a blocked consult an earlier call left working when it is picked up, without waiting again", async () => {
    const stuck = task("a1");
    const { calls, ports } = fake({
      driver: "pi",
      subagents: () => [stuck],
      blocked: new Set(["thread:child:a1"]),
      results: [],
    });
    const result = await Effect.runPromise(consultAdvisor(ports, {}));
    expect(result).toMatchObject({ status: "failed", taskId: "a1", consultsRemaining: 2 });
    expect(calls.waits).toEqual([]);
    expect(calls.starts).toBe(0);
    expect(calls.abandoned).toEqual([{ taskId: "a1", childThreadId: "thread:child:a1" }]);
    // Stopped, it is final: the next call starts consult 2 and archives it.
    const next = fake({
      driver: "pi",
      subagents: () => [{ ...stuck, status: "cancelled" }],
      results: [taskResult("a2", "completed", "Fine.")],
    });
    expect(await Effect.runPromise(consultAdvisor(next.ports, {}))).toMatchObject({
      status: "advice",
      consultsRemaining: 1,
    });
    expect(next.calls.archived[0]).toEqual(["thread:child:a1"]);
  });

  it("ends a picked-up consult whose child became blocked during the wait", async () => {
    const { calls, ports } = fake({
      driver: "codex",
      subagents: () => [task("a1")],
      results: [taskResult("a1", "running")],
      blocked: new Set(),
    });
    // Not blocked before the wait: it waits, then the child asks for approval.
    let checks = 0;
    const blockedLater: typeof ports = {
      ...ports,
      blocked: () => Effect.sync(() => ++checks > 1),
    };
    const result = await Effect.runPromise(consultAdvisor(blockedLater, {}));
    expect(result.status).toBe("failed");
    expect(calls.waits.map((wait) => wait.taskId)).toEqual(["a1"]);
    expect(calls.abandoned).toEqual([{ taskId: "a1", childThreadId: "thread:child:a1" }]);
  });
  it("starts one child for two calls made at once, the second picking it up", async () => {
    const subagents: Array<OrchestrationV2Subagent> = [];
    const { calls, ports } = fake({
      driver: "codex",
      subagents: () => [...subagents],
      results: [taskResult("a1", "running"), taskResult("a1", "running")],
    });
    const lock = Semaphore.makeUnsafe(1);
    const racing: typeof ports = {
      ...ports,
      serialize: (effect) => lock.withPermits(1)(effect),
      // The dispatch records the task, after a pause in which the other call runs.
      start: (startInput) =>
        Effect.gen(function* () {
          yield* Effect.yieldNow;
          const taskId = yield* ports.start(startInput);
          subagents.push(task(taskId));
          return taskId;
        }),
    };
    const [first, second] = await Effect.runPromise(
      Effect.all([consultAdvisor(racing, {}), consultAdvisor(racing, {})], {
        concurrency: "unbounded",
      }),
    );
    expect(calls.starts).toBe(1);
    expect([first.status, second.status]).toEqual(["working", "working"]);
    expect([first.consultsRemaining, second.consultsRemaining]).toEqual([2, 2]);
    expect(calls.waits.map((wait) => wait.taskId)).toEqual(["a1", "a1"]);
  });
});
