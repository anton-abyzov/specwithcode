import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  ScheduledTaskUpsertInput,
  ThreadId,
  type ProjectId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectCoordinator from "../project/ProjectCoordinatorService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Service from "./ScheduledTaskService.ts";
import { routineProject } from "./ScheduledTaskService.test-fixtures.ts";

// A fictional household: nothing here names a real person, account or folder.
const TAX_PREP = {
  id: "routine-tax-prep",
  title: "Monthly tax prep",
  prompt: "Sort last month's receipts into deductible categories and total them.",
  enabled: true,
  projectId: "aide",
  schedule: { type: "manual" },
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "claudeAgent", model: "fixture" },
  runtimeMode: "full-access",
  interactionMode: "default",
  ownThread: true,
  brief: {
    inputs: [
      { label: "Receipts folder", location: "/fixtures/example-household/receipts" },
      { label: "Bank export", location: "/fixtures/example-household/bank/{period}.csv" },
    ],
    output: "/fixtures/example-household/tax/{period}-prep.md",
    prepareOnly: true,
  },
};
const decodeTaskInput = Schema.decodeUnknownSync(ScheduledTaskUpsertInput);
const taskInput = (overrides: Record<string, unknown> = {}) =>
  decodeTaskInput({ ...TAX_PREP, ...overrides });

const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const state = {
    launches: [] as Array<{
      readonly commandId: string;
      readonly title: string;
      readonly text: string;
      readonly messageId: string;
    }>,
    sent: [] as Array<{ readonly threadId: string; readonly text: string }>,
    coordinatorWakes: 0,
    transferred: false,
    transferDuringCheck: false,
  };
  const threadRow = (id: string) =>
    sql`INSERT OR IGNORE INTO orchestration_v2_projection_threads ${sql.insert({ thread_id: id, project_id: "aide", title: "Monthly tax prep", default_provider: "claudeAgent", runtime_mode: "full-access", interaction_mode: "default", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", deleted_at: null, payload_json: "{}" })}`.pipe(
      Effect.orDie,
    );
  const dependencies = () =>
    Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: (id: ProjectId) =>
          Effect.succeed(
            Option.some({
              ...routineProject(id),
              ...(state.transferred
                ? {
                    workspaceSettings: {
                      ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
                      coordinatorBinding: { epoch: 1, state: "transferred" as const },
                    },
                  }
                : {}),
            }),
          ),
      }),
      // Launches are idempotent by command id, like the real service: a
      // repeated id resumes the thread it started.
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) =>
          Effect.gen(function* () {
            const index = state.launches.findIndex((entry) => entry.commandId === input.commandId);
            const resumed = index >= 0;
            const ordinal = resumed ? index : state.launches.length;
            if (!resumed)
              state.launches.push({
                commandId: input.commandId,
                title: input.title ?? "",
                text: input.initialMessage?.text ?? "",
                messageId: input.initialMessage?.messageId ?? "",
              });
            const threadId = ThreadId.make(`routine-thread-${ordinal + 1}`);
            yield* threadRow(threadId);
            return {
              threadId,
              resumed,
              // The thread holds the message its first launch posted.
              projection: { messages: [{ id: state.launches[ordinal]?.messageId }] },
            } as never;
          }),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        sendToThread: (input) =>
          Effect.sync(() => {
            state.sent.push({ threadId: input.threadId, text: input.text });
            return {} as never;
          }),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ProcessRunner.ProcessRunner)({
        run: () =>
          Effect.sync(() => {
            if (state.transferDuringCheck) state.transferred = true;
            return { code: 0, stdout: "synthetic check", stderr: "" } as never;
          }),
      }),
      Layer.mock(ProjectCoordinator.ProjectCoordinatorService)({
        start: () =>
          Effect.sync(() => {
            state.coordinatorWakes++;
            return { threadId: ThreadId.make("project-coordinator:aide"), created: false };
          }),
        nextTurnModel: () => Effect.succeed(undefined as never),
      }),
      Layer.mock(Scheduler.Scheduler)({
        register: () => Effect.void,
        heldMsBetween: () => Effect.succeed(0),
      }),
    );
  const run = <A, E, R>(
    body: (service: Service.ScheduledTaskService["Service"]) => Effect.Effect<A, E, R>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Service.ScheduledTaskService;
        return yield* body(service);
      }).pipe(Effect.provide(Service.layer.pipe(Layer.provide(dependencies())))),
    );
  const boundThread = Effect.map(
    sql<{ thread_id: string | null }>`SELECT thread_id FROM scheduled_tasks`,
    (rows) => rows[0]?.thread_id ?? null,
  );
  return { state, run, sql, boundThread };
});

