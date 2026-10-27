import { assert, it } from "@effect/vitest";
import { RuntimeRequestId, ThreadId } from "@specweave-studio/contracts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Cleanup from "./ServiceUpdateCleanup.ts";
import * as ClosedQuestions from "./ServiceUpdateClosedQuestions.ts";
import * as Preparation from "./ServiceUpdatePreparation.ts";

/** The columns update.py, the drain and the stale-wait check read. */
const schema = [
  `CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, thread_id TEXT, status TEXT, provider_thread_id TEXT, payload_json TEXT)`,
  `CREATE TABLE orchestration_v2_projection_runtime_requests (runtime_request_id TEXT, thread_id TEXT, status TEXT, kind TEXT, created_at TEXT)`,
  `CREATE TABLE orchestration_v2_effect_outbox (thread_id TEXT, status TEXT, command_id TEXT, effect_type TEXT)`,
  `CREATE TABLE orchestration_v2_projection_provider_sessions (thread_id TEXT, status TEXT)`,
  `CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, title TEXT, project_id TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT)`,
  `CREATE TABLE projection_projects (project_id TEXT, title TEXT)`,
  `CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, provider_session_id TEXT)`,
  `CREATE TABLE orchestration_v2_projection_provider_turns (provider_thread_id TEXT, provider_turn_id TEXT, ordinal INTEGER, run_attempt_id TEXT)`,
  `CREATE TABLE orchestration_v2_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, occurred_at TEXT)`,
];

const fast: Preparation.ServiceUpdatePreparationTimings = {
  interruptGraceMs: 40,
  settleMs: 40,
  effectGraceMs: 40,
  deadlineMs: 5_000,
  pollMs: 5,
};

interface Fixture {
  /** Whether an interrupt ends the run (a provider that answers) or nothing happens (hung). */
  readonly stopEndsRun: boolean;
  readonly dispatched: Array<{ type: string; runId?: string; reason?: string; cause?: string }>;
  readonly released: Array<string>;
  readonly cleanupCalls: Array<{
    step: string;
    reason?: string;
    threadIds?: ReadonlyArray<string>;
  }>;
}

const newFixture = (stopEndsRun: boolean): Fixture => ({
  stopEndsRun,
  dispatched: [],
  released: [],
  cleanupCalls: [],
});

type Parts = Effect.Success<ReturnType<typeof Preparation.makePartsWithTimings>>;

