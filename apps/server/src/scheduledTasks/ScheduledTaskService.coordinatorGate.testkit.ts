/** A scheduler on one copy of a linked project, with its coordinator role and wake fence under test control. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ScheduledTaskUpsertInput, ThreadId, type ProjectId } from "@specweave-studio/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  CoordinatorRole,
  type CoordinatorRoleChange,
  type CoordinatorRoleShape,
  type CoordinatorRoleStatus,
} from "../project/CoordinatorRole.ts";
import { CoordinatorWakeGate } from "../project/CoordinatorWakeGate.ts";
import * as ProjectCoordinator from "../project/ProjectCoordinatorService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { DEFAULT_PROJECT_WORKSPACE_SETTINGS } from "../../../../packages/contracts/src/projectWorkspace.ts";
import * as Service from "./ScheduledTaskService.ts";
import { routineProject } from "./ScheduledTaskService.test-fixtures.ts";

const decodeTaskInput = Schema.decodeUnknownSync(ScheduledTaskUpsertInput);
export const taskInput = (overrides: Record<string, unknown> = {}) =>
  decodeTaskInput({
    id: "routine",
    title: "Synthetic review",
    prompt: "Review synthetic fixture",
    enabled: true,
    projectId: "project-a",
    threadId: null,
    schedule: { type: "interval", everyMs: 60000 },
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "fixture" },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  });

export type Role = Pick<CoordinatorRoleStatus, "active" | "epoch" | "state">;
export const ACTIVE: Role = { active: true, epoch: 1, state: "active" };
export const TRANSFERRED: Role = { active: false, epoch: 2, state: "transferred" };

export const roleService = (
  state: { role: Role },
  changes: Stream.Stream<CoordinatorRoleChange> = Stream.empty,
): CoordinatorRoleShape => ({
  roleOf: (projectId) =>
    Effect.sync(() => Option.some({ projectId, logicalProjectId: "logical-a", ...state.role })),
  changes,
  publish: () => Effect.void,
});

export const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const roleChanges = yield* PubSub.unbounded<CoordinatorRoleChange>();
  const subscribed = yield* Deferred.make<void>();
  const handled = yield* Deferred.make<void>();
  // Resolves `subscribed` when the scheduler subscribes, and `handled` once it handled a takeover.
  const changes = Stream.unwrap(
    Effect.map(PubSub.subscribe(roleChanges), (subscription) =>
      Stream.fromSubscription(subscription).pipe(
        Stream.onStart(Deferred.succeed(subscribed, undefined)),
        // runForEach pulls the next change only once it handled the last one.
        Stream.tap((change) =>
          change.kind === "standby-released" ? Deferred.succeed(handled, undefined) : Effect.void,
        ),
      ),
    ),
  );
  const state = {
    /** Publishes this copy's takeover once the scheduler listens, and lets it act on it. */
    publishTookOver: () =>
      Deferred.await(subscribed).pipe(
        Effect.andThen(
          PubSub.publish(roleChanges, {
            kind: "took-over",
            projectId: "project-a" as ProjectId,
            logicalProjectId: "logical-a",
            epoch: 3,
            predecessor: null,
            takenOverBy: "auto",
            at: "2026-11-03T12:00:00.000Z",
          }),
        ),
        Effect.andThen(
          PubSub.publish(roleChanges, {
            kind: "standby-released",
            projectId: "project-a" as ProjectId,
            logicalProjectId: "logical-a",
            reason: "test",
            at: "2026-11-03T12:00:00.000Z",
          }),
        ),
        Effect.andThen(Deferred.await(handled)),
      ),
    role: ACTIVE,
    fence: null as string | null,
    launches: 0,
    sends: 0,
    due: Effect.void as Effect.Effect<void, never, SqlClient.SqlClient>,
  };
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (id: ProjectId) =>
        Effect.succeed(
          Option.some({
            ...routineProject(id),
            workspaceSettings: DEFAULT_PROJECT_WORKSPACE_SETTINGS,
          }),
        ),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      // A routine with a thread of its own starts it here.
      launch: () =>
        Effect.sync(() => {
          state.launches++;
          return { threadId: "synthetic", resumed: false } as never;
        }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      // No thread record: a routine's own thread keeps its mode.
      getThreadShell: () => Effect.succeed(null),
      sendToThread: () =>
        Effect.sync(() => {
          state.sends++;
          return {} as never;
        }),
    }),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(ProcessRunner.ProcessRunner)({}),
    Layer.mock(ProjectCoordinator.ProjectCoordinatorService)({
      start: (input) =>
        Effect.sync(() => {
          state.launches++;
        }).pipe(
          Effect.andThen(
            sql`INSERT OR IGNORE INTO orchestration_v2_projection_threads ${sql.insert({ thread_id: `project-coordinator:${input.projectId}`, project_id: input.projectId, title: "Coordinator", default_provider: "codex", runtime_mode: "full-access", interaction_mode: "default", created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z", deleted_at: null, payload_json: "{}" })}`.pipe(
              Effect.orDie,
            ),
          ),
          Effect.as({
            threadId: ThreadId.make(`project-coordinator:${input.projectId}`),
            created: false,
          }),
        ),
      nextTurnModel: () => Effect.succeed(undefined as never),
    }),
    Layer.mock(Scheduler.Scheduler)({
      register: <E, R>(_name: string, work: Effect.Effect<void, E, R>) =>
        Effect.gen(function* () {
          const context = yield* Effect.context<R>();
          state.due = work.pipe(Effect.provideContext(context), Effect.orDie);
        }),
      heldMsBetween: () => Effect.succeed(0),
    }),
    Layer.succeed(CoordinatorRole, CoordinatorRole.of(roleService(state, changes))),
    Layer.succeed(CoordinatorWakeGate, { check: () => Effect.sync(() => state.fence) }),
  );
  const run = <A, E, R>(
    body: (service: Service.ScheduledTaskService["Service"]) => Effect.Effect<A, E, R>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        return yield* body(yield* Service.ScheduledTaskService);
      }).pipe(Effect.provide(Service.layer.pipe(Layer.provide(dependencies)))),
    );
  const row = Effect.map(
    sql<{
      next_run_at: string | null;
      last_run_error: string | null;
      run_count: number;
    }>`SELECT next_run_at, last_run_error, run_count FROM scheduled_tasks WHERE task_id = 'routine'`,
    (rows) => rows[0],
  );
  const seedThread = (id: string, projectId: string) =>
    sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({ thread_id: id, project_id: projectId, title: "Synthetic", default_provider: "codex", runtime_mode: "full-access", interaction_mode: "default", created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z", deleted_at: null, payload_json: "{}" })}`;
  return { state, run, sql, row, seedThread };
});
