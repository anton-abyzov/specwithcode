import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  type ModelSelection,
  type OrchestrationV2ThreadOrigin,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
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

const createThread = Effect.fn("createThread")(function* (
  suffix: string,
  origin: OrchestrationV2ThreadOrigin | undefined,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${suffix}`);
  yield* store.apply({
    id: EventId.make(`event:${suffix}:thread-created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "agent",
      creationSource: "mcp",
      id: threadId,
      projectId: ProjectId.make("project:origin"),
      title: `Thread ${suffix}`,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      ...(origin === undefined ? {} : { origin }),
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

it.layer(layerTest)("thread origin projection", (it) => {
  it.effect("puts the origin on the detail shell and the list shell, and none when absent", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const fleet: OrchestrationV2ThreadOrigin = {
        kind: "fleet_machine",
        label: "SpecWithCode",
        machineLabel: "m4-studio",
        environmentId: EnvironmentId.make("env-coordinator"),
      };
      const client: OrchestrationV2ThreadOrigin = { kind: "mcp_client", label: "Claude.ai" };
      const ids = {
        fleet: yield* createThread("fleet", fleet),
        client: yield* createThread("client", client),
        none: yield* createThread("none", undefined),
      };
      const snapshot = yield* store.getShellSnapshot();
      for (const [key, expected] of [
        ["fleet", fleet],
        ["client", client],
        ["none", undefined],
      ] as const) {
        const threadId = ids[key];
        const detail = ProjectionStore.threadShellFromProjection(
          yield* store.getThreadProjection(threadId),
        );
        const listed = snapshot.threads.find((thread) => thread.id === threadId);
        assert.deepEqual(detail.origin, expected);
        assert.deepEqual(listed?.origin, expected);
        if (expected === undefined) assert.isFalse("origin" in detail);
      }
    }),
  );
});
