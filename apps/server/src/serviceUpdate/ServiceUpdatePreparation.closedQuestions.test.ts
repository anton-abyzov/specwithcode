import { assert, it } from "@effect/vitest";
import { RuntimeRequestId, ThreadId } from "@specweave-studio/contracts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Cleanup from "./ServiceUpdateCleanup.ts";
import * as ClosedQuestions from "./ServiceUpdateClosedQuestions.ts";
import * as Preparation from "./ServiceUpdatePreparation.ts";

/** The columns the drain, its record and update.py read. */
const schema = [
  `CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, thread_id TEXT, status TEXT, provider_thread_id TEXT, payload_json TEXT)`,
  `CREATE TABLE orchestration_v2_projection_runtime_requests (runtime_request_id TEXT, thread_id TEXT, status TEXT, kind TEXT, created_at TEXT)`,
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

/** What happened, in order: records, interrupts, dismissals and cancels. */
type Step = string;

interface HarnessOptions {
  /** The record cannot be written (a full disk). */
  readonly recordFails?: boolean;
  /**
   * The turn asks once more while it is interrupted, and only closing its
   * agent process cancels what it asked (not the interrupt).
   */
  readonly asksWhileStopping?: boolean;
}

const harness = (
  steps: Array<Step>,
  recorded: Array<ClosedQuestions.ClosedQuestion>,
  options: HarnessOptions = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of schema) yield* sql.unsafe(statement);
    yield* sql`INSERT INTO projection_projects VALUES ('p1', 'EasyChamp')`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('t1', 'Fix login', 'p1'), ('t2', 'Docs', 'p1')`;
    // t1 runs a turn that asked a question and waits for an approval; t2's turn
    // ended with a question asked as a message still open.
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES
      ('r1', 't1', 'running', 'pt1'), ('r2', 't2', 'completed', NULL)`;
    yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests VALUES
      ('q1', 't1', 'pending', 'user_input', '2026-10-21T09:00:00.000Z'),
      ('a1', 't1', 'pending', 'command', '2026-10-21T09:01:00.000Z'),
      ('m2', 't2', 'pending', 'user_input', '2026-10-21T09:02:00.000Z')`;
    const store = ClosedQuestions.ServiceUpdateClosedQuestions.of({
      bootId: "this-process",
      record: (entries) =>
        Effect.sync(() => {
          steps.push(`record:${entries.map((entry) => entry.requestId).join(",")}`);
          if (options.recordFails === true) return false;
          for (const entry of entries)
            if (!recorded.some((known) => known.requestId === entry.requestId))
              recorded.push(entry);
          return true;
        }),
      pending: Effect.sync(() => recorded),
      forRun: () => Effect.succeed([]),
      markReopened: () => Effect.succeed(true),
      reopening: (effect) => effect,
      draining: (effect) =>
        Effect.sync(() => steps.push("drain:start")).pipe(
          Effect.andThen(effect),
          Effect.ensuring(Effect.sync(() => steps.push("drain:end"))),
        ),
      isDraining: Effect.succeed(false),
    });
    const records = (threadId: string) => ({
      thread: { title: threadId === "t1" ? "Fix login" : "Docs" },
      runtimeRequests:
        threadId === "t1"
          ? [
              { id: "q1", nodeId: "n-q1", kind: "user_input", status: "pending" },
              { id: "a1", nodeId: "n-a1", kind: "command", status: "pending" },
              { id: "late", nodeId: "n-a1", kind: "command", status: "pending" },
            ]
          : [{ id: "m2", nodeId: "n-m2", kind: "user_input", status: "pending" }],
      nodes: [
        { id: "n-q1", runId: "r1" },
        { id: "n-a1", runId: "r1" },
        { id: "n-m2", runId: "r2" },
      ],
      turnItems: [
        {
          type: "user_input_request",
          requestId: "q1",
          runId: "r1",
          questions: [{ id: "q", header: "DB", question: "Which database?", options: [] }],
        },
        { type: "approval_request", requestId: "a1", runId: "r1", prompt: "Run npm publish" },
        { type: "approval_request", requestId: "late", runId: "r1", prompt: "Run git push" },
        {
          type: "user_input_request",
          requestId: "m2",
          runId: "r2",
          questions: [{ id: "q", header: "Docs", question: "Which docs site?", options: [] }],
        },
      ],
    });
    const mocks = Layer.mergeAll(
      Layer.succeed(ClosedQuestions.ServiceUpdateClosedQuestions, store),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: (threadId) => Effect.succeed(records(threadId) as never),
        dispatch: (command) =>
          Effect.gen(function* () {
            if (command.type === "run.interrupt") {
              steps.push(`interrupt:${command.runId}`);
              // A provider that answers ends the turn and cancels its requests.
              yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'interrupted' WHERE run_id = ${command.runId}`;
              if (options.asksWhileStopping === true)
                yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('late', 't1', 'pending', 'command', '2026-10-21T09:05:00.000Z')`;
              else
                yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status = 'cancelled' WHERE thread_id = 't1'`;
            }
            if (command.type === "thread.user-input.dismiss") {
              steps.push(`dismiss:${command.requestId}`);
              yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status = 'resolved' WHERE runtime_request_id = ${command.requestId}`;
            }
          }).pipe(Effect.orDie) as never,
      }),
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        release: () => Effect.void as never,
        releaseIdle: () =>
          Effect.gen(function* () {
            steps.push("release-sessions");
            // Closing a process cancels what its turn still asked.
            if (options.asksWhileStopping === true)
              yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status = 'cancelled' WHERE thread_id = 't1'`;
            return 0;
          }).pipe(Effect.orDie),
      }),
      Layer.mock(Cleanup.ServiceUpdateCleanup)({
        finalizeStuckRuns: () => Effect.succeed({ interrupted: 0, completed: 0 }),
        listMessageModeRequests: Effect.sync(() => [
          { threadId: ThreadId.make("t2"), requestId: RuntimeRequestId.make("m2") },
        ]),
        cancelPendingRequests: () =>
          Effect.gen(function* () {
            steps.push("cancel-requests");
            yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status = 'cancelled' WHERE status = 'pending'`;
            return 0;
          }).pipe(Effect.orDie),
        reconcileOrphanedSessions: Effect.succeed(0),
        cancelUnsettledEffects: () => Effect.succeed([]),
      }),
    );
    return yield* Preparation.makeWithTimings(fast).pipe(Effect.provide(mocks));
  });

it.live("names the questions and approvals a forced update closes, by thread", () =>
  Effect.gen(function* () {
    const steps: Array<Step> = [];
    const preparation = yield* harness(steps, []);
    const preview = yield* preparation.prepare({ stopWork: false });
    assert.deepEqual(
      preview.blockers
        .filter((blocker) => blocker.kind === "request")
        .map((blocker) => [
          blocker.threadTitle,
          blocker.count,
          blocker.questions,
          blocker.approvals,
        ]),
      [
        ["Docs", 1, 1, 0],
        ["Fix login", 2, 1, 1],
      ],
    );
    // Looking closes nothing and records nothing.
    assert.deepEqual(steps, []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.live("records every question and approval before the drain closes any of them", () =>
  Effect.gen(function* () {
    const steps: Array<Step> = [];
    const recorded: Array<ClosedQuestions.ClosedQuestion> = [];
    const preparation = yield* harness(steps, recorded);
    const result = yield* preparation.prepare({ stopWork: true, hold: true, reason: "install" });
    assert.isTrue(result.idle);
    // Recorded before the interrupt (which cancels t1's requests itself), and
    // again before the leftovers are dismissed and cancelled; the whole drain
    // is marked so nothing is reopened under it.
    assert.deepEqual(steps, [
      "drain:start",
      "record:q1,a1,m2",
      "interrupt:r1",
      "release-sessions",
      "dismiss:m2",
      "cancel-requests",
      "drain:end",
    ]);
    assert.deepEqual(
      recorded.map((entry) => [
        entry.requestId,
        entry.threadId,
        entry.runId,
        entry.kind,
        entry.text,
      ]),
      [
        ["q1", "t1", "r1", "user_input", "Which database?"],
        ["a1", "t1", "r1", "command", "Run npm publish"],
        ["m2", "t2", "r2", "user_input", "Which docs site?"],
      ],
    );
    for (const entry of recorded) {
      assert.isNull(entry.reopenedAt);
      assert.isTrue(Number.isFinite(Date.parse(entry.closedAt)));
    }
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.live("records what a turn asks while it is stopped, before its process is closed", () =>
  Effect.gen(function* () {
    const steps: Array<Step> = [];
    const recorded: Array<ClosedQuestions.ClosedQuestion> = [];
    const preparation = yield* harness(steps, recorded, { asksWhileStopping: true });
    yield* preparation.prepare({ stopWork: true, hold: true, reason: "install" });
    // Asked after the round's record, cancelled when its process closed.
    assert.deepEqual(steps.slice(0, 5), [
      "drain:start",
      "record:q1,a1,m2",
      "interrupt:r1",
      "record:late",
      "release-sessions",
    ]);
    assert.deepEqual(
      recorded.map((entry) => [entry.requestId, entry.text]),
      [
        ["q1", "Which database?"],
        ["a1", "Run npm publish"],
        ["m2", "Which docs site?"],
        ["late", "Run git push"],
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.live("closes nothing when the record cannot be written", () =>
  Effect.gen(function* () {
    const steps: Array<Step> = [];
    const preparation = yield* harness(steps, [], { recordFails: true });
    const failure = yield* preparation
      .prepare({ stopWork: true, hold: true, reason: "install" })
      .pipe(Effect.flip);
    assert.equal(failure.message, Preparation.NOT_RECORDED_MESSAGE);
    // No turn stopped, no question dismissed, no request cancelled.
    assert.deepEqual(steps, ["drain:start", "record:q1,a1,m2", "drain:end"]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
