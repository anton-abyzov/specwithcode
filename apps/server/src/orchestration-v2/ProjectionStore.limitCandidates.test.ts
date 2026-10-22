import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/**
 * A usage-limited thread with one pending request is a limit recovery
 * candidate only when the request does not really wait on a person. The SQL
 * read and the memory read decide alike.
 */
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const driver = ProviderDriverKind.make("codex");

type Pending = "message-question" | "approval" | "approval-on-no-run";

const limitedThread = (pending: Pending) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(`limit-candidate:${pending}`);
    const runId = RunId.make(`limit-candidate:${pending}:run`);
    const rootNodeId = NodeId.make(`limit-candidate:${pending}:root`);
    const event = (key: string) => EventId.make(`limit-candidate:${pending}:${key}`);
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`limit-candidate:${pending}:message`),
      rootNodeId,
      activeAttemptId: null,
      status: "running" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    yield* store.apply({
      id: event("thread"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("limit-candidate:project"),
        title: "Limited thread",
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    yield* store.apply({
      id: event("run"),
      type: "run.created",
      threadId,
      runId,
      nodeId: rootNodeId,
      driver,
      providerInstanceId: modelSelection.instanceId,
      occurredAt: now,
      payload: run,
    });
    // A node that names no run and roots none: the request belongs to no run.
    const requestNodeId =
      pending === "approval-on-no-run"
        ? NodeId.make(`limit-candidate:${pending}:orphan`)
        : rootNodeId;
    if (pending === "approval-on-no-run")
      yield* store.apply({
        id: event("orphan"),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: requestNodeId,
          threadId,
          runId: null,
          parentNodeId: null,
          rootNodeId: requestNodeId,
          kind: "approval_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: RuntimeRequestId.make(`limit-candidate:${pending}:request`),
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      });
    yield* store.apply({
      id: event("request"),
      type: "runtime-request.updated",
      threadId,
      nodeId: requestNodeId,
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make(`limit-candidate:${pending}:request`),
        nodeId: requestNodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: pending === "message-question" ? "user_input" : "command",
        status: "pending",
        responseCapability:
          pending === "message-question"
            ? { type: "message" }
            : { type: "live", providerSessionId: ProviderSessionId.make("session:limit") },
        createdAt: now,
        resolvedAt: null,
      },
    });
    yield* store.apply({
      id: event("failed"),
      type: "run.updated",
      threadId,
      runId,
      nodeId: rootNodeId,
      driver,
      occurredAt: now,
      payload: { ...run, status: "failed", completedAt: now },
    });
    yield* store.apply({
      id: event("error"),
      type: "turn-item.updated",
      threadId,
      runId,
      nodeId: rootNodeId,
      driver,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`limit-candidate:${pending}:error`),
        type: "error",
        threadId,
        runId,
        nodeId: rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 2,
        status: "failed",
        title: "Usage limit reached",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        failure: {
          class: "usage_limit",
          message: "Plan limit reached.",
          code: "usageLimitExceeded",
          retryable: null,
          resetAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
        },
      },
    });
    const candidates = yield* store.getLimitRecoveryCandidates({
      now,
      autoResume: true,
      snooze: false,
    });
    return { runId, candidate: candidates.find((thread) => thread.id === threadId) };
  });

const layers = {
  memory: ProjectionStore.layerMemory,
  SQL: ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
} as const;

it.effect.each(["memory", "SQL"] as const)(
  "%s: a thread whose question the next message answers is a candidate",
  (name) =>
    Effect.gen(function* () {
      const { runId, candidate } = yield* limitedThread("message-question");
      assert.isDefined(candidate);
      // With its detail, so the worker sees it holds nothing too.
      assert.deepEqual(candidate?.pendingRuntimeRequest?.responseCapability, { type: "message" });
      assert.equal(candidate?.pendingRuntimeRequest?.runId, runId);
    }).pipe(Effect.provide(layers[name])),
);

it.effect.each([
  ["memory", "approval"],
  ["memory", "approval-on-no-run"],
  ["SQL", "approval"],
  ["SQL", "approval-on-no-run"],
] as const)("%s: a thread waiting on an approval is not a candidate (%s)", ([name, pending]) =>
  Effect.gen(function* () {
    assert.isUndefined((yield* limitedThread(pending)).candidate);
  }).pipe(Effect.provide(layers[name])),
);
