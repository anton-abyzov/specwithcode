import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { makeProviderFailure } from "./ProviderFailure.ts";

const layerTestStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);
const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, SqlitePersistence.layerMemory)),
);
const layerDependencies = Layer.mergeAll(
  layerTestStores,
  layerTestEventSink,
  IdAllocator.layer,
  ThreadCommandExecutor.layer,
);
const layerTest = Layer.mergeAll(
  layerDependencies,
  ProviderEventIngestor.layer.pipe(Layer.provide(layerDependencies)),
);

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");

const threadCreatedEvent = (now: DateTime.Utc) =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const projectId = yield* idAllocator.allocate.project({ fixtureName: "failure-reports" });
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName: "failure-reports",
      projectId,
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: "Failure reports",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      branchPullRequest: null,
      activeOrderKey: null,
      activeProviderThreadId: idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "failure-thread",
      }),
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const event: OrchestrationV2DomainEvent = {
      id: yield* idAllocator.allocate.event({ threadId }),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: thread,
    };
    return event;
  });

it("builds a turn_failed report with only class, provider, model and code", () => {
  const event = ProviderEventIngestor.providerTurnFailureCrashReport({
    driver: CODEX_DRIVER,
    model: "gpt-5.4",
    failure: makeProviderFailure({
      message: "Rate limited.",
      code: "rate_limited",
      class: "usage_limit",
      retryable: true,
    }),
    retryAttempt: 2,
  });
  assert.deepEqual(event, {
    kind: "turn_failed",
    category: "usage_limit",
    provider: "codex",
    model: "gpt-5.4",
    error: { name: "rate_limited", message: "Rate limited." },
    detail: { retryable: true, code: "rate_limited", retryAttempt: 2 },
    foldKey: "usage_limit|codex|rate_limited",
  });
});

it.effect("reports a persisted failed turn once, grouped by failure class", () => {
  const reported: Array<ProviderEventIngestor.ProviderTurnFailureReport> = [];
  const layerReports = Layer.succeed(ProviderEventIngestor.ProviderTurnFailureReports, {
    report: (input) =>
      Effect.sync(() => {
        reported.push(input);
      }),
  });
  return Effect.gen(function* () {
    const now = yield* DateTime.now;
    const eventSink = yield* EventSink.EventSinkV2;
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const threadEvent = yield* threadCreatedEvent(now);
    yield* eventSink.write({ events: [threadEvent] });
    const providerSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: modelSelection.instanceId,
      threadId: threadEvent.threadId,
    });
    const providerThreadId = idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "failure-thread",
    });
    const failure = makeProviderFailure({
      message: "Invalid reasoning effort.",
      code: "invalid_request",
      class: "validation_error",
    });
    const input = {
      providerSessionId,
      providerInstanceId: modelSelection.instanceId,
      threadId: threadEvent.threadId,
      analyticsContext: { modelSelection },
      event: {
        type: "turn.terminal" as const,
        driver: CODEX_DRIVER,
        providerThreadId,
        providerTurnId: idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "failure-turn",
        }),
        runOrdinal: 1,
        failureItemOrdinal: 7,
        status: "failed" as const,
        failure,
        threadDisposition: "reusable" as const,
      },
    };
    yield* ingestor.ingestNormalized(input);
    yield* ingestor.ingestNormalized(input);
    yield* ingestor.ingestNormalized({
      ...input,
      event: {
        type: "turn.terminal" as const,
        driver: CODEX_DRIVER,
        providerThreadId,
        providerTurnId: idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "completed-turn",
        }),
        runOrdinal: 2,
        status: "completed" as const,
        failure: null,
        threadDisposition: "reusable" as const,
      },
    });
    assert.lengthOf(reported, 1);
    assert.deepEqual(reported[0], {
      driver: CODEX_DRIVER,
      failure,
      model: "gpt-5.4",
    });
  }).pipe(Effect.provide(layerTest.pipe(Layer.provide(layerReports))));
});
