import { assert, describe, it } from "@effect/vitest";
import type { ScheduledTaskId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as WorkGrants from "../fleet/WorkGrants.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import {
  ROUTINE_GRANT_GONE_NOTE,
  ROUTINE_GRANT_NO_ROUTINES_NOTE,
  ROUTINE_GRANT_PROJECT_NOTE,
  ROUTINE_GRANT_REVOKED_NOTE,
  readRoutineGrant,
  routineGrantRefusal,
} from "./ScheduledTaskGrantGate.ts";
import { harness, taskInput } from "./ScheduledTaskService.coordinatorGate.testkit.ts";

const M4 = "env-m4";
const AT = "2026-11-09T12:00:00.000Z";

const policy = (
  overrides: Partial<WorkGrants.WorkGrantPolicyRecord> = {},
): WorkGrants.WorkGrantPolicyRecord => ({
  coordinatorEnvironmentId: M4,
  projects: { kind: "all" },
  accounts: { kind: "all" },
  owner: "self",
  legacy: false,
  routines: true,
  runtimeCap: null,
  createdAt: AT,
  updatedAt: AT,
  revokedAt: null,
  interruptAt: null,
  interruptedAt: null,
  ...overrides,
});
const project = { id: "project-a" };

describe("routineGrantRefusal", () => {
  it("lets a routine run while its grant allows routines in its project", () => {
    assert.isNull(routineGrantRefusal({ coordinatorEnvironmentId: M4, policy: policy(), project }));
    // A legacy grant allows routines whatever it stored.
    assert.isNull(
      routineGrantRefusal({
        coordinatorEnvironmentId: M4,
        policy: policy({ legacy: true, routines: false }),
        project,
      }),
    );
  });

  it("turns it off once the grant is gone, revoked, without routines or without the project", () => {
    const refusal = (input: Partial<Parameters<typeof routineGrantRefusal>[0]>) =>
      routineGrantRefusal({ coordinatorEnvironmentId: M4, policy: policy(), project, ...input });
    assert.equal(refusal({ policy: undefined }), ROUTINE_GRANT_GONE_NOTE);
    assert.equal(refusal({ policy: policy({ revokedAt: AT }) }), ROUTINE_GRANT_REVOKED_NOTE);
    assert.equal(refusal({ policy: policy({ routines: false }) }), ROUTINE_GRANT_NO_ROUTINES_NOTE);
    // A policy written before routines existed decodes without the key: off.
    const { routines: _omitted, ...older } = policy();
    assert.equal(refusal({ policy: older }), ROUTINE_GRANT_NO_ROUTINES_NOTE);
    assert.equal(
      refusal({ policy: policy({ projects: { kind: "listed", projectIds: [] } }) }),
      ROUTINE_GRANT_PROJECT_NOTE,
    );
    assert.equal(refusal({ project: undefined }), ROUTINE_GRANT_PROJECT_NOTE);
  });
});

describe("a routine made under a work grant", () => {
  it.effect("fires while the grant allows it and is turned off at the next fire after revoke", () =>
    Effect.gen(function* () {
      const { state, run, sql } = yield* harness;
      yield* TestClock.setTime(Date.parse(AT));
      const grant = { current: policy() };
      const grants: WorkGrants.WorkGrantsShape = {
        ...WorkGrants.WorkGrants.defaultValue(),
        enabled: true,
        policies: Effect.sync(() => [grant.current]),
      };
      const enabledOf = (id: string) =>
        sql<{
          enabled: number;
          last_run_error: string | null;
          next_run_at: string | null;
        }>`SELECT enabled, last_run_error, next_run_at FROM scheduled_tasks WHERE task_id = ${id}`.pipe(
          Effect.map((rows) => rows[0]),
        );
      yield* run((service) =>
        Effect.gen(function* () {
          yield* service.upsert(taskInput({ id: "granted" }));
          yield* service.upsert(taskInput({ id: "owned" }));
          yield* service.recordGrant!({
            id: "granted" as ScheduledTaskId,
            coordinatorEnvironmentId: M4,
          });
          assert.equal(yield* readRoutineGrant("granted"), M4);
          assert.isUndefined(yield* readRoutineGrant("owned"));

          yield* sql`UPDATE scheduled_tasks SET next_run_at = '2026-11-09T11:59:00.000Z'`;
          yield* state.due;
          assert.equal(state.launches, 2);
          assert.equal((yield* enabledOf("granted"))?.enabled, 1);

          // Revoked: the next fire turns it off with the note; the owner's routine keeps running.
          grant.current = policy({ revokedAt: AT });
          yield* sql`UPDATE scheduled_tasks SET next_run_at = '2026-11-09T11:59:00.000Z'`;
          yield* state.due;
          assert.equal(state.launches, 3);
          const granted = yield* enabledOf("granted");
          assert.equal(granted?.enabled, 0);
          assert.isNull(granted?.next_run_at);
          assert.equal(granted?.last_run_error, ROUTINE_GRANT_REVOKED_NOTE);
          assert.equal((yield* enabledOf("owned"))?.enabled, 1);

          // A manual run is refused with the same reason.
          yield* sql`UPDATE scheduled_tasks SET enabled = 1 WHERE task_id = 'granted'`;
          const refused = yield* service
            .runNow({ id: "granted" as ScheduledTaskId })
            .pipe(Effect.flip);
          assert.include(refused.message, "revoked work");
        }),
      ).pipe(Effect.provideService(WorkGrants.WorkGrants, grants));
    }).pipe(Effect.provide(Sqlite.layerMemory)),
  );

  it.effect("turns off when the grant stops allowing routines; an owner save adopts it", () =>
    Effect.gen(function* () {
      const { state, run, sql } = yield* harness;
      yield* TestClock.setTime(Date.parse(AT));
      const grants: WorkGrants.WorkGrantsShape = {
        ...WorkGrants.WorkGrants.defaultValue(),
        enabled: true,
        policies: Effect.succeed([policy({ routines: false })]),
      };
      yield* run((service) =>
        Effect.gen(function* () {
          yield* service.upsert(taskInput({ id: "granted" }));
          yield* service.recordGrant!({
            id: "granted" as ScheduledTaskId,
            coordinatorEnvironmentId: M4,
          });
          yield* service.upsert(taskInput({ id: "adopted" }));
          yield* service.recordGrant!({
            id: "adopted" as ScheduledTaskId,
            coordinatorEnvironmentId: M4,
          });
          // The owner edits it here: it is the owner's now.
          yield* service.upsert(taskInput({ id: "adopted", prompt: "Owner's prompt" }));
          assert.isUndefined(yield* readRoutineGrant("adopted"));

          yield* sql`UPDATE scheduled_tasks SET next_run_at = '2026-11-09T11:59:00.000Z'`;
          yield* state.due;
          assert.equal(state.launches, 1);
          const rows = yield* sql<{
            task_id: string;
            enabled: number;
            last_run_error: string | null;
          }>`SELECT task_id, enabled, last_run_error FROM scheduled_tasks ORDER BY task_id`;
          assert.deepEqual(
            rows.map((row) => [row.task_id, row.enabled, row.last_run_error]),
            [
              ["adopted", 1, null],
              ["granted", 0, ROUTINE_GRANT_NO_ROUTINES_NOTE],
            ],
          );
        }),
      ).pipe(Effect.provideService(WorkGrants.WorkGrants, grants));
    }).pipe(Effect.provide(Sqlite.layerMemory)),
  );
});