const run = <E>(
  fixture: Fixture,
  body: (parts: Parts) => Effect.Effect<void, E, SqlClient.SqlClient>,
  /** Where what the sweep closes is recorded; absent in tools without one. */
  store?: ClosedQuestions.ServiceUpdateClosedQuestionsShape,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of schema) yield* sql.unsafe(statement);
    yield* sql`INSERT INTO projection_projects VALUES ('p1', 'EasyChamp')`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, title, project_id, payload_json)
      VALUES ('t1', 'Worker', 'p1', '{}'), ('t2', 'Docs', 'p1', '{}')`;
    const inScope = (threadIds: ReadonlyArray<string> | undefined) =>
      threadIds === undefined ? "1" : threadIds.map((id) => `'${id}'`).join(", ");
    const mocks = Layer.mergeAll(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: () =>
          Effect.succeed({
            thread: { title: "Worker" },
            runtimeRequests: [{ id: "req1", nodeId: "n1", kind: "command", status: "pending" }],
            nodes: [{ id: "n1", runId: "r1" }],
            turnItems: [
              { type: "approval_request", requestId: "req1", runId: "r1", prompt: "Run npm test" },
            ],
          } as never),
        dispatch: (command) =>
          Effect.gen(function* () {
            fixture.dispatched.push({
              type: command.type,
              ...("runId" in command ? { runId: command.runId } : {}),
              ...("reason" in command && typeof command.reason === "string"
                ? { reason: command.reason }
                : {}),
              ...("cause" in command && typeof command.cause === "string"
                ? { cause: command.cause }
                : {}),
            });
            if (command.type === "run.interrupt" && fixture.stopEndsRun)
              yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'interrupted'
                WHERE run_id = ${command.runId}`;
            if (command.type === "thread.background-work.settle")
              yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'interrupted'
                WHERE thread_id = ${command.threadId} AND status = 'running'`;
          }).pipe(Effect.orDie) as never,
      }),
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        release: (input) =>
          Effect.sync(() => {
            fixture.released.push(input.providerSessionId);
          }) as never,
      }),
      Layer.mock(Cleanup.ServiceUpdateCleanup)({
        finalizeStuckRuns: (input) =>
          Effect.gen(function* () {
            fixture.cleanupCalls.push({
              step: "finalize",
              reason: input.reason,
              ...(input.threadIds === undefined ? {} : { threadIds: input.threadIds }),
            });
            yield* sql.unsafe(`UPDATE orchestration_v2_projection_runs SET status = 'interrupted'
              WHERE status IN ('preparing', 'starting', 'running', 'waiting')
                AND thread_id IN (${inScope(input.threadIds)})`);
            return { interrupted: 0, completed: 0 };
          }).pipe(Effect.orDie),
        listMessageModeRequests: Effect.succeed([
          { threadId: ThreadId.make("t1"), requestId: RuntimeRequestId.make("q1") },
          { threadId: ThreadId.make("t2"), requestId: RuntimeRequestId.make("q2") },
        ]),
        cancelPendingRequests: (input) =>
          Effect.gen(function* () {
            fixture.cleanupCalls.push({
              step: "requests",
              reason: input.reason,
              ...(input.threadIds === undefined ? {} : { threadIds: input.threadIds }),
            });
            yield* sql.unsafe(`UPDATE orchestration_v2_projection_runtime_requests
              SET status = 'cancelled'
              WHERE status = 'pending' AND thread_id IN (${inScope(input.threadIds)})`);
            return 0;
          }).pipe(Effect.orDie),
        reconcileOrphanedSessions: Effect.sync(() => {
          fixture.cleanupCalls.push({ step: "sessions" });
          return 0;
        }),
      }),
    );
    const parts = yield* Preparation.makePartsWithTimings(fast).pipe(
      Effect.provide(
        store === undefined
          ? mocks
          : Layer.merge(mocks, Layer.succeed(ClosedQuestions.ServiceUpdateClosedQuestions, store)),
      ),
    );
    yield* body(parts);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

const minutesAgo = (minutes: number) =>
  Effect.map(Clock.currentTimeMillis, (now) =>
    DateTime.formatIso(DateTime.makeUnsafe(now - minutes * 60_000)),
  );

/**
 * A Codex worker turn on `t1` waiting on an approval since `requestMinutes` ago,
 * with its last recorded activity `activityMinutes` ago.
 */
const waitingWorker = (requestMinutes: number, activityMinutes: number, kind = "command") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id)
      VALUES ('r1', 't1', 'running', 'pt1')`;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_threads VALUES ('pt1', 's1')`;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_turns VALUES ('pt1', 'turn1', 1, NULL)`;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions VALUES ('t1', 'running')`;
    yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests VALUES
      ('req1', 't1', 'pending', ${kind}, ${yield* minutesAgo(requestMinutes)})`;
    yield* sql`INSERT INTO orchestration_v2_events (thread_id, occurred_at) VALUES
      ('t1', ${yield* minutesAgo(requestMinutes)}), ('t1', ${yield* minutesAgo(activityMinutes)})`;
  });

const pending = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runs = yield* sql<{ readonly run_id: string; readonly status: string }>`
    SELECT run_id, status FROM orchestration_v2_projection_runs ORDER BY run_id`;
  const requests = yield* sql<{ readonly runtime_request_id: string; readonly status: string }>`
    SELECT runtime_request_id, status FROM orchestration_v2_projection_runtime_requests
     ORDER BY runtime_request_id`;
  return {
    runs: runs.map((row) => [row.run_id, row.status]),
    requests: requests.map((row) => [row.runtime_request_id, row.status]),
  };
});

describe("agentWaitsForQuiet", () => {
  it("is true only while the update agent waits for a quiet moment to install", () => {
    expect(Preparation.agentWaitsForQuiet('{"status":"waiting-for-quiet"}')).toBe(true);
    expect(Preparation.agentWaitsForQuiet('{"status":"downloaded"}')).toBe(false);
    expect(Preparation.agentWaitsForQuiet('{"status":"installing"}')).toBe(false);
    expect(Preparation.agentWaitsForQuiet("{not json")).toBe(false);
    expect(Preparation.agentWaitsForQuiet("[]")).toBe(false);
  });
});

