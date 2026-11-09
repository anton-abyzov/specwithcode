import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  type ScheduledTaskGrantedBy,
  type ScheduledTaskId,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as WorkGrants from "../fleet/WorkGrants.ts";
import type { WorkOrigin } from "../fleet/workGrantPolicy.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import {
  ROUTINE_GRANT_ACCOUNT_NOTE,
  ROUTINE_GRANT_CHECK_FAILED_NOTE,
  ROUTINE_GRANT_GONE_NOTE,
  ROUTINE_GRANT_MODE_NOTE,
  ROUTINE_GRANT_NO_ROUTINES_NOTE,
  ROUTINE_GRANT_PROJECT_NOTE,
  ROUTINE_GRANT_REVOKED_NOTE,
  readRoutineGrant,
  routineGrantRefusal,
} from "./ScheduledTaskGrantGate.ts";
import { harness, taskInput } from "./ScheduledTaskService.coordinatorGate.testkit.ts";

const M4 = "env-m4";
const AT = "2026-11-09T12:00:00.000Z";
const DUE = "2026-11-09T11:59:00.000Z";
const GRANTED_BY: ScheduledTaskGrantedBy = {
  coordinatorEnvironmentId: M4,
  runtimeCap: "full-access",
  accounts: { kind: "all" },
};

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
const task = {
  runtimeMode: "auto",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
} as Parameters<typeof routineGrantRefusal>[0]["task"];

const grantsOf = (
  current: () => WorkGrants.WorkGrantPolicyRecord,
  origins: Array<readonly [string, WorkOrigin]> = [],
): WorkGrants.WorkGrantsShape => ({
  ...WorkGrants.WorkGrants.defaultValue(),
  enabled: true,
  policies: Effect.sync(() => [current()]),
  recordOrigin: (threadId, origin) =>
    Effect.sync(() => {
      origins.push([threadId, origin]);
    }),
});

