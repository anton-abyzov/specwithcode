import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_TASK_ROUTING_SETTINGS,
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
  type TaskRoutingDecision,
  type TaskRoutingSettings,
  type ModelLanes,
  type LearnedModelPreference,
} from "@specweave-studio/contracts";
import { ProviderFallbackEnv } from "../orchestration-v2/ProviderFallbackWorker.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { projectFixture } from "../project/ProjectWorkspace.testkit.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const parentThreadId = ThreadId.make("thread:routing-parent");
const childThreadId = ThreadId.make("thread:routing-child");
const parentRunId = RunId.make("run:routing-parent");
const parentNodeId = NodeId.make("node:routing-root");
const taskId = NodeId.make("node:routing-task");
const projectId = ProjectId.make("project:routing");
const claude = ProviderInstanceId.make("claudeAgent");
const copilot = ProviderInstanceId.make("copilot-0889");
const opus = { instanceId: claude, model: "claude-opus-5-5" };

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:routing"),
  requestNamespace: "provider-session:routing",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:routing",
    providerInstanceId: claude,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const effort = {
  id: "effort",
  label: "Effort",
  type: "select" as const,
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
  ],
};

const provider = (
  instanceId: ProviderInstanceId,
  driver: string,
  models: ReadonlyArray<readonly [string, string]>,
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-20T00:00:00.000Z",
  models: models.map(([slug, name]) => ({
    slug,
    name,
    isCustom: false,
    capabilities: { optionDescriptors: [effort] },
  })),
  slashCommands: [],
  skills: [],
});

const providers = [
  provider(claude, "claudeAgent", [
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
    ["claude-haiku-5-5", "Claude Haiku 5.5"],
  ]),
  provider(copilot, "acpRegistry", [
    ["claude-opus-5.5", "Claude Opus 5.5"],
    ["claude-sonnet-5.5", "Claude Sonnet 5.5"],
  ]),
];

const parentProjection = (
  subagents: ReadonlyArray<unknown>,
  modelSelection = opus,
): OrchestrationV2ThreadProjection =>
  ({
    thread: {
      id: parentThreadId,
      projectId,
      title: "Routing parent",
      createdBy: "user",
      creationSource: "web",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    },
    runs: [
      {
        id: parentRunId,
        ordinal: 1,
        status: "running",
        rootNodeId: parentNodeId,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
      },
    ],
    contextTransfers: [],
    subagents,
  }) as unknown as OrchestrationV2ThreadProjection;

const childProjection = {
  thread: {
    id: childThreadId,
    title: "Child",
    modelSelection: opus,
    createdBy: "agent",
    creationSource: "mcp",
  },
  runs: [],
  contextTransfers: [],
  messages: [],
  subagents: [],
  providerThreads: [],
  turnItems: [],
} as unknown as OrchestrationV2ThreadProjection;

