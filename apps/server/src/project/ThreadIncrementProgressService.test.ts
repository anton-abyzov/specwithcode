// @effect-diagnostics nodeBuiltinImport:off - A temporary SpecWeave folder for the unplanned cases.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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
import * as SqlClient from "effect/sql/SqlClient";
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
// Threads the folder read finds no increment for, and threads that declared a small fix.
const unbound = vi.hoisted(() => new Set<string>());
const smallFixed = vi.hoisted(() => new Set<string>());

vi.mock("./ThreadIncrementProgress.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ThreadIncrementProgress.ts")>()),
  readThreadIncrementProgress: async (
    _workspaceRoot: string,
    sources: ReadonlyArray<ThreadIncrementSource>,
  ) => {
    progressReads.push(sources);
    await readGate.wait;
    return sources
      .filter((source) => source.link?.incrementId !== null && !unbound.has(source.threadId))
      .map((source) => ({ threadId: source.threadId }) as ThreadIncrementProgress);
  },
  threadDeclaredSmallFix: async (threadId: string) => smallFixed.has(threadId),
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
  options: {
    readonly projectId?: ProjectId;
    readonly deleted?: boolean;
    readonly providerChild?: boolean;
    readonly parent?: string;
  } = {},
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(id);
  const payload = {
    createdBy: options.providerChild ? ("agent" as const) : ("user" as const),
    creationSource: options.providerChild ? ("provider" as const) : ("web" as const),
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
    lineage: options.providerChild
      ? {
          parentThreadId: ThreadId.make(options.parent ?? "thread:parent"),
          relationshipToParent: "subagent" as const,
          rootThreadId: ThreadId.make(options.parent ?? "thread:parent"),
        }
      : { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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

/** One run of the thread, with a file change unless `changed` is false. */
const addRun = Effect.fn("addRun")(function* (
  threadId: ThreadId,
  options: { readonly ordinal?: number; readonly status?: string; readonly changed?: boolean } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const ordinal = options.ordinal ?? 1;
  const runId = `${threadId}:run:${ordinal}`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES (${runId}, ${threadId}, ${ordinal}, 'codex', ${options.status ?? "completed"}, '2026-10-22T10:00:00Z', '{}')`;
  if (options.changed === false) return;
  yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json) VALUES (${`${runId}:edit`}, ${threadId}, ${runId}, ${ordinal}, 'file_change', 'completed', '2026-10-22T10:00:00Z', '{}')`;
});

/** A project folder SpecWeave plans in: it has `.specweave/increments`. */
const specweaveRoot = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "plan-unplanned-"));
  NodeFS.mkdirSync(NodePath.join(root, ".specweave", "increments"), { recursive: true });
  return root;
};

