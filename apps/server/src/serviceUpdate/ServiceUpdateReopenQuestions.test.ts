import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@specweave-studio/contracts";
import * as NodeSqliteClient from "@specweave-studio/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import { ProjectionStoreThreadNotFoundError } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ClosedQuestions from "./ServiceUpdateClosedQuestions.ts";
import * as Hold from "./ServiceUpdateHold.ts";
import * as Reopen from "./ServiceUpdateReopenQuestions.ts";

const at = DateTime.makeUnsafe("2026-10-21T10:00:00.000Z");
const later = DateTime.makeUnsafe("2026-10-21T10:05:00.000Z");

const run = (
  id: string,
  ordinal: number,
  status: string,
  fields: Record<string, unknown> = {},
) => ({
  id: RunId.make(id),
  ordinal,
  status,
  completedAt: status === "running" || status === "queued" ? null : at,
  rootNodeId: NodeId.make(`node:${id}`),
  providerThreadId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  ...fields,
});

describe("continuationExpected", () => {
  const runs = [run("r1", 1, "completed"), run("r2", 2, "interrupted")] as never;
  it("is true for the latest turn stopped for the update, where the project continues", () => {
    expect(Reopen.continuationExpected(runs, "r2", true)).toBe(true);
    expect(Reopen.continuationExpected(runs, "r2", false)).toBe(false);
    // An older turn is not the one a restart continues.
    expect(Reopen.continuationExpected(runs, "r1", true)).toBe(false);
  });
  it("is true once a continuation of that turn exists, and ignores queued turns", () => {
    const continued = [
      run("r2", 2, "interrupted"),
      run("r3", 3, "running", { restartContinuationOfRunId: "r2" }),
    ] as never;
    expect(Reopen.continuationExpected(continued, "r2", true)).toBe(true);
    const queuedBehind = [run("r2", 2, "interrupted"), run("r3", 3, "queued")] as never;
    expect(Reopen.continuationExpected(queuedBehind, "r2", true)).toBe(true);
    // The update cancels the messages queued behind the turn before it stops it.
    const cancelledBehind = [
      run("r2", 2, "interrupted"),
      run("r3", 3, "cancelled", { cancelledForUpdate: true }),
    ] as never;
    expect(Reopen.continuationExpected(cancelledBehind, "r2", true)).toBe(true);
  });
});

