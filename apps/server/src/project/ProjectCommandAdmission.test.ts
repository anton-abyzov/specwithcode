import { expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@specweave-studio/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Persistence from "../persistence/Sqlite.ts";
import * as Admission from "./ProjectAdmission.ts";
import { guardProjectCreation } from "./ProjectCommandAdmission.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";

const projectId = ProjectId.make("admission");
const threadId = ThreadId.make("thread:admission");
const createdAt = "2026-10-09T00:00:00.000Z";
const command: OrchestrationV2ServerCommand = {
  type: "thread.create",
  commandId: CommandId.make("create"),
  threadId,
  projectId,
  title: "Worker",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdBy: "user",
  creationSource: "web",
};
const layer = Layer.mergeAll(Admission.layer, Projects.layer).pipe(
  Layer.provideMerge(Persistence.layerMemory),
);
const fixture = Effect.gen(function* () {
  const projects = yield* Projects.ProjectStoreV2;
  const admission = yield* Admission.ProjectAdmission;
  yield* projects.apply({
    sequence: 1,
    eventId: EventId.make("create-project"),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: createdAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Fixture",
      workspaceRoot: "/tmp/fixture",
      defaultModelSelection: null,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
  });
  const projections = {
    getThreadRecords: () =>
      Effect.succeed(idleThreadProjection({ ...liveThreadShell(threadId), projectId })),
  };
  const guard = guardProjectCreation({
    projects,
    projections,
    admission,
    reject: (_command, cause) => {
      if (cause instanceof Error || typeof cause === "string") return cause;
      throw new Error("Unexpected admission failure", { cause });
    },
  });
  return { projects, admission, guard };
});
it.effect("serializes a delayed raw creation behind deletion and refuses the orphan", () =>
  Effect.gen(function* () {
    const { admission, guard } = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    const reached = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const deletion = yield* admission
      .withLock(
        projectId,
        Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(
            sql`UPDATE projection_projects SET deleted_at=${createdAt} WHERE project_id=${projectId}`,
          ),
        ),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(reached);
    let committed = false;
    const late = yield* guard(
      command,
      Effect.sync(() => {
        committed = true;
      }),
    ).pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    expect(late.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(deletion);
    expect(yield* Fiber.join(late)).toMatchObject({ code: "not_found" });
    expect(committed).toBe(false);
  }).pipe(Effect.provide(layer)),
);
it.effect("guards direct create, fork and delegated requests when paused or archived", () =>
  Effect.gen(function* () {
    const { guard } = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    for (const status of ["paused", "archived"] as const) {
      yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify({ ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, [status]: true })} WHERE project_id=${projectId}`;
      for (const input of [
        command,
        { ...command, type: "thread.fork", sourceThreadId: threadId },
        { ...command, type: "delegated_task.request", parentThreadId: threadId },
      ] as OrchestrationV2ServerCommand[]) {
        expect(
          yield* guard(input, Effect.die("must not dispatch")).pipe(Effect.flip),
        ).toMatchObject({ code: status });
      }
    }
  }).pipe(Effect.provide(layer)),
);
it.effect("protects the retained coordinator but permits ordinary thread deletion", () =>
  Effect.gen(function* () {
    const { guard } = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify({ ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, coordinatorThreadId: threadId })} WHERE project_id=${projectId}`;
    const deletion = {
      type: "thread.delete",
      commandId: CommandId.make("delete"),
      threadId,
    } as const;
    expect(yield* guard(deletion, Effect.die("must not delete")).pipe(Effect.flip)).toContain(
      "coordinator is retained",
    );
    expect(
      yield* guard({ ...deletion, threadId: ThreadId.make("worker") }, Effect.succeed("deleted")),
    ).toBe("deleted");
  }).pipe(Effect.provide(layer)),
);
it.effect("refuses to archive the retained coordinator but permits ordinary thread archive", () =>
  Effect.gen(function* () {
    const { guard } = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify({ ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, coordinatorThreadId: threadId })} WHERE project_id=${projectId}`;
    const archive = {
      type: "thread.archive",
      commandId: CommandId.make("archive"),
      threadId,
    } as const;
    expect(yield* guard(archive, Effect.die("must not archive")).pipe(Effect.flip)).toContain(
      "Archive the project from project settings",
    );
    expect(
      yield* guard({ ...archive, threadId: ThreadId.make("worker") }, Effect.succeed("archived")),
    ).toBe("archived");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "fences direct dispatch, queued/retried work, provider changes and approvals after handoff",
  () =>
    Effect.gen(function* () {
      const { guard } = yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      for (const state of ["transferring", "transferred"] as const) {
        yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify({
          ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
          coordinatorThreadId: threadId,
          coordinatorBinding: { state, epoch: 0, operationId: "transfer" },
        })} WHERE project_id=${projectId}`;
        for (const type of [
          "message.dispatch",
          "queue.resume",
          "prepared-run.release",
          "prepared-run.retry",
          "provider.switch",
          "runtime-request.respond",
          "queued-message.promote-to-steer",
        ] as const) {
          const input = {
            type,
            threadId,
            commandId: CommandId.make(type),
          } as OrchestrationV2ServerCommand;
          expect(
            yield* guard(input, Effect.die("must not start old coordinator")).pipe(Effect.flip),
          ).toMatchObject({ code: "transferred" });
        }
      }
    }).pipe(Effect.provide(layer)),
);
it.effect("permits nested admission in one fiber but serializes a child fiber", () =>
  Effect.gen(function* () {
    const { admission } = yield* fixture;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const outer = yield* admission
      .withLock(
        projectId,
        Effect.gen(function* () {
          expect(yield* admission.withLock(projectId, Effect.succeed("nested"))).toBe("nested");
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const waiting = yield* admission
      .withLock(projectId, Effect.succeed("next"))
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    expect(waiting.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(outer);
    expect(yield* Fiber.join(waiting)).toBe("next");
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps source workers usable after acknowledgment without reviving its coordinator", () =>
  Effect.gen(function* () {
    const { guard } = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    const worker = ThreadId.make("ordinary-worker");
    yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify({
      ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
      coordinatorThreadId: threadId,
      coordinatorBinding: { state: "transferred", epoch: 0, operationId: "transfer" },
    })} WHERE project_id=${projectId}`;
    expect(yield* guard({ ...command, threadId: worker }, Effect.succeed("created"))).toBe(
      "created",
    );
    expect(
      yield* guard(
        {
          type: "message.dispatch",
          threadId: worker,
          commandId: CommandId.make("worker-send"),
        } as OrchestrationV2ServerCommand,
        Effect.succeed("sent"),
      ),
    ).toBe("sent");
    expect(
      yield* guard(command, Effect.die("duplicate coordinator")).pipe(Effect.flip),
    ).toMatchObject({ code: "transferred" });
  }).pipe(Effect.provide(layer)),
);