it.live(
  "stops a turn that waited 2 minutes on a person, so an automatic install can go ahead",
  () => {
    const fixture = newFixture(true);
    return run(fixture, (parts) =>
      Effect.gen(function* () {
        yield* waitingWorker(31, 31);
        const result = yield* parts.releaseStaleWaits;
        assert.deepEqual(result.releasedThreads, ["t1"]);
        // A plain interrupt that names the update, then the request is cancelled with the reason.
        assert.deepEqual(fixture.dispatched, [
          {
            type: "run.interrupt",
            runId: "r1",
            reason: Preparation.STALE_WAIT_REASON,
            cause: "service_update",
          },
          { type: "thread.user-input.dismiss" },
        ]);
        // Its agent process, still waiting on the answer, is closed.
        assert.deepEqual(fixture.released, ["s1"]);
        // Only this thread is touched.
        assert.deepEqual(fixture.cleanupCalls, [
          { step: "finalize", reason: Preparation.STALE_WAIT_REASON, threadIds: ["t1"] },
          { step: "requests", reason: Preparation.STALE_WAIT_REASON, threadIds: ["t1"] },
          { step: "sessions" },
        ]);
        assert.deepEqual(yield* pending, {
          runs: [["r1", "interrupted"]],
          requests: [["req1", "cancelled"]],
        });
      }),
    );
  },
);

it.live("ends a waiting turn whose provider never answers the interrupt", () => {
  const fixture = newFixture(false);
  return run(fixture, (parts) =>
    Effect.gen(function* () {
      yield* waitingWorker(45, 40);
      const result = yield* parts.releaseStaleWaits;
      assert.deepEqual(result.releasedThreads, ["t1"]);
      assert.deepEqual(
        fixture.dispatched.map((command) => command.type),
        ["run.interrupt", "thread.background-work.settle", "thread.user-input.dismiss"],
      );
      assert.deepEqual(yield* pending, {
        runs: [["r1", "interrupted"]],
        requests: [["req1", "cancelled"]],
      });
    }),
  );
});

it.live("releases a card that asks a closed approval again, as it released the approval", () => {
  const fixture = newFixture(true);
  return run(fixture, (parts) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // After the last install, the approval it released came back as a card,
      // with no turn waiting behind it.
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests VALUES
        ('update-reopen-approval:req0', 't1', 'pending', 'user_input', ${yield* minutesAgo(40)})`;
      yield* sql`INSERT INTO orchestration_v2_events (thread_id, occurred_at)
        VALUES ('t1', ${yield* minutesAgo(40)})`;
      assert.deepEqual((yield* parts.releaseStaleWaits).releasedThreads, ["t1"]);
      assert.deepEqual(yield* pending, {
        runs: [],
        requests: [["update-reopen-approval:req0", "cancelled"]],
      });
      // A card that asks a question again is released like the question was.
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests VALUES
        ('update-reopen:q0', 't2', 'pending', 'user_input', ${yield* minutesAgo(40)})`;
      yield* sql`INSERT INTO orchestration_v2_events (thread_id, occurred_at)
        VALUES ('t2', ${yield* minutesAgo(40)})`;
      assert.deepEqual((yield* parts.releaseStaleWaits).releasedThreads, ["t2"]);
    }),
  );
});

it.live("keeps waiting while the thread had activity in the last 2 minutes", () => {
  const fixture = newFixture(true);
  return run(fixture, (parts) =>
    Effect.gen(function* () {
      yield* waitingWorker(45, 1);
      assert.deepEqual((yield* parts.releaseStaleWaits).releasedThreads, []);
      assert.deepEqual(fixture.dispatched, []);
      assert.deepEqual(fixture.cleanupCalls, []);
      assert.deepEqual(yield* pending, {
        runs: [["r1", "running"]],
        requests: [["req1", "pending"]],
      });
    }),
  );
});

it.live("keeps waiting while the request is younger than 2 minutes", () => {
  const fixture = newFixture(true);
  return run(fixture, (parts) =>
    Effect.gen(function* () {
      yield* waitingWorker(1, 1);
      assert.deepEqual((yield* parts.releaseStaleWaits).releasedThreads, []);
      assert.deepEqual(fixture.dispatched, []);
    }),
  );
});

