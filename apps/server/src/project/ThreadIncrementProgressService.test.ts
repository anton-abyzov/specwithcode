import { assert, it } from "@effect/vitest";
import {
  EventId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadIncrementProgress,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import type { ThreadIncrementSource } from "./ThreadIncrementProgress.ts";
import * as ThreadIncrementProgressService from "./ThreadIncrementProgressService.ts";

const progressReads = vi.hoisted(() => [] as Array<ReadonlyArray<ThreadIncrementSource>>);
// When set, folder reads wait on it, standing in for a slow pass.
const readGate = vi.hoisted(() => ({ wait: undefined as Promise<void> | undefined }));

vi.mock("./ThreadIncrementProgress.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ThreadIncrementProgress.ts")>()),
  readThreadIncrementProgress: async (
    _workspaceRoot: string,
    sources: ReadonlyArray<ThreadIncrementSource>,
  ) => {
    progressReads.push(sources);
    await readGate.wait;
    return sources.map((source) => ({ threadId: source.threadId }) as ThreadIncrementProgress);
  },
}));

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const PROJECT = ProjectId.make("project:plan");
const OTHER_PROJECT = ProjectId.make("project:other");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const addThread = Effect.fn("addThread")(function* (
  id: string,
  options: { readonly projectId?: ProjectId; readonly deleted?: boolean } = {},
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(id);
  const payload = {
    createdBy: "user" as const,
    creationSource: "web" as const,
    id: threadId,
    projectId: options.projectId ?? PROJECT,
    title: `Thread ${id}`,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: `inc/${id}`,
    worktreePath: `/work/${id}`,
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
  };
  yield* store.apply({
    id: EventId.make(`event:${id}:created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload,
  });
  if (options.deleted) {
    yield* store.apply({
      id: EventId.make(`event:${id}:deleted`),
      type: "thread.deleted",
      threadId,
      occurredAt: now,
      payload: { ...payload, deletedAt: now },
    });
  }
  return threadId;
});

/** The service over the real projection store, counting its thread reads. */
const makeService = Effect.fn("makeService")(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const calls = { shell: 0, summaries: 0 };
  const counted: ProjectionStore.ProjectionStoreV2Shape = {
    ...store,
    getThreadShell: (threadId) => {
      calls.shell += 1;
      return store.getThreadShell(threadId);
    },
    getThreadSummaries: (projectId, threadIds) => {
      calls.summaries += 1;
      return store.getThreadSummaries!(projectId, threadIds);
    },
  };
  const service = yield* ThreadIncrementProgressService.make.pipe(
    Effect.provideService(ProjectionStore.ProjectionStoreV2, counted),
    Effect.provideService(
      ProjectStore.ProjectStoreV2,
      ProjectStore.ProjectStoreV2.of({
        get: () => Effect.succeedSome({ workspaceRoot: "/work/root" }),
      } as never),
    ),
  );
  return { service, calls };
});

it.layer(layerTest)("ThreadIncrementProgressService", (it) => {
  it.effect("reads every thread in one projection read and skips deleted and foreign ones", () =>
    Effect.gen(function* () {
      progressReads.length = 0;
      const ids = yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => index),
        (index) => addThread(`thread:batch:${String(index).padStart(2, "0")}`),
      );
      const deleted = yield* addThread("thread:batch:deleted", { deleted: true });
      const foreign = yield* addThread("thread:batch:foreign", { projectId: OTHER_PROJECT });
      const { service, calls } = yield* makeService();

      const snapshot = yield* service.read({
        projectId: PROJECT,
        threadIds: [...ids, deleted, foreign, ThreadId.make("thread:batch:unknown")],
      });

      assert.deepStrictEqual(calls, { shell: 0, summaries: 1 });
      assert.deepStrictEqual(
        snapshot.threads.map((thread) => thread.threadId),
        ids.map(String),
      );
      assert.deepStrictEqual(progressReads[0]?.[0], {
        threadId: ThreadId.make("thread:batch:00"),
        title: "Thread thread:batch:00",
        branch: "inc/thread:batch:00",
        worktreePath: "/work/thread:batch:00",
      });
    }),
  );

  it.effect("identical reads within five seconds share one folder read", () =>
    Effect.gen(function* () {
      progressReads.length = 0;
      const first = yield* addThread("thread:shared:a");
      const second = yield* addThread("thread:shared:b");
      const { service } = yield* makeService();
      const input = { projectId: PROJECT, threadIds: [second, first] };

      yield* Effect.all([service.read(input), service.read(input), service.read(input)], {
        concurrency: "unbounded",
      });
      yield* service.read({ projectId: PROJECT, threadIds: [first, second] });
      assert.strictEqual(progressReads.length, 1);

      // A hand-made link changes what the read depends on, so it reads again.
      yield* service.link({ projectId: PROJECT, threadId: first, link: { type: "none" } });
      yield* service.read(input);
      assert.strictEqual(progressReads.length, 2);

      yield* TestClock.adjust("5 seconds");
      yield* service.read(input);
      assert.strictEqual(progressReads.length, 3);
    }),
  );

  it.effect("a read still running after five seconds stays shared", () =>
    Effect.gen(function* () {
      progressReads.length = 0;
      let release = () => {};
      readGate.wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const thread = yield* addThread("thread:slow");
      const { service } = yield* makeService();
      const input = { projectId: PROJECT, threadIds: [thread] };

      const first = yield* Effect.forkChild(service.read(input));
      while (progressReads.length === 0) yield* Effect.yieldNow;
      yield* TestClock.adjust("6 seconds");
      const second = yield* Effect.forkChild(service.read(input));
      yield* Effect.yieldNow;
      assert.strictEqual(progressReads.length, 1);

      release();
      readGate.wait = undefined;
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      yield* TestClock.adjust("4 seconds");
      yield* service.read(input);
      assert.strictEqual(progressReads.length, 1);

      yield* TestClock.adjust("1 second");
      yield* service.read(input);
      assert.strictEqual(progressReads.length, 2);
    }),
  );
});
