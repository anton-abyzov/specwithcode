import { assert } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";

/** Uses the real SQLite/event/receipt harness without opening any native session. */
export const verifyNativeRecovery = (
  scenario:
    | "early"
    | "no-reset"
    | "expired-reset"
    | "cancel-race"
    | "stale"
    | "user-edit"
    | "archive",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const events = yield* EventSink.EventSinkV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`native-recovery:${scenario}`),
      projectId = ProjectId.make(`native-recovery:${scenario}`);
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
    const now = yield* DateTime.now,
      createdAt = DateTime.formatIso(now);
    yield* projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: "Private recovery fixture",
        workspaceRoot: process.cwd(),
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
      },
    });
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: "Limited",
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
      commandId: CommandId.make(`start:${threadId}`),
      threadId,
      messageId: MessageId.make(`start:${threadId}`),
      text: "Work.",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    const resetAt =
      scenario === "no-reset"
        ? null
        : DateTime.formatIso(DateTime.add(now, { days: scenario === "expired-reset" ? -1 : 7 }));
    yield* events.write({
      events: [
        {
          id: EventId.make(`failed:${threadId}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...run, status: "failed", completedAt: now },
        },
        {
          id: EventId.make(`error:${threadId}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`error:${threadId}`),
            type: "error",
            threadId,
            runId: run.id,
            nodeId: run.rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 2,
            status: "failed",
            title: "Usage limited",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            failure: {
              class: "usage_limit",
              message: "Usage limit reached",
              code: "usageLimitExceeded",
              retryable: null,
              resetAt,
            },
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(`arm:${threadId}`),
      threadId,
      limitRecovery: { runId: run.id, resetAt, autoResume: true },
      limitRecoveryAffinity: {
        instanceId: modelSelection.instanceId,
        continuationKey: "opaque",
        quotaPoolId: `codex:sha256:${"a".repeat(64)}`,
      },
    });
    const candidate = (yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: false,
      snooze: false,
    })).find((thread) => thread.id === threadId)!;
    assert.isDefined(candidate);
    assert.isNull(limitRecoveryCommand(candidate, false, DateTime.toEpochMillis(now)));
    yield* TestClock.adjust("1 second");
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (scenario === "cancel-race")
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`cancel:${threadId}`),
        threadId,
        limitRecovery: { runId: run.id, resetAt, autoResume: false },
      });
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(`checked:${threadId}`),
      threadId,
      limitAvailability: {
        runId: run.id,
        requestId: candidate.limitRecovery!.requestId,
        expectedUpdatedAt: DateTime.formatIso(candidate.updatedAt),
        observation: {
          checkedAt,
          retryAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 5 })),
          status: "allowed",
          threadUpdatedAt: DateTime.formatIso(candidate.updatedAt),
          affinity: {
            instanceId: modelSelection.instanceId,
            continuationKey: "opaque",
            quotaPoolId: `codex:sha256:${"a".repeat(64)}`,
          },
        },
      },
    });
    const checked = (yield* projections.getThreadShell(threadId))!;
    if (scenario === "cancel-race") {
      assert.isUndefined(checked.limitRecovery?.availability);
      assert.isNull(limitRecoveryCommand(checked, false, Date.parse(checkedAt)));
      return;
    }
    const command = limitRecoveryCommand(checked, false, Date.parse(checkedAt));
    assert.isNotNull(command);
    if (scenario === "stale") yield* TestClock.adjust("61 seconds");
    if (scenario === "user-edit") {
      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`edit:${threadId}`),
        threadId,
        title: "User changed the thread",
      });
    }
    if (scenario === "archive")
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`archive:${threadId}`),
        threadId,
      });
    yield* orchestrator.dispatch(command!);
    yield* orchestrator.dispatch(command!);
    const after = yield* orchestrator.getThreadProjection(threadId);
    assert.lengthOf(after.runs, ["early", "no-reset", "expired-reset"].includes(scenario) ? 2 : 1);
  });
