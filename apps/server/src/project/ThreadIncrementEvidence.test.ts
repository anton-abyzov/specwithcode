// @effect-diagnostics nodeBuiltinImport:off - Real folders: a project, and a repository the agent made elsewhere.
/**
 * The plan card of a thread that plans outside its project, end to end: the
 * real folder reader over the real projection. This is the "Build SpecOS on
 * Linux" thread of November 11, 2026: launched in one project, told to build
 * in `~/live/spec-os`, where its agent ran `git init`, `specweave init` and
 * `specweave create-increment`. Its card said "No plan" for all 26 tasks.
 */
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
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { specweaveStudioThreadBindingPath } from "./ThreadIncrementProgress.ts";
import * as ThreadIncrementProgressService from "./ThreadIncrementProgressService.ts";

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const PROJECT = ProjectId.make("project:specos");
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-fable-5-2",
} satisfies ModelSelection;
const INCREMENT = "0001-specos-browser-desktop-for-ai-agent-work";
const SPEC = `# SpecOS: browser desktop for AI agent work

## Acceptance Criteria
- [ ] AC-01: The server prints one URL with a token

## Tasks
### T-01 Scaffold
- AC: AC-01 | Files: package.json | Test: npm run build
### T-02 Token access
- AC: AC-01 | Files: server/src/access.ts | Test: npm test
### T-03 Path guard
- AC: AC-01 | Files: server/src/guard.ts | Test: npm test
`;

const folder = (prefix: string) =>
  NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));

/** A SpecWeave repository with one increment, as `specweave create-increment` leaves it. */
function plannedRepository(prefix: string, incrementId: string) {
  const root = folder(prefix);
  const increment = NodePath.join(root, ".specweave", "increments", incrementId);
  NodeFS.mkdirSync(increment, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, ".specweave", "config.json"), "{}");
  NodeFS.writeFileSync(NodePath.join(increment, "spec.md"), SPEC);
  NodeFS.writeFileSync(
    NodePath.join(increment, "metadata.json"),
    JSON.stringify({ status: "active", title: "SpecOS: browser desktop for AI agent work" }),
  );
  return { root, increment, spec: NodePath.join(increment, "spec.md") };
}

function appendLedger(increment: string, events: ReadonlyArray<Record<string, string>>) {
  NodeFS.appendFileSync(
    NodePath.join(increment, "ledger.jsonl"),
    events.map((event) => `${JSON.stringify(event)}\n`).join(""),
  );
}

/** What SpecWeave writes on a ledger append made in the thread's turn. */
function writeClaim(home: string, threadId: string, root: string, taskId: string) {
  const file = specweaveStudioThreadBindingPath(threadId, home);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      threadId,
      incrementId: INCREMENT,
      root,
      taskId,
      event: "done",
      at: "2026-11-11T18:57:31Z",
    }),
  );
}

/** A thread in the project folder itself: no worktree and no branch, like one started on another machine. */
const addThread = Effect.fn("addThread")(function* (id: string) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(id);
  yield* store.apply({
    id: EventId.make(`event:${id}:created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "agent",
      creationSource: "mcp",
      id: threadId,
      projectId: PROJECT,
      title: "Build SpecOS on Linux",
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

const addChange = Effect.fn("addChange")(function* (
  threadId: ThreadId,
  ordinal: number,
  path: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json) VALUES (${`${threadId}:change:${ordinal}`}, ${threadId}, NULL, ${ordinal}, 'file_change', 'completed', '2026-11-11T18:55:00Z', ${JSON.stringify({ fileName: path })})`;
});

const makeService = (workspaceRoot: string) =>
  ThreadIncrementProgressService.make.pipe(
    Effect.provideService(
      ProjectStore.ProjectStoreV2,
      ProjectStore.ProjectStoreV2.of({
        get: () => Effect.succeedSome({ workspaceRoot }),
      } as never),
    ),
  );

/** Points the claim files at a home of the test's own for one effect. */
const withHome = <A, E, R>(home: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }),
  );

