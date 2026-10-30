import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import * as FolderWork from "../fleet/folderTransfer/folderWork.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as Cleanup from "./ServiceUpdateCleanup.ts";
import * as Descendants from "./ServiceUpdateDescendants.ts";
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

/** Fleet and automatic installs: slow enough that a bounded drain is told apart. */
const slow: Preparation.ServiceUpdatePreparationTimings = {
  interruptGraceMs: 1_500,
  settleMs: 40,
  effectGraceMs: 300,
  deadlineMs: 10_000,
  pollMs: 5,
};

/** INTERACTIVE_TIMINGS scaled down. */
const interactive: Preparation.ServiceUpdatePreparationTimings = {
  interruptGraceMs: 40,
  settleMs: 30,
  effectGraceMs: 300,
  deadlineMs: 2_000,
  pollMs: 5,
  sharedEffectGrace: true,
};

interface Fixture {
  readonly dispatched: Array<{ type: string; runId?: string }>;
  releasedIdle: number;
  readonly cleanupCalls: Array<string>;
  readonly hold?: Hold.ServiceUpdateHoldShape;
  readonly terminals?: { open: number };
  readonly folderWork?: FolderWork.FolderWorkActivity["Service"];
  /** What the process-table look answers, one per look; the last one repeats. */
  readonly leftover?: Array<Option.Option<number>>;
  looks: number;
  readonly timings?: Preparation.ServiceUpdatePreparationTimings;
  readonly interactiveTimings?: Preparation.ServiceUpdatePreparationTimings;
}

const newFixture = (extra: Partial<Fixture> = {}): Fixture => ({
  dispatched: [],
  releasedIdle: 0,
  cleanupCalls: [],
  looks: 0,
  ...extra,
});