const runNow = (service: Service.ScheduledTaskService["Service"], commandId: string) =>
  service.runNow({ id: TAX_PREP.id as never, commandId: CommandId.make(commandId) });

it.effect("gives a routine its own thread, continued by later runs, with the brief first", () =>
  Effect.gen(function* () {
    const { state, run, boundThread } = yield* harness;
    yield* TestClock.setTime(Date.parse("2026-10-20T16:00:00.000Z"));
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(taskInput());
        // "When I ask": nothing is due.
        assert.isNull(task.nextRunAt);
        assert.isTrue(task.ownThread);

        yield* runNow(service, "first");
        assert.equal(state.launches.length, 1);
        assert.equal(state.launches[0]?.title, "Monthly tax prep");
        assert.equal(yield* boundThread, "routine-thread-1");
        const text = state.launches[0]?.text ?? "";
        assert.include(text, 'Routine "Monthly tax prep", run on October 20, 2026.');
        assert.include(text, "Previous month: September 2026 (2026-09).");
        assert.include(text, "- Receipts folder: /fixtures/example-household/receipts");
        assert.include(text, "/fixtures/example-household/tax/2026-09-prep.md");
        assert.include(text, "Prepare and draft only.");
        assert.isTrue(text.endsWith(`---\n${TAX_PREP.prompt}`));

        // A second run continues the same thread; a retried request runs once.
        yield* runNow(service, "second");
        yield* runNow(service, "second");
        assert.equal(state.launches.length, 1);
        assert.equal(state.sent.length, 1);
        assert.equal(state.sent[0]?.threadId, "routine-thread-1");
        assert.include(state.sent[0]?.text ?? "", "Previous month: September 2026");
        assert.equal(state.coordinatorWakes, 0);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("replaces a deleted or archived own thread and keeps it across edits", () =>
  Effect.gen(function* () {
    const { state, run, sql, boundThread } = yield* harness;
    yield* TestClock.setTime(Date.parse("2026-10-20T16:00:00.000Z"));
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput());
        yield* runNow(service, "first");
        assert.equal(yield* boundThread, "routine-thread-1");

        // An edit from a form that leaves out the thread and brief keeps both.
        const { brief: _brief, ownThread: _own, ...withoutRoutineFields } = TAX_PREP;
        const { task } = yield* service.upsert(
          decodeTaskInput({ ...withoutRoutineFields, title: "Monthly tax prep" }),
        );
        assert.equal(task.threadId, "routine-thread-1");
        assert.isTrue(task.ownThread);
        assert.equal(task.brief?.inputs.length, 2);

        yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = '2026-10-20T00:00:00Z' WHERE thread_id = 'routine-thread-1'`;
        yield* runNow(service, "after-archive");
        assert.equal(state.launches.length, 2);
        assert.equal(yield* boundThread, "routine-thread-2");

        yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-10-20T00:00:00Z' WHERE thread_id = 'routine-thread-2'`;
        yield* runNow(service, "after-delete");
        assert.equal(state.launches.length, 3);
        assert.equal(yield* boundThread, "routine-thread-3");
        assert.equal(state.sent.length, 0);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("resumes the thread a run started when its binding was not saved", () =>
  Effect.gen(function* () {
    const { state, run, sql, boundThread } = yield* harness;
    yield* TestClock.setTime(Date.parse("2026-10-20T16:00:00.000Z"));
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput());
        yield* runNow(service, "first");
        // As if the host stopped between the launch and saving the binding.
        yield* sql`UPDATE scheduled_tasks SET thread_id = NULL`;
        yield* runNow(service, "second");
        assert.equal(state.launches.length, 1);
        assert.equal(yield* boundThread, "routine-thread-1");
        // The later run's prompt still reaches the thread, once.
        assert.equal(state.sent.length, 1);
        assert.equal(state.sent[0]?.threadId, "routine-thread-1");
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "runs a routine made without a thread in a thread of its own, never the coordinator",
  () =>
    Effect.gen(function* () {
      const { state, run, boundThread } = yield* harness;
      yield* run((service) =>
        Effect.gen(function* () {
          const { brief: _brief, ownThread: _own, ...plain } = TAX_PREP;
          const { task } = yield* service.upsert(decodeTaskInput(plain));
          assert.isTrue(task.ownThread);
          assert.isNull(task.threadId);

          yield* runNow(service, "plain");
          assert.equal(state.coordinatorWakes, 0);
          assert.equal(state.launches.length, 1);
          assert.equal(state.launches[0]?.title, "Monthly tax prep");
          // No brief: the thread gets the prompt exactly, with no coordinator wrapper.
          assert.equal(state.launches[0]?.text, TAX_PREP.prompt);
          assert.equal(yield* boundThread, "routine-thread-1");

          yield* runNow(service, "plain-again");
          assert.equal(state.launches.length, 1);
          assert.deepEqual(state.sent, [{ threadId: "routine-thread-1", text: TAX_PREP.prompt }]);
          assert.equal(state.coordinatorWakes, 0);
        }),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("never saves a routine onto the coordinator thread", () =>
  Effect.gen(function* () {
    const { run, boundThread } = yield* harness;
    yield* run((service) =>
      Effect.gen(function* () {
        const { ownThread: _own, ...plain } = TAX_PREP;
        const { task } = yield* service.upsert(
          decodeTaskInput({ ...plain, threadId: "project-coordinator:aide" }),
        );
        assert.isNull(task.threadId);
        assert.isTrue(task.ownThread);
        assert.isNull(yield* boundThread);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect.each([
  { name: "the coordinator", threadId: "project-coordinator:aide" },
  { name: "no thread", threadId: null },
])("moves an older routine saved with $name onto a thread of its own", (legacy) =>
  Effect.gen(function* () {
    const { state, run, sql, boundThread } = yield* harness;
    yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({ thread_id: "project-coordinator:aide", project_id: "aide", title: "Coordinator", default_provider: "claudeAgent", runtime_mode: "full-access", interaction_mode: "default", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", deleted_at: null, payload_json: "{}" })}`;
    yield* run((service) =>
      Effect.gen(function* () {
        const { brief: _brief, ownThread: _own, ...plain } = TAX_PREP;
        yield* service.upsert(decodeTaskInput(plain));
        // As a host before own threads saved it.
        yield* sql`UPDATE scheduled_tasks SET thread_id = ${legacy.threadId}, run_policy_json = NULL`;

        const listed = (yield* service.list()).tasks[0];
        assert.isNull(listed?.threadId);
        assert.isTrue(listed?.ownThread);

        yield* runNow(service, "legacy");
        assert.equal(state.coordinatorWakes, 0);
        assert.equal(state.sent.length, 0);
        assert.equal(state.launches.length, 1);
        assert.include(
          state.launches[0]?.commandId ?? "",
          `:own-thread:${(yield* service.list()).tasks[0]?.createdAt}:${legacy.threadId ?? "first"}`,
        );
        assert.equal(yield* boundThread, "routine-thread-1");
        // Recorded as owning the thread, so an archived one is replaced like any other.
        const policy = yield* sql<{ own: number | null }>`
            SELECT json_extract(run_policy_json, '$.ownThread') AS own FROM scheduled_tasks`;
        assert.equal(policy[0]?.own, 1);
        const after = (yield* service.list()).tasks[0];
        assert.equal(after?.threadId, "routine-thread-1");
        assert.isTrue(after?.ownThread);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
it.effect("keeps migrated project routines fenced after transfer, including after an edit", () =>
  Effect.gen(function* () {
    const { state, run, sql } = yield* harness;
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput());
        yield* sql`UPDATE scheduled_tasks SET thread_id = 'project-coordinator:aide', run_policy_json = NULL`;
        state.transferred = true;
        const refusal = yield* Effect.flip(runNow(service, "transferred-legacy"));
        assert.include(refusal.message, "handed off");
        // Saving the migrated routine must not lose the ownership fence.
        yield* service.upsert(taskInput({ title: "Updated title" }));
        const editedRefusal = yield* Effect.flip(runNow(service, "transferred-edited"));
        assert.include(editedRefusal.message, "handed off");
        assert.equal(state.launches.length, 0);
        assert.equal(state.sent.length, 0);
        assert.equal(state.coordinatorWakes, 0);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("does not launch locally when transfer completes during a pre-run check", () =>
  Effect.gen(function* () {
    const { state, run } = yield* harness;
    state.transferDuringCheck = true;
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput({ check: { command: "synthetic check" } }));
        yield* runNow(service, "transfer-during-check").pipe(Effect.catch(() => Effect.void));
        assert.isTrue(state.transferred);
        assert.equal(state.launches.length, 0);
        assert.equal(state.sent.length, 0);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
