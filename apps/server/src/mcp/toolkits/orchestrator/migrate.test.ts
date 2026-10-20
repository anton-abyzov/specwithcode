import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  HandoffModeError,
  type HandoffModeSnapshot,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import * as HandoffMode from "../../../handoff/HandoffMode.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "./handlers.ts";
import { migrateSummary } from "./migrate.ts";
import { OrchestratorToolkit } from "./tools.ts";

const projectId = ProjectId.make("project");
const coordinatorId = ThreadId.make("project-coordinator:project");
const providerInstanceId = ProviderInstanceId.make("codex");
const MINI = { id: "mini", label: "Mac mini", environmentId: EnvironmentId.make("env-mini") };
const LATER = "Handing a machine off arrives in a later SpecWithCode update.";

const shell = (id: string, overrides: Record<string, unknown> = {}) =>
  ({
    id: ThreadId.make(id),
    projectId,
    title: `Thread ${id}`,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "auto",
    interactionMode: "default",
    status: "running",
    activityRunStatus: null,
    activeRunId: `run-${id}`,
    latestRunId: `run-${id}`,
    archivedAt: null,
    deletedAt: null,
    lineage: { parentThreadId: null, relationshipToParent: null },
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;

const caller = shell(coordinatorId, { activeRunId: "active-run" });
const threads = [
  caller,
  shell("w1"),
  shell("w2"),
  shell("w3", { status: "completed", activeRunId: null }),
  shell("off"),
  shell("elsewhere", { projectId: ProjectId.make("other-project") }),
];

const snapshot = {
  environmentId: EnvironmentId.make("env-m4"),
  machineLabel: "M4",
  config: { defaultMode: "off" },
  projectModes: { [projectId]: "on" },
  threads: [{ threadId: "off", projectId, effectiveMode: "off", continuedOn: null }],
} as unknown as HandoffModeSnapshot;

const setup = (
  options: {
    readonly fenced?: boolean;
    readonly error?: HandoffModeError;
    readonly callerId?: ThreadId;
  } = {},
) => {
  const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
  const self = options.callerId === undefined ? caller : shell(options.callerId);
  const byId = new Map(threads.map((thread) => [thread.id as string, thread]));
  byId.set(self.id, self);
  const failOr = <A>(value: A) =>
    options.error === undefined ? Effect.succeed(value) : Effect.fail(options.error);
  const dependencies = Layer.mergeAll(
    Layer.succeed(RemoteWorkers.RemoteWorkers, {
      ...RemoteWorkers.RemoteWorkers.defaultValue(),
      enabled: true,
      resolveMachine: (target) =>
        target === undefined || target === "local"
          ? Effect.succeed({ kind: "local" })
          : Effect.succeed({ kind: "remote", machine: MINI }),
      resolveThread: ({ threadId }) =>
        Effect.succeed({ target: { kind: "local" }, threadId: ThreadId.make(threadId) }),
    }),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("env-m4"),
      requestNamespace: "session",
      thread: { threadId: self.id, providerSessionId: "session", providerInstanceId },
      client: undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(byId.get(id) ?? null),
      listProjectThreads: (input) =>
        Effect.sync(() => {
          calls.push({ method: "listProjectThreads", input });
          return threads.filter((thread) => thread.projectId === input.projectId);
        }),
    }),
    Layer.mock(HandoffMode.HandoffMode)({
      snapshot: Effect.succeed(snapshot),
      fence: () =>
        Effect.succeed(
          options.fenced
            ? { kind: "fenced", message: "Mac mini continues this thread; this copy is fenced." }
            : { kind: "unleased" },
        ),
      handOff: (input) =>
        Effect.suspend(() => {
          calls.push({ method: "handOff", input });
          return failOr({
            environmentId: MINI.environmentId,
            machineLabel: MINI.label,
            threadId: ThreadId.make(`${input.threadId}-mini`),
            modelSelection: null,
            notice: "Continues on Mac mini.",
          });
        }),
      handOffMachine: (input) =>
        Effect.suspend(() => {
          calls.push({ method: "handOffMachine", input });
          return failOr({
            destinationEnvironmentId: MINI.environmentId,
            destinationLabel: MINI.label,
            reason: input.reason,
            startedAt: "2026-10-20T00:00:00.000Z",
            finishedAt: "2026-10-20T00:00:05.000Z",
            results: (input.threadIds ?? []).map((threadId, index) =>
              index === 0
                ? {
                    threadId,
                    title: `Thread ${threadId}`,
                    outcome: "moved" as const,
                    detail: null,
                    continuedThreadId: ThreadId.make(`${threadId}-mini`),
                    resumed: true,
                  }
                : {
                    threadId,
                    title: `Thread ${threadId}`,
                    outcome: "stayed" as const,
                    detail: "Mac mini has no checkout of this repository.",
                    continuedThreadId: null,
                    resumed: false,
                  },
            ),
          });
        }),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId ? Option.some({ id, workspaceSettings: {} } as never) : Option.none(),
        ),
    }),
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({}),
    Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
  );
  const call = (params: Record<string, unknown>) =>
    OrchestratorToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer).pipe(
          Layer.provide(dependencies),
        ),
      ),
      Effect.flatMap((toolkit) =>
        toolkit
          .handle("studio_thread_migrate", params as never)
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies)),
      ),
      Effect.map((results) => results.at(-1)?.result as unknown as Record<string, unknown>),
    );
  const handoffCalls = () =>
    calls.filter((entry) => entry.method === "handOff" || entry.method === "handOffMachine");
  return { call, calls, handoffCalls };
};

