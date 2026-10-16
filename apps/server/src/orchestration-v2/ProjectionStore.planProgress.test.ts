import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ModelSelection,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

it.layer(layerTest)("thread shell plan progress", (it) => {
  it.effect("summarizes the newest todo list the same way in SQL and in memory", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:plan-progress");
      const nodeId = NodeId.make("node:plan-progress");
      yield* store.apply({
        id: EventId.make("event:plan-progress:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:plan-progress"),
          title: "Plan progress",
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

      const shells = Effect.gen(function* () {
        const sql = (yield* store.getShellSnapshot()).threads.find((row) => row.id === threadId)!;
        const memory = ProjectionStore.threadShellFromProjection(
          yield* store.getThreadProjection(threadId),
        );
        return { sql: sql.planProgress, memory: memory.planProgress };
      });

      assert.deepEqual(yield* shells, { sql: null, memory: null });

      const run = (ordinal: number) =>
        store.apply({
          id: EventId.make(`event:plan-progress:run:${ordinal}`),
          type: "run.created",
          threadId,
          runId: RunId.make(`run:plan-progress:${ordinal}`),
          nodeId,
          driver: ProviderDriverKind.make("codex"),
          occurredAt: now,
          payload: {
            id: RunId.make(`run:plan-progress:${ordinal}`),
            threadId,
            ordinal,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make(`message:plan-progress:${ordinal}`),
            rootNodeId: nodeId,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
      yield* run(1);
      yield* run(2);

      const todo = (
        id: string,
        ordinal: number,
        steps: ReadonlyArray<[string, string]>,
        sequence: number,
      ) =>
        store.apply({
          id: EventId.make(`event:plan-progress:${id}:${sequence}`),
          type: "plan.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: PlanId.make(id),
            threadId,
            runId: RunId.make(`run:plan-progress:${ordinal}`),
            nodeId,
            kind: "todo_list",
            status: "active",
            steps: steps.map(([text, status], index) => ({
              id: `${id}-${index}`,
              text,
              status: status as "pending" | "running" | "completed",
            })),
          },
        });

      yield* todo(
        "plan:b-first",
        1,
        [
          ["Read", "completed"],
          ["Write", "running"],
        ],
        1,
      );
      // The newer run's list wins even though its id sorts first.
      yield* todo(
        "plan:a-second",
        2,
        [
          ["Plan", "completed"],
          ["Build", "running"],
          ["Test", "pending"],
          ["Ship", "pending"],
        ],
        2,
      );
      // An update to the older run's list does not take over.
      yield* todo("plan:b-first", 1, [["Read", "completed"]], 3);
      yield* todo(
        "plan:a-second",
        2,
        [
          ["Plan", "completed"],
          ["Build", "completed"],
          ["Test", "running"],
          ["Ship", "pending"],
        ],
        4,
      );

      const expected = { completed: 2, total: 4, current: "Test", next: "Ship" };
      assert.deepEqual(yield* shells, { sql: expected, memory: expected });
    }),
  );
});
