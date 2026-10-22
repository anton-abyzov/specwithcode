import { assert, it } from "@effect/vitest";
import { CommandId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { OrchestratorCommandPreviouslyRejectedError } from "../orchestration-v2/Orchestrator.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import {
  START,
  codexReady,
  copilotNotPrepared,
  copilotReady,
  harness,
  insertRun,
  occurrences,
  taskInput,
} from "./ScheduledTaskService.providerGate.testkit.ts";
import { nextRunAfterStuck } from "./ScheduledTaskStorage.ts";

const AT = "2026-10-21T07:00:00.000Z";
const HOUR = 60 * 60_000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const once = (at: string = AT) => taskInput({ schedule: { type: "once", at } });

it.effect("fires a one-time task once at its time, and never again", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run, fireNext, taskRow } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(once());
        assert.equal(task.nextRunAt, AT);

        yield* TestClock.setTime(Date.parse(AT) - 60_000);
        yield* state.poll!;
        assert.deepEqual(state.sent, []);

        yield* fireNext;
        assert.equal(state.sent.length, 1);
        assert.deepEqual(state.messageIds, [
          `scheduled-task-message:${task.id}:${task.createdAt}:${AT}:scheduled`,
        ]);
        const fired = yield* taskRow;
        assert.isNull(fired.next_run_at);
        assert.equal(fired.last_run_status, "succeeded");
        assert.equal(fired.run_count, 1);

        // The next day, unlike a daily fixed_time task, it does not fire again.
        yield* TestClock.setTime(Date.parse(AT) + 24 * HOUR);
        yield* state.poll!;
        yield* state.poll!;
        assert.equal(state.sent.length, 1);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("fires a late one-time task once on the next poll instead of dropping it", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run, taskRow } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(once());
        // The host was asleep for three hours past the slot, far beyond the
        // grace that skips a missed fixed_time run.
        yield* TestClock.setTime(Date.parse(AT) + 3 * HOUR);
        yield* state.poll!;
        assert.equal(state.sent.length, 1);
        assert.isNull((yield* taskRow).next_run_at);
        yield* state.poll!;
        assert.equal(state.sent.length, 1);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("turns a one-time task off only once its run has started", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run, fireNext, taskRow } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(once());
        yield* fireNext;
        assert.equal((yield* taskRow).enabled, 1);

        // Queued behind other work: posted, not started.
        const queued = {
          runId: "run-once",
          ordinal: 1,
          instanceId: "acpRegistry_copilot",
          completedAt: null,
          userMessageId: state.messageIds[0]!,
        };
        yield* insertRun({ ...queued, status: "queued", startedAt: null });
        yield* state.poll!;
        assert.equal((yield* taskRow).enabled, 1);

        yield* insertRun({ ...queued, status: "running", startedAt: "2026-10-21T07:02:00.000Z" });
        yield* state.poll!;
        const started = yield* taskRow;
        assert.equal(started.enabled, 0);
        assert.isNull(started.next_run_at);
        assert.isFalse((yield* service.list()).tasks[0]!.enabled);
        assert.equal(state.sent.length, 1);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("keeps a one-time task that waits for its provider, then fires that same run once", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run, fireNext, taskRow, failRunOnCopilot } = yield* harness([
      copilotNotPrepared,
      codexReady,
    ]);
    yield* failRunOnCopilot("2026-10-21T06:45:00.000Z");
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(once());
        yield* fireNext;
        assert.deepEqual(state.sent, []);
        const deferred = yield* taskRow;
        assert.equal(deferred.enabled, 1);
        assert.equal(deferred.run_count, 0);
        assert.isNotNull(deferred.next_run_at);
        assert.isAbove(Date.parse(deferred.next_run_at!), Date.parse(AT));
        assert.match(deferred.last_run_error ?? "", /^Deferred until /);

        state.providers = [{ ...copilotReady, checkedAt: "2026-10-21T07:30:00.000Z" }, codexReady];
        yield* fireNext;
        assert.equal(state.sent.length, 1);
        assert.deepEqual(state.messageIds, [
          `scheduled-task-message:${task.id}:${task.createdAt}:${AT}:scheduled`,
        ]);
        const fired = yield* taskRow;
        assert.isNull(fired.next_run_at);
        assert.equal(fired.enabled, 1);

        yield* TestClock.setTime(Date.parse(AT) + 24 * HOUR);
        yield* state.poll!;
        assert.equal(state.sent.length, 1);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("tries a one-time task whose post failed again later, under the same fire key", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run, fireNext, taskRow } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(once());
        state.failSends = 1;
        yield* fireNext;
        assert.deepEqual(state.sent, []);
        const failed = yield* taskRow;
        assert.equal(failed.enabled, 1);
        assert.equal(failed.last_run_status, "failed");
        assert.equal(failed.next_run_at, "2026-10-21T07:15:01.000Z");
        assert.match(failed.last_run_error ?? "", /^Trying again at 2026-10-21T07:15:01.000Z: /);

        yield* fireNext;
        assert.deepEqual(state.messageIds, [
          `scheduled-task-message:${task.id}:${task.createdAt}:${AT}:scheduled`,
        ]);
        assert.isNull((yield* taskRow).next_run_at);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("leaves a one-time task's own run in place when it is run by hand", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run, fireNext, taskRow } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(once());
        yield* service.runNow({ id: task.id });
        assert.equal(state.sent.length, 1);
        assert.equal((yield* taskRow).next_run_at, AT);

        yield* fireNext;
        assert.equal(state.sent.length, 2);
        assert.isNull((yield* taskRow).next_run_at);

        // A run by hand after it fired does not arm it again.
        yield* service.runNow({ id: task.id });
        yield* TestClock.setTime(Date.parse(AT) + HOUR);
        yield* state.poll!;
        assert.equal(state.sent.length, 3);
        assert.isNull((yield* taskRow).next_run_at);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("turns off, and says so, a one-time task whose fire left no run to follow", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const sql = yield* SqlClient.SqlClient;
    const { state, run, fireNext, taskRow } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(once());
        yield* fireNext;
        assert.equal(state.sent.length, 1);
        // The fire's occurrence was never recorded, so nothing follows its run.
        yield* sql`DELETE FROM scheduled_task_run_receipts WHERE command_id LIKE 'scheduled-occurrence:%'`;
        yield* state.poll!;
        const retired = yield* taskRow;
        assert.equal(retired.enabled, 0);
        assert.isNull(retired.next_run_at);
        assert.equal(retired.last_run_status, "failed");
        assert.match(retired.last_run_error ?? "", /^It did not run: .* Turned off; turn it on/);
        assert.isFalse((yield* service.list()).tasks[0]!.enabled);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("leaves a one-time task whose run succeeded reporting that success", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run, fireNext, taskRow } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(once());
        yield* fireNext;
        yield* insertRun({
          runId: "run-once",
          ordinal: 1,
          instanceId: "acpRegistry_copilot",
          status: "completed",
          startedAt: "2026-10-21T07:01:00.000Z",
          completedAt: "2026-10-21T07:05:00.000Z",
          userMessageId: state.messageIds[0]!,
        });
        yield* state.poll!;
        yield* TestClock.setTime(Date.parse(AT) + 3 * 24 * HOUR);
        yield* state.poll!;
        const done = yield* taskRow;
        assert.equal(done.enabled, 0);
        assert.equal(done.last_run_status, "succeeded");
        assert.isNull(done.last_run_error);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("fires a one-time task moved to a new time under a new key, not its old retry", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run, fireNext, taskRow } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(once());
        state.failSends = 1;
        yield* fireNext;
        assert.match((yield* taskRow).last_run_error ?? "", /^Trying again at /);

        // Moved to a later time while its failed post waits to be tried again.
        const later = "2026-10-21T09:00:00.000Z";
        yield* service.upsert({ ...once(later), id: task.id });
        assert.equal((yield* taskRow).next_run_at, later);
        yield* fireNext;
        assert.deepEqual(state.messageIds, [
          `scheduled-task-message:${task.id}:${task.createdAt}:${later}:g1:scheduled`,
        ]);
        const states = (yield* occurrences).map((occurrence) => occurrence.state);
        assert.sameMembers(states, ["failed", "dispatched"]);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("fires a one-time task turned off and on again under a new key", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run, fireNext } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(once());
        state.failSends = 1;
        yield* fireNext;
        yield* service.setEnabled({ id: task.id, enabled: false });
        yield* service.setEnabled({ id: task.id, enabled: true });
        yield* fireNext;
        assert.deepEqual(state.messageIds, [
          `scheduled-task-message:${task.id}:${task.createdAt}:${AT}:g2:scheduled`,
        ]);

        // Turned on once more after it fired: a third arming, a third key.
        yield* service.setEnabled({ id: task.id, enabled: false });
        yield* service.setEnabled({ id: task.id, enabled: true });
        yield* fireNext;
        assert.equal(state.messageIds.length, 2);
        assert.match(state.messageIds[1]!, /:g4:scheduled$/);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("backs a one-time run cut off by a restart off, then fires it under its own key", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const sql = yield* SqlClient.SqlClient;
    const { state, run, taskRow } = yield* harness([copilotReady]);
    const { task } = yield* run((service) => service.upsert(once()));
    const cutOffAt = Date.parse(AT) + 1_000;
    yield* TestClock.setTime(cutOffAt);
    yield* sql`UPDATE scheduled_tasks
      SET last_run_status = 'running', last_run_at = ${iso(cutOffAt)}`;

    // The server restarts.
    yield* run(() =>
      Effect.gen(function* () {
        const recovered = yield* taskRow;
        assert.equal(recovered.last_run_status, "failed");
        assert.equal(recovered.next_run_at, iso(cutOffAt + 15 * 60_000));
        yield* state.poll!;
        assert.deepEqual(state.sent, []);

        yield* TestClock.setTime(cutOffAt + 15 * 60_000 + 1_000);
        yield* state.poll!;
        assert.deepEqual(state.messageIds, [
          `scheduled-task-message:${task.id}:${task.createdAt}:${AT}:scheduled`,
        ]);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it("backs off only a one-time slot that is already due after a stuck run", () => {
  const now = DateTime.makeUnsafe(Date.parse(AT) + HOUR);
  const backoff = 15 * 60_000;
  const due = { enabled: true, schedule: { type: "once", at: AT }, nextRunAt: AT } as const;
  assert.equal(
    nextRunAfterStuck(due, now, backoff),
    iso(Date.parse(AT) + HOUR + backoff),
  );
  const ahead = "2026-10-22T07:00:00.000Z";
  assert.equal(nextRunAfterStuck({ ...due, nextRunAt: ahead }, now, backoff), ahead);
  assert.isNull(nextRunAfterStuck({ ...due, enabled: false }, now, backoff));
  assert.equal(
    nextRunAfterStuck(
      { enabled: true, schedule: { type: "interval", everyMs: HOUR }, nextRunAt: AT },
      now,
      backoff,
    ),
    iso(Date.parse(AT) + 2 * HOUR),
  );
});

it.effect("turns a one-time task off after its post fails a few times", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run, fireNext, taskRow } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(once());
        state.failSends = 10;
        yield* fireNext;
        yield* fireNext;
        assert.equal((yield* taskRow).enabled, 1);
        yield* fireNext;
        const gaveUp = yield* taskRow;
        assert.equal(gaveUp.enabled, 0);
        assert.isNull(gaveUp.next_run_at);
        assert.match(gaveUp.last_run_error ?? "", /Turned off; turn it on to try again\.$/);
        assert.equal(state.failSends, 7);

        yield* TestClock.setTime(Date.parse(AT) + 24 * HOUR);
        yield* state.poll!;
        assert.equal(state.failSends, 7);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("turns a one-time task off at once when its post was rejected before", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run, fireNext, taskRow } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(once());
        state.failSends = 10;
        state.failSendsWith = new OrchestratorCommandPreviouslyRejectedError({
          commandId: CommandId.make("scheduled-task:rejected"),
          commandType: "message.dispatch",
          detail: "The thread was archived.",
        });
        yield* fireNext;
        const rejected = yield* taskRow;
        assert.equal(rejected.enabled, 0);
        assert.isNull(rejected.next_run_at);
        assert.equal(rejected.last_run_status, "failed");
        assert.match(rejected.last_run_error ?? "", /previously rejected/);
        assert.match(rejected.last_run_error ?? "", /Turned off; turn it on to try again\.$/);
        assert.equal(state.failSends, 9);

        yield* TestClock.setTime(Date.parse(AT) + HOUR);
        yield* state.poll!;
        assert.equal(state.failSends, 9);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("keeps a due one-time task of a paused project as it is, then fires it once", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run, fireNext, taskRow } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(once());
        state.projectState = "paused";
        yield* fireNext;
        assert.deepEqual(state.sent, []);
        const waiting = yield* taskRow;
        assert.equal(waiting.next_run_at, AT);

        // Not written again however many polls find it due.
        yield* TestClock.adjust("1 minute");
        yield* state.poll!;
        yield* TestClock.adjust("1 hour");
        yield* state.poll!;
        const still = yield* taskRow;
        assert.equal(still.updated_at, waiting.updated_at);
        assert.equal(still.next_run_at, AT);
        assert.equal(still.enabled, 1);

        state.projectState = "active";
        yield* state.poll!;
        assert.deepEqual(state.messageIds, [
          `scheduled-task-message:${task.id}:${task.createdAt}:${AT}:scheduled`,
        ]);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("keeps a one-time task whose fire was cut off before it posted, up to a few tries", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run, fireNext, taskRow } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(once());
        // The app quits while the post is on its way: the fire is interrupted.
        const cutOff = Effect.gen(function* () {
          const hungBefore = state.hungSends;
          state.hangSends = true;
          const fiber = yield* Effect.forkChild(fireNext);
          for (let spins = 0; state.hungSends === hungBefore && spins < 10_000; spins++)
            yield* Effect.yieldNow;
          assert.equal(state.hungSends, hungBefore + 1);
          yield* Fiber.interrupt(fiber);
          state.hangSends = false;
          return yield* taskRow;
        });
        const first = yield* cutOff;
        assert.equal(first.enabled, 1);
        assert.equal(first.last_run_status, "failed");
        assert.equal(first.next_run_at, iso(Date.parse(AT) + 1_000 + 15 * 60_000));

        // Its next try posts the same occurrence.
        yield* fireNext;
        assert.deepEqual(state.messageIds, [
          `scheduled-task-message:${task.id}:${task.createdAt}:${AT}:scheduled`,
        ]);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("turns a one-time task off after its fire is cut off a few times", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run, fireNext, taskRow } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(once());
        state.hangSends = true;
        const rows = [];
        for (let attempt = 1; attempt <= 3; attempt++) {
          const fiber = yield* Effect.forkChild(fireNext);
          for (let spins = 0; state.hungSends < attempt && spins < 10_000; spins++)
            yield* Effect.yieldNow;
          assert.equal(state.hungSends, attempt);
          yield* Fiber.interrupt(fiber);
          rows.push(yield* taskRow);
        }
        assert.deepEqual(
          rows.map((row) => row.enabled),
          [1, 1, 0],
        );
        assert.isNull(rows[2]!.next_run_at);
        assert.match(rows[2]!.last_run_error ?? "", /Turned off; turn it on to try again\.$/);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