it.effect("moves one thread with handOff to the machine the launch resolver names", () => {
  const { call, handoffCalls } = setup();
  return Effect.gen(function* () {
    const moved = yield* call({
      machine: "Mac mini",
      threadIds: ["w1"],
      modelSelection: { instanceId: "codex", model: "gpt-5.5" },
    });
    expect(handoffCalls()).toEqual([
      {
        method: "handOff",
        input: {
          threadId: "w1",
          destinationEnvironmentId: MINI.environmentId,
          modelSelection: { instanceId: "codex", model: "gpt-5.5" },
        },
      },
    ]);
    expect(moved).toMatchObject({
      destination: { environmentId: MINI.environmentId, label: "Mac mini" },
      reason: "manual",
      results: [
        {
          threadId: "w1",
          outcome: "moved",
          detail: "Continues on Mac mini.",
          continuedThreadId: "w1-mini",
        },
      ],
      summary: "Mac mini: 1 moved.",
    });
  });
});

it.effect("moves several threads with handOffMachine and returns each thread's result", () => {
  const { call, handoffCalls } = setup();
  return Effect.gen(function* () {
    const run = yield* call({ machine: "mini", threadIds: ["w1", "w2", "w1"] });
    expect(handoffCalls()).toEqual([
      {
        method: "handOffMachine",
        input: {
          destinationEnvironmentId: MINI.environmentId,
          reason: "manual",
          threadIds: ["w1", "w2"],
        },
      },
    ]);
    expect(run).toMatchObject({
      destination: { environmentId: MINI.environmentId, label: "Mac mini" },
      results: [
        { threadId: "w1", outcome: "moved", continuedThreadId: "w1-mini", resumed: true },
        {
          threadId: "w2",
          outcome: "stayed",
          detail: "Mac mini has no checkout of this repository.",
          resumed: false,
        },
      ],
      summary: "Mac mini: 1 moved, 1 stayed.",
    });
  });
});

it.effect(
  "names only this project's running handoff-mode threads when threadIds is omitted",
  () => {
    const { call, calls } = setup();
    return Effect.gen(function* () {
      yield* call({ machine: "mini" });
      expect(calls).toEqual([
        { method: "listProjectThreads", input: { projectId, includeSubagents: false } },
        {
          method: "handOffMachine",
          input: {
            destinationEnvironmentId: MINI.environmentId,
            reason: "manual",
            threadIds: ["w1", "w2"],
          },
        },
      ]);
    });
  },
);

it.effect("refuses another project's thread and a non-coordinator before any handoff", () => {
  const coordinator = setup();
  const worker = setup({ callerId: ThreadId.make("w9") });
  return Effect.gen(function* () {
    expect(
      yield* coordinator.call({ machine: "mini", threadIds: ["w1", "elsewhere"] }),
    ).toMatchObject({
      code: "capability_denied",
      message: expect.stringContaining("belongs to another project"),
    });
    expect(yield* worker.call({ machine: "mini", threadIds: ["w1"] })).toMatchObject({
      code: "capability_denied",
    });
    expect(yield* coordinator.call({ machine: "local", threadIds: ["w1"] })).toMatchObject({
      code: "invalid_request",
    });
    expect([...coordinator.handoffCalls(), ...worker.handoffCalls()]).toEqual([]);
  });
});

it.effect("surfaces the handoff service's error code and message verbatim", () => {
  const { call, handoffCalls } = setup({
    error: new HandoffModeError({ code: "failed", message: LATER }),
  });
  return Effect.gen(function* () {
    expect(yield* call({ machine: "mini", threadIds: ["w1", "w2"] })).toMatchObject({
      code: "orchestration_error",
      message: `Handoff failed (failed): ${LATER}`,
    });
    expect(handoffCalls()).toHaveLength(1);
  });
});

it.effect("refuses a fenced copy through the side-effect fence before any handoff", () => {
  const { call, handoffCalls } = setup({ fenced: true });
  return Effect.gen(function* () {
    expect(yield* call({ machine: "mini", threadIds: ["w1"] })).toMatchObject({
      code: "thread_fenced",
      message: "Mac mini continues this thread; this copy is fenced.",
    });
    expect(handoffCalls()).toEqual([]);
  });
});

it("summarizes each outcome and an empty run", () => {
  expect(
    migrateSummary("Mac mini", [
      { outcome: "moved" },
      { outcome: "moved" },
      { outcome: "skipped" },
    ]),
  ).toBe("Mac mini: 2 moved, 1 skipped.");
  expect(migrateSummary("Mac mini", [])).toBe("Mac mini: no running handoff-mode threads to move.");
});