const run = <E>(
  fixture: Fixture,
  body: Effect.Effect<void, E, SqlClient.SqlClient | Preparation.ServiceUpdatePreparation>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of schema) yield* sql.unsafe(statement);
    yield* sql`INSERT INTO projection_projects VALUES ('p1', 'EasyChamp')`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('t1', 'Fix login', 'p1')`;
    const mocks = Layer.mergeAll(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        // A provider that never answers its interrupt: only the forced end settles the turn.
        dispatch: (command) =>
          Effect.gen(function* () {
            fixture.dispatched.push({
              type: command.type,
              ...("runId" in command ? { runId: command.runId } : {}),
            });
            if (command.type === "thread.background-work.settle")
              yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'interrupted'
                WHERE thread_id = ${command.threadId} AND status = 'running'`;
          }).pipe(Effect.orDie) as never,
      }),
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        release: () => Effect.void as never,
        releaseIdle: () =>
          sql`UPDATE orchestration_v2_projection_provider_sessions SET status = 'stopped'`.pipe(
            Effect.orDie,
            Effect.as(1),
            Effect.tap(() => Effect.sync(() => (fixture.releasedIdle += 1))),
          ),
      }),
      Layer.mock(Cleanup.ServiceUpdateCleanup)({
        finalizeStuckRuns: () =>
          Effect.gen(function* () {
            fixture.cleanupCalls.push("finalize");
            yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE status = 'waiting'`;
            yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'interrupted'
              WHERE status IN ('preparing', 'starting', 'running')`;
            return { interrupted: 0, completed: 0 };
          }).pipe(Effect.orDie),
        listMessageModeRequests: Effect.succeed([]),
        cancelPendingRequests: () =>
          Effect.sync(() => {
            fixture.cleanupCalls.push("requests");
            return 0;
          }),
        reconcileOrphanedSessions: Effect.sync(() => {
          fixture.cleanupCalls.push("sessions");
          return 0;
        }),
        cancelUnsettledEffects: () =>
          Effect.gen(function* () {
            fixture.cleanupCalls.push("effects");
            yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'cancelled'
              WHERE status IS NULL OR status NOT IN ('succeeded', 'failed', 'cancelled')`;
            return [];
          }).pipe(Effect.orDie),
      }),
    );
    const optional = Layer.mergeAll(
      fixture.folderWork === undefined
        ? Layer.empty
        : Layer.succeed(FolderWork.FolderWorkActivity, fixture.folderWork),
      fixture.hold === undefined
        ? Layer.empty
        : Layer.succeed(Hold.ServiceUpdateHold, fixture.hold),
      fixture.terminals === undefined
        ? Layer.empty
        : Layer.mock(TerminalManager.TerminalManager)({
            closeAll: Effect.sync(() => {
              const closed = fixture.terminals!.open;
              fixture.terminals!.open = 0;
              fixture.cleanupCalls.push("terminals");
              return closed;
            }),
            countOpen: Effect.sync(() => fixture.terminals!.open),
          }),
      fixture.leftover === undefined
        ? Layer.empty
        : Layer.succeed(
            Descendants.ServiceUpdateDescendants,
            Descendants.ServiceUpdateDescendants.of({
              countLeftover: Effect.sync(() => {
                const answers = fixture.leftover!;
                const answer = answers[Math.min(fixture.looks, answers.length - 1)]!;
                fixture.looks += 1;
                return answer;
              }),
            }),
          ),
    );
    yield* body.pipe(
      Effect.provide(
        Layer.effect(
          Preparation.ServiceUpdatePreparation,
          Effect.map(
            Preparation.makePartsWithTimings(
              fixture.timings ?? slow,
              fixture.interactiveTimings ?? interactive,
            ),
            (parts) => parts.service,
          ),
        ).pipe(Layer.provide(Layer.merge(mocks, optional))),
      ),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

/** A hold whose update agent reports a release ready to install. */
const holdFor = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "service-update-interactive-" });
    const agentStatePath = `${dir}/state.json`;
    yield* fs.writeFileString(agentStatePath, JSON.stringify({ status: "downloaded" }));
    return yield* Hold.makeWithOptions({ agentStatePath });
  });

const elapsedSince = (started: number) =>
  Effect.map(Clock.currentTimeMillis, (now) => now - started);

describe("INTERACTIVE_TIMINGS", () => {
  it("bounds a drain a person waits on to 15 s, the default to 70 s", () => {
    expect(Preparation.INTERACTIVE_TIMINGS).toMatchObject({
      interruptGraceMs: 8_000,
      settleMs: 3_000,
      effectGraceMs: 5_000,
      deadlineMs: 15_000,
      sharedEffectGrace: true,
    });
    expect(Preparation.DEFAULT_TIMINGS.deadlineMs).toBe(70_000);
    expect(Preparation.DESCENDANT_SETTLE_MS).toBe(3_000);
  });
});

describe("leftoverDescendants", () => {
  const table = Descendants.parseDescendantTable(
    [
      "  100     1 /Applications/SpecWithCode.app/specweave-studio",
      "  101   100 /usr/bin/caffeinate",
      "  102   100 /Users/a/.specwithcode/tools/chrome-headless-shell/mac-arm64/1/chrome-headless-shell",
      "  103   102 /Users/a/.specwithcode/tools/chrome-headless-shell/mac-arm64/1/chrome-headless-shell Helper",
      "  104   100 /Users/a/.specwithcode/tools/cloudflared",
      "  105   100 /bin/ps",
      "  106   100 /Users/a/.local/bin/claude",
      "  107   106 /bin/zsh",
      "  108   107 /usr/bin/caffeinate",
      "  200     1 /usr/bin/caffeinate",
      "garbage",
    ].join("\n"),
  );

  it("reads pid, parent and executable, executables with spaces too", () => {
    expect(table).toHaveLength(10);
    expect(table[3]).toEqual({
      pid: 103,
      ppid: 102,
      executable:
        "/Users/a/.specwithcode/tools/chrome-headless-shell/mac-arm64/1/chrome-headless-shell Helper",
    });
  });

  it("leaves out the supervisor, the server browser with its helpers and the tunnel", () => {
    // An agent's own caffeinate, deeper in its tree, is work like any other.
    expect(Descendants.leftoverDescendants(table, 100).map((row) => row.pid)).toEqual([
      106, 107, 108,
    ]);
  });

  it("finds nothing beneath a service with only what the helper accepts", () => {
    expect(
      Descendants.leftoverDescendants(
        table.filter((row) => row.pid < 106),
        100,
      ),
    ).toEqual([]);
  });
});

describe("settleDescendants", () => {
  it.live("stops looking once nothing is left", () =>
    Effect.gen(function* () {
      const answers = [Option.some(2), Option.some(1), Option.some(0)];
      let looks = 0;
      const left = yield* Descendants.settleDescendants(
        Effect.sync(() => answers[Math.min(looks++, answers.length - 1)]!),
        2_000,
        5,
      );
      assert.deepEqual(left, Option.some(0));
      assert.equal(looks, 3);
    }),
  );

  it.live("gives up at its budget and says how many are left", () =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const left = yield* Descendants.settleDescendants(Effect.succeedSome(1), 60, 5);
      assert.deepEqual(left, Option.some(1));
      assert.isAtLeast(yield* elapsedSince(started), 60);
      assert.isBelow(yield* elapsedSince(started), 1_000);
    }),
  );
});

it.live("a pressed install ends a turn that ignores Stop within its short grace", () =>
  Effect.gen(function* () {
    const hold = yield* holdFor();
    const fixture = newFixture({ hold });
    yield* run(
      fixture,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES ('r1', 't1', 'running', 'pt1')`;
        yield* sql`INSERT INTO orchestration_v2_projection_provider_threads VALUES ('pt1', 'session-1')`;
        yield* sql`INSERT INTO orchestration_v2_projection_provider_turns VALUES ('pt1', 'turn-1', 1, NULL)`;
        const preparation = yield* Preparation.ServiceUpdatePreparation;
        const started = yield* Clock.currentTimeMillis;
        const result = yield* preparation.prepare({
          stopWork: true,
          hold: true,
          reason: "install",
          interactive: true,
        });
        // Well inside the default 1.5 s grace: the interactive one ended it.
        assert.isBelow(yield* elapsedSince(started), 1_000);
        assert.isTrue(result.idle);
        assert.isTrue(result.held);
        assert.equal(result.interruptedRuns, 1);
        assert.deepEqual(
          fixture.dispatched.map((command) => command.type),
          ["run.interrupt", "thread.background-work.settle"],
        );
        // Ended `interrupted`, never failed: the restart or the person continues it.
        const left = yield* sql<{ status: string }>`
          SELECT status FROM orchestration_v2_projection_runs WHERE run_id = 'r1'`;
        assert.equal(left[0]?.status, "interrupted");
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a fleet drain keeps the full grace, and so does an interactive app restart", () =>
  Effect.gen(function* () {
    const hold = yield* holdFor();
    const fixture = newFixture({ hold, timings: { ...slow, interruptGraceMs: 400 } });
    yield* run(
      fixture,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const preparation = yield* Preparation.ServiceUpdatePreparation;
        for (const input of [
          { stopWork: true, hold: true, reason: "install" as const },
          { stopWork: true, hold: true, reason: "app-restart" as const, interactive: true },
        ]) {
          yield* sql`DELETE FROM orchestration_v2_projection_runs`;
          yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES ('r1', 't1', 'running', 'pt1')`;
          const started = yield* Clock.currentTimeMillis;
          const result = yield* preparation.prepare(input);
          assert.isAtLeast(yield* elapsedSince(started), 400);
          assert.isTrue(result.idle);
          yield* preparation.prepare({ stopWork: false, releaseHold: true });
        }
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("an idle service is held without the stop pass", () =>
  Effect.gen(function* () {
    const hold = yield* holdFor();
    const fixture = newFixture({ hold, terminals: { open: 0 }, leftover: [Option.some(0)] });
    yield* run(
      fixture,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // An idle agent process between turns, a finished run and a settled effect.
        yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions VALUES ('t1', 'ready')`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES ('r1', 't1', 'completed', NULL)`;
        yield* sql`INSERT INTO orchestration_v2_effect_outbox (thread_id, status) VALUES ('t1', 'succeeded')`;
        const preparation = yield* Preparation.ServiceUpdatePreparation;
        const { holdUntil, ...result } = yield* preparation.prepare({
          stopWork: true,
          hold: true,
          reason: "install",
          interactive: true,
        });
        assert.isString(holdUntil);
        assert.deepEqual(result, {
          idle: true,
          stoppedThreads: 0,
          blockers: [],
          held: true,
          holdReason: "install",
          interruptedRuns: 0,
          openTerminals: 0,
          folderCopies: 0,
        });
        // Idle agent processes close, and nothing else is stopped or cleaned.
        assert.equal(fixture.releasedIdle, 1);
        assert.deepEqual(fixture.dispatched, []);
        assert.deepEqual(fixture.cleanupCalls, []);
        assert.equal(fixture.looks, 1);
        assert.isTrue(yield* hold.isHeld);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("an open terminal takes the full drain, which closes it", () =>
  Effect.gen(function* () {
    const hold = yield* holdFor();
    const fixture = newFixture({ hold, terminals: { open: 1 } });
    yield* run(
      fixture,
      Effect.gen(function* () {
        const preparation = yield* Preparation.ServiceUpdatePreparation;
        const result = yield* preparation.prepare({
          stopWork: true,
          hold: true,
          reason: "install",
          interactive: true,
        });
        assert.isTrue(result.idle);
        assert.equal(result.openTerminals, 1);
        assert.deepEqual(fixture.cleanupCalls, ["finalize", "requests", "sessions", "terminals"]);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// #1041: a folder copy is work update.py cannot see, and a press never makes it look idle.
it.live("a folder copy in flight still blocks a pressed install", () =>
  Effect.gen(function* () {
    const hold = yield* holdFor();
    const fixture = newFixture({
      hold,
      folderWork: FolderWork.FolderWorkActivity.of({
        register: () => Effect.void,
        inFlight: Effect.succeed([{ operationId: "op-1", role: "source", state: "ready" }]),
      }),
    });
    yield* run(
      fixture,
      Effect.gen(function* () {
        const preparation = yield* Preparation.ServiceUpdatePreparation;
        const result = yield* preparation.prepare({
          stopWork: true,
          hold: true,
          reason: "install",
          interactive: true,
        });
        assert.isFalse(result.idle);
        assert.equal(result.folderCopies, 1);
        // Not the idle path: the full drain ran, and stopped no copy.
        assert.include(fixture.cleanupCalls, "finalize");
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("the checkpoint and effect graces share one window when a person waits", () =>
  Effect.gen(function* () {
    const hold = yield* holdFor();
    const fixture = newFixture({ hold });
    yield* run(
      fixture,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const preparation = yield* Preparation.ServiceUpdatePreparation;
        const elapsed: Array<number> = [];
        for (const interactiveInput of [true, false]) {
          yield* sql`DELETE FROM orchestration_v2_projection_runs`;
          yield* sql`DELETE FROM orchestration_v2_effect_outbox`;
          // A finished turn whose checkpoint never finishes, and another effect.
          yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, status, provider_thread_id) VALUES ('r1', 't1', 'waiting', NULL)`;
          yield* sql`INSERT INTO orchestration_v2_effect_outbox (thread_id, status, command_id, effect_type) VALUES
            ('t1', 'pending', ${`${Cleanup.CHECKPOINT_CAPTURE_COMMAND_PREFIX}r1`}, 'checkpoint.capture'),
            ('t1', 'pending', 'other', 'provider-thread.rollback')`;
          const started = yield* Clock.currentTimeMillis;
          const result = yield* preparation.prepare({
            stopWork: true,
            hold: true,
            reason: "install",
            interactive: interactiveInput,
          });
          elapsed.push(yield* elapsedSince(started));
          assert.isTrue(result.idle);
          yield* preparation.prepare({ stopWork: false, releaseHold: true });
        }
        // One 300 ms window, against 300 ms for checkpoints and 300 ms more for effects.
        assert.isBelow(elapsed[0]!, 550);
        assert.isAtLeast(elapsed[1]!, 600);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("waits for closed agent processes to exit before answering", () =>
  Effect.gen(function* () {
    const hold = yield* holdFor();
    const fixture = newFixture({
      hold,
      leftover: [Option.some(2), Option.some(1), Option.some(0)],
    });
    yield* run(
      fixture,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions VALUES ('t1', 'running')`;
        const preparation = yield* Preparation.ServiceUpdatePreparation;
        const result = yield* preparation.prepare({ stopWork: true, hold: true });
        assert.isTrue(result.idle);
        assert.isUndefined(result.leftoverProcesses);
        assert.equal(fixture.looks, 3);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("reports processes still left, so the press does not look idle", () =>
  Effect.gen(function* () {
    const hold = yield* holdFor();
    const fixture = newFixture({
      hold,
      leftover: [Option.some(1)],
      interactiveTimings: { ...interactive, deadlineMs: 300 },
    });
    yield* run(
      fixture,
      Effect.gen(function* () {
        const preparation = yield* Preparation.ServiceUpdatePreparation;
        const started = yield* Clock.currentTimeMillis;
        const result = yield* preparation.prepare({
          stopWork: true,
          hold: true,
          reason: "install",
          interactive: true,
        });
        // The wait ends with the drain's deadline, well before DESCENDANT_SETTLE_MS.
        assert.isBelow(yield* elapsedSince(started), 1_500);
        assert.isFalse(result.idle);
        assert.equal(result.leftoverProcesses, 1);
        assert.deepEqual(result.blockers, []);
        // A drain that cannot say leaves the helper's check to decide.
        fixture.leftover!.splice(0, 1, Option.none());
        fixture.looks = 0;
        yield* preparation.prepare({ stopWork: false, releaseHold: true });
        const unknown = yield* preparation.prepare({
          stopWork: true,
          hold: true,
          reason: "install",
          interactive: true,
        });
        assert.isTrue(unknown.idle);
        assert.isUndefined(unknown.leftoverProcesses);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