interface Harness {
  readonly policy?: Partial<TaskRoutingSettings>;
  /** The calling thread coordinates the project. */
  readonly coordinator?: boolean;
  readonly parentModel?: typeof opus;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly modelLanes?: ModelLanes;
  readonly learnedModelPreferences?: ReadonlyArray<LearnedModelPreference>;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

type Dispatched = {
  readonly type: string;
  readonly modelSelection?: { readonly instanceId: string; readonly model: string };
  readonly routing?: TaskRoutingDecision;
  readonly task?: string;
  readonly text?: string;
};

const run = <A, E>(
  harness: Harness,
  use: (
    service: OrchestratorMcpService.OrchestratorMcpService["Service"],
    dispatched: Ref.Ref<ReadonlyArray<Dispatched>>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<Dispatched>>([]);
    let task: unknown = null;
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      taskRouting: { ...DEFAULT_TASK_ROUTING_SETTINGS, ...harness.policy },
      ...(harness.modelLanes !== undefined ? { modelLanes: harness.modelLanes } : {}),
      ...(harness.learnedModelPreferences !== undefined
        ? { learnedModelPreferences: harness.learnedModelPreferences }
        : {}),
    };
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: (threadId) =>
          Effect.succeed(
            threadId === parentThreadId
              ? parentProjection(task === null ? [] : [task], harness.parentModel)
              : childProjection,
          ),
        dispatch: (command) =>
          Effect.gen(function* () {
            yield* Ref.update(dispatched, (commands) => [...commands, command as Dispatched]);
            if (command.type !== "delegated_task.request")
              return { sequence: 1, storedEvents: [] } as never;
            task = {
              id: taskId,
              threadId: parentThreadId,
              runId: parentRunId,
              parentNodeId,
              origin: "app_owned",
              createdBy: "agent",
              driver: ProviderDriverKind.make("claudeAgent"),
              providerInstanceId: command.modelSelection.instanceId,
              providerThreadId: null,
              childThreadId,
              nativeTaskRef: null,
              prompt: command.task,
              title: null,
              model: command.modelSelection.model,
              ...(command.routing === undefined ? {} : { routing: command.routing }),
              status: "running",
              result: null,
              startedAt: null,
              completedAt: null,
            };
            return {
              sequence: 1,
              storedEvents: [
                {
                  sequence: 1,
                  commandId: null,
                  event: { type: "subagent.updated", payload: task },
                },
              ],
            } as never;
          }),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed(harness.providers ?? providers),
        refreshInstance: () => Effect.succeed(harness.providers ?? providers),
      }),
      Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
        ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
          list: () => Effect.succeed([claude, copilot]),
          get: (instanceId) => Effect.succeed({ instanceId } as unknown as ProviderAdapterV2Shape),
        }),
      ),
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.sync(() =>
            Option.some(
              projectFixture(id, {
                defaultModelSelection: opus,
                workspaceSettings: {
                  ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
                  ...(harness.coordinator === false ? {} : { coordinatorThreadId: parentThreadId }),
                },
              }),
            ),
          ),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed(settings),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      Layer.succeed(ProviderFallbackEnv, harness.env ?? {}),
    );
    return yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* use(service, dispatched);
    }).pipe(
      Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(layer))),
      Effect.provideService(ProviderFallbackEnv, harness.env ?? {}),
    );
  });

const delegated = (dispatched: Ref.Ref<ReadonlyArray<Dispatched>>) =>
  Ref.get(dispatched).pipe(
    Effect.map((commands) =>
      commands.find((command) => command.type === "delegated_task.request")!,
    ),
  );

