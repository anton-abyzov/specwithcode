import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { RuntimeRequestId, ThreadId } from "@specweave-studio/contracts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import { ifIdleRestart } from "../cli/update.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as Cleanup from "./ServiceUpdateCleanup.ts";
import * as Hold from "./ServiceUpdateHold.ts";
import * as Preparation from "./ServiceUpdatePreparation.ts";

/** The columns update.py and this service read, nothing else. */
const schema = [
  `CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, thread_id TEXT, status TEXT, provider_thread_id TEXT, payload_json TEXT)`,
  `CREATE TABLE orchestration_v2_projection_runtime_requests (thread_id TEXT, status TEXT, kind TEXT DEFAULT 'command')`,
  `CREATE TABLE orchestration_v2_effect_outbox (thread_id TEXT, status TEXT, command_id TEXT, effect_type TEXT)`,
  `CREATE TABLE orchestration_v2_projection_provider_sessions (thread_id TEXT, status TEXT)`,
  `CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, title TEXT, project_id TEXT)`,
  `CREATE TABLE projection_projects (project_id TEXT, title TEXT)`,
  `CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, provider_session_id TEXT)`,
  `CREATE TABLE orchestration_v2_projection_provider_turns (provider_thread_id TEXT, provider_turn_id TEXT, ordinal INTEGER, run_attempt_id TEXT)`,
];

const fast: Preparation.ServiceUpdatePreparationTimings = {
  interruptGraceMs: 40,
  settleMs: 40,
  effectGraceMs: 40,
  deadlineMs: 5_000,
  pollMs: 5,
};

