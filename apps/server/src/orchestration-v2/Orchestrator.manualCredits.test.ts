import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { seedReplayProject } from "../project/ProjectContextTestkit.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapterV2Shape;
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "manual-credits" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const makeThread = Effect.fn("manualCredits.makeThread")(function* (id: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make(`thread:${id}`);
  yield* orchestrator.dispatch({ type: "thread.create", commandId: CommandId.make(`create:${id}`), threadId,
    projectId: ProjectId.make("project:manual-credits"), title: "Marker", modelSelection,
    runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null,
    createdBy: "user", creationSource: "web" });
  return threadId;
});

it.effect("stores the exact human credit binding in the durable run and never inherits it", () =>
  Effect.gen(function* () {
    yield* seedReplayProject("project:manual-credits", "/synthetic/manual-credits");
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    for (const mode of ["defer_start", "start_immediately"] as const) {
      const threadId = yield* makeThread(mode);
      const manualCodexCreditIntent = { type: "human-submit-existing-credits" as const, ...modelSelection,
        expectedQuotaPoolId: `codex:sha256:${"a".repeat(64)}`,
        observedAt: DateTime.formatIso(yield* DateTime.now) };
      yield* orchestrator.dispatch({ type: "message.dispatch", commandId: CommandId.make(`send:${mode}`), threadId,
        messageId: MessageId.make(`message:${mode}`), text: "Read marker.txt", attachments: [],
        modelSelection, dispatchMode: { type: mode }, createdBy: "user", creationSource: "web",
        manualCodexCreditIntent });
      const projection = yield* projections.getThreadProjection(threadId);
      assert.deepEqual(projection.runs[0]?.manualCodexCreditIntent, manualCodexCreditIntent);
      // Queueing a later ordinary message cannot copy the first run's permission.
      yield* orchestrator.dispatch({ type: "message.dispatch", commandId: CommandId.make(`ordinary:${mode}`), threadId,
        messageId: MessageId.make(`ordinary-message:${mode}`), text: "Next", attachments: [],
        dispatchMode: { type: "queue_after_active" }, createdBy: "user", creationSource: "web" });
      const later = yield* projections.getThreadProjection(threadId);
      assert.isUndefined(later.runs[1]?.manualCodexCreditIntent);
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects stale, changed-model, queued, automatic and goal credit commands before run creation", () =>
  Effect.gen(function* () {
    yield* seedReplayProject("project:manual-credits", "/synthetic/manual-credits");
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const cases = [
      { id: "stale", observedAt: "2026-01-01T00:00:00Z" },
      { id: "model", model: "other" },
      { id: "queue", dispatchMode: "queue_after_active" as const },
      { id: "steer-intent", deliveryIntent: "steer" as const },
      { id: "restart-intent", deliveryIntent: "restart" as const },
      { id: "auto", creationSource: "server" as const },
      { id: "goal", text: "/goal Continue autonomously" },
    ];
    for (const test of cases) {
      const threadId = yield* makeThread(test.id);
      const result = yield* orchestrator.dispatch({ type: "message.dispatch", commandId: CommandId.make(`send:${test.id}`),
        threadId, messageId: MessageId.make(`message:${test.id}`), text: test.text ?? "Read marker.txt", attachments: [],
        modelSelection, dispatchMode: { type: test.dispatchMode ?? "start_immediately" }, createdBy: "user",
        ...(test.deliveryIntent === undefined ? {} : { deliveryIntent: test.deliveryIntent }),
        creationSource: test.creationSource ?? "web", manualCodexCreditIntent: {
          type: "human-submit-existing-credits", instanceId, model: test.model ?? modelSelection.model,
          expectedQuotaPoolId: `codex:sha256:${"a".repeat(64)}`,
          observedAt: test.observedAt ?? DateTime.formatIso(yield* DateTime.now),
        } }).pipe(Effect.exit);
      assert.equal(result._tag, "Failure", test.id);
      assert.deepEqual((yield* projections.getThreadProjection(threadId)).runs, [], test.id);
    }
  }).pipe(Effect.provide(layerTest)),
);