it.effect(
  "captures what each waiting question and approval asked, not the app's own tool calls",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE orchestration_v2_projection_runtime_requests (runtime_request_id TEXT, thread_id TEXT, status TEXT, kind TEXT, created_at TEXT)`;
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests VALUES
      ('q1', 't1', 'pending', 'user_input', '2026-10-21T09:00:00.000Z'),
      ('a1', 't1', 'pending', 'command', '2026-10-21T09:01:00.000Z'),
      ('tool', 't1', 'pending', 'dynamic_tool_call', '2026-10-21T09:02:00.000Z'),
      ('done', 't2', 'resolved', 'user_input', '2026-10-21T09:03:00.000Z')`;
      const records = {
        thread: { title: "Fix login" },
        runtimeRequests: [
          { id: "q1", nodeId: "n-q1", kind: "user_input", status: "pending" },
          { id: "a1", nodeId: "n-a1", kind: "command", status: "pending" },
        ],
        nodes: [
          { id: "n-q1", runId: "r1" },
          { id: "n-a1", runId: "r1" },
        ],
        turnItems: [
          {
            type: "user_input_request",
            requestId: "q1",
            runId: "r1",
            questions: [{ id: "q", header: "DB", question: "Which database?", options: [] }],
          },
          { type: "approval_request", requestId: "a1", runId: "r1", prompt: "Run npm publish" },
        ],
      };
      const entries = yield* Reopen.captureOpenRequests({
        sql,
        threads: { getThreadRecords: () => Effect.succeed(records as never) },
      });
      assert.deepEqual(
        entries.map((entry) => [
          entry.requestId,
          entry.kind,
          entry.runId,
          entry.text,
          entry.threadTitle,
        ]),
        [
          ["q1", "user_input", "r1", "Which database?", "Fix login"],
          ["a1", "command", "r1", "Run npm publish", "Fix login"],
        ],
      );
      assert.isNull(entries[0]!.reopenedAt);
      assert.equal(entries[0]!.askedAt, "2026-10-21T09:00:00.000Z");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

interface World {
  held: boolean;
  /** The desktop's install request is still under way. */
  requestOpen: boolean;
  continues: boolean;
  /** An automatic install still waits for quiet or installs. */
  installUnderway: boolean;
  /** What reading the thread fails with, when it fails. */
  readFailure: unknown;
  /** Runs while a thread is read (a drain starting meanwhile, say). */
  onRead: Effect.Effect<void>;
  projection: Record<string, unknown>;
  /** Threads other than t1, by id: the parents a subagent is folded into. */
  parents: Record<string, Record<string, unknown>>;
  readonly notes: Array<{ commandId: string; message: string; runId: string }>;
  readonly cards: Array<{
    requestId: string;
    runId: string;
    nodeId: string;
    questions: unknown;
    reopenedFromAskedAt?: string | null | undefined;
  }>;
}

const newWorld = (fields: Partial<World> = {}): World => ({
  held: false,
  requestOpen: false,
  continues: false,
  installUnderway: false,
  readFailure: null,
  onRead: Effect.void,
  projection: {
    thread: {
      id: ThreadId.make("t1"),
      projectId: ProjectId.make("p1"),
      archivedAt: null,
      deletedAt: null,
    },
    runs: [run("r1", 1, "interrupted")],
    runtimeRequests: [
      { id: RuntimeRequestId.make("q1"), status: "cancelled" },
      { id: RuntimeRequestId.make("a1"), status: "cancelled" },
    ],
  },
  parents: {},
  notes: [],
  cards: [],
  ...fields,
});

/** A reopener over a record at `recordPath`, against a fake thread store. */
const reopenerFor = (world: World, recordPath: string) =>
  Effect.gen(function* () {
    const store = yield* ClosedQuestions.makeWithPath(recordPath);
    const reopener = yield* Reopen.makeReopener.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ClosedQuestions.ServiceUpdateClosedQuestions, store),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              world.parents[threadId] !== undefined
                ? Effect.succeed({
                    thread: world.parents[threadId],
                  } as unknown as OrchestrationV2ThreadProjection)
                : world.onRead.pipe(
                    Effect.andThen(
                      world.readFailure === null
                        ? Effect.succeed(
                            world.projection as unknown as OrchestrationV2ThreadProjection,
                          )
                        : Effect.fail(world.readFailure as never),
                    ),
                  ),
            dispatch: (command) =>
              Effect.sync(() => {
                if (command.type === "user_input_request.record")
                  world.cards.push({
                    requestId: command.requestId,
                    runId: command.runId,
                    nodeId: command.nodeId,
                    questions: command.questions,
                    reopenedFromAskedAt: command.reopenedFromAskedAt,
                  });
                return {} as never;
              }),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) =>
              Effect.sync(() => {
                for (const event of input.events)
                  if (event.type === "turn-item.updated" && event.payload.type === "system_notice")
                    world.notes.push({
                      commandId: input.commandId,
                      message: event.payload.message,
                      runId: event.payload.runId ?? "",
                    });
                return {} as never;
              }),
          }),
          IdAllocator.layer,
          Layer.mock(Hold.ServiceUpdateHold)({
            isHeld: Effect.sync(() => world.held),
            installRequestOpen: Effect.sync(() => world.requestOpen),
            automaticInstallUnderway: Effect.sync(() => world.installUnderway),
          }),
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: world.continues }),
        ),
      ),
    );
    return { store, reopener };
  });

