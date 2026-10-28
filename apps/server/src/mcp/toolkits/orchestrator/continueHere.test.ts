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
import * as TestClock from "effect/testing/TestClock";

import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import * as WorkGrants from "../../../fleet/WorkGrants.ts";
import * as HandoffMode from "../../../handoff/HandoffMode.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "./handlers.ts";
import { OrchestratorToolkit } from "./tools.ts";

const projectId = ProjectId.make("project-minis");
const coordinatorId = ThreadId.make("project-coordinator:project-minis");
const providerInstanceId = ProviderInstanceId.make("codex");
const M4 = EnvironmentId.make("env-m4");
const MINIS = EnvironmentId.make("env-minis");
const LONG_AGO = "2026-10-20T00:00:00.000Z";
const NOW = "2026-10-21T00:00:00.000Z";
const FIVE_MINUTES_BEFORE_NOW = "2026-10-20T23:55:00.000Z";

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

const replica = (sourceThreadId: string, overrides: Record<string, unknown> = {}) => ({
  sourceEnvironmentId: M4,
  sourceLabel: "M4",
  sourceThreadId: ThreadId.make(sourceThreadId),
  projectId,
  title: `M4 ${sourceThreadId}`,
  checkpoint: { createdAt: "2026-10-20T10:00:00.000Z", branch: "feat/x" },
  lease: {
    holderEnvironmentId: M4,
    holderLabel: "M4",
    holderThreadId: ThreadId.make(sourceThreadId),
    epoch: 3,
    renewedAt: LONG_AGO,
    state: "held",
  },
  sourceLastSeenAt: LONG_AGO,
  sourceUnreachable: true,
  receivedAt: LONG_AGO,
  continuedThreadId: null,
  ...overrides,
});

const snapshot = {
  environmentId: MINIS,
  machineLabel: "Minis",
  config: { defaultMode: "on" },
  projectModes: {},
  threads: [],
  incoming: [
    replica("t-old", { checkpoint: { createdAt: "2026-10-20T09:00:00.000Z", branch: null } }),
    replica("t-new", { checkpoint: { createdAt: "2026-10-20T11:00:00.000Z", branch: "feat/y" } }),
    replica("t-live", { lease: { ...replica("x").lease, renewedAt: NOW } }),
    replica("t-recent", {
      checkpoint: { createdAt: "2026-10-20T08:00:00.000Z", branch: null },
      lease: { ...replica("x").lease, renewedAt: FIVE_MINUTES_BEFORE_NOW },
    }),
    replica("t-done", { continuedThreadId: ThreadId.make("t-done-minis") }),
    replica("t-other", { projectId: ProjectId.make("other") }),
    replica("t-unlinked", { projectId: null }),
  ],
  pausedSince: null,
  machineRun: null,
} as unknown as HandoffModeSnapshot;

const setup = (
  options: {
    readonly callerId?: ThreadId;
    readonly error?: HandoffModeError;
    readonly runtimeMode?: "auto" | "full-access";
    readonly grants?: WorkGrants.WorkGrantsShape;
  } = {},
) => {
  const continued: Array<unknown> = [];
  const asked: Array<unknown> = [];
  const self = shell(options.callerId ?? coordinatorId, {
    activeRunId: "active-run",
    ...(options.runtimeMode === undefined ? {} : { runtimeMode: options.runtimeMode }),
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(WorkGrants.WorkGrants, options.grants ?? WorkGrants.WorkGrants.defaultValue()),
    Layer.succeed(RemoteWorkers.RemoteWorkers, {
      ...RemoteWorkers.RemoteWorkers.defaultValue(),
      enabled: true,
    }),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: MINIS,
      requestNamespace: "session",
      thread: { threadId: self.id, providerSessionId: "session", providerInstanceId },
      client: undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(id === self.id ? self : null),
    }),
    Layer.mock(HandoffMode.HandoffMode)({
      environmentId: MINIS,
      machineLabel: "Minis",
      snapshot: Effect.succeed(snapshot),
      fence: () => Effect.succeed({ kind: "unleased" }),
      continueHere: (input, continueOptions) =>
        Effect.suspend(() => {
          continued.push(input);
          asked.push(continueOptions);
          return options.error === undefined
            ? Effect.succeed({
                environmentId: MINIS,
                machineLabel: "Minis",
                threadId: ThreadId.make(`${input.sourceThreadId}-minis`),
                modelSelection: null,
                notice: "Continues here from M4's checkpoint.",
              })
            : Effect.fail(options.error);
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
  const call = (tool: string, params: Record<string, unknown>) =>
    OrchestratorToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer).pipe(
          Layer.provide(dependencies),
        ),
      ),
      Effect.flatMap((toolkit) =>
        toolkit
          .handle(tool as never, params as never)
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies)),
      ),
      Effect.map((results) => results.at(-1)?.result as unknown as Record<string, unknown>),
    );
  return { call, continued, asked };
};

it.effect("lists this project's handoff-ready threads from other machines, newest first", () => {
  const { call } = setup();
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const listed = yield* call("studio_handoff_ready_list", {});
    expect(listed).toMatchObject({
      projectId,
      threads: [
        {
          source: { environmentId: M4, label: "M4" },
          sourceThreadId: "t-new",
          title: "M4 t-new",
          branch: "feat/y",
          sourceUnreachable: true,
          canContinueNow: true,
          continuedThreadId: null,
        },
        { sourceThreadId: "t-live", canContinueNow: false },
        { sourceThreadId: "t-old", canContinueNow: true },
        // Its lease is stale, but an agent waits 10 minutes of silence.
        { sourceThreadId: "t-recent", canContinueNow: false },
      ],
    });
    // Sorted by checkpoint time; t-live keeps the replica default of 10:00.
    expect(
      (listed.threads as Array<{ sourceThreadId: string }>).map((t) => t.sourceThreadId),
    ).toEqual(["t-new", "t-live", "t-old", "t-recent"]);
    const all = yield* call("studio_handoff_ready_list", { includeContinued: true });
    expect(
      (all.threads as Array<{ sourceThreadId: string }>).map((t) => t.sourceThreadId),
    ).toContain("t-done");
  });
});