describe("OrchestratorMcpService task routing", () => {
  it.effect(
    "moves a coordinator's translation worker from Opus 5.5 to Sonnet 5.5 and records why",
    () =>
      run({ policy: { mode: "auto" } }, (service, dispatched) =>
        Effect.gen(function* () {
          const result = yield* service.delegateTask(scope, {
            task: "Translate the onboarding emails into Spanish.",
            mode: "async",
            clientRequestId: "route-translation",
          });
          const request = yield* delegated(dispatched);
          assert.deepInclude(request.modelSelection, {
            instanceId: claude,
            model: "claude-sonnet-5-5",
          });
          assert.equal(request.routing?.taskClass, "translation");
          assert.isTrue(request.routing?.moved);
          assert.deepEqual(request.routing?.escalation, opus);
          assert.equal(result.routing?.selection.model, "claude-sonnet-5-5");
          assert.equal(result.model, "claude-sonnet-5-5");
        }),
      ),
  );

  it.effect("keeps today's worker model when Auto is off", () =>
    run({}, (service, dispatched) =>
      Effect.gen(function* () {
        yield* service.delegateTask(scope, {
          task: "Translate the onboarding emails into Spanish.",
          mode: "async",
          clientRequestId: "route-off",
        });
        const request = yield* delegated(dispatched);
        assert.equal(request.modelSelection?.model, "claude-opus-5-5");
        assert.isUndefined(request.routing);
      }),
    ),
  );

  it.effect("never overrides a named model", () =>
    run({ policy: { mode: "auto" } }, (service, dispatched) =>
      Effect.gen(function* () {
        yield* service.delegateTask(scope, {
          task: "Translate the onboarding emails into Spanish.",
          target: { providerInstanceId: claude, model: "claude-opus-5-5", effort: "high" },
          mode: "async",
          clientRequestId: "route-pinned",
        });
        const request = yield* delegated(dispatched);
        assert.equal(request.modelSelection?.model, "claude-opus-5-5");
        assert.isUndefined(request.routing);
      }),
    ),
  );

  it.effect("keeps code and review work on the baseline and says so", () =>
    run({ policy: { mode: "auto" } }, (service, dispatched) =>
      Effect.gen(function* () {
        yield* service.delegateTask(scope, {
          task: "Implement the billing endpoint and its unit tests.",
          mode: "async",
          clientRequestId: "route-code",
        });
        const request = yield* delegated(dispatched);
        assert.equal(request.modelSelection?.model, "claude-opus-5-5");
        assert.equal(request.routing?.taskClass, "code");
        assert.isFalse(request.routing?.moved);
        assert.isNull(request.routing?.escalation);
      }),
    ),
  );

  it.effect("leaves a non-coordinator's inherited model alone unless it passes a task class", () =>
    run({ policy: { mode: "auto" }, coordinator: false }, (service, dispatched) =>
      Effect.gen(function* () {
        yield* service.delegateTask(scope, {
          task: "Translate the onboarding emails into Spanish.",
          mode: "async",
          clientRequestId: "route-lane",
        });
        const inherited = yield* delegated(dispatched);
        assert.equal(inherited.modelSelection?.model, "claude-opus-5-5");
        assert.isUndefined(inherited.routing);
        yield* Ref.set(dispatched, []);
        yield* service.delegateTask(scope, {
          task: "Handle the strings in docs/es.",
          taskClass: "translation",
          mode: "async",
          clientRequestId: "route-lane-hint",
        });
        const hinted = yield* delegated(dispatched);
        assert.equal(hinted.modelSelection?.model, "claude-sonnet-5-5");
        assert.equal(hinted.routing?.confidence, "hint");
      }),
    ),
  );

  it.effect("keeps Auto off for work under a grant that names its sign-ins", () =>
    run({ policy: { mode: "auto" } }, (service, dispatched) =>
      Effect.gen(function* () {
        yield* service.delegateTask(
          scope,
          {
            task: "Translate the emails.",
            taskClass: "translation",
            mode: "async",
            clientRequestId: "route-grant",
          },
          { autoRouting: false },
        );
        const request = yield* delegated(dispatched);
        assert.equal(request.modelSelection?.model, "claude-opus-5-5");
        assert.isUndefined(request.routing);
      }),
    ),
  );

  it.effect(
    "routes around an excluded provider to the other Copilot only when it is not excluded",
    () =>
      run({ policy: { mode: "auto", excludedProviders: [claude] } }, (service, dispatched) =>
        Effect.gen(function* () {
          yield* service.delegateTask(scope, {
            task: "Summarize the meeting notes.",
            mode: "async",
            clientRequestId: "route-excluded",
          });
          const request = yield* delegated(dispatched);
          assert.deepInclude(request.modelSelection, {
            instanceId: copilot,
            model: "claude-sonnet-5.5",
          });
        }),
      ),
  );

  it.effect("tells a long-audio worker to transcribe with ASR before the text model", () =>
    run({ policy: { mode: "auto" } }, (service, dispatched) =>
      Effect.gen(function* () {
        yield* service.delegateTask(scope, {
          task: "Process an hour of speech from the keynote recording into chapter notes.",
          mode: "async",
          clientRequestId: "route-audio",
        });
        const request = yield* delegated(dispatched);
        assert.equal(request.routing?.taskClass, "transcript");
        assert.include(request.task, "speech-to-text (ASR)");
        assert.include(request.task, "the text model never reads audio");
      }),
    ),
  );

  it.effect("routes complex work to the first model in the complex lane", () =>
    run(
      {
        modelLanes: {
          complex: [{ instanceId: claude, model: "claude-opus-5-5" }],
          routine: [{ instanceId: claude, model: "claude-haiku-5-5" }],
        },
      },
      (service, dispatched) =>
        Effect.gen(function* () {
          yield* service.delegateTask(scope, {
            task: "Design an end-to-end distributed consensus architecture and evaluate trade-offs.",
            mode: "async",
            clientRequestId: "route-complex-lane",
          });
          const request = yield* delegated(dispatched);
          assert.equal(request.modelSelection?.model, "claude-opus-5-5");
          assert.equal(request.routing?.lane, "complex");
        }),
    ),
  );

  it.effect("routes routine work to the first model in the routine lane", () =>
    run(
      {
        modelLanes: {
          complex: [{ instanceId: claude, model: "claude-opus-5-5" }],
          routine: [{ instanceId: claude, model: "claude-haiku-5-5" }],
        },
      },
      (service, dispatched) =>
        Effect.gen(function* () {
          yield* service.delegateTask(scope, {
            task: "Fix a typo in README.md and update changelog.",
            mode: "async",
            clientRequestId: "route-routine-lane",
          });
          const request = yield* delegated(dispatched);
          assert.equal(request.modelSelection?.model, "claude-haiku-5-5");
          assert.equal(request.routing?.lane, "routine");
        }),
    ),
  );

  it.effect("respects caller explicit taskLane hint", () =>
    run(
      {
        modelLanes: {
          complex: [{ instanceId: claude, model: "claude-opus-5-5" }],
          routine: [{ instanceId: claude, model: "claude-haiku-5-5" }],
        },
      },
      (service, dispatched) =>
        Effect.gen(function* () {
          yield* service.delegateTask(scope, {
            task: "Brief one-line update.",
            taskLane: "complex",
            mode: "async",
            clientRequestId: "route-hinted-lane",
          });
          const request = yield* delegated(dispatched);
          assert.equal(request.modelSelection?.model, "claude-opus-5-5");
          assert.equal(request.routing?.lane, "complex");
          assert.equal(request.routing?.confidence, "hint");
        }),
    ),
  );

  it.effect(
    "skips an exhausted provider in the lane and advances to the next available model",
    () =>
      run(
        {
          modelLanes: {
            complex: [],
            routine: [
              { instanceId: copilot, model: "claude-opus-5.5" },
              { instanceId: claude, model: "claude-haiku-5-5" },
            ],
          },
          env: { STUDIO_SIMULATE_USAGE_LIMIT: "copilot-0889" },
        },
        (service, dispatched) =>
          Effect.gen(function* () {
            yield* service.delegateTask(scope, {
              task: "Fix a typo in README.md and update changelog.",
              mode: "async",
              clientRequestId: "route-skip-exhausted",
            });
            const request = yield* delegated(dispatched);
            assert.equal(request.modelSelection?.model, "claude-haiku-5-5");
            assert.equal(request.routing?.lane, "routine");
            assert.isTrue(request.routing?.skipped && request.routing.skipped.length > 0);
          }),
      ),
  );

  it.effect("applies learned model preferences over default lane selection", () =>
    run(
      {
        modelLanes: {
          complex: [{ instanceId: claude, model: "claude-opus-5-5" }],
          routine: [{ instanceId: claude, model: "claude-haiku-5-5" }],
        },
        learnedModelPreferences: [
          {
            id: "pref-custom-1",
            keywords: ["docs", "readme"],
            action: {
              kind: "prefer",
              model: { instanceId: claude, model: "claude-sonnet-5-5" },
            },
            createdAt: "2026-10-22T00:00:00.000Z",
          },
        ],
      },
      (service, dispatched) =>
        Effect.gen(function* () {
          yield* service.delegateTask(scope, {
            task: "Update the project readme docs with setup instructions.",
            mode: "async",
            clientRequestId: "route-learned-pref",
          });
          const request = yield* delegated(dispatched);
          assert.equal(request.modelSelection?.model, "claude-sonnet-5-5");
          assert.equal(request.routing?.preferenceId, "pref-custom-1");
        }),
    ),
  );

  it.effect("does not restore an avoided baseline when routed target options fail", () =>
    run(
      {
        modelLanes: { complex: [], routine: [{ instanceId: claude, model: "claude-sonnet-5-5" }] },
        learnedModelPreferences: [
          {
            id: "avoid-opus",
            keywords: ["changelog"],
            action: { kind: "avoid", model: opus },
            createdAt: "2026-10-22T00:00:00.000Z",
          },
        ],
        providers: providers.map((entry) => ({
          ...entry,
          models: entry.models.map((model) =>
            model.slug === "claude-sonnet-5-5"
              ? {
                  ...model,
                  capabilities: {
                    optionDescriptors: [{ ...effort, options: [{ id: "low", label: "Low" }] }],
                  },
                }
              : model,
          ),
        })),
      },
      (service, dispatched) =>
        Effect.gen(function* () {
          const error = yield* service
            .delegateTask(scope, {
              task: "Update the changelog",
              target: { options: [{ id: "effort", value: "high" }] },
              mode: "async",
              clientRequestId: "options-lane",
            })
            .pipe(Effect.flip);
          assert.equal(error.code, "model_unavailable");
          assert.include(error.message, "baseline was not substituted");
          assert.equal(
            (yield* Ref.get(dispatched)).filter(
              (command) => command.type === "delegated_task.request",
            ).length,
            0,
          );
        }),
    ),
  );

  it.effect("keeps frontier minimumTier authoritative over a routine lane", () =>
    run(
      {
        policy: { minimumTier: "frontier" },
        modelLanes: {
          complex: [],
          routine: [{ instanceId: claude, model: "claude-sonnet-5-5" }, opus],
        },
      },
      (service, dispatched) =>
        Effect.gen(function* () {
          yield* service.delegateTask(scope, {
            task: "Update the changelog",
            mode: "async",
            clientRequestId: "floor-lane",
          });
          assert.equal((yield* delegated(dispatched)).modelSelection?.model, "claude-opus-5-5");
        }),
    ),
  );

  for (const mode of ["off", "auto"] as const) {
    it.effect(`refuses an avoided baseline before dispatch with Auto ${mode}`, () =>
      run(
        {
          policy: { mode },
          modelLanes: { complex: [], routine: [opus] },
          learnedModelPreferences: [
            {
              id: "avoid-opus",
              keywords: ["changelog"],
              action: { kind: "avoid", model: opus },
              createdAt: "2026-10-22T00:00:00.000Z",
            },
          ],
        },
        (service, dispatched) =>
          Effect.gen(function* () {
            const error = yield* service
              .delegateTask(scope, {
                task: "Update the changelog",
                mode: "async",
                clientRequestId: `avoid-${mode}`,
              })
              .pipe(Effect.flip);
            assert.equal(error.code, "model_unavailable");
            assert.include(error.message, "avoided for tasks like this");
            assert.equal(
              (yield* Ref.get(dispatched)).filter(
                (command) => command.type === "delegated_task.request",
              ).length,
              0,
            );
          }),
      ),
    );
  }

  it.effect("routes create_threads per thread and keeps the decision on the thread", () =>
    run({ policy: { mode: "auto" } }, (service, dispatched) =>
      Effect.gen(function* () {
        const result = yield* service.createThreads(scope, {
          threads: [
            {
              prompt: "Make a first draft of the promo animation storyboard.",
              title: "Promo draft",
            },
            { prompt: "Render the final promo animation for publishing.", title: "Promo final" },
          ],
          clientRequestId: "route-create",
        });
        const creates = (yield* Ref.get(dispatched)).filter(
          (command) => command.type === "thread.create",
        );
        assert.equal(creates[0]?.modelSelection?.model, "claude-sonnet-5-5");
        assert.equal(creates[0]?.routing?.taskClass, "animation-draft");
        assert.equal(creates[1]?.modelSelection?.model, "claude-opus-5-5");
        assert.equal(creates[1]?.routing?.taskClass, "animation-final");
        assert.equal(result.threads[0]?.routing?.selection.model, "claude-sonnet-5-5");
      }),
    ),
  );
});
