import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import {
  START,
  copilotReady,
  harness,
  insertRun,
  taskInput,
} from "./ScheduledTaskService.providerGate.testkit.ts";

const DAY = 24 * 60 * 60_000;
const AT = "2026-10-21T07:00:00.000Z";
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const COPILOT = "acpRegistry_copilot";
const watch = (id: string) =>
  taskInput({
    id,
    prompt: "PR 42 merged: verify main.",
    check: { command: "gh pr view 42 --json state", stopAfterPass: true },
  });

const rowsOf = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    id: string;
    enabled: number;
    next: string | null;
    finished: string | null;
  }>`SELECT task_id AS id, enabled, next_run_at AS next,
      json_extract(run_policy_json, '$.finishedAt') AS finished
    FROM scheduled_tasks ORDER BY task_id`;
});

/** Moves the clock to `id`'s next run and runs the due poll once. */
const fire = (poll: Effect.Effect<void>, id: string) =>
  Effect.gen(function* () {
    const row = (yield* rowsOf).find((entry) => entry.id === id)!;
    yield* TestClock.setTime(Date.parse(row.next!) + 1_000);
    yield* poll;
  });

it.effect("turns a one-shot watch off when its check passes and removes it a week after", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(watch("watch-merged"));
        assert.deepEqual(task.check, {
          command: "gh pr view 42 --json state",
          stopAfterPass: true,
        });
        // A routine paused by hand is never removed.
        yield* service.upsert(taskInput({ id: "paused-by-hand", enabled: false }));

        // A quiet check keeps watching.
        state.checkExit = 1;
        yield* fire(state.poll!, "watch-merged");
        assert.lengthOf(state.sent, 0);
        assert.equal((yield* rowsOf)[1]?.enabled, 1);

        // The check passes: the prompt goes out once and the watch turns off.
        state.checkExit = 0;
        yield* fire(state.poll!, "watch-merged");
        assert.lengthOf(state.sent, 1);
        const met = (yield* rowsOf)[1]!;
        assert.equal(met.enabled, 0);
        assert.isNull(met.next);
        // Not finished until its run succeeds.
        assert.isNull(met.finished);
        assert.isFalse((yield* service.list()).tasks.find((t) => t.id === task.id)!.enabled);

        const sentAt = yield* Clock.currentTimeMillis;
        yield* insertRun({
          runId: "run-watch",
          ordinal: 1,
          instanceId: COPILOT,
          status: "completed",
          startedAt: iso(sentAt + 60_000),
          completedAt: iso(sentAt + 300_000),
          userMessageId: state.messageIds[0]!,
        });
        yield* TestClock.setTime(sentAt + 10 * 60_000);
        yield* state.poll!;
        const finishedAt = (yield* rowsOf)[1]!.finished;
        assert.isString(finishedAt);

        // Six days on it is still listed with its last run; a week on it goes.
        yield* TestClock.setTime(Date.parse(finishedAt!) + 6 * DAY);
        yield* state.poll!;
        assert.lengthOf(yield* rowsOf, 2);
        yield* TestClock.setTime(Date.parse(finishedAt!) + 7 * DAY + 1_000);
        yield* state.poll!;
        assert.deepEqual(
          (yield* rowsOf).map((row) => row.id),
          ["paused-by-hand"],
        );
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("keeps a met watch whose run never started, and one turned back on", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(watch("watch-lost"));
        state.checkExit = 0;
        yield* fire(state.poll!, "watch-lost");
        assert.lengthOf(state.sent, 1);
        // Queued behind other work and never started: the watch is not finished.
        yield* insertRun({
          runId: "run-lost",
          ordinal: 1,
          instanceId: COPILOT,
          status: "queued",
          startedAt: null,
          completedAt: null,
          userMessageId: state.messageIds[0]!,
        });
        yield* TestClock.setTime((yield* Clock.currentTimeMillis) + 7 * 60 * 60_000);
        yield* state.poll!;
        yield* TestClock.setTime((yield* Clock.currentTimeMillis) + 9 * DAY);
        yield* state.poll!;
        const [lost] = yield* rowsOf;
        assert.equal(lost?.enabled, 0);
        assert.isNull(lost?.finished);

        // A finished watch turned back on and off by hand is kept.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE scheduled_tasks SET last_run_status = 'succeeded',
          run_policy_json = json_set(run_policy_json, '$.finishedAt', '2026-10-01T00:00:00.000Z')`;
        yield* service.setEnabled({ id: "watch-lost" as never, enabled: true });
        yield* service.setEnabled({ id: "watch-lost" as never, enabled: false });
        assert.isNull((yield* rowsOf)[0]?.finished);
        yield* TestClock.setTime((yield* Clock.currentTimeMillis) + 2 * 60 * 60_000);
        yield* state.poll!;
        assert.lengthOf(yield* rowsOf, 1);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("removes a one-time task a week after its run succeeded", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput({ id: "once-done", schedule: { type: "once", at: AT } }));
        yield* fire(state.poll!, "once-done");
        yield* insertRun({
          runId: "run-done",
          ordinal: 1,
          instanceId: COPILOT,
          status: "completed",
          startedAt: "2026-10-21T07:01:00.000Z",
          completedAt: "2026-10-21T07:05:00.000Z",
          userMessageId: state.messageIds[0]!,
        });
        yield* TestClock.setTime(Date.parse("2026-10-21T07:30:00.000Z"));
        yield* state.poll!;
        const [done] = yield* rowsOf;
        assert.equal(done?.enabled, 0);
        assert.isString(done?.finished);
        yield* TestClock.setTime(Date.parse(done!.finished!) + 6 * DAY);
        yield* state.poll!;
        assert.lengthOf(yield* rowsOf, 1);
        yield* TestClock.setTime(Date.parse(done!.finished!) + 7 * DAY + 1_000);
        yield* state.poll!;
        assert.lengthOf(yield* rowsOf, 0);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("keeps a one-time task whose run never started", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput({ id: "once-lost", schedule: { type: "once", at: AT } }));
        yield* fire(state.poll!, "once-lost");
        yield* insertRun({
          runId: "run-lost",
          ordinal: 1,
          instanceId: COPILOT,
          status: "queued",
          startedAt: null,
          completedAt: null,
          userMessageId: state.messageIds[0]!,
        });
        yield* TestClock.setTime(Date.parse(AT) + 7 * 60 * 60_000);
        yield* state.poll!;
        yield* TestClock.setTime(Date.parse(AT) + 9 * DAY);
        yield* state.poll!;
        const [lost] = yield* rowsOf;
        assert.equal(lost?.enabled, 0);
        assert.isNull(lost?.finished);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
