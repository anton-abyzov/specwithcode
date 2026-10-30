import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
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
  openSession: () => Effect.die("No provider process needed for mark unread"),
} as ProviderAdapterV2Shape;
const projectNames = ["mark-unread-expired-snooze", "mark-unread-future-snooze"];
const layerDatabase = fixtureProjectDatabase(
  projectNames.map((name) => ProjectId.make(`project:${name}`)),
);
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "mark-unread" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const completeAndSnoozeThread = Effect.fn("test.completeAndSnoozeThread")(function* (
  name: string,
  snoozeMinutes: number,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create-${name}`),
    threadId,
    projectId: ProjectId.make(`project:${name}`),
    title: "Snoozed completion",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`dispatch-${name}`),
    threadId,
    messageId: MessageId.make(`dispatch-${name}`),
    text: "Run in the background",
    attachments: [],
    dispatchMode: { type: "defer_start" },
    createdBy: "agent",
    creationSource: "mcp",
  });
  yield* orchestrator.dispatch({
    type: "run.interrupt",
    commandId: CommandId.make(`interrupt-${name}`),
    threadId,
    runId: (yield* projections.getThreadProjection(threadId)).runs[0]!.id,
  });
  const completedAt = (yield* projections.getThreadProjection(threadId)).runs.at(-1)?.completedAt;
  assert.ok(completedAt);
  yield* TestClock.adjust("1 second");
  const snoozedUntil = DateTime.add(yield* DateTime.now, { minutes: snoozeMinutes });
  yield* orchestrator.dispatch({
    type: "thread.snooze",
    commandId: CommandId.make(`snooze-${name}`),
    threadId,
    snoozedUntil: DateTime.formatIso(snoozedUntil),
  });
  return { threadId, completedAt, snoozedUntil };
});

it.effect("mark unread retires an expired snooze so a dismissed wake stays dismissed", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId, completedAt, snoozedUntil } = yield* completeAndSnoozeThread(
      "mark-unread-expired-snooze",
      1,
    );
    yield* TestClock.adjust("2 minutes");
    yield* orchestrator.dispatch({
      type: "thread.visit",
      commandId: CommandId.make("dismiss-woke"),
      threadId,
      visitedAt: DateTime.formatIso(snoozedUntil),
    });
    const dismissed = yield* projections.getThread(threadId);
    assert.deepEqual(dismissed.lastVisitedAt, snoozedUntil);

    yield* orchestrator.dispatch({
      type: "thread.mark-unread",
      commandId: CommandId.make("mark-unread-expired-snooze"),
      threadId,
    });
    assert.deepEqual(yield* projections.getThread(threadId), {
      ...dismissed,
      lastVisitedAt: DateTime.subtract(completedAt, { milliseconds: 1 }),
      snoozedUntil: null,
      snoozedAt: null,
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("mark unread leaves a future snooze untouched", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId, completedAt } = yield* completeAndSnoozeThread(
      "mark-unread-future-snooze",
      60,
    );
    yield* TestClock.adjust("1 minute");
    yield* orchestrator.dispatch({
      type: "thread.visit",
      commandId: CommandId.make("visit-snoozed"),
      threadId,
      visitedAt: DateTime.formatIso(yield* DateTime.now),
    });
    const visited = yield* projections.getThread(threadId);
    assert.isNotNull(visited.snoozedUntil);

    yield* orchestrator.dispatch({
      type: "thread.mark-unread",
      commandId: CommandId.make("mark-unread-future-snooze"),
      threadId,
    });
    assert.deepEqual(yield* projections.getThread(threadId), {
      ...visited,
      lastVisitedAt: DateTime.subtract(completedAt, { milliseconds: 1 }),
    });
  }).pipe(Effect.provide(layerTest)),
);