interface Fixture {
  readonly dispatched: Array<{
    type: string;
    threadId?: string;
    runId?: string;
    requestId?: string;
  }>;
  readonly released: Array<string>;
  releasedIdle: number;
  /** Whether each forced release kept MCP credentials for the restarted server. */
  readonly releasedIdleKeptMcp: Array<boolean>;
  readonly releasedIdleEndedStreams: Array<boolean>;
  readonly releasedKeptMcp: Array<boolean>;
  /** What an interrupt does in the fixture: end the run (a provider that answers), or nothing (hung). */
  stopEndsRun: boolean;
  /** Runs the orchestrator refuses to interrupt (no provider thread yet). */
  readonly uninterruptible?: ReadonlySet<string>;
  /** Interrupting this run wakes its coordinator: a new queued run on `t2`. */
  readonly wakesCoordinator?: string;
  /** The cleanup writes nothing: what Stop leaves stays. */
  readonly cleanupStuck?: boolean;
  /** Questions asked as a plain message, for the dismiss step. */
  readonly messageModeRequests?: ReadonlyArray<{ threadId: string; requestId: string }>;
  readonly cleanupCalls: Array<string>;
  /** Whether the hold was on when the drain sent its first command. */
  heldAtFirstDispatch?: boolean;
  readonly hold?: Hold.ServiceUpdateHoldShape;
  readonly terminals?: { open: number };
  /** How long closing one agent process takes (a hung CLI). */
  readonly releaseDelayMs?: number;
  /** Runs still `waiting` on their checkpoint when the cleanup ended stuck runs. */
  waitingAtFinalize?: number;
  readonly timings?: Preparation.ServiceUpdatePreparationTimings;
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
            if (fixture.dispatched.length === 0 && fixture.hold !== undefined)
              fixture.heldAtFirstDispatch = yield* fixture.hold.isHeld;
            fixture.dispatched.push({
              type: command.type,
              ...("threadId" in command ? { threadId: command.threadId } : {}),
              ...("runId" in command ? { runId: command.runId } : {}),
              ...(command.type === "checkpoint.rollback.fail"
                ? { requestId: command.requestId }
                : {}),
            });
            if (command.type === "run.interrupt") {
              if (fixture.uninterruptible?.has(command.runId))
                return yield* Effect.die(new Error(`Run ${command.runId} is not interruptible.`));
              if (fixture.stopEndsRun)
                yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'interrupted'
                  WHERE run_id = ${command.runId}`;
              if (command.runId === fixture.wakesCoordinator)
                yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES ('wake', 't2', 'queued', NULL)`;
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
          Effect.sleep(Duration.millis(fixture.releaseDelayMs ?? 0)).pipe(
            Effect.andThen(
              Effect.sync(() => {
                fixture.released.push(input.providerSessionId);
                fixture.releasedKeptMcp.push(input.keepMcpCredentials === true);
              }),
            ),
          ) as never,
        releaseIdle: (input) =>
          sql`UPDATE orchestration_v2_projection_provider_sessions SET status = 'stopped'`.pipe(
            Effect.orDie,
            Effect.as(1),
            Effect.tap(() =>
              Effect.sync(() => {
                fixture.releasedIdle += 1;
                fixture.releasedIdleKeptMcp.push(input.keepMcpCredentials === true);
                fixture.releasedIdleEndedStreams.push(input.endStreams === true);
              }),
            ),
          ),
      }),
      Layer.mock(Cleanup.ServiceUpdateCleanup)({
        finalizeStuckRuns: () =>
          Effect.gen(function* () {
            fixture.cleanupCalls.push("finalize");
            const waiting = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs WHERE status = 'waiting'`;
            fixture.waitingAtFinalize = Number(waiting[0]?.count ?? 0);
            if (fixture.cleanupStuck) return { interrupted: 0, completed: 0 };
            yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE status = 'waiting'`;
            yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'interrupted'
              WHERE status IN ('preparing', 'starting', 'running')`;
            return { interrupted: 0, completed: 0 };
          }).pipe(Effect.orDie),
        listMessageModeRequests: Effect.sync(() =>
          (fixture.messageModeRequests ?? []).map((request) => ({
            threadId: ThreadId.make(request.threadId),
            requestId: RuntimeRequestId.make(request.requestId),
          })),
        ),
        cancelPendingRequests: () =>
          Effect.gen(function* () {
            fixture.cleanupCalls.push("requests");
            if (!fixture.cleanupStuck)
              yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status = 'cancelled'
                WHERE status = 'pending'`;
            return 0;
          }).pipe(Effect.orDie),
        reconcileOrphanedSessions: Effect.sync(() => {
          fixture.cleanupCalls.push("sessions");
          return 0;
        }),
        cancelUnsettledEffects: () =>
          Effect.gen(function* () {
            fixture.cleanupCalls.push("effects");
            if (fixture.cleanupStuck) return [];
            // As the outbox does: a running rollback or checkpoint is left to finish.
            const rows = yield* sql<{
              readonly effect_type: string;
              readonly command_id: string;
              readonly thread_id: string;
            }>`UPDATE orchestration_v2_effect_outbox SET status = 'cancelled'
                WHERE (status IS NULL OR status NOT IN ('succeeded', 'failed', 'cancelled'))
                  AND NOT (status = 'running'
                    AND effect_type IN ('provider-thread.rollback', 'checkpoint.capture'))
                RETURNING effect_type, command_id, thread_id`;
            return rows.map((row) => ({
              effectId: `effect:${row.command_id}`,
              effectType: row.effect_type,
              commandId: row.command_id,
              threadId: row.thread_id,
            }));
          }).pipe(Effect.orDie),
      }),
    );
    const optional = Layer.mergeAll(
      fixture.hold === undefined
        ? Layer.empty
        : Layer.succeed(Hold.ServiceUpdateHold, fixture.hold),
      fixture.terminals === undefined
        ? Layer.empty
        : Layer.mock(TerminalManager.TerminalManager)({
            closeAll: Effect.sync(() => {
              const terminals = fixture.terminals!;
              const closed = terminals.open;
              terminals.open = 0;
              fixture.cleanupCalls.push("terminals");
              return closed;
            }),
            countOpen: Effect.sync(() => fixture.terminals!.open),
          }),
    );
    yield* body.pipe(
      Effect.provide(
        Layer.effect(
          Preparation.ServiceUpdatePreparation,
          Preparation.makeWithTimings(fixture.timings ?? fast),
        ).pipe(Layer.provide(Layer.merge(mocks, optional))),
      ),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

const newFixture = (stopEndsRun: boolean, extra: Partial<Fixture> = {}): Fixture => ({
  dispatched: [],
  released: [],
  releasedIdle: 0,
  releasedIdleKeptMcp: [],
  releasedIdleEndedStreams: [],
  releasedKeptMcp: [],
  cleanupCalls: [],
  stopEndsRun,
  ...extra,
});

// October 23, 2026: closing a session whose turn start was still in flight
// failed the start, and a failed run is never continued after the update.
describe("isStartInFlight", () => {
  it("waits for a turn its provider has not reported yet, not for one it has", () => {
    expect(
      [
        { status: "preparing", turnStarted: false },
        { status: "starting", turnStarted: false },
        { status: "running", turnStarted: false },
        { status: "running", turnStarted: true },
        { status: "waiting", turnStarted: false },
      ].map(Preparation.isStartInFlight),
    ).toEqual([true, true, true, false, false]);
  });
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
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES
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
        assert.deepEqual(result, {
          idle: true,
          stoppedThreads: 1,
          blockers: [],
          held: false,
          interruptedRuns: 1,
          openTerminals: 0,
        });
        // The queue goes first so the interrupt does not start it, and a plain
        // interrupt keeps the thread's pull request watches; Stop is not used.
        assert.deepEqual(fixture.dispatched, [
          { type: "queued-run.cancel", threadId: "t1", runId: "r2" },
          { type: "run.interrupt", threadId: "t1", runId: "r1" },
        ]);
        // Stop was answered, so nothing was forced.
        assert.deepEqual(fixture.released, []);
        assert.equal(fixture.releasedIdle, 1);
        // Agents' MCP credentials outlive the update restart.
        assert.deepEqual(fixture.releasedIdleKeptMcp, [true]);
        // A turn the release cuts ends rather than fails, so it is stopped for the
        // update and continued after the restart instead of shown as failed.
        assert.deepEqual(fixture.releasedIdleEndedStreams, [true]);
      }),
    );
  },
);