it.live("touches nothing while other work still runs: the install waits for it anyway", () => {
  const fixture = newFixture(true);
  return run(fixture, (parts) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* waitingWorker(60, 60);
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id)
        VALUES ('r2', 't2', 'running', 'pt2')`;
      assert.deepEqual((yield* parts.releaseStaleWaits).releasedThreads, []);
      assert.deepEqual(fixture.dispatched, []);
      assert.deepEqual(yield* pending, {
        runs: [
          ["r1", "running"],
          ["r2", "running"],
        ],
        requests: [["req1", "pending"]],
      });
    }),
  );
});

it.live("does not count a turn that is only running, with no request, as waiting", () => {
  const fixture = newFixture(true);
  return run(fixture, (parts) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id)
        VALUES ('r1', 't1', 'running', 'pt1')`;
      yield* sql`INSERT INTO orchestration_v2_events (thread_id, occurred_at)
        VALUES ('t1', ${yield* minutesAgo(90)})`;
      assert.deepEqual((yield* parts.releaseStaleWaits).releasedThreads, []);
      assert.deepEqual(fixture.dispatched, []);
    }),
  );
});

it.live("releases a question left 2 minutes, so it never holds the install back for good", () => {
  const fixture = newFixture(true);
  return run(fixture, (parts) =>
    Effect.gen(function* () {
      yield* waitingWorker(31, 31, "user_input");
      assert.deepEqual((yield* parts.releaseStaleWaits).releasedThreads, ["t1"]);
      assert.deepEqual(yield* pending, {
        runs: [["r1", "interrupted"]],
        requests: [["req1", "cancelled"]],
      });
    }),
  );
});

it.live("keeps a fresh question waiting: the person may still answer it", () => {
  const fixture = newFixture(true);
  return run(fixture, (parts) =>
    Effect.gen(function* () {
      yield* waitingWorker(1, 1, "user_input");
      assert.deepEqual((yield* parts.releaseStaleWaits).releasedThreads, []);
      assert.deepEqual(fixture.dispatched, []);
    }),
  );
});

it.live("keeps a sign-in waiting however long it has waited", () => {
  const fixture = newFixture(true);
  return run(fixture, (parts) =>
    Effect.gen(function* () {
      yield* waitingWorker(90, 90, "auth_refresh");
      assert.deepEqual((yield* parts.releaseStaleWaits).releasedThreads, []);
      assert.deepEqual(fixture.dispatched, []);
      assert.deepEqual(yield* pending, {
        runs: [["r1", "running"]],
        requests: [["req1", "pending"]],
      });
    }),
  );
});

it.live("keeps waiting when an approval waits beside a sign-in on the same thread", () => {
  const fixture = newFixture(true);
  return run(fixture, (parts) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* waitingWorker(45, 45);
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests VALUES
        ('req2', 't1', 'pending', 'auth_refresh', ${yield* minutesAgo(45)})`;
      assert.deepEqual((yield* parts.releaseStaleWaits).releasedThreads, []);
      assert.deepEqual(fixture.dispatched, []);
    }),
  );
});

it.live("closes at once what an archived thread waits on, without asking it again", () => {
  const fixture = newFixture(true);
  const recorded: Array<ClosedQuestions.ClosedQuestion> = [];
  return run(
    fixture,
    (parts) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // A sign-in asked a minute ago, on a thread the person archived: nobody sees it.
        yield* waitingWorker(1, 1, "auth_refresh");
        yield* sql`UPDATE orchestration_v2_projection_threads
          SET archived_at = ${yield* minutesAgo(0)} WHERE thread_id = 't1'`;
        assert.deepEqual((yield* parts.releaseStaleWaits).releasedThreads, ["t1"]);
        assert.deepEqual(recorded, []);
        assert.deepEqual(fixture.dispatched[0], {
          type: "run.interrupt",
          runId: "r1",
          reason: Preparation.HIDDEN_WAIT_REASON,
          cause: "service_update",
        });
        assert.deepEqual(fixture.cleanupCalls, [
          { step: "finalize", reason: Preparation.HIDDEN_WAIT_REASON, threadIds: ["t1"] },
          { step: "requests", reason: Preparation.HIDDEN_WAIT_REASON, threadIds: ["t1"] },
          { step: "sessions" },
        ]);
        assert.deepEqual(yield* pending, {
          runs: [["r1", "interrupted"]],
          requests: [["req1", "cancelled"]],
        });
      }),
    recordingStore(fixture, recorded, true),
  );
});

it.live("closes a question the person resolved its thread over, but not one asked after", () => {
  const fixture = newFixture(true);
  return run(fixture, (parts) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // A coordinator's question from 5 minutes ago, on a thread resolved 2 minutes ago.
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests VALUES
        ('q1', 't1', 'pending', 'user_input', ${yield* minutesAgo(5)})`;
      yield* sql`INSERT INTO orchestration_v2_events (thread_id, occurred_at)
        VALUES ('t1', ${yield* minutesAgo(2)})`;
      const resolved = JSON.stringify({
        settledOverride: "settled",
        settledAt: yield* minutesAgo(2),
      });
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${resolved}
        WHERE thread_id = 't1'`;
      // The same on t2, but the question came after the resolve: it reopens the
      // thread in Needs you, so it waits like any fresh question.
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests VALUES
        ('q2', 't2', 'pending', 'user_input', ${yield* minutesAgo(1)})`;
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${resolved}
        WHERE thread_id = 't2'`;
      assert.deepEqual((yield* parts.releaseStaleWaits).releasedThreads, []);
      yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status = 'resolved'
        WHERE runtime_request_id = 'q2'`;
      assert.deepEqual((yield* parts.releaseStaleWaits).releasedThreads, ["t1"]);
      assert.deepEqual(yield* pending, {
        runs: [],
        requests: [
          ["q1", "cancelled"],
          ["q2", "resolved"],
        ],
      });
    }),
  );
});

