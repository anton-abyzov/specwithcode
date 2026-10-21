import { describe, it } from "@effect/vitest";
import {
  ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_TASK_ROUTING_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  type TaskRoutingDecision,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import { projectFixture } from "../project/ProjectWorkspace.testkit.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  makeSweep,
  taskRoutingEscalationCommand,
  type EscalationThread,
} from "./TaskRoutingEscalationWorker.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const sonnet = { instanceId: claude, model: "claude-sonnet-5-5" };
const opus = { instanceId: claude, model: "claude-opus-5-5" };
const projectId = ProjectId.make("project:escalation");

const ready: ServerProvider = {
  instanceId: claude,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-20T00:00:00.000Z",
  models: [
    { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
    { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};

const routing: TaskRoutingDecision = {
  taskClass: "translation",
  confidence: "high",
  moved: true,
  tier: "standard",
  selection: sonnet,
  baseline: opus,
  escalation: opus,
  billing: "subscription",
  reason: "Translation fits Standard: Claude Sonnet 5.5 instead of Claude Opus 5.5.",
  signals: ["translate"],
  decidedAt: "2026-10-20T20:00:00.000Z",
};

const failed = (
  over: Partial<EscalationThread> = {},
): EscalationThread & { projectId: ProjectId } => ({
  id: ThreadId.make("thread:routed"),
  projectId,
  modelSelection: sonnet,
  status: "failed",
  lastErrorClass: "provider_error",
  latestRunId: RunId.make("run:routed:1"),
  activeRunId: null,
  pendingRuntimeRequest: null,
  settledOverride: null,
  routing,
  ...over,
});

describe("taskRoutingEscalationCommand", () => {
  it("continues a failed routed run once on the baseline, in the same thread", () => {
    const command = taskRoutingEscalationCommand(failed(), [ready]);
    expect(command).toMatchObject({
      type: "message.dispatch",
      commandId: "route-escalate:thread:routed",
      threadId: "thread:routed",
      manualContinuationOfRunId: "run:routed:1",
      modelSelection: opus,
      dispatchMode: { type: "start_immediately" },
    });
    expect((command as { text: string }).text).toContain("you now run on Claude Opus 5.5");
    // The id is one per thread: a second failure produces the same id, which the orchestrator refuses.
    expect(
      taskRoutingEscalationCommand(failed({ latestRunId: RunId.make("run:routed:2") }), [ready])
        ?.commandId,
    ).toBe(command?.commandId);
  });

  it("leaves usage limits to the provider fallback and never escalates a refused permission", () => {
    expect(
      taskRoutingEscalationCommand(failed({ lastErrorClass: "usage_limit" }), [ready]),
    ).toBeNull();
    expect(
      taskRoutingEscalationCommand(failed({ lastErrorClass: "permission_error" }), [ready]),
    ).toBeNull();
    expect(
      taskRoutingEscalationCommand(failed({ lastErrorClass: "transport_error" }), [ready]),
    ).toBeNull();
  });

  it("never acts mid-turn, on a thread already moved or escalated, or without a ready target", () => {
    expect(
      taskRoutingEscalationCommand(failed({ activeRunId: RunId.make("run:live") }), [ready]),
    ).toBeNull();
    expect(taskRoutingEscalationCommand(failed({ modelSelection: opus }), [ready])).toBeNull();
    expect(
      taskRoutingEscalationCommand(
        failed({
          modelSelection: {
            instanceId: ProviderInstanceId.make("copilot-0889"),
            model: "claude-sonnet-5.5",
          },
        }),
        [ready],
      ),
    ).toBeNull();
    expect(taskRoutingEscalationCommand(failed({ status: "completed" }), [ready])).toBeNull();
    expect(taskRoutingEscalationCommand(failed(), [{ ...ready, status: "error" }])).toBeNull();
    expect(
      taskRoutingEscalationCommand(failed({ routing: { ...routing, escalation: null } }), [ready]),
    ).toBeNull();
    expect(
      taskRoutingEscalationCommand(failed({ routing: { ...routing, moved: false } }), [ready]),
    ).toBeNull();
    // A delegated task's failure already went to its parent, which owns the retry.
    expect(
      taskRoutingEscalationCommand(
        failed({
          lineage: {
            parentThreadId: ThreadId.make("thread:parent"),
            relationshipToParent: "subagent",
            rootThreadId: ThreadId.make("thread:parent"),
          },
        }),
        [ready],
      ),
    ).toBeNull();
  });
});

describe("TaskRoutingEscalationWorker sweep", () => {
  const sweepWith = (
    escalate: boolean,
    dispatched: Array<OrchestrationV2ServerCommand>,
    failureCode: string | null = null,
  ) => {
    let thread = failed() as unknown as OrchestrationV2ThreadShell;
    const deps = Layer.mergeAll(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getShellSnapshot: () => Effect.sync(() => ({ threads: [thread] }) as never),
        getThreadShell: () => Effect.sync(() => thread),
        getThreadRecords: () =>
          Effect.sync(() => {
            const latest = {
              id: thread.latestRunId,
              status: "failed",
              rootNodeId: "root",
            };
            const error = {
              type: "error",
              id: "error",
              status: "failed",
              runId: thread.latestRunId,
              nodeId: "root",
              ordinal: 1,
              updatedAt: DateTime.makeUnsafe(1),
              failure: {
                class: "provider_error",
                message: "failed",
                code: failureCode,
                retryable: false,
              },
            };
            return { runs: [latest], turnItems: [error] } as never;
          }),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command as OrchestrationV2ServerCommand);
            // The continuation moves the thread to the baseline model and starts a run.
            thread = {
              ...thread,
              modelSelection: opus,
              status: "running",
              activeRunId: RunId.make("run:routed:2"),
            };
            return {} as never;
          }),
      }),
      Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.succeed([ready]) }),
      Layer.mock(Projects.ProjectService)({
        getById: (id) =>
          Effect.succeed(
            Option.some(
              projectFixture(id, { workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS }),
            ),
          ),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          taskRouting: { ...DEFAULT_TASK_ROUTING_SETTINGS, mode: "auto", escalate },
        }),
      }),
    );
    return {
      fail: () => {
        thread = {
          ...thread,
          status: "failed",
          activeRunId: null,
          latestRunId: RunId.make("run:routed:3"),
        };
      },
      sweep: makeSweep.pipe(Effect.provide(deps)),
    };
  };

  it.effect("escalates a failed routed thread exactly once", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationV2ServerCommand> = [];
      const harness = sweepWith(true, dispatched);
      const sweep = yield* harness.sweep;
      yield* sweep();
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({ modelSelection: opus });
      // The escalated run fails too: no second step, no loop.
      harness.fail();
      yield* TestClock.adjust("31 seconds");
      yield* sweep();
      expect(dispatched).toHaveLength(1);
    }),
  );

  it.effect("does nothing when the policy turned escalation off", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationV2ServerCommand> = [];
      const sweep = yield* sweepWith(false, dispatched).sweep;
      yield* sweep();
      expect(dispatched).toHaveLength(0);
    }),
  );

  it.effect("leaves a provider that could not open to the provider fallback", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationV2ServerCommand> = [];
      // The fallback's `switch` rule moves this thread; continuing it here too would run it twice.
      const sweep = yield* sweepWith(
        true,
        dispatched,
        ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE,
      ).sweep;
      yield* sweep();
      expect(dispatched).toHaveLength(0);
    }),
  );
});