it.live("leaves a held queue in place: it is not work the update waits for", () => {
  const fixture = newFixture(true);
  return run(
    fixture,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // A restart held this worker's handoffs; only someone's Resume starts them.
      yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES
        ('h1', 't1', 'queued', NULL, '{"status":"queued","queueHeld":true}'),
        ('h2', 't1', 'queued', NULL, '{"status":"queued","queueHeld":true}'),
        ('q1', 't2', 'queued', NULL, '{"status":"queued","queueHeld":false}')`;
      const preparation = yield* Preparation.ServiceUpdatePreparation;
      const before = yield* preparation.prepare({ stopWork: false });
      assert.deepEqual(
        before.blockers.map((blocker) => [blocker.kind, blocker.count, blocker.threadTitle]),
        [["queued", 1, "Docs"]],
      );
      const result = yield* preparation.prepare({ stopWork: true });
      assert.isTrue(result.idle);
      // Only the waiting message is cancelled (and queued again after the restart);
      // the held ones stay held, in order, for the person to resume or discard.
      assert.deepEqual(fixture.dispatched, [
        { type: "queued-run.cancel", threadId: "t2", runId: "q1" },
      ]);
      const left = yield* sql<{ run_id: string; status: string }>`
        SELECT run_id, status FROM orchestration_v2_projection_runs ORDER BY run_id`;
      assert.deepEqual(
        left.map((row) => [row.run_id, row.status]),
        [
          ["h1", "queued"],
          ["h2", "queued"],
          ["q1", "cancelled"],
        ],
      );
    }),
  );
});

it.live("ends a turn whose provider never answers the interrupt", () => {
  const fixture = newFixture(false);
  return run(
    fixture,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES ('r1', 't1', 'running', 'pt1')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads VALUES ('pt1', 'session-1')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_turns VALUES ('pt1', 'turn-1', 1, NULL), ('pt1', 'turn-2', 2, NULL)`;
      const preparation = yield* Preparation.ServiceUpdatePreparation;
      const result = yield* preparation.prepare({ stopWork: true });
      assert.isTrue(result.idle);
      assert.deepEqual(fixture.released, ["session-1"]);
      assert.deepEqual(fixture.releasedKeptMcp, [true]);
      assert.deepEqual(
        fixture.dispatched.map((command) => command.type),
        ["run.interrupt", "thread.background-work.settle"],
      );
    }),
  );
});

