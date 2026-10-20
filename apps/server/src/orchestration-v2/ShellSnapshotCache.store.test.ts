import { assert, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS } from "./ShellSnapshotCache.ts";

const layerSql = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const now = DateTime.makeUnsafe("2026-10-19T12:00:00Z");
const old = DateTime.subtract(now, { days: 10 });
const providerInstanceId = ProviderInstanceId.make("codex");

const createThread = Effect.fn(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:sweep-filter:${name}`);
  yield* store.apply({
    id: EventId.make(`event:${threadId}`),
    type: "thread.created",
    threadId,
    occurredAt: old,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:sweep-filter"),
      title: name,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: old,
      updatedAt: old,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
      ...overrides,
    },
  });
  return threadId;
});

it.effect("a sweep's unsettled view matches the database's unsettled read", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* createThread("open");
    yield* createThread("reopened", { settledOverride: "active" });
    yield* createThread("reopened-stamped", { settledOverride: "active", settledAt: old });
    yield* createThread("manual", { settledOverride: "settled" });
    yield* createThread("manual-stamped", { settledOverride: "settled", settledAt: old });
    yield* createThread("auto", { settledAt: old });
    yield* createThread("archived", { archivedAt: old });

    for (const location of ["active", "archive", undefined] as const) {
      const options = location === undefined ? {} : { location };
      const exact = yield* store.getShellSnapshot({ ...options, unsettledOnly: true });
      const shared = yield* store.getShellSnapshot({
        ...options,
        unsettledOnly: true,
        maxAgeMs: SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS,
      });
      assert.deepEqual(shared, exact, `location ${location ?? "all"}`);
    }
    const active = yield* store.getShellSnapshot({
      location: "active",
      unsettledOnly: true,
      maxAgeMs: SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS,
    });
    assert.deepEqual(active.threads.map((thread) => thread.title).toSorted(), ["open", "reopened"]);
  }).pipe(Effect.provide(layerSql)),
);