const withRecord = <A, E>(
  body: (recordPath: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "reopen-questions-" });
    return yield* body(path.join(dir, "updates", "closed-questions.json"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const closed = (requestId: string, fields: Partial<ClosedQuestions.ClosedQuestion> = {}) => ({
  requestId,
  threadId: "t1",
  threadTitle: "Fix login",
  runId: "r1",
  kind: "user_input",
  text: "Which database should I use?",
  questions: [{ id: "q", header: "DB", question: "Which database should I use?", options: [] }],
  askedAt: null,
  closedAt: DateTime.formatIso(at),
  reopenedAt: null,
  ...fields,
});

it.effect("asks each closed question again once the service is no longer held, and only once", () =>
  withRecord((recordPath) =>
    Effect.gen(function* () {
      const world = newWorld({ held: true });
      const { store, reopener } = yield* reopenerFor(world, recordPath);
      yield* store.record([
        closed("q1"),
        closed("a1", { kind: "command", text: "Run npm publish" }),
      ]);

      // Held for the install (or gated until the helper verified it): nothing yet.
      assert.deepEqual(yield* reopener.reopenPending, []);
      assert.lengthOf(world.notes, 0);

      world.held = false;
      const outcomes = yield* reopener.reopenPending;
      assert.deepEqual(
        outcomes.map((entry) => [entry.requestId, entry.outcome]),
        [
          ["q1", { type: "reopened", by: "card" }],
          ["a1", { type: "reopened", by: "card" }],
        ],
      );
      // The note quotes what was closed, on the turn that asked.
      assert.deepEqual(
        world.notes.map((note) => [note.commandId, note.runId]),
        [
          ["service-update:reopen:q1:note", "r1"],
          ["service-update:reopen:a1:note", "r1"],
        ],
      );
      assert.include(world.notes[0]!.message, "> Which database should I use?");
      assert.include(world.notes[1]!.message, "> Run npm publish");
      // The question comes back as a card answered by message: Needs you, "Answer needed".
      assert.deepEqual(
        world.cards.map((card) => [card.requestId, card.runId, card.nodeId]),
        [
          ["update-reopen:q1", "r1", "node:r1"],
          // A closed approval's card keeps an approval id (a later sweep can release it).
          ["update-reopen-approval:a1", "r1", "node:r1"],
        ],
      );
      assert.lengthOf(yield* store.pending, 0);

      // The next pass, and a restart reading the same record, reopen nothing again.
      assert.deepEqual(yield* reopener.reopenPending, []);
      const restarted = yield* reopenerFor(world, recordPath);
      assert.deepEqual(yield* restarted.reopener.reopenPending, []);
      assert.lengthOf(world.notes, 2);
      assert.lengthOf(world.cards, 2);
    }),
  ),
);

it.effect("leaves the asking to a continuing agent where the project continues threads", () =>
  withRecord((recordPath) =>
    Effect.gen(function* () {
      const world = newWorld({ continues: true });
      // Closed by the process the update replaced; this one is the restarted service.
      const closing = yield* reopenerFor(world, recordPath);
      yield* closing.store.record([closed("q1")]);
      const { store, reopener } = yield* reopenerFor(world, recordPath);
      // The continuation has not started yet: nothing is said or asked meanwhile.
      assert.deepEqual(yield* reopener.reopenPending, []);
      assert.lengthOf(world.notes, 0);
      assert.lengthOf(world.cards, 0);
      world.projection = {
        ...world.projection,
        runs: [
          run("r1", 1, "interrupted"),
          run("r2", 2, "running", { restartContinuationOfRunId: "r1", requestedAt: at }),
        ],
      };
      // While the continuing agent runs, it asks: nothing else is asked.
      assert.deepEqual(yield* reopener.reopenPending, []);
      assert.lengthOf(world.notes, 0);
      // It asked again (its own question, after it started), then ended.
      world.projection = {
        ...world.projection,
        runs: [
          run("r1", 1, "interrupted"),
          run("r2", 2, "completed", { restartContinuationOfRunId: "r1", requestedAt: at }),
        ],
        runtimeRequests: [
          {
            id: RuntimeRequestId.make("q1"),
            status: "cancelled",
            kind: "user_input",
            createdAt: at,
          },
          {
            id: RuntimeRequestId.make("q-new"),
            status: "pending",
            kind: "user_input",
            createdAt: later,
          },
        ],
      };
      const outcomes = yield* reopener.reopenPending;
      assert.deepEqual(outcomes[0]?.outcome, { type: "reopened", by: "agent" });
      assert.include(world.notes[0]!.message, "The agent continues and asks it again.");
      assert.lengthOf(world.cards, 0);
      assert.deepEqual(
        (yield* store.forRun("t1", "r1")).map((entry) => entry.reopenedBy),
        ["agent"],
      );
      // A turn that is not the one continued gets its card after all.
      world.projection = {
        ...world.projection,
        runs: [run("r1", 1, "interrupted"), run("r2", 2, "completed")],
      };
      yield* store.record([closed("q2", { runId: "r1" })]);
      world.projection = {
        ...world.projection,
        runtimeRequests: [{ id: RuntimeRequestId.make("q2"), status: "cancelled" }],
      };
      const second = yield* reopener.reopenPending;
      assert.deepEqual(second[0]?.outcome, { type: "reopened", by: "card" });
      assert.lengthOf(world.cards, 1);
      // A continuation that runs later leaves out what a card already asks.
      assert.deepEqual(
        (yield* store.forRun("t1", "r1")).map((entry) => [entry.requestId, entry.reopenedBy]),
        [
          ["q1", "agent"],
          ["q2", "card"],
        ],
      );
    }),
  ),
);

it.effect("asks with a card when the continuing agent ends without asking again", () =>
  withRecord((recordPath) =>
    Effect.gen(function* () {
      const world = newWorld({ continues: true });
      const closing = yield* reopenerFor(world, recordPath);
      yield* closing.store.record([closed("q1")]);
      const { reopener } = yield* reopenerFor(world, recordPath);
      // The continuation failed (its provider was down), or went on without asking.
      world.projection = {
        ...world.projection,
        runs: [
          run("r1", 1, "interrupted"),
          run("r2", 2, "failed", { restartContinuationOfRunId: "r1", requestedAt: at }),
        ],
        runtimeRequests: [
          {
            id: RuntimeRequestId.make("q1"),
            status: "cancelled",
            kind: "user_input",
            createdAt: at,
          },
        ],
      };
      const outcomes = yield* reopener.reopenPending;
      assert.deepEqual(outcomes[0]?.outcome, { type: "reopened", by: "card" });
      // Needs you either way: the card asks.
      assert.deepEqual(
        world.cards.map((card) => card.requestId),
        ["update-reopen:q1"],
      );
      assert.include(world.notes[0]!.message, "It is asked again below.");
    }),
  ),
);

it.effect("asks with a card when the update was cancelled, though the project continues", () =>
  withRecord((recordPath) =>
    Effect.gen(function* () {
      // The drain closed the approval, then the update was cancelled (or refused,
      // or its hold ran out): this process never restarts, so nothing continues.
      const world = newWorld({ continues: true });
      const { store, reopener } = yield* reopenerFor(world, recordPath);
      yield* store.record([closed("a1", { kind: "command", text: "Run npm publish" })]);
      const outcomes = yield* reopener.reopenPending;
      assert.deepEqual(outcomes[0]?.outcome, { type: "reopened", by: "card" });
      assert.include(world.notes[0]!.message, "It is asked again below.");
      assert.deepEqual(
        world.cards.map((card) => card.requestId),
        ["update-reopen-approval:a1"],
      );
    }),
  ),
);

it.effect("asks with a card when the restart continuation never starts", () =>
  withRecord((recordPath) =>
    Effect.gen(function* () {
      const world = newWorld({ continues: true });
      const closing = yield* reopenerFor(world, recordPath);
      yield* closing.store.record([closed("q1")]);
      const { reopener } = yield* reopenerFor(world, recordPath);
      // The continuation skips the turn (its provider changed, say): no run follows.
      assert.deepEqual(yield* reopener.reopenPending, []);
      yield* TestClock.adjust(Duration.millis(Reopen.CONTINUATION_WAIT_MS - 1));
      assert.deepEqual(yield* reopener.reopenPending, []);
      yield* TestClock.adjust(Duration.millis(1));
      const outcomes = yield* reopener.reopenPending;
      assert.deepEqual(outcomes[0]?.outcome, { type: "reopened", by: "card" });
      assert.lengthOf(world.cards, 1);
      assert.lengthOf(world.notes, 1);
    }),
  ),
);

it.effect("reopens nothing while the install request it was closed for still waits", () =>
  withRecord((recordPath) =>
    Effect.gen(function* () {
      // Between two drains of one update the hold can lapse (the agent fetched
      // the release, the restarted service holds nothing yet): not over yet.
      const world = newWorld({ requestOpen: true });
      const { store, reopener } = yield* reopenerFor(world, recordPath);
      yield* store.record([closed("q1")]);
      assert.deepEqual(yield* reopener.reopenPending, []);
      assert.lengthOf(world.cards, 0);
      assert.lengthOf(yield* store.pending, 1);
      world.requestOpen = false;
      const outcomes = yield* reopener.reopenPending;
      assert.deepEqual(outcomes[0]?.outcome, { type: "reopened", by: "card" });
    }),
  ),
);

it.effect("asks on the thread's latest turn when the closed one was not known", () =>
  withRecord((recordPath) =>
    Effect.gen(function* () {
      const world = newWorld();
      world.projection = {
        ...world.projection,
        runs: [run("r1", 1, "completed"), run("r2", 2, "interrupted"), run("r3", 3, "queued")],
      };
      const { store, reopener } = yield* reopenerFor(world, recordPath);
      // The thread could not be read when the drain recorded it.
      yield* store.record([closed("q1", { runId: null, text: "A question for you." })]);
      const outcomes = yield* reopener.reopenPending;
      assert.deepEqual(outcomes[0]?.outcome, { type: "reopened", by: "card" });
      assert.deepEqual(
        world.cards.map((card) => [card.requestId, card.runId]),
        [["update-reopen:q1", "r2"]],
      );
      assert.equal(world.notes[0]?.runId, "r2");
    }),
  ),
);

it.effect("asks what an automatic install's sweep closed once that install is over", () =>
  withRecord((recordPath) =>
    Effect.gen(function* () {
      const world = newWorld({ installUnderway: true });
      const sweeping = yield* reopenerFor(world, recordPath);
      yield* sweeping.store.record([
        closed("a1", { kind: "command", text: "Run npm publish", reopenAfterRestart: true }),
      ]);
      // Asked again now, it would hold the install it was released for.
      assert.deepEqual(yield* sweeping.reopener.reopenPending, []);
      assert.lengthOf(world.cards, 0);
      // A restart that was not the install (the Mac rebooted): the install still waits.
      const rebooted = yield* reopenerFor(world, recordPath);
      assert.deepEqual(yield* rebooted.reopener.reopenPending, []);
      assert.lengthOf(world.cards, 0);
      // Installed (or failed, or cancelled): asked again.
      world.installUnderway = false;
      const outcomes = yield* rebooted.reopener.reopenPending;
      assert.deepEqual(outcomes[0]?.outcome, { type: "reopened", by: "card" });
      assert.deepEqual(
        world.cards.map((card) => card.requestId),
        ["update-reopen-approval:a1"],
      );
    }),
  ),
);

it.effect("asks what the sweep closed in the same process when its install ends unrestarted", () =>
  withRecord((recordPath) =>
    Effect.gen(function* () {
      const world = newWorld({ installUnderway: true });
      const { store, reopener } = yield* reopenerFor(world, recordPath);
      yield* store.record([
        closed("a1", { kind: "command", text: "Run npm publish", reopenAfterRestart: true }),
      ]);
      assert.deepEqual(yield* reopener.reopenPending, []);
      // The install failed verification, or the person cancelled it: no restart follows.
      world.installUnderway = false;
      const outcomes = yield* reopener.reopenPending;
      assert.deepEqual(outcomes[0]?.outcome, { type: "reopened", by: "card" });
      assert.lengthOf(world.cards, 1);
      assert.lengthOf(yield* store.pending, 0);
    }),
  ),
);

it.effect("tries a thread that cannot be read again, and drops only one that is gone", () =>
  withRecord((recordPath) =>
    Effect.gen(function* () {
      const world = newWorld({ readFailure: new Error("SQLITE_BUSY") });
      const { store, reopener } = yield* reopenerFor(world, recordPath);
      yield* store.record([closed("q1")]);
      // A read that fails now (the database busy right after the restart): kept for later.
      assert.deepEqual(yield* reopener.reopenPending, []);
      assert.lengthOf(yield* store.pending, 1);
      world.readFailure = null;
      const outcomes = yield* reopener.reopenPending;
      assert.deepEqual(outcomes[0]?.outcome, { type: "reopened", by: "card" });
      // A thread that is not there is gone for good.
      yield* store.record([closed("q2", { threadId: "gone" })]);
      world.readFailure = {
        _tag: "OrchestratorProjectionError",
        cause: new ProjectionStoreThreadNotFoundError({ threadId: ThreadId.make("gone") }),
      };
      const gone = yield* reopener.reopenPending;
      assert.deepEqual(gone[0]?.outcome, { type: "skipped", reason: "thread-gone" });
      assert.lengthOf(yield* store.pending, 0);
    }),
  ),
);

it.effect("stops a pass when a drain starts, and records afresh what it never closed", () =>
  withRecord((recordPath) =>
    Effect.gen(function* () {
      const world = newWorld();
      const { store, reopener } = yield* reopenerFor(world, recordPath);
      yield* store.record([closed("q1"), closed("a1", { kind: "command", text: "Run it" })]);
      // Update now is pressed while the pass reads q1's thread.
      const drain = yield* Deferred.make<Fiber.Fiber<number>>();
      world.onRead = Effect.gen(function* () {
        world.onRead = Effect.void;
        // The drain starts only after the pass under way ended: it sees q1's card.
        const fiber = yield* store
          .draining(Effect.sync(() => world.cards.length))
          .pipe(Effect.forkDetach);
        yield* Deferred.succeed(drain, fiber);
        yield* Effect.yieldNow;
      });
      const outcomes = yield* reopener.reopenPending;
      // q1 was under way and finishes; a1 waits for the update to be over.
      assert.deepEqual(
        outcomes.map((entry) => entry.requestId),
        ["q1"],
      );
      assert.equal(yield* Fiber.join(yield* Deferred.await(drain)), 1);
      assert.lengthOf(world.cards, 1);
      // A question the drain recorded and then never closed (it stopped first):
      // still open, so it is not asked again, and the next drain records it afresh.
      world.projection = {
        ...world.projection,
        runtimeRequests: [{ id: RuntimeRequestId.make("a1"), status: "pending" }],
      };
      const skipped = yield* reopener.reopenPending;
      assert.deepEqual(skipped[0]?.outcome, { type: "skipped", reason: "request-pending" });
      assert.lengthOf(yield* store.pending, 0);
      assert.isTrue(yield* store.record([closed("a1", { kind: "command", text: "Run it" })]));
      assert.deepEqual(
        (yield* store.pending).map((entry) => entry.requestId),
        ["a1"],
      );
    }),
  ),
);

it.effect("asks nothing again on a resolved thread, nor on a subagent of one", () =>
  withRecord((recordPath) =>
    Effect.gen(function* () {
      const world = newWorld();
      const t1 = world.projection.thread as Record<string, unknown>;
      world.projection = { ...world.projection, thread: { ...t1, settledOverride: "settled" } };
      const { store, reopener } = yield* reopenerFor(world, recordPath);
      yield* store.record([closed("q1")]);
      const resolved = yield* reopener.reopenPending;
      assert.deepEqual(resolved[0]?.outcome, { type: "skipped", reason: "thread-resolved" });

      // A subagent whose grandparent was resolved: its asks were settled with it.
      world.projection = {
        ...world.projection,
        thread: {
          ...t1,
          settledOverride: null,
          lineage: { parentThreadId: "review", relationshipToParent: "subagent" },
        },
      };
      world.parents = {
        review: {
          id: "review",
          settledOverride: null,
          lineage: { parentThreadId: "root", relationshipToParent: "subagent" },
        },
        root: { id: "root", settledOverride: "settled", lineage: null },
      };
      yield* store.record([closed("q2")]);
      const folded = yield* reopener.reopenPending;
      assert.deepEqual(folded[0]?.outcome, { type: "skipped", reason: "thread-resolved" });
      assert.lengthOf(world.notes, 0);
      assert.lengthOf(world.cards, 0);

      // Once the parent is reopened, the question is asked again.
      world.parents = {
        ...world.parents,
        root: { id: "root", settledOverride: "active", lineage: null },
      };
      yield* store.record([closed("q3")]);
      const reopened = yield* reopener.reopenPending;
      assert.deepEqual(reopened[0]?.outcome, { type: "reopened", by: "card" });
    }),
  ),
);

it.effect(
  "reopens questions on active forks and their subagents even when the source is resolved",
  () =>
    withRecord((recordPath) =>
      Effect.gen(function* () {
        const world = newWorld();
        const t1 = world.projection.thread as Record<string, unknown>;
        world.projection = {
          ...world.projection,
          thread: {
            ...t1,
            settledOverride: "active",
            lineage: { parentThreadId: "root", relationshipToParent: "fork" },
          },
        };
        world.parents = {
          root: { id: "root", settledOverride: "settled", lineage: null },
        };
        const { store, reopener } = yield* reopenerFor(world, recordPath);
        yield* store.record([closed("q1")]);
        assert.deepEqual((yield* reopener.reopenPending)[0]?.outcome, {
          type: "reopened",
          by: "card",
        });

        // A subagent belongs to its active fork, not to the fork's resolved source.
        world.projection = {
          ...world.projection,
          thread: {
            ...t1,
            lineage: { parentThreadId: "fork", relationshipToParent: "subagent" },
          },
        };
        world.parents = {
          ...world.parents,
          fork: {
            id: "fork",
            settledOverride: "active",
            lineage: { parentThreadId: "root", relationshipToParent: "fork" },
          },
        };
        yield* store.record([closed("q2")]);
        assert.deepEqual((yield* reopener.reopenPending)[0]?.outcome, {
          type: "reopened",
          by: "card",
        });
        assert.lengthOf(world.cards, 2);
        assert.lengthOf(world.notes, 2);
        assert.lengthOf(yield* store.pending, 0);
      }),
    ),
);

it.effect("reopens nothing that was answered, nor on a closed thread, and waits out a drain", () =>
  withRecord((recordPath) =>
    Effect.gen(function* () {
      const world = newWorld();
      world.projection = {
        ...world.projection,
        runtimeRequests: [
          { id: RuntimeRequestId.make("q1"), status: "resolved", decision: "accept" },
        ],
      };
      const { store, reopener } = yield* reopenerFor(world, recordPath);
      yield* store.record([closed("q1")]);
      // While a drain runs, nothing is reopened under it.
      const during = yield* store.draining(reopener.reopenPending);
      assert.deepEqual(during, []);
      const outcomes = yield* reopener.reopenPending;
      assert.deepEqual(outcomes[0]?.outcome, { type: "skipped", reason: "request-resolved" });
      yield* store.record([closed("q9")]);
      world.projection = {
        ...world.projection,
        thread: { ...(world.projection.thread as object), archivedAt: later },
      };
      const archived = yield* reopener.reopenPending;
      assert.deepEqual(archived[0]?.outcome, { type: "skipped", reason: "thread-closed" });
      assert.lengthOf(world.notes, 0);
      assert.lengthOf(world.cards, 0);
      assert.lengthOf(yield* store.pending, 0);
    }),
  ),
);

it.effect("does not reopen an answered restored copy after another update", () =>
  withRecord((recordPath) =>
    Effect.gen(function* () {
      const world = newWorld({ continues: false });
      const { store, reopener } = yield* reopenerFor(world, recordPath);
      yield* store.record([closed("q1")]);
      world.projection = {
        ...world.projection,
        runtimeRequests: [
          {
            id: RuntimeRequestId.make("q1"),
            status: "cancelled",
            kind: "user_input",
            createdAt: at,
          },
          {
            id: RuntimeRequestId.make("update-reopen:q1"),
            status: "resolved",
            kind: "user_input",
            createdAt: later,
            answers: { q1: "Accept both" },
          },
        ],
      } as never;
      const outcomes = yield* reopener.reopenPending;
      assert.deepEqual(outcomes[0]?.outcome, {
        type: "skipped",
        reason: "request-family-answered",
      });
      assert.lengthOf(world.cards, 0);
    }),
  ),
);

for (const [askedAt, reopen] of [
  ["2026-10-29T11:00:00Z", false],
  ["2026-10-29T12:00:00Z", false],
  ["2026-10-29T13:00:00Z", true],
  [null, false],
] as const)
  it.effect(
    `keeps original ask chronology ${String(askedAt)} through nested settled ancestry`,
    () =>
      withRecord((recordPath) =>
        Effect.gen(function* () {
          const world = newWorld();
          const t1 = world.projection.thread as Record<string, unknown>;
          world.projection = {
            ...world.projection,
            thread: {
              ...t1,
              settledOverride: "active",
              lineage: { parentThreadId: "middle", relationshipToParent: "subagent" },
            },
          };
          world.parents = {
            middle: {
              id: "middle",
              settledOverride: "settled",
              settledAt: DateTime.makeUnsafe("2026-10-29T10:00:00Z"),
              lineage: { parentThreadId: "root", relationshipToParent: "subagent" },
            },
            root: {
              id: "root",
              settledOverride: "settled",
              settledAt: DateTime.makeUnsafe("2026-10-29T12:00:00Z"),
              lineage: null,
            },
          };
          const { store, reopener } = yield* reopenerFor(world, recordPath);
          yield* store.record([closed("q1", { askedAt })]);
          const result = yield* reopener.reopenPending;
          expect(result[0]?.outcome).toEqual(
            reopen
              ? { type: "reopened", by: "card" }
              : { type: "skipped", reason: "thread-resolved" },
          );
          expect(world.cards).toHaveLength(reopen ? 1 : 0);
          if (reopen) expect(world.cards[0]?.reopenedFromAskedAt).toBe(askedAt);
          expect(yield* reopener.reopenPending).toEqual([]);
        }),
      ),
  );

it.effect("captures reopened cards with their original ask time on another update", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_v2_projection_runtime_requests (runtime_request_id TEXT, thread_id TEXT, status TEXT, kind TEXT, created_at TEXT)`;
    yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests VALUES
      ('update-reopen:q1', 't1', 'pending', 'user_input', '2026-10-29T15:00:00Z'),
      ('update-reopen:legacy', 't1', 'pending', 'user_input', '2026-10-29T15:00:00Z')`;
    const entries = yield* Reopen.captureOpenRequests({
      sql,
      threads: {
        getThreadRecords: () =>
          Effect.succeed({
            thread: { title: "Task" },
            nodes: [],
            turnItems: [],
            runtimeRequests: [
              { id: "update-reopen:q1", reopenedFromAskedAt: "2026-10-29T13:00:00Z" },
              { id: "update-reopen:legacy" },
            ],
          } as never),
      },
    });
    expect(entries.map((entry) => [entry.requestId, entry.askedAt])).toEqual([
      ["update-reopen:q1", "2026-10-29T13:00:00Z"],
      ["update-reopen:legacy", null],
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