it.live("names what is left when work will not stop", () => {
  const fixture = newFixture(false, { cleanupStuck: true });
  return run(
    fixture,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // An effect the outbox has not finished, and a run with no provider turn to settle.
      yield* sql`INSERT INTO orchestration_v2_effect_outbox (thread_id, status)
        VALUES ('t2', 'pending'), (NULL, NULL), ('t2', 'succeeded')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES ('r1', 't1', 'starting', NULL)`;
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
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES ('r1', 't1', 'running', 'pt1')`;
      const preparation = yield* Preparation.ServiceUpdatePreparation;
      const result = yield* preparation.prepare({ stopWork: true });
      assert.deepEqual(result, {
        idle: true,
        stoppedThreads: 2,
        blockers: [],
        held: false,
        interruptedRuns: 1,
        openTerminals: 0,
      });
      assert.deepEqual(fixture.dispatched, [
        { type: "run.interrupt", threadId: "t1", runId: "r1" },
        { type: "queued-run.cancel", threadId: "t2", runId: "wake" },
      ]);
    }),
  );
});

it.live(
  "falls back to Stop for a run it cannot interrupt, and closes a lone request without Stop",
  () => {
    const fixture = newFixture(true, { uninterruptible: new Set(["r1"]) });
    return run(
      fixture,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES ('r1', 't1', 'preparing', NULL)`;
        yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests (thread_id, status) VALUES ('t2', 'pending')`;
        const preparation = yield* Preparation.ServiceUpdatePreparation;
        const result = yield* preparation.prepare({ stopWork: true });
        assert.deepEqual(result, {
          idle: true,
          stoppedThreads: 1,
          blockers: [],
          held: false,
          interruptedRuns: 1,
          openTerminals: 0,
        });
        // Stop would also end t2's pull request watches; the cleanup cancels its request.
        assert.deepEqual(fixture.dispatched, [
          { type: "run.interrupt", threadId: "t1", runId: "r1" },
          { type: "thread.stop", threadId: "t1" },
        ]);
        assert.include(fixture.cleanupCalls, "requests");
      }),
    );
  },
);

it.live("clears what Stop leaves behind even without a hold", () => {
  const fixture = newFixture(false);
  return run(
    fixture,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // A turn that never reached its provider, a request on an ended run, an
      // effect nobody will finish and a session row whose process is gone.
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES ('r1', 't1', 'starting', NULL)`;
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests (thread_id, status) VALUES ('t2', 'pending')`;
      yield* sql`INSERT INTO orchestration_v2_effect_outbox (thread_id, status) VALUES ('t2', 'pending')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions VALUES ('t1', 'working')`;
      const preparation = yield* Preparation.ServiceUpdatePreparation;
      const result = yield* preparation.prepare({ stopWork: true });
      assert.isTrue(result.idle);
      assert.equal(result.held, false);
      assert.equal(result.interruptedRuns, 1);
      assert.deepEqual(fixture.cleanupCalls, ["finalize", "requests", "sessions", "effects"]);
    }),
  );
});

/** A hold whose update agent reports a release ready to install. */
const holdFor = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "service-update-prepare-" });
    const agentStatePath = `${dir}/state.json`;
    yield* fs.writeFileString(agentStatePath, JSON.stringify({ status: "downloaded" }));
    return yield* Hold.makeWithOptions({ agentStatePath });
  });

it.live("does not hold the service when no update is on its way", () =>
  Effect.gen(function* () {
    const hold = yield* Hold.makeWithOptions({
      agentStatePath: "/nonexistent/specweave-studio-test/updates/state.json",
    });
    const fixture = newFixture(false, { hold });
    yield* run(
      fixture,
      Effect.gen(function* () {
        const preparation = yield* Preparation.ServiceUpdatePreparation;
        const result = yield* preparation.prepare({ stopWork: true, hold: true });
        assert.isFalse(result.held);
        assert.isFalse(yield* hold.isHeld);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("Update now holds the service before draining, then closes terminals", () =>
  Effect.gen(function* () {
    const hold = yield* holdFor();
    const fixture = newFixture(false, {
      hold,
      terminals: { open: 2 },
      messageModeRequests: [{ threadId: "t2", requestId: "question-1" }],
    });
    yield* run(
      fixture,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // r1 waits on its checkpoint; r2 never reached its provider.
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES
          ('r1', 't1', 'waiting', NULL), ('r2', 't2', 'starting', NULL)`;
        yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests (thread_id, status) VALUES ('t2', 'pending')`;
        const preparation = yield* Preparation.ServiceUpdatePreparation;

        const looked = yield* preparation.prepare({ stopWork: false });
        assert.equal(looked.held, false);
        assert.equal(looked.openTerminals, 2);

        const drainStarted = yield* Clock.currentTimeMillis;
        const { holdUntil, ...result } = yield* preparation.prepare({
          stopWork: true,
          hold: true,
        });
        assert.deepEqual(result, {
          idle: true,
          stoppedThreads: 2,
          blockers: [],
          held: true,
          holdReason: "install",
          interruptedRuns: 1,
          openTerminals: 2,
        });
        // The time limit starts over once drained, as the install request is written.
        const current = yield* hold.current;
        assert.isTrue(current._tag === "Some");
        if (current._tag === "Some") {
          assert.isAbove(current.value.startedAtMs, drainStarted);
          assert.equal(
            holdUntil,
            DateTime.formatIso(DateTime.makeUnsafe(current.value.expiresAtMs)),
          );
        }
        assert.isTrue(fixture.heldAtFirstDispatch);
        // One pass: nothing new can start behind a held drain.
        assert.deepEqual(
          fixture.dispatched.map((command) => [command.type, command.runId ?? command.threadId]),
          [
            ["run.interrupt", "r1"],
            ["run.interrupt", "r2"],
            ["thread.user-input.dismiss", "t2"],
          ],
        );
        assert.deepEqual(fixture.cleanupCalls, ["finalize", "requests", "sessions", "terminals"]);

        const meanwhile = yield* preparation.prepare({ stopWork: false });
        assert.equal(meanwhile.held, true);
        assert.equal(meanwhile.openTerminals, 0);

        const cancelled = yield* preparation.prepare({ stopWork: false, releaseHold: true });
        assert.equal(cancelled.held, false);
        assert.isFalse(yield* hold.isHeld);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("an app-restart drain holds the service only briefly", () =>
  Effect.gen(function* () {
    const hold = yield* holdFor();
    const fixture = newFixture(false, { hold });
    yield* run(
      fixture,
      Effect.gen(function* () {
        const preparation = yield* Preparation.ServiceUpdatePreparation;
        const drained = yield* Clock.currentTimeMillis;
        const result = yield* preparation.prepare({
          stopWork: true,
          hold: true,
          reason: "app-restart",
        });
        assert.isTrue(result.held);
        // Other windows learn why, and leave this hold to the service.
        assert.equal(result.holdReason, "app-restart");
        assert.equal((yield* preparation.prepare({ stopWork: false })).holdReason, "app-restart");
        const current = yield* hold.current;
        assert.isTrue(current._tag === "Some");
        if (current._tag === "Some") {
          const ttlMs = current.value.expiresAtMs - current.value.startedAtMs;
          assert.equal(ttlMs, Hold.APP_RESTART_HOLD_TTL_MS);
          assert.isBelow(current.value.expiresAtMs - drained, Hold.HOLD_TTL_MS);
        }
        // An install request keeps the full time limit.
        yield* preparation.prepare({ stopWork: false, releaseHold: true });
        const installed = yield* preparation.prepare({
          stopWork: true,
          hold: true,
          reason: "install",
        });
        assert.equal(installed.holdReason, "install");
        const install = yield* hold.current;
        assert.isTrue(install._tag === "Some");
        if (install._tag === "Some") {
          assert.equal(install.value.expiresAtMs - install.value.startedAtMs, Hold.HOLD_TTL_MS);
        }
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a failed drain lets work start again", () =>
  Effect.gen(function* () {
    const hold = yield* holdFor();
    const fixture = newFixture(false, { hold });
    yield* run(
      fixture,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Without the runs table the drain cannot read what is running.
        yield* sql`DROP TABLE orchestration_v2_projection_runs`;
        const preparation = yield* Preparation.ServiceUpdatePreparation;
        const failed = yield* Effect.flip(preparation.prepare({ stopWork: true, hold: true }));
        assert.equal(failed._tag, "ServerPrepareServiceUpdateError");
        assert.isFalse(yield* hold.isHeld);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// `specweave-studio update --if-idle`: a Linux worker has no update agent, and the hold must not
// stop the work it finds.
const noAgentHold = () =>
  Hold.makeWithOptions({ agentStatePath: "/nonexistent/specweave-studio-test/updates/state.json" });

it.live("an if-idle hold holds an idle service, stopping nothing, without an update agent", () =>
  Effect.gen(function* () {
    const hold = yield* noAgentHold();
    const fixture = newFixture(false, { hold });
    yield* run(
      fixture,
      Effect.gen(function* () {
        const preparation = yield* Preparation.ServiceUpdatePreparation;
        const result = yield* preparation.prepare({ stopWork: false, hold: true, ifIdle: true });
        assert.isTrue(result.idle);
        assert.isTrue(result.held);
        assert.isTrue(yield* hold.isHeld);
        assert.deepEqual(fixture.dispatched, []);
        const current = yield* hold.current;
        assert.isTrue(current._tag === "Some");
        if (current._tag === "Some") {
          // The lease is renewed after the blocker read, not dated before that I/O.
          assert.isAtLeast(
            current.value.expiresAtMs - current.value.startedAtMs,
            Preparation.IF_IDLE_HOLD_TTL_MS,
          );
          assert.equal(current.value.expiresAtMs, Date.parse(result.holdUntil!));
          assert.isAtMost(
            current.value.expiresAtMs - (yield* Clock.currentTimeMillis),
            Preparation.IF_IDLE_HOLD_TTL_MS,
          );
        }
        // A hold already in place is not this caller's: not reported as its own, not released.
        const again = yield* preparation.prepare({ stopWork: false, hold: true, ifIdle: true });
        assert.isFalse(again.held);
        assert.isTrue(yield* hold.isHeld);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("an if-idle hold leaves a busy service running and unheld", () =>
  Effect.gen(function* () {
    const hold = yield* noAgentHold();
    const fixture = newFixture(false, { hold });
    yield* run(
      fixture,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES ('r1', 't1', 'running', 'p-1')`;
        const preparation = yield* Preparation.ServiceUpdatePreparation;
        const result = yield* preparation.prepare({ stopWork: false, hold: true, ifIdle: true });
        assert.isFalse(result.idle);
        assert.isFalse(result.held);
        assert.isFalse(yield* hold.isHeld);
        assert.deepEqual(
          result.blockers.map((blocker) => [blocker.kind, blocker.threadTitle]),
          [["run", "Fix login"]],
        );
        // Nothing was stopped.
        assert.deepEqual(fixture.dispatched, []);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("tells a thread its rollback was cancelled and leaves a running checkpoint", () => {
  const fixture = newFixture(true);
  return run(
    fixture,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_effect_outbox VALUES
        ('t1', 'pending', 'rollback-1', 'provider-thread.rollback'),
        ('t2', 'running', 'capture-1', 'checkpoint.capture')`;
      const preparation = yield* Preparation.ServiceUpdatePreparation;
      const result = yield* preparation.prepare({ stopWork: true });
      // The capture keeps writing its checkpoint; the update helper waits for it.
      assert.deepEqual(
        result.blockers.map((blocker) => [blocker.kind, blocker.threadTitle]),
        [["effect", "Docs"]],
      );
      assert.deepEqual(
        fixture.dispatched.filter((command) => command.type === "checkpoint.rollback.fail"),
        [{ type: "checkpoint.rollback.fail", threadId: "t1", requestId: "rollback-1" }],
      );
    }),
  );
});

it.live("lets a finished turn's checkpoint finish before closing the turn", () => {
  const fixture = newFixture(false, {
    timings: { ...fast, interruptGraceMs: 10, settleMs: 10, effectGraceMs: 2_000 },
  });
  return run(
    fixture,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES ('r1', 't1', 'waiting', NULL)`;
      yield* sql`INSERT INTO orchestration_v2_effect_outbox VALUES
        ('t1', 'running', 'command:effect:checkpoint.capture:r1', 'checkpoint.capture')`;
      // The capture takes longer than every other wait in the drain.
      yield* Effect.sleep(Duration.millis(150)).pipe(
        Effect.andThen(
          sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded'`.pipe(
            Effect.andThen(
              sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'r1'`,
            ),
          ),
        ),
        Effect.forkChild,
      );
      const preparation = yield* Preparation.ServiceUpdatePreparation;
      const result = yield* preparation.prepare({ stopWork: true });
      assert.isTrue(result.idle);
      assert.equal(fixture.waitingAtFinalize, 0);
    }),
  );
});

it.live("closes a finished turn without its checkpoint once the wait runs out", () => {
  const fixture = newFixture(false, {
    timings: { ...fast, interruptGraceMs: 10, settleMs: 10, effectGraceMs: 30 },
  });
  return run(
    fixture,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES ('r1', 't1', 'waiting', NULL)`;
      yield* sql`INSERT INTO orchestration_v2_effect_outbox VALUES
        ('t1', 'pending', 'command:effect:checkpoint.capture:r1', 'checkpoint.capture')`;
      const preparation = yield* Preparation.ServiceUpdatePreparation;
      const result = yield* preparation.prepare({ stopWork: true });
      assert.isTrue(result.idle);
      assert.equal(fixture.waitingAtFinalize, 1);
    }),
  );
});

it.live("keeps to its budget when agent processes take long to close", () => {
  const fixture = newFixture(false, {
    releaseDelayMs: 3_000,
    timings: { ...fast, interruptGraceMs: 10, settleMs: 10, deadlineMs: 300 },
  });
  return run(
    fixture,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES
        ('r1', 't1', 'running', 'pt1'), ('r2', 't2', 'running', 'pt2')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads VALUES
        ('pt1', 'session-1'), ('pt2', 'session-2')`;
      const preparation = yield* Preparation.ServiceUpdatePreparation;
      const started = yield* Clock.currentTimeMillis;
      yield* preparation.prepare({ stopWork: true });
      // Two hung processes would take 6 s one after another.
      assert.isBelow((yield* Clock.currentTimeMillis) - started, 1_500);
    }),
  );
});

it.live("an interrupted drain releases the hold", () =>
  Effect.gen(function* () {
    const hold = yield* holdFor();
    const fixture = newFixture(false, {
      hold,
      timings: { ...fast, interruptGraceMs: 5_000 },
    });
    yield* run(
      fixture,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES ('r1', 't1', 'running', 'pt1')`;
        const preparation = yield* Preparation.ServiceUpdatePreparation;
        // The window that asked closes while Stop is still waiting on the turn.
        const fiber = yield* preparation
          .prepare({ stopWork: true, hold: true })
          .pipe(Effect.forkChild);
        yield* Effect.sleep(Duration.millis(100));
        assert.isTrue(yield* hold.isHeld);
        yield* Fiber.interrupt(fiber);
        assert.isFalse(yield* hold.isHeld);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a held drain cancels a message queued after its single round", () =>
  Effect.gen(function* () {
    const hold = yield* holdFor();
    const fixture = newFixture(true, { hold, wakesCoordinator: "r1" });
    yield* run(
      fixture,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES ('r1', 't1', 'running', 'pt1')`;
        const preparation = yield* Preparation.ServiceUpdatePreparation;
        const result = yield* preparation.prepare({ stopWork: true, hold: true });
        assert.isTrue(result.idle);
        assert.deepEqual(
          fixture.dispatched.map((command) => [command.type, command.runId]),
          [
            ["run.interrupt", "r1"],
            ["queued-run.cancel", "wake"],
          ],
        );

        // One that lands later is cleared by the next look while held.
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES ('late', 't2', 'queued', NULL)`;
        const looked = yield* preparation.prepare({ stopWork: false });
        assert.isTrue(looked.idle);
        assert.isString(looked.holdUntil);
        assert.deepEqual(fixture.dispatched.at(-1), {
          type: "queued-run.cancel",
          threadId: "t2",
          runId: "late",
        });
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("if-idle waits for an admitted command to persist and reports its work as busy", () =>
  Effect.gen(function* () {
    const hold = yield* noAgentHold();
    const fixture = newFixture(false, { hold });
    yield* run(
      fixture,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const preparation = yield* Preparation.ServiceUpdatePreparation;
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const command = yield* hold
          .withAdmission(
            "message.dispatch",
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(resume);
              yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES ('late', 't1', 'starting', 'p-1')`;
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const preparing = yield* preparation
          .prepare({ stopWork: false, hold: true, ifIdle: true })
          .pipe(Effect.forkScoped);
        // Wait for the real hold acquisition, not a sleep based on the old poll duration.
        yield* Effect.gen(function* () {
          while (!(yield* hold.isHeld)) yield* Effect.yieldNow;
        });
        assert.isUndefined(preparing.pollUnsafe());
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(command);
        const result = yield* Fiber.join(preparing);
        assert.isFalse(result.idle);
        assert.isFalse(result.held);
        assert.isFalse(yield* hold.isHeld);
        assert.deepEqual(fixture.dispatched, []);
      }).pipe(Effect.scoped),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("if-idle confirmation and cancellation act only on the matching lease", () =>
  Effect.gen(function* () {
    const hold = yield* noAgentHold();
    yield* run(
      newFixture(false, { hold }),
      Effect.gen(function* () {
        const preparation = yield* Preparation.ServiceUpdatePreparation;
        const lease = yield* preparation.prepare({ stopWork: false, hold: true, ifIdle: true });
        assert.isTrue(typeof lease.holdToken === "string");
        const wrong = yield* preparation.prepare({
          stopWork: false,
          hold: true,
          ifIdle: true,
          holdToken: "foreign",
        });
        assert.isFalse(wrong.held);
        yield* preparation.prepare({ stopWork: false, releaseHold: true, holdToken: "foreign" });
        assert.isTrue(yield* hold.isHeld);
        const renewed = yield* preparation.prepare({
          stopWork: false,
          hold: true,
          ifIdle: true,
          holdToken: lease.holdToken!,
        });
        assert.isTrue(renewed.held);
        assert.equal(renewed.holdToken, lease.holdToken);
        yield* preparation.prepare({
          stopWork: false,
          releaseHold: true,
          holdToken: lease.holdToken!,
        });
        assert.isFalse(yield* hold.isHeld);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("cancelling an if-idle request waiting for admission releases only its lease", () =>
  Effect.gen(function* () {
    const hold = yield* noAgentHold();
    yield* run(
      newFixture(false, { hold }),
      Effect.gen(function* () {
        const preparation = yield* Preparation.ServiceUpdatePreparation;
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const command = yield* hold
          .withAdmission(
            "message.dispatch",
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume))),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const preparing = yield* preparation
          .prepare({ stopWork: false, hold: true, ifIdle: true })
          .pipe(Effect.forkScoped);
        while (!(yield* hold.isHeld)) yield* Effect.yieldNow;
        yield* Fiber.interrupt(preparing);
        assert.isFalse(yield* hold.isHeld);
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(command);
      }).pipe(Effect.scoped),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.each(["open", "restart", "attach"] as const)(
  "if-idle waits for an admitted terminal %s to register and refuses without closing it",
  (operation) =>
    Effect.gen(function* () {
      const hold = yield* noAgentHold();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "if-idle-terminal-" });
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let killed = false;
      let spawned = false;
      const manager = yield* TerminalManager.makeWithOptions({
        logsDir: path.join(dir, "logs"),
        processKillGraceMs: 1,
        ptyAdapter: {
          spawn: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(resume);
              spawned = true;
              return {
                pid: 2147483646,
                write: () => {},
                resize: () => {},
                kill: () => {
                  killed = true;
                },
                onData: () => () => {},
                onExit: () => () => {},
              };
            }),
        },
      }).pipe(Effect.provideService(Hold.ServiceUpdateHold, hold));
      const input = {
        threadId: "terminal",
        terminalId: "default",
        cwd: dir,
        cols: 100,
        rows: 24,
      };
      const opening = yield* (
        operation === "attach"
          ? manager.attachStream(input, () => Effect.void)
          : operation === "restart"
            ? manager.restart(input)
            : manager.open(input)
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* run(
        newFixture(false, { hold }),
        Effect.gen(function* () {
          const preparation = yield* Preparation.makeWithTimings(fast).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(TerminalManager.TerminalManager, manager),
                Layer.succeed(Hold.ServiceUpdateHold, hold),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
                Layer.mock(Cleanup.ServiceUpdateCleanup)({}),
              ),
            ),
          );
          const preparing = yield* preparation
            .prepare({ stopWork: false, hold: true, ifIdle: true })
            .pipe(Effect.forkScoped);
          while (!(yield* hold.isHeld)) yield* Effect.yieldNow;
          assert.isFalse(spawned);
          assert.isUndefined(preparing.pollUnsafe());
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(opening);
          const result = yield* Fiber.join(preparing);
          assert.equal(result.openTerminals, 1);
          assert.isFalse(result.idle);
          assert.isFalse(result.held);
          assert.isFalse(ifIdleRestart(Option.some(Option.some(result))).held);
          assert.isFalse(yield* hold.isHeld);
          assert.isFalse(killed);
          // A terminal already running also refuses both acquisition and final confirmation.
          const again = yield* preparation.prepare({ stopWork: false, hold: true, ifIdle: true });
          assert.isFalse(again.held);
          const lease = yield* hold.acquireIfUnheld(Preparation.IF_IDLE_HOLD_TTL_MS);
          assert.isTrue(Option.isSome(lease));
          if (Option.isSome(lease)) {
            const final = yield* preparation.prepare({
              stopWork: false,
              hold: true,
              ifIdle: true,
              holdToken: lease.value.leaseToken!,
            });
            assert.isFalse(final.held);
            assert.isFalse(final.idle);
            assert.equal(final.openTerminals, 1);
          }
          assert.equal(yield* manager.countOpen, 1);
          assert.isFalse(killed);
        }).pipe(Effect.scoped),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
);