it.layer(layerTest)("a thread that plans outside its project folder", (it) => {
  it.effect("shows the increment it claimed there, with live task progress", () =>
    Effect.gen(function* () {
      const project = folder("plan-specos-project-");
      const home = folder("plan-specos-home-");
      const elsewhere = plannedRepository("plan-specos-live-", INCREMENT);
      const thread = yield* addThread("thread:specos:claim");
      const service = yield* makeService(project);
      const read = () =>
        service
          .read({ projectId: PROJECT, threadIds: [thread] })
          .pipe(Effect.tap(() => TestClock.adjust("6 seconds")));

      yield* withHome(
        home,
        Effect.gen(function* () {
          appendLedger(elsewhere.increment, [
            { t: "T-01", e: "claim", by: "claude@minisforum", at: "2026-11-11T18:55:00Z" },
            {
              t: "T-01",
              e: "done",
              by: "claude@minisforum",
              at: "2026-11-11T18:57:31Z",
              evidence: "f54e0c3",
            },
          ]);
          writeClaim(home, thread, elsewhere.root, "T-01");

          // Before: the claim file alone names a folder outside the project. "No plan".
          assert.deepStrictEqual((yield* read()).threads, []);

          // The thread's own turn wrote there (its agent filled spec.md).
          yield* addChange(thread, 1, elsewhere.spec);
          const [bound] = (yield* read()).threads;
          assert.strictEqual(bound?.incrementId, INCREMENT);
          assert.strictEqual(bound?.binding, "claim");
          assert.strictEqual(bound?.incrementPath, elsewhere.increment);
          assert.deepStrictEqual(
            bound?.tasks.map((task) => [task.id, task.status]),
            [
              ["T-01", "done"],
              ["T-02", "planned"],
              ["T-03", "planned"],
            ],
          );

          // A background workflow's agents finish tasks: plain ledger lines, read on the next poll.
          appendLedger(elsewhere.increment, [
            { t: "T-02", e: "claim", by: "claude@minisforum", at: "2026-11-11T19:10:00Z" },
            {
              t: "T-02",
              e: "done",
              by: "claude@minisforum",
              at: "2026-11-11T19:20:00Z",
              evidence: "6317d9f",
            },
          ]);
          assert.deepStrictEqual(
            (yield* read()).threads[0]?.tasks.map((task) => task.status),
            ["done", "done", "planned"],
          );
        }),
      );
    }),
  );

  it.effect("shows an increment its agent just wrote, before any ledger write", () =>
    Effect.gen(function* () {
      const project = folder("plan-specos-project-");
      const home = folder("plan-specos-home-");
      const elsewhere = plannedRepository("plan-specos-live-", INCREMENT);
      const thread = yield* addThread("thread:specos:spec");
      const idle = yield* addThread("thread:specos:idle");
      yield* addChange(thread, 1, elsewhere.spec);
      const service = yield* makeService(project);

      const snapshot = yield* withHome(
        home,
        service.read({ projectId: PROJECT, threadIds: [thread, idle] }),
      );
      assert.deepStrictEqual(
        snapshot.threads.map((entry) => [entry.threadId, entry.incrementId, entry.boundTaskId]),
        [[thread, INCREMENT, null]],
      );
      assert.strictEqual(snapshot.threads[0]?.specPath, elsewhere.spec);
    }),
  );

  it.effect("refuses a claim file that names a folder the thread never worked in", () =>
    Effect.gen(function* () {
      const project = folder("plan-specos-project-");
      const home = folder("plan-specos-home-");
      const elsewhere = plannedRepository("plan-specos-live-", INCREMENT);
      const worker = yield* addThread("thread:specos:worker");
      const borrower = yield* addThread("thread:specos:borrower");
      yield* addChange(worker, 1, NodePath.join(elsewhere.root, "server", "src", "app.ts"));
      yield* addChange(borrower, 1, NodePath.join(project, "README.md"));
      const service = yield* makeService(project);

      const snapshot = yield* withHome(
        home,
        Effect.gen(function* () {
          writeClaim(home, worker, elsewhere.root, "T-01");
          // The same file under another thread's id: forged, or SPECWEAVE_STUDIO_THREAD_ID borrowed.
          writeClaim(home, borrower, elsewhere.root, "T-01");
          return yield* service.read({ projectId: PROJECT, threadIds: [worker, borrower] });
        }),
      );
      assert.deepStrictEqual(
        snapshot.threads.map((entry) => entry.threadId),
        [worker],
      );
    }),
  );

  it.effect("lists and links that folder's increments for the thread, and only for it", () =>
    Effect.gen(function* () {
      const project = folder("plan-specos-project-");
      const home = folder("plan-specos-home-");
      const elsewhere = plannedRepository("plan-specos-live-", INCREMENT);
      const stranger = plannedRepository("plan-specos-stranger-", "0009-not-this-thread");
      const thread = yield* addThread("thread:specos:link");
      const other = yield* addThread("thread:specos:unrelated");
      yield* addChange(thread, 1, elsewhere.spec);
      const service = yield* makeService(project);

      yield* withHome(
        home,
        Effect.gen(function* () {
          const listed = yield* service.listIncrements({ projectId: PROJECT, threadId: thread });
          assert.deepStrictEqual(
            listed.increments.map((entry) => entry.incrementId),
            [INCREMENT],
          );
          const forOther = yield* service.listIncrements({ projectId: PROJECT, threadId: other });
          assert.deepStrictEqual(forOther.increments, []);

          const link = { type: "increment", incrementId: INCREMENT } as const;
          yield* service.link({ projectId: PROJECT, threadId: thread, link });
          const [bound] = (yield* service.read({ projectId: PROJECT, threadIds: [thread] }))
            .threads;
          assert.strictEqual(bound?.binding, "manual");
          assert.strictEqual(bound?.incrementPath, elsewhere.increment);

          // A folder this thread never touched stays out of reach, by hand too.
          const refused = yield* Effect.flip(
            service.link({
              projectId: PROJECT,
              threadId: thread,
              link: { type: "increment", incrementId: NodePath.basename(stranger.increment) },
            }),
          );
          assert.strictEqual(refused.code, "not_found");
          const borrowed = yield* Effect.flip(
            service.link({ projectId: PROJECT, threadId: other, link }),
          );
          assert.strictEqual(borrowed.code, "not_found");
        }),
      );
    }),
  );
});
