import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Preparation from "./ServiceUpdatePreparation.ts";

/** The columns update.py and this service read, nothing else. */
const schema = [
  `CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, thread_id TEXT, status TEXT, provider_thread_id TEXT)`,
  `CREATE TABLE orchestration_v2_projection_runtime_requests (thread_id TEXT, status TEXT)`,
  `CREATE TABLE orchestration_v2_effect_outbox (thread_id TEXT, status TEXT)`,
  `CREATE TABLE orchestration_v2_projection_provider_sessions (thread_id TEXT, status TEXT)`,
  `CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, title TEXT, project_id TEXT)`,
  `CREATE TABLE projection_projects (project_id TEXT, title TEXT)`,
  `CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, provider_session_id TEXT)`,
  `CREATE TABLE orchestration_v2_projection_provider_turns (provider_thread_id TEXT, provider_turn_id TEXT, ordinal INTEGER)`,
];

const fast = { interruptGraceMs: 40, settleMs: 40, pollMs: 5 };

interface Fixture {
  readonly dispatched: Array<{ type: string; threadId?: string; runId?: string }>;
  readonly released: Array<string>;
  releasedIdle: number;
  /** What an interrupt does in the fixture: end the run (a provider that answers), or nothing (hung). */
  stopEndsRun: boolean;
  /** Runs the orchestrator refuses to interrupt (no provider thread yet). */
  readonly uninterruptible?: ReadonlySet<string>;
  /** Interrupting this run wakes its coordinator: a new queued run on `t2`. */
  readonly wakesCoordinator?: string;
}

const run = <E>(
  fixture: Fixture,
  body: Effect.Effect<void, E, SqlClient.SqlClient | Preparation.ServiceUpdatePreparation>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of schema) yield* sql.unsafe(statement);
    yield* sql`INSERT INTO projection_projects VALUES ('p1', 'EasyChamp')`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('t1', 'Fix login', 'p1'), ('t2', 'Docs', 'p1')`;
    const mocks = Layer.mergeAll(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        dispatch: (command) =>
          Effect.gen(function* () {
            fixture.dispatched.push({
              type: command.type,
              ...("threadId" in command ? { threadId: command.threadId } : {}),
              ...("runId" in command ? { runId: command.runId } : {}),
            });
            if (command.type === "run.interrupt") {
              if (fixture.uninterruptible?.has(command.runId))
                return yield* Effect.die(new Error(`Run ${command.runId} is not interruptible.`));
              if (fixture.stopEndsRun)
                yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'interrupted'
                  WHERE run_id = ${command.runId}`;
              if (command.runId === fixture.wakesCoordinator)
                yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('wake', 't2', 'queued', NULL)`;
            }
            if (command.type === "thread.stop" && fixture.stopEndsRun) {
              yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'interrupted'
                WHERE thread_id = ${command.threadId} AND status <> 'queued'`;
              yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status = 'cancelled'
                WHERE thread_id = ${command.threadId}`;
            }
            if (command.type === "queued-run.cancel") {
              yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'cancelled' WHERE run_id = ${command.runId}`;
            }
            if (command.type === "thread.background-work.settle") {
              yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'interrupted'
                WHERE thread_id = ${command.threadId} AND status = 'running'`;
            }
          }).pipe(Effect.orDie) as never,
      }),
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        release: (input) =>
          Effect.sync(() => {
            fixture.released.push(input.providerSessionId);
          }) as never,
        releaseIdle: () =>
          sql`UPDATE orchestration_v2_projection_provider_sessions SET status = 'stopped'`.pipe(
            Effect.orDie,
            Effect.as(1),
            Effect.tap(() =>
              Effect.sync(() => {
                fixture.releasedIdle += 1;
              }),
            ),
          ),
      }),
    );
    yield* body.pipe(
      Effect.provide(
        Layer.effect(Preparation.ServiceUpdatePreparation, Preparation.makeWithTimings(fast)).pipe(
          Layer.provide(mocks),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

const newFixture = (stopEndsRun: boolean, extra: Partial<Fixture> = {}): Fixture => ({
  dispatched: [],
  released: [],
  releasedIdle: 0,
  stopEndsRun,
  ...extra,
});

describe("summarizeBlockers", () => {
  it("groups by thread and kind, running work first", () => {
    const rows: Array<Preparation.BlockerRow> = [
      { kind: "effect", threadId: null, threadTitle: null, projectId: null, projectTitle: null },
      {
        kind: "queued",
        threadId: "t1",
        threadTitle: "Fix login",
        projectId: "p1",
        projectTitle: "EasyChamp",
      },
      {
        kind: "queued",
        threadId: "t1",
        threadTitle: "Fix login",
        projectId: "p1",
        projectTitle: "EasyChamp",
      },
      {
        kind: "run",
        threadId: "t2",
        threadTitle: "Docs",
        projectId: "p1",
        projectTitle: "EasyChamp",
      },
    ];
    expect(
      Preparation.summarizeBlockers(rows).map((row) => [row.kind, row.count, row.threadTitle]),
    ).toEqual([
      ["run", 1, "Docs"],
      ["queued", 2, "Fix login"],
      ["effect", 1, null],
    ]);
  });
});

it.live(
  "cancels queued messages, interrupts running work and closes idle agents before reporting idle",
  () => {
    const fixture = newFixture(true);
    return run(
      fixture,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES
        ('r1', 't1', 'running', 'pt1'), ('r2', 't1', 'queued', NULL), ('r3', 't2', 'completed', NULL)`;
        yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions VALUES ('t2', 'running')`;
        const preparation = yield* Preparation.ServiceUpdatePreparation;

        // Looking only reports, by thread and project.
        const before = yield* preparation.prepare({ stopWork: false });
        assert.isFalse(before.idle);
        assert.deepEqual(
          before.blockers.map((blocker) => [
            blocker.kind,
            blocker.count,
            blocker.threadTitle,
            blocker.projectTitle,
          ]),
          [
            ["run", 1, "Fix login", "EasyChamp"],
            ["queued", 1, "Fix login", "EasyChamp"],
            ["session", 1, "Docs", "EasyChamp"],
          ],
        );
        assert.deepEqual(fixture.dispatched, []);

        const result = yield* preparation.prepare({ stopWork: true });
        assert.deepEqual(result, { idle: true, stoppedThreads: 1, blockers: [] });
        // The queue goes first so the interrupt does not start it, and a plain
        // interrupt keeps the thread's pull request watches; Stop is not used.
        assert.deepEqual(fixture.dispatched, [
          { type: "queued-run.cancel", threadId: "t1", runId: "r2" },
          { type: "run.interrupt", threadId: "t1", runId: "r1" },
        ]);
        // Stop was answered, so nothing was forced.
        assert.deepEqual(fixture.released, []);
        assert.equal(fixture.releasedIdle, 1);
      }),
    );
  },
);

it.live("ends a turn whose provider never answers the interrupt", () => {
  const fixture = newFixture(false);
  return run(
    fixture,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 't1', 'running', 'pt1')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads VALUES ('pt1', 'session-1')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_turns VALUES ('pt1', 'turn-1', 1), ('pt1', 'turn-2', 2)`;
      const preparation = yield* Preparation.ServiceUpdatePreparation;
      const result = yield* preparation.prepare({ stopWork: true });
      assert.isTrue(result.idle);
      assert.deepEqual(fixture.released, ["session-1"]);
      assert.deepEqual(
        fixture.dispatched.map((command) => command.type),
        ["run.interrupt", "thread.background-work.settle"],
      );
    }),
  );
});