it.effect("continues one handoff-ready thread here in a single call", () => {
  const { call, continued, asked } = setup();
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const result = yield* call("studio_thread_continue_here", { sourceThreadId: "t-new" });
    expect(continued).toEqual([{ sourceEnvironmentId: M4, sourceThreadId: "t-new" }]);
    // The service holds an agent to more than the user: shown online, the source asked.
    expect(asked).toEqual([{ byAgent: true }]);
    expect(result).toEqual({
      source: { environmentId: M4, label: "M4" },
      sourceThreadId: "t-new",
      threadId: "t-new-minis",
      machineLabel: "Minis",
      modelSelection: null,
      notice: "Continues here from M4's checkpoint.",
    });
  });
});

it.effect("refuses another project's or an unlinked replica, and a non-coordinator", () => {
  const coordinator = setup();
  const worker = setup({ callerId: ThreadId.make("worker") });
  return Effect.gen(function* () {
    expect(
      yield* coordinator.call("studio_thread_continue_here", { sourceThreadId: "t-other" }),
    ).toMatchObject({
      code: "capability_denied",
      message: expect.stringContaining("another project"),
    });
    expect(
      yield* coordinator.call("studio_thread_continue_here", { sourceThreadId: "t-unlinked" }),
    ).toMatchObject({ code: "capability_denied", message: expect.stringContaining("not linked") });
    expect(
      yield* coordinator.call("studio_thread_continue_here", { sourceThreadId: "missing" }),
    ).toMatchObject({ code: "thread_not_found" });
    expect(
      yield* coordinator.call("studio_thread_continue_here", {
        sourceThreadId: "t-new",
        machine: "Mac mini",
      }),
    ).toMatchObject({ code: "thread_not_found" });
    expect(
      yield* worker.call("studio_thread_continue_here", { sourceThreadId: "t-new" }),
    ).toMatchObject({ code: "capability_denied" });
    expect([...coordinator.continued, ...worker.continued]).toEqual([]);
  });
});

it.effect("returns the handoff service's refusal verbatim, such as a live lease", () => {
  const { call } = setup({
    error: new HandoffModeError({
      code: "busy",
      message:
        "M4 renewed this thread's lease less than 90 seconds ago; it may still be running it.",
    }),
  });
  return Effect.gen(function* () {
    // Eleven minutes after t-live's last renewal: past the agent's wait, so the service decides.
    yield* TestClock.setTime(Date.parse(NOW) + 11 * 60_000);
    expect(yield* call("studio_thread_continue_here", { sourceThreadId: "t-live" })).toMatchObject({
      code: "orchestration_error",
      message: expect.stringContaining("Handoff failed (busy): M4 renewed"),
    });
  });
});

it.effect("refuses continuing a handoff to a thread another machine's grant started", () => {
  // M1's work started this full-access worker here under M1's grant. The
  // continued thread would be this machine's own, outside that grant.
  const M1 = EnvironmentId.make("env-m1");
  const worker = ThreadId.make("m1-worker");
  const grant = {
    coordinatorEnvironmentId: M1,
    projects: { kind: "all" },
    accounts: { kind: "all" },
    owner: "self",
    hopLimit: 2,
    revoked: false,
  } as const;
  const grants: WorkGrants.WorkGrantsShape = {
    ...WorkGrants.WorkGrants.defaultValue(),
    enabled: true,
    forClient: () => Effect.succeed(undefined),
    forCoordinator: () => Effect.succeed(grant),
    originOf: (thread) =>
      Effect.succeed(
        thread.id === worker ? { coordinatorEnvironmentId: M1, path: [M1], hops: 1 } : undefined,
      ),
  };
  const underGrant = setup({ callerId: worker, runtimeMode: "full-access", grants });
  const ownWorker = setup({ callerId: worker, runtimeMode: "full-access" });
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    expect(
      yield* underGrant.call("studio_thread_continue_here", { sourceThreadId: "t-new" }),
    ).toMatchObject({ code: "outside_grant_scope" });
    expect(underGrant.continued).toEqual([]);
    // The same worker as this machine's own work still continues it.
    yield* ownWorker.call("studio_thread_continue_here", { sourceThreadId: "t-new" });
    expect(ownWorker.continued).toEqual([{ sourceEnvironmentId: M4, sourceThreadId: "t-new" }]);
  });
});

it.effect("refuses an agent while the source has been silent less than 10 minutes", () => {
  const { call, continued } = setup();
  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    // The lease is five minutes stale: the user may continue it, an agent may not yet.
    expect(
      yield* call("studio_thread_continue_here", { sourceThreadId: "t-recent" }),
    ).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("renewed thread t-recent's lease 5 minutes ago"),
    });
    expect(continued).toEqual([]);
    yield* TestClock.adjust("5 minutes");
    yield* call("studio_thread_continue_here", { sourceThreadId: "t-recent" });
    expect(continued).toEqual([{ sourceEnvironmentId: M4, sourceThreadId: "t-recent" }]);
  });
});