/** The service over the real projection store, counting its thread reads. */
const makeService = Effect.fn("makeService")(function* (workspaceRoot = "/work/root") {
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
        get: () => Effect.succeedSome({ workspaceRoot }),
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

  it.effect("lists threads that changed code with no increment, small fix or none link", () =>
    Effect.gen(function* () {
      const root = specweaveRoot();
      try {
        const bound = yield* addThread("thread:unplanned:bound");
        const none = yield* addThread("thread:unplanned:none");
        const smallFix = yield* addThread("thread:unplanned:small-fix");
        const child = yield* addThread("thread:unplanned:child", { providerChild: true });
        const unplanned = yield* addThread("thread:unplanned:edited");
        const readOnly = yield* addThread("thread:unplanned:read-only");
        const idle = yield* addThread("thread:unplanned:idle");
        for (const thread of [bound, none, smallFix, child, unplanned]) yield* addRun(thread);
        yield* addRun(readOnly, { changed: false });
        for (const thread of [none, smallFix, child, unplanned, readOnly, idle]) {
          unbound.add(thread);
        }
        smallFixed.add(smallFix);
        const { service } = yield* makeService(root);
        yield* service.link({ projectId: PROJECT, threadId: none, link: { type: "none" } });

        const snapshot = yield* service.read({
          projectId: PROJECT,
          threadIds: [bound, none, smallFix, child, unplanned, readOnly, idle],
        });

        assert.strictEqual(snapshot.specweave, true);
        assert.deepStrictEqual(
          snapshot.threads.map((thread) => thread.threadId),
          [bound],
        );
        assert.deepStrictEqual(snapshot.unplanned, [unplanned]);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("keeps a settled no until the thread's next run, and never while one runs", () =>
    Effect.gen(function* () {
      const root = specweaveRoot();
      try {
        const settled = yield* addThread("thread:unplanned:later");
        const running = yield* addThread("thread:unplanned:running");
        yield* addRun(settled, { changed: false });
        yield* addRun(running, { status: "running", changed: false });
        unbound.add(settled);
        unbound.add(running);
        const { service } = yield* makeService(root);
        const input = { projectId: PROJECT, threadIds: [settled, running] };
        assert.deepStrictEqual((yield* service.read(input)).unplanned, []);

        // The running turn edits a file: read again at once.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json) VALUES ('running:edit', ${running}, ${`${running}:run:1`}, 2, 'file_change', 'completed', '2026-10-22T10:00:00Z', '{}')`;
        assert.deepStrictEqual((yield* service.read(input)).unplanned, [running]);

        // The settled thread's next run edits a file: its new last run reads again.
        yield* addRun(settled, { ordinal: 2 });
        yield* TestClock.adjust("5 seconds");
        assert.deepStrictEqual(
          (yield* service.read(input)).unplanned,
          [settled, running].toSorted(),
        );
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("counts a provider-native subagent's edits for its parent", () =>
    Effect.gen(function* () {
      const root = specweaveRoot();
      try {
        const parent = yield* addThread("thread:unplanned:delegating");
        const child = yield* addThread("thread:unplanned:delegate", {
          providerChild: true,
          parent,
        });
        yield* addRun(parent, { changed: false });
        // Native subagent edits are runless items under the child's own thread id.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json) VALUES ('delegate:edit', ${child}, NULL, 1, 'file_change', 'completed', '2026-10-22T10:00:00Z', '{}')`;
        unbound.add(parent);
        unbound.add(child);
        const { service } = yield* makeService(root);

        const snapshot = yield* service.read({ projectId: PROJECT, threadIds: [parent, child] });

        assert.deepStrictEqual(snapshot.unplanned, [parent]);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("drops a native subagent's edits once the run that spawned it is rolled back", () =>
    Effect.gen(function* () {
      const root = specweaveRoot();
      try {
        const parent = yield* addThread("thread:unplanned:undone-parent");
        const child = yield* addThread("thread:unplanned:undone-child", {
          providerChild: true,
          parent,
        });
        yield* addRun(parent, { changed: false });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json) VALUES ('undone:edit', ${child}, NULL, 1, 'file_change', 'completed', '2026-10-22T10:00:00Z', '{"fileName":"/work/app/src/index.ts"}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_subagents (subagent_id, thread_id, run_id, parent_node_id, provider, child_thread_id, origin, status, updated_at, payload_json) VALUES ('node:undone', ${parent}, ${`${parent}:run:1`}, 'node:undone-parent', 'codex', ${child}, 'provider_native', 'completed', '2026-10-22T10:00:00Z', '{}')`;
        unbound.add(parent);
        unbound.add(child);
        const { service } = yield* makeService(root);
        const input = { projectId: PROJECT, threadIds: [parent, child] };
        assert.deepStrictEqual((yield* service.read(input)).unplanned, [parent]);

        yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'rolled_back' WHERE thread_id = ${parent}`;
        const snapshot = yield* service.read(input);
        assert.deepStrictEqual(snapshot.unplanned, []);
        assert.strictEqual(snapshot.documentation, undefined);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("lists report and spec-only work as documentation, not code", () =>
    Effect.gen(function* () {
      const root = specweaveRoot();
      try {
        const reports = yield* addThread("thread:unplanned:reports");
        const mixed = yield* addThread("thread:unplanned:mixed");
        const delegating = yield* addThread("thread:unplanned:spec-parent");
        const child = yield* addThread("thread:unplanned:spec-child", {
          providerChild: true,
          parent: delegating,
        });
        const sql = yield* SqlClient.SqlClient;
        const edit = (id: string, threadId: ThreadId, runId: string | null, payload: object) =>
          sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json) VALUES (${id}, ${threadId}, ${runId}, 1, 'file_change', 'completed', '2026-10-22T10:00:00Z', ${JSON.stringify(payload)})`;
        for (const thread of [reports, mixed, delegating])
          yield* addRun(thread, { changed: false });
        yield* edit("reports:spec", reports, `${reports}:run:1`, {
          fileName: "/work/umb/.specweave/increments/1001-x/spec.md",
        });
        yield* edit("reports:page", reports, `${reports}:run:1`, {
          fileName: "/home/me/evidence/run-1/report.html",
          changes: [
            { operation: "add", path: "/home/me/evidence/run-1/report.html" },
            { operation: "add", path: "/home/me/evidence/run-1/dark.png" },
          ],
        });
        yield* edit("mixed:notes", mixed, `${mixed}:run:1`, { fileName: "/work/app/NOTES.md" });
        yield* edit("mixed:code", mixed, `${mixed}:run:1`, {
          fileName: "/work/app/reports/summary.md",
          changes: [
            { operation: "update", path: "/work/app/reports/summary.md" },
            { operation: "update", path: "/work/app/src/reports/view.ts" },
          ],
        });
        yield* edit("child:ledger", child, null, {
          fileName: "C:\\work\\umb\\.specweave\\increments\\1001-x\\ledger.jsonl",
        });
        for (const thread of [reports, mixed, delegating, child]) unbound.add(thread);
        const { service } = yield* makeService(root);

        const snapshot = yield* service.read({
          projectId: PROJECT,
          threadIds: [reports, mixed, delegating, child],
        });

        assert.deepStrictEqual(snapshot.unplanned, [mixed]);
        assert.deepStrictEqual(snapshot.documentation, [delegating, reports].toSorted());
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("a running thread's code edit after a document edit is not hidden", () =>
    Effect.gen(function* () {
      const root = specweaveRoot();
      try {
        const thread = yield* addThread("thread:unplanned:doc-then-code");
        yield* addRun(thread, { status: "running", changed: false });
        unbound.add(thread);
        const sql = yield* SqlClient.SqlClient;
        const edit = (id: string, ordinal: number, fileName: string) =>
          sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json) VALUES (${id}, ${thread}, ${`${thread}:run:1`}, ${ordinal}, 'file_change', 'completed', '2026-10-22T10:00:00Z', ${JSON.stringify({ fileName })})`;
        const { service } = yield* makeService(root);
        const input = { projectId: PROJECT, threadIds: [thread] };
        yield* edit("doc-then-code:readme", 1, "/work/app/README.md");
        const first = yield* service.read(input);
        assert.deepStrictEqual(first.unplanned, []);
        assert.deepStrictEqual(first.documentation, [thread]);

        yield* edit("doc-then-code:src", 2, "/work/app/src/index.ts");
        yield* TestClock.adjust("10 seconds");
        const second = yield* service.read(input);
        assert.deepStrictEqual(second.unplanned, [thread]);
        assert.strictEqual(second.documentation, undefined);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("finds a code change past the first page of document edits", () =>
    Effect.gen(function* () {
      const root = specweaveRoot();
      try {
        // Its worktree is /work/reports: a checkout under a folder named
        // "reports" is judged by paths inside it, so its data file is code.
        const thread = yield* addThread("reports");
        yield* addRun(thread, { changed: false });
        unbound.add(thread);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json) VALUES ('reports:data', ${thread}, ${`${thread}:run:1`}, 1, 'file_change', 'completed', '2026-10-22T10:00:00Z', ${JSON.stringify({ fileName: "/work/reports/data.json" })})`;
        for (let ordinal = 2; ordinal <= 60; ordinal++) {
          yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json) VALUES (${`reports:doc:${ordinal}`}, ${thread}, ${`${thread}:run:1`}, ${ordinal}, 'file_change', 'completed', '2026-10-22T10:00:00Z', ${JSON.stringify({ fileName: `/work/reports/docs/${ordinal}.md` })})`;
        }
        const { service } = yield* makeService(root);
        const snapshot = yield* service.read({ projectId: PROJECT, threadIds: [thread] });
        assert.deepStrictEqual(snapshot.unplanned, [thread]);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it("classifies changed paths as documentation or code", () => {
    for (const path of [
      "/u/umb/.specweave/increments/1001-x/spec.md",
      ".specweave/config.json",
      "docs/guide.MD",
      "/u/app/reports/run/notes.txt",
      "/u/app/reports/run/screenshot.png",
      "C:\\u\\evidence\\capture.webm",
      "/u/app/reports/run/frame.b64",
    ]) {
      assert.strictEqual(ThreadIncrementProgressService.isDocumentationPath(path), true, path);
    }
    for (const path of [
      "/u/app/src/reports/view.ts",
      "/u/app/evidence/run.sh",
      "/u/app/package.json",
      "File change",
      "/u/app/report.html",
      "README.txt",
      "requirements.txt",
      "CMakeLists.txt",
    ]) {
      assert.strictEqual(ThreadIncrementProgressService.isDocumentationPath(path), false, path);
    }
    assert.strictEqual(ThreadIncrementProgressService.fileChangeKind(null, "[]"), "code");
    assert.strictEqual(ThreadIncrementProgressService.fileChangeKind("a.md", "not json"), "code");
    assert.strictEqual(
      ThreadIncrementProgressService.fileChangeKind("a.md", '[["b.md","src/old.ts"]]'),
      "code",
    );
    assert.strictEqual(
      ThreadIncrementProgressService.fileChangeKind("a.md", '[["b.md",null]]'),
      "documentation",
    );
    // Judged inside the checkout: its own location does not make it a report folder.
    assert.strictEqual(
      ThreadIncrementProgressService.fileChangeKind("/w/reports/app/out.json", "[]", [
        "/w/reports/app",
      ]),
      "code",
    );
    assert.strictEqual(
      ThreadIncrementProgressService.fileChangeKind("/w/reports/app/reports/out.json", "[]", [
        "/w/reports/app",
      ]),
      "documentation",
    );
  });

  it.effect("stops flagging a thread once its edits are rolled back", () =>
    Effect.gen(function* () {
      const root = specweaveRoot();
      try {
        const thread = yield* addThread("thread:unplanned:rolled-back");
        yield* addRun(thread);
        unbound.add(thread);
        const { service } = yield* makeService(root);
        const input = { projectId: PROJECT, threadIds: [thread] };
        assert.deepStrictEqual((yield* service.read(input)).unplanned, [thread]);

        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'rolled_back' WHERE thread_id = ${thread}`;
        assert.deepStrictEqual((yield* service.read(input)).unplanned, []);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("says nothing about unplanned work outside a SpecWeave project", () =>
    Effect.gen(function* () {
      const thread = yield* addThread("thread:unplanned:plain");
      yield* addRun(thread);
      unbound.add(thread);
      const { service } = yield* makeService();

      const snapshot = yield* service.read({ projectId: PROJECT, threadIds: [thread] });

      assert.strictEqual(snapshot.specweave, false);
      assert.strictEqual(snapshot.unplanned, undefined);
    }),
  );
});