it.live("names what is left when work will not stop", () => {
  const fixture = newFixture(false);
  return run(
    fixture,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // An effect the outbox has not finished, and a run with no provider turn to settle.
      yield* sql`INSERT INTO orchestration_v2_effect_outbox VALUES ('t2', 'pending'), (NULL, NULL), ('t2', 'succeeded')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 't1', 'starting', NULL)`;
      const preparation = yield* Preparation.ServiceUpdatePreparation;
      const result = yield* preparation.prepare({ stopWork: true });
      assert.isFalse(result.idle);
      assert.deepEqual(
        result.blockers.map((blocker) => [blocker.kind, blocker.count, blocker.threadTitle]),
        [
          ["run", 1, "Fix login"],
          ["effect", 1, null],
          ["effect", 1, "Docs"],
        ],
      );
    }),
  );
});

it.live("stops the coordinator turn an interrupted worker wakes", () => {
  const fixture = newFixture(true, { wakesCoordinator: "r1" });
  return run(
    fixture,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 't1', 'running', 'pt1')`;
      const preparation = yield* Preparation.ServiceUpdatePreparation;
      const result = yield* preparation.prepare({ stopWork: true });
      assert.deepEqual(result, { idle: true, stoppedThreads: 2, blockers: [] });
      assert.deepEqual(fixture.dispatched, [
        { type: "run.interrupt", threadId: "t1", runId: "r1" },
        { type: "queued-run.cancel", threadId: "t2", runId: "wake" },
      ]);
    }),
  );
});

it.live("falls back to Stop for a run it cannot interrupt and for a request left alone", () => {
  const fixture = newFixture(true, { uninterruptible: new Set(["r1"]) });
  return run(
    fixture,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 't1', 'preparing', NULL)`;
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('t2', 'pending')`;
      const preparation = yield* Preparation.ServiceUpdatePreparation;
      const result = yield* preparation.prepare({ stopWork: true });
      assert.deepEqual(result, { idle: true, stoppedThreads: 2, blockers: [] });
      assert.deepEqual(fixture.dispatched, [
        { type: "run.interrupt", threadId: "t1", runId: "r1" },
        { type: "thread.stop", threadId: "t1" },
        { type: "thread.stop", threadId: "t2" },
      ]);
    }),
  );
});