it.live("skips a thread answered between being picked and being interrupted", () => {
  const fixture = newFixture(true);
  return run(fixture, (parts) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* waitingWorker(45, 45);
      const selected = yield* parts.selectStaleWaits;
      assert.deepEqual(
        selected.map((thread) => thread.threadId),
        ["t1"],
      );
      // The person approves just then: the request resolves and the turn records it.
      yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status = 'resolved'
        WHERE runtime_request_id = 'req1'`;
      yield* sql`INSERT INTO orchestration_v2_events (thread_id, occurred_at)
        VALUES ('t1', ${yield* minutesAgo(0)})`;
      assert.deepEqual((yield* parts.releaseSelected(selected)).releasedThreads, []);
      assert.deepEqual(fixture.dispatched, []);
      assert.deepEqual(fixture.released, []);
      assert.deepEqual(fixture.cleanupCalls, []);
      assert.deepEqual(yield* pending, {
        runs: [["r1", "running"]],
        requests: [["req1", "resolved"]],
      });
    }),
  );
});

it.live(
  "skips a thread with new activity since it was picked, even with the request pending",
  () => {
    const fixture = newFixture(true);
    return run(fixture, (parts) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* waitingWorker(45, 45);
        const selected = yield* parts.selectStaleWaits;
        yield* sql`INSERT INTO orchestration_v2_events (thread_id, occurred_at)
        VALUES ('t1', ${yield* minutesAgo(0)})`;
        assert.deepEqual((yield* parts.releaseSelected(selected)).releasedThreads, []);
        assert.deepEqual(fixture.dispatched, []);
        assert.deepEqual(yield* pending, {
          runs: [["r1", "running"]],
          requests: [["req1", "pending"]],
        });
      }),
    );
  },
);

describe("sweepStaleWaits", () => {
  const released = { releasedThreads: ["t1"] };
  const sweep = (agentWaiting: boolean, isHeld: boolean, calls: Array<string>) =>
    Preparation.sweepStaleWaits({
      agentWaiting: Effect.succeed(agentWaiting),
      isHeld: Effect.succeed(isHeld),
      releaseStaleWaits: Effect.sync(() => {
        calls.push("release");
        return released;
      }),
    });

  it.effect("looks only while the agent waits for quiet and Update now holds nothing", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      assert.deepEqual(yield* sweep(false, false, calls), { releasedThreads: [] });
      assert.deepEqual(yield* sweep(true, true, calls), { releasedThreads: [] });
      assert.deepEqual(calls, []);
      assert.deepEqual(yield* sweep(true, false, calls), released);
      assert.deepEqual(calls, ["release"]);
    }),
  );

  it.effect("a failed look is logged and the next one tries again", () =>
    Effect.gen(function* () {
      const result = yield* Preparation.sweepStaleWaits({
        agentWaiting: Effect.succeed(true),
        isHeld: Effect.succeed(false),
        releaseStaleWaits: Effect.die(new Error("database busy")),
      });
      assert.deepEqual(result, { releasedThreads: [] });
    }),
  );
});

describe("ServiceUpdatePreparation.layer", () => {
  /** Builds the production layer and returns the update-state reads its sweep made. */
  const build = (withConfig: boolean) =>
    Effect.gen(function* () {
      const reads: Array<string> = [];
      const services = Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(Cleanup.ServiceUpdateCleanup)({}),
        NodeSqliteClient.layer({ filename: ":memory:" }),
        Path.layer,
        FileSystem.layerNoop({
          // Not waiting for quiet, so a look stops before the database.
          readFileString: (path) => Effect.sync(() => (reads.push(path), "{}")),
        }),
        withConfig
          ? Layer.succeed(ServerConfig.ServerConfig, { baseDir: "/studio" } as never)
          : Layer.empty,
      );
      yield* Layer.build(Preparation.layer.pipe(Layer.provide(services)));
      return reads;
    });

  it.effect("starts the stale-wait sweep when config, file system and path are there", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reads = yield* build(true);
        yield* TestClock.adjust(Duration.millis(Preparation.STALE_WAIT_SWEEP_MS - 1));
        assert.deepEqual(reads, []);
        yield* TestClock.adjust("1 millis");
        assert.deepEqual(reads, ["/studio/updates/state.json"]);
        yield* TestClock.adjust(Duration.millis(Preparation.STALE_WAIT_SWEEP_MS));
        assert.deepEqual(reads, ["/studio/updates/state.json", "/studio/updates/state.json"]);
      }),
    ),
  );

  it.effect("runs no sweep without a server config", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reads = yield* build(false);
        yield* TestClock.adjust(Duration.millis(Preparation.STALE_WAIT_SWEEP_MS * 2));
        assert.deepEqual(reads, []);
      }),
    ),
  );
});

/** A record that keeps what it is given, or refuses every write. */
const recordingStore = (
  fixture: Fixture,
  recorded: Array<ClosedQuestions.ClosedQuestion>,
  writes: boolean,
) =>
  ClosedQuestions.ServiceUpdateClosedQuestions.of({
    bootId: "this-process",
    record: (entries) =>
      Effect.sync(() => {
        fixture.cleanupCalls.push({ step: "record" });
        if (writes) recorded.push(...entries);
        return writes;
      }),
    pending: Effect.sync(() => recorded),
    forRun: () => Effect.succeed([]),
    markReopened: () => Effect.succeed(true),
    reopening: (effect) => effect,
    draining: (effect) => effect,
    isDraining: Effect.succeed(false),
  });

it.live("records each approval it releases, asked again only after the restart", () => {
  const fixture = newFixture(true);
  const recorded: Array<ClosedQuestions.ClosedQuestion> = [];
  return run(
    fixture,
    (parts) =>
      Effect.gen(function* () {
        yield* waitingWorker(31, 31);
        const result = yield* parts.releaseStaleWaits;
        assert.deepEqual(result.releasedThreads, ["t1"]);
        assert.deepEqual(
          recorded.map((entry) => [
            entry.requestId,
            entry.kind,
            entry.text,
            entry.reopenAfterRestart,
          ]),
          [["req1", "command", "Run npm test", true]],
        );
        // Recorded before anything was stopped or cancelled.
        assert.equal(fixture.cleanupCalls[0]?.step, "record");
      }),
    recordingStore(fixture, recorded, true),
  );
});

it.live("leaves a thread waiting when what it would close cannot be recorded", () => {
  const fixture = newFixture(true);
  return run(
    fixture,
    (parts) =>
      Effect.gen(function* () {
        yield* waitingWorker(31, 31);
        const result = yield* parts.releaseStaleWaits;
        assert.deepEqual(result.releasedThreads, []);
        assert.deepEqual(fixture.dispatched, []);
        assert.deepEqual(yield* pending, {
          runs: [["r1", "running"]],
          requests: [["req1", "pending"]],
        });
      }),
    recordingStore(fixture, [], false),
  );
});
