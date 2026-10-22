import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type ModelSelection,
  ModelSelection as ModelSelectionSchema,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS } from "./ShellSnapshotCache.ts";

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");

const createThread = Effect.fn("createThread")(function* (suffix: string) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${suffix}`);
  yield* store.apply({
    id: EventId.make(`event:${suffix}:thread-created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:shell-cache"),
      title: `Thread ${suffix}`,
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
  return threadId;
});

const gemini = {
  instanceId: ProviderInstanceId.make("acpRegistry_gemini"),
  model: "default",
} satisfies ModelSelection;
it.layer(layerTest)("thread model identity", (it) => {
  it.effect(
    "matches detail and unopened list through fallback, running, return and manual changes",
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const threadId = yield* createThread("model-identity");
        const addRun = (
          ordinal: number,
          selection: ModelSelection,
          status: "completed" | "running" | "queued" = "completed",
        ) =>
          Effect.gen(function* () {
            const id = RunId.make(`run:identity:${ordinal}`);
            yield* store.apply({
              id: EventId.make(`e:run:${ordinal}`),
              type: "run.created",
              threadId,
              runId: id,
              occurredAt: now,
              payload: {
                id,
                threadId,
                ordinal,
                providerInstanceId: selection.instanceId,
                modelSelection: selection,
                providerThreadId: null,
                userMessageId: MessageId.make(`message:${ordinal}`),
                rootNodeId: NodeId.make(`node:${ordinal}`),
                activeAttemptId: null,
                status,
                requestedAt: now,
                startedAt: status === "queued" ? null : now,
                completedAt: status === "completed" ? now : null,
                checkpointId: null,
                contextHandoffId: null,
              },
            });
            return id;
          });
        const setThread = (selection: ModelSelection) =>
          Effect.gen(function* () {
            const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ModelSelectionSchema))(
              selection,
            );
            yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.modelSelection', json(${encoded})) WHERE thread_id = ${threadId}`;
          });
        const check = (expected: unknown) =>
          Effect.gen(function* () {
            const detail = ProjectionStore.threadShellFromProjection(
              yield* store.getThreadProjection(threadId),
            );
            const shell = (yield* store.getShellSnapshot()).threads.find((t) => t.id === threadId)!;
            assert.deepEqual(shell.modelIdentity, expected);
            assert.deepEqual(detail.modelIdentity, shell.modelIdentity);
          });
        yield* check({ current: modelSelection, preferred: null, kind: null });
        const stopped = yield* addRun(1, modelSelection);
        const fallback = yield* addRun(2, gemini);
        yield* setThread(gemini);
        const providerMoveId = MessageId.make(`provider-fallback:${threadId}:${stopped}`);
        yield* store.apply({
          id: EventId.make("e:provider-move"),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "system",
            creationSource: "server",
            id: providerMoveId,
            threadId,
            runId: fallback,
            nodeId: null,
            role: "user",
            text: "Continue",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* store.apply({
          id: EventId.make("e:fallback"),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "system",
            creationSource: "server",
            id: MessageId.make(`limit-fallback:${threadId}:${stopped}`),
            threadId,
            runId: fallback,
            nodeId: null,
            role: "user",
            text: "Continue",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });
        // Same timestamp, insertion order differs from message-id order. Both read paths agree.
        yield* check({ current: gemini, preferred: null, kind: null });
        yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = ${providerMoveId}`;
        yield* check({ current: gemini, preferred: modelSelection, kind: "fallback" });
        // A hand pick for the next turn cannot relabel the running turn.
        const live = yield* addRun(3, gemini, "running");
        yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = json_set(payload_json, '$.modelSelection.instanceId', ${modelSelection.instanceId}) WHERE run_id = ${live}`;
        yield* setThread(modelSelection);
        yield* check({ current: gemini, preferred: modelSelection, kind: "running" });
        const queued = yield* addRun(4, modelSelection, "queued");
        yield* check({ current: gemini, preferred: modelSelection, kind: "running" });
        yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed', payload_json = json_set(payload_json, '$.status', 'completed') WHERE run_id = ${queued}`;
        yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed', payload_json = json_set(payload_json, '$.status', 'completed') WHERE run_id = ${live}`;
        yield* check({ current: modelSelection, preferred: null, kind: null });
        yield* addRun(5, modelSelection);
        yield* setThread(gemini);
        // Returning home clears the old pairing even after a later manual provider switch.
        yield* check({ current: gemini, preferred: null, kind: null });
      }),
  );
});
