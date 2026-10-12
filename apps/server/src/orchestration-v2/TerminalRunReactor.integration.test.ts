import * as StudioCapacity from "../studio/Capacity.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as NodeOs from "node:os";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const layerPlatformTest = Layer.mergeAll(
  Layer.mock(StudioCapacity.Capacity)({ assertNativeStart: () => Effect.void }),
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(NodeOs.tmpdir(), {
  prefix: "studio-terminal-reactor-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);
const layerGitWorkflowTest = Layer.mock(GitWorkflow.GitWorkflowService)({
  pruneWorktrees: () => Effect.void,
  createWorktree: () => Effect.succeed({} as never),
});
const layerProjectServiceTest = Layer.mock(ProjectService.ProjectService)({
  getById: () => Effect.succeed(Option.none()),
});

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by lifecycle tests"),
} as ProviderAdapterV2Shape;
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  // No supportedRuntimeModes: every runtime mode runs as stored.
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;
const layerTestProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed([providerInstance].find((instance) => instanceId === instance.instanceId)),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(fixtureProjectDatabase([ProjectId.make("terminal-reactor-project")])),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);

it.effect(
  "a blocked A terminal reaction cannot stop B's persisted queue promotion",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const a = ThreadId.make("terminal-blocked-A");
        const b = ThreadId.make("terminal-ready-B");
        const now = yield* DateTime.now;
        for (const threadId of [a, b]) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create:${threadId}`),
            threadId,
            projectId: ProjectId.make("terminal-reactor-project"),
            createdBy: "user",
            creationSource: "web",
            title: threadId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: NodeOs.tmpdir(),
          });
          for (const ordinal of [0, 1])
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`message:${threadId}:${ordinal}`),
              threadId,
              messageId: MessageId.make(`message:${threadId}:${ordinal}`),
              createdBy: "user",
              creationSource: "web",
              text: `Task ${ordinal}`,
              attachments: [],
              dispatchMode: { type: ordinal === 0 ? "start_immediately" : "queue_after_active" },
            });
        }
        const beforeA = yield* orchestrator.getThreadProjection(a);
        const beforeB = yield* orchestrator.getThreadProjection(b);
        assert.deepEqual(
          beforeB.runs.map((run) => run.status),
          ["starting", "queued"],
        );
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* locks
          .withLock(
            a,
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const afterSequence = yield* sink.latestSequence();
        const bPromoted = yield* sink.stream({ afterSequence, eventType: "run.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.threadId === b &&
              stored.event.type === "run.updated" &&
              stored.event.payload.id === beforeB.runs[1]!.id &&
              stored.event.payload.status === "starting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        for (const [threadId, projection] of [
          [a, beforeA],
          [b, beforeB],
        ] as const) {
          const run = projection.runs[0]!;
          yield* sink.write({
            commandId: CommandId.make(`completed:${threadId}`),
            events: [
              {
                id: EventId.make(`completed:${threadId}`),
                type: "run.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: { ...run, status: "completed", completedAt: now },
              },
            ],
          });
        }
        yield* Fiber.join(bPromoted);
        const waitingA = yield* orchestrator.getThreadProjection(a);
        assert.equal(waitingA.runs[1]!.status, "queued");
        const afterB = yield* orchestrator.getThreadProjection(b);
        assert.deepEqual(
          afterB.runs.map((run) => run.status),
          ["completed", "starting"],
        );
        assert.equal(afterB.runs[1]!.id, beforeB.runs[1]!.id);
        assert.equal(afterB.runs[1]!.providerInstanceId, beforeB.runs[1]!.providerInstanceId);
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const checkedAgain = yield* Deferred.make<boolean>();
        const canStartQueuedRun = projections.canStartQueuedRun;
        const spy = vi
          .spyOn(projections, "canStartQueuedRun")
          .mockImplementation((threadId) =>
            canStartQueuedRun(threadId).pipe(
              Effect.tap((eligible) =>
                threadId === b ? Deferred.succeed(checkedAgain, eligible) : Effect.void,
              ),
            ),
          );
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        yield* sink.write({
          commandId: CommandId.make("duplicate-terminal-B"),
          events: [
            {
              id: EventId.make("duplicate-terminal-B"),
              type: "run.updated",
              threadId: b,
              runId: beforeB.runs[0]!.id,
              occurredAt: now,
              payload: { ...beforeB.runs[0]!, status: "completed", completedAt: now },
            },
          ],
        });
        assert.isFalse(yield* Deferred.await(checkedAgain));
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(b)).runs.map((run) => run.id),
          beforeB.runs.map((run) => run.id),
        );
        const aPromoted = yield* sink
          .stream({ afterSequence: yield* sink.latestSequence(), eventType: "run.updated" })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.threadId === a &&
                stored.event.type === "run.updated" &&
                stored.event.payload.id === beforeA.runs[1]!.id &&
                stored.event.payload.status === "starting",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(aPromoted);
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(a)).runs.map((run) => run.status),
          ["completed", "starting"],
        );
      }),
    ).pipe(Effect.provide(layerTest)),
  3000,
);