describe("routineGrantRefusal", () => {
  it("lets a routine run while its grant allows routines, its project, sign-in and mode", () => {
    assert.isNull(routineGrantRefusal({ coordinatorEnvironmentId: M4, policy: policy(), project }));
    assert.isNull(
      routineGrantRefusal({
        coordinatorEnvironmentId: M4,
        policy: policy({
          runtimeCap: "auto",
          accounts: { kind: "listed", instanceIds: [ProviderInstanceId.make("codex")] },
        }),
        project,
        task,
      }),
    );
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

  it("turns it off when the grant no longer allows its sign-in or caps runs below its mode", () => {
    const refusal = (input: Partial<Parameters<typeof routineGrantRefusal>[0]>) =>
      routineGrantRefusal({
        coordinatorEnvironmentId: M4,
        policy: policy(),
        project,
        task,
        ...input,
      });
    assert.equal(
      refusal({ policy: policy({ accounts: { kind: "none" } }) }),
      ROUTINE_GRANT_ACCOUNT_NOTE,
    );
    assert.equal(
      refusal({
        policy: policy({
          accounts: { kind: "listed", instanceIds: [ProviderInstanceId.make("claude")] },
        }),
      }),
      ROUTINE_GRANT_ACCOUNT_NOTE,
    );
    assert.equal(
      refusal({ policy: policy({ runtimeCap: "auto-accept-edits" }) }),
      ROUTINE_GRANT_MODE_NOTE,
    );
    // A policy with no cap yet falls back to the cap the routine recorded.
    assert.equal(
      refusal({ recorded: { ...GRANTED_BY, runtimeCap: "approval-required" } }),
      ROUTINE_GRANT_MODE_NOTE,
    );
    assert.isNull(refusal({ recorded: GRANTED_BY }));
  });
});

const rowOf = (id: string) =>
  Effect.gen(function* () {
    const { sql } = yield* harness;
    return yield* sql<{
      enabled: number;
      last_run_error: string | null;
      next_run_at: string | null;
    }>`SELECT enabled, last_run_error, next_run_at FROM scheduled_tasks WHERE task_id = ${id}`.pipe(
      Effect.map((rows) => rows[0]),
    );
  });

describe("a routine made under a work grant", () => {
  it.effect("records the grant in the save itself, and keeps it across later saves", () =>
    Effect.gen(function* () {
      const { run } = yield* harness;
      yield* TestClock.setTime(Date.parse(AT));
      yield* run((service) =>
        Effect.gen(function* () {
          yield* service.upsert(taskInput({ id: "granted" }), { grantedBy: GRANTED_BY });
          yield* service.upsert(taskInput({ id: "owned" }));
          assert.deepEqual(yield* readRoutineGrant("granted"), GRANTED_BY);
          assert.deepEqual(yield* service.readGrant!("granted" as ScheduledTaskId), GRANTED_BY);
          assert.isUndefined(yield* readRoutineGrant("owned"));

          // The owner edits it here: it still runs under the grant.
          yield* service.upsert(taskInput({ id: "granted", prompt: "Owner's prompt" }));
          assert.deepEqual(yield* readRoutineGrant("granted"), GRANTED_BY);
          // Turning it off and on keeps it too.
          yield* service.setEnabled({ id: "granted" as ScheduledTaskId, enabled: false });
          yield* service.setEnabled({ id: "granted" as ScheduledTaskId, enabled: true });
          assert.deepEqual(yield* readRoutineGrant("granted"), GRANTED_BY);
          // Only an explicit null clears it (a copy the coordinator sent without one).
          yield* service.upsert(taskInput({ id: "granted" }), { grantedBy: null });
          assert.isUndefined(yield* readRoutineGrant("granted"));
        }),
      ).pipe(
        Effect.provideService(
          WorkGrants.WorkGrants,
          grantsOf(() => policy()),
        ),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
  );

  it.effect("fires under the grant's origin and is turned off at the next fire after revoke", () =>
    Effect.gen(function* () {
      const { state, run, sql } = yield* harness;
      yield* TestClock.setTime(Date.parse(AT));
      const grant = { current: policy() };
      const origins: Array<readonly [string, WorkOrigin]> = [];
      yield* run((service) =>
        Effect.gen(function* () {
          yield* service.upsert(taskInput({ id: "granted" }), { grantedBy: GRANTED_BY });
          yield* service.upsert(taskInput({ id: "owned" }));

          yield* sql`UPDATE scheduled_tasks SET next_run_at = ${DUE}`;
          yield* state.due;
          assert.equal(state.launches, 2);
          assert.equal((yield* rowOf("granted"))?.enabled, 1);
          // The grant's routine starts its thread under a stable id recorded as M4's work first.
          const granted = state.launched.find((launch) => launch.threadId !== undefined);
          assert.isDefined(granted?.threadId);
          assert.include(granted!.threadId!, "thread:routine:granted:");
          assert.deepEqual(origins, [
            [
              granted!.threadId as ThreadId,
              {
                coordinatorEnvironmentId: EnvironmentId.make(M4),
                path: [EnvironmentId.make(M4)],
                hops: 1,
              },
            ],
          ]);
          // The owner's routine starts its thread as before.
          assert.equal(state.launched.filter((launch) => launch.threadId === undefined).length, 1);

          // Revoked: the next fire turns it off with the note; the owner's routine keeps running.
          grant.current = policy({ revokedAt: AT });
          yield* sql`UPDATE scheduled_tasks SET next_run_at = ${DUE}`;
          yield* state.due;
          assert.equal(state.launches, 3);
          const off = yield* rowOf("granted");
          assert.equal(off?.enabled, 0);
          assert.isNull(off?.next_run_at);
          assert.equal(off?.last_run_error, ROUTINE_GRANT_REVOKED_NOTE);
          assert.equal((yield* rowOf("owned"))?.enabled, 1);

          // A manual run is refused with the same reason.
          yield* sql`UPDATE scheduled_tasks SET enabled = 1 WHERE task_id = 'granted'`;
          const refused = yield* service
            .runNow({ id: "granted" as ScheduledTaskId })
            .pipe(Effect.flip);
          assert.include(refused.message, "revoked work");
        }),
      ).pipe(
        Effect.provideService(
          WorkGrants.WorkGrants,
          grantsOf(() => grant.current, origins),
        ),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
  );

  it.effect("turns off when the grant drops its sign-in or caps its mode lower", () =>
    Effect.gen(function* () {
      const { state, run, sql } = yield* harness;
      yield* TestClock.setTime(Date.parse(AT));
      const grant = {
        current: policy({
          accounts: { kind: "listed", instanceIds: [ProviderInstanceId.make("claude")] },
        }),
      };
      yield* run((service) =>
        Effect.gen(function* () {
          yield* service.upsert(taskInput({ id: "account" }), { grantedBy: GRANTED_BY });
          yield* sql`UPDATE scheduled_tasks SET next_run_at = ${DUE}`;
          yield* state.due;
          assert.equal(state.launches, 0);
          assert.equal((yield* rowOf("account"))?.last_run_error, ROUTINE_GRANT_ACCOUNT_NOTE);

          grant.current = policy({ runtimeCap: "auto" });
          // taskInput runs at full-access, above the cap.
          yield* service.upsert(taskInput({ id: "mode" }), { grantedBy: GRANTED_BY });
          yield* sql`UPDATE scheduled_tasks SET next_run_at = ${DUE} WHERE task_id = 'mode'`;
          yield* state.due;
          assert.equal(state.launches, 0);
          const mode = yield* rowOf("mode");
          assert.equal(mode?.enabled, 0);
          assert.equal(mode?.last_run_error, ROUTINE_GRANT_MODE_NOTE);
        }),
      ).pipe(
        Effect.provideService(
          WorkGrants.WorkGrants,
          grantsOf(() => grant.current),
        ),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
  );

  it.effect("skips a fire, without turning it off, when the grant cannot be checked", () =>
    Effect.gen(function* () {
      const { state, run, sql } = yield* harness;
      yield* TestClock.setTime(Date.parse(AT));
      const failing: WorkGrants.WorkGrantsShape = {
        ...grantsOf(() => policy()),
        policies: Effect.fail(new WorkGrants.WorkGrantsError({ reason: "storage" } as never)),
      };
      yield* run((service) =>
        Effect.gen(function* () {
          yield* service.upsert(taskInput({ id: "granted" }), { grantedBy: GRANTED_BY });
          yield* service.upsert(taskInput({ id: "owned" }));
          yield* sql`UPDATE scheduled_tasks SET next_run_at = ${DUE}`;
          yield* state.due;
          // Only the owner's routine ran.
          assert.equal(state.launches, 1);
          const skipped = yield* rowOf("granted");
          assert.equal(skipped?.enabled, 1);
          assert.isNotNull(skipped?.next_run_at);
          assert.notEqual(skipped?.next_run_at, DUE);
          assert.equal(skipped?.last_run_error, ROUTINE_GRANT_CHECK_FAILED_NOTE);
          const refused = yield* service
            .runNow({ id: "granted" as ScheduledTaskId })
            .pipe(Effect.flip);
          assert.equal(refused.message, ROUTINE_GRANT_CHECK_FAILED_NOTE);
          assert.equal(state.launches, 1);
        }),
      ).pipe(Effect.provideService(WorkGrants.WorkGrants, failing));
    }).pipe(Effect.provide(Sqlite.layerMemory)),
  );

  it.effect("turns off when the grant stops allowing routines", () =>
    Effect.gen(function* () {
      const { state, run, sql } = yield* harness;
      yield* TestClock.setTime(Date.parse(AT));
      yield* run((service) =>
        Effect.gen(function* () {
          yield* service.upsert(taskInput({ id: "granted" }), { grantedBy: GRANTED_BY });
          yield* service.upsert(taskInput({ id: "owned" }));
          yield* sql`UPDATE scheduled_tasks SET next_run_at = ${DUE}`;
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
              ["granted", 0, ROUTINE_GRANT_NO_ROUTINES_NOTE],
              ["owned", 1, null],
            ],
          );
        }),
      ).pipe(
        Effect.provideService(
          WorkGrants.WorkGrants,
          grantsOf(() => policy({ routines: false })),
        ),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
  );
});
