/**
 * A worker a thread on the source launched is handed off to the target; its
 * result must reach that thread once. The world is handoffFollow.testkit.ts:
 * real moves and a real receiver over real Git repositories, the target's
 * thread tools answering as a released peer does.
 */
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  allow,
  type KeptMessage,
  quiet,
  rows,
  settled,
  type World,
} from "../fleet/remoteWorkers.testkit.ts";
import {
  launcher,
  removeStages,
  type Stage,
  stage,
  target,
  worker,
} from "./handoffFollow.testkit.ts";

afterEach(removeStages);

const LIVE = { timeout: 30_000 };

const keptCount = (kept: ReadonlyArray<KeptMessage>) => Effect.sync(() => kept.length);

/** The first life of the source: it may run work on the target, and its moves are built. */
const begin = (life: ReturnType<Stage["boot"]>) =>
  Effect.andThen(allow("auto", target.id), life.start);

/** The follower asked the target at least `more` more times, so "nothing said" was observed. */
const askedAgain = (world: World, peer: Stage["peer"], more = 2) =>
  Effect.suspend(() => {
    const before = peer.calls.length;
    return settled(
      world,
      Effect.sync(() => peer.calls.length),
      (calls) => calls >= before + more,
    );
  });

/** One message per handoff, whichever run is its result: the id is the row's. */
const wakeOf = (rowId: string | undefined, _runId: string) => `remote-worker-wake:${rowId}`;

describe("a handed-off worker's result", () => {
  it.live(
    "reaches the thread that launched it once, and nothing is said while the run is going",
    () => {
      const s = stage();
      const life = s.boot();
      return Effect.gen(function* () {
        const { moves, handOff } = yield* begin(life);
        const moved = yield* handOff;
        expect(s.launches.map((launch) => launch.threadId)).toEqual([moved.threadId]);
        const { run } = s.lastRun();
        yield* settled(life.world, rows, (current) => current[0]?.followedRunId === run.id);
        yield* askedAgain(life.world, s.peer);
        expect(s.kept).toEqual([]);
        yield* s.finish();
        const [row] = yield* settled(life.world, rows, (current) => current[0]?.state === "idle");
        expect(row).toMatchObject({
          callerThreadId: launcher,
          remoteThreadId: moved.threadId,
          machineId: target.id,
          lastStatus: "completed",
          deliveredRunIds: [run.id],
        });
        expect(s.kept).toMatchObject([{ threadId: launcher, commandId: wakeOf(row?.id, run.id) }]);
        expect(s.kept[0]?.text).toContain("finished: completed");
        expect(life.world.wakes[0]?.mode).toBe("queue");
        // The same handoff asked again, and later heartbeats, add nothing.
        expect((yield* handOff).threadId).toBe(moved.threadId);
        yield* moves.tick;
        yield* moves.tick;
        yield* quiet(life.world);
        expect(s.kept).toHaveLength(1);
        expect(yield* rows).toHaveLength(1);
        expect(s.documents.source.threads[worker]?.continuedOn?.threadId).toBe(moved.threadId);
      }).pipe(Effect.provide(life.layer));
    },
    LIVE,
  );

  it.live(
    "keeps asking for a continuation the target does not have yet, then reports its run once",
    () => {
      const s = stage();
      const life = s.boot();
      return Effect.gen(function* () {
        const { moves, handOff } = yield* begin(life);
        s.network.dropTakeoverRequest = true;
        expect((yield* handOff.pipe(Effect.flip)).code).toBe("unreachable");
        expect(s.launches).toHaveLength(0);
        // The target answers "no such thread" for as long as the takeover is open.
        yield* askedAgain(life.world, s.peer, 4);
        expect(yield* rows).toMatchObject([{ state: "following", deliveredRunIds: [] }]);
        expect(s.kept).toEqual([]);
        // The takeover gets through on the next heartbeat.
        s.network.dropTakeoverRequest = false;
        yield* moves.tick;
        expect(s.launches).toHaveLength(1);
        const { run } = s.lastRun();
        yield* settled(life.world, rows, (current) => current[0]?.followedRunId === run.id);
        expect(s.kept).toEqual([]);
        yield* s.finish();
        const [row] = yield* settled(life.world, rows, (current) => current[0]?.state === "idle");
        expect(row?.remoteThreadId).toBe(s.launches[0]?.threadId);
        expect(s.kept.map((message) => message.commandId)).toEqual([wakeOf(row?.id, run.id)]);
      }).pipe(Effect.provide(life.layer));
    },
    LIVE,
  );

  it.live(
    "reports once when the takeover's answer was lost and a heartbeat fences the source later",
    () => {
      const s = stage();
      const life = s.boot();
      return Effect.gen(function* () {
        const { moves, handOff } = yield* begin(life);
        s.network.dropTakeoverAnswer = true;
        expect((yield* handOff.pipe(Effect.flip)).code).toBe("unreachable");
        // The target did continue it, and finishes before the source learns that.
        expect(s.launches).toHaveLength(1);
        expect(s.documents.source.threads[worker]?.continuedOn).toBeNull();
        const { run } = s.lastRun();
        yield* s.finish();
        yield* settled(life.world, rows, (current) => current[0]?.state === "idle");
        expect(s.kept).toHaveLength(1);
        s.network.dropTakeoverAnswer = false;
        yield* moves.tick;
        yield* moves.tick;
        yield* quiet(life.world);
        expect(s.documents.source.threads[worker]?.continuedOn?.threadId).toBe(
          s.launches[0]?.threadId,
        );
        expect(s.kept).toHaveLength(1);
        expect(yield* rows).toMatchObject([{ state: "idle", deliveredRunIds: [run.id] }]);
      }).pipe(Effect.provide(life.layer));
    },
    LIVE,
  );

  it.live(
    "stops following when the target refuses, and follows the handoff that goes through",
    () => {
      const s = stage();
      const life = s.boot();
      return Effect.gen(function* () {
        const { handOff } = yield* begin(life);
        s.network.refuseTakeover = true;
        expect((yield* handOff.pipe(Effect.flip)).code).toBe("busy");
        expect(s.documents.source.threads[worker]?.lease?.state).toBe("active");
        const [refused] = yield* rows;
        expect(refused).toMatchObject({ state: "disposed", deliveredRunIds: [] });
        expect(yield* rows).toHaveLength(1);
        expect(s.kept).toEqual([]);
        // The same thread is handed off again, and this time it is taken. The refused
        // epoch is used up, so the move that goes through has a follow of its own.
        s.network.refuseTakeover = false;
        const moved = yield* handOff;
        const { run } = s.lastRun();
        yield* settled(life.world, rows, (current) =>
          current.some((row) => row.followedRunId === run.id),
        );
        expect(s.kept).toEqual([]);
        yield* s.finish();
        const current = yield* settled(life.world, rows, (all) =>
          all.some((row) => row.state === "idle"),
        );
        expect(current).toHaveLength(2);
        // The refused move's follow stays ended and told the launcher nothing.
        expect(current.find((row) => row.id === refused?.id)).toMatchObject({
          state: "disposed",
          deliveredRunIds: [],
        });
        // The move that went through is another row, and the one result came from it.
        const accepted = current.find((row) => row.id !== refused?.id);
        expect(accepted).toMatchObject({
          state: "idle",
          callerThreadId: launcher,
          remoteThreadId: moved.threadId,
          deliveredRunIds: [run.id],
        });
        expect(s.kept).toHaveLength(1);
        expect(s.kept).toMatchObject([
          { threadId: launcher, commandId: wakeOf(accepted?.id, run.id) },
        ]);
      }).pipe(Effect.provide(life.layer));
    },
    LIVE,
  );

  it.live(
    "reports nothing for a worker that arrives idle until a message there starts a run",
    () => {
      const s = stage();
      const life = s.boot();
      return Effect.gen(function* () {
        const { handOff } = yield* begin(life);
        // Its last run on the source completed, so the continuation waits for a message.
        s.fixture.runEnding = "completed";
        const moved = yield* handOff;
        expect(s.launches[0]?.initialMessage).toBeUndefined();
        expect(s.peer.threads.get(moved.threadId)?.runs).toEqual([]);
        yield* settled(life.world, rows, (current) => current[0]?.handoff?.awaiting === "run");
        yield* askedAgain(life.world, s.peer);
        expect(yield* rows).toMatchObject([{ state: "following", deliveredRunIds: [] }]);
        expect(s.kept).toEqual([]);
        // Someone on the target sends it a message.
        const run = s.peer.start(moved.threadId, { creationSource: "web" });
        s.changed.fire();
        yield* settled(life.world, rows, (current) => current[0]?.followedRunId === run.id);
        expect(s.kept).toEqual([]);
        yield* s.finish();
        const [row] = yield* settled(life.world, rows, (current) => current[0]?.state === "idle");
        expect(s.kept.map((message) => message.commandId)).toEqual([wakeOf(row?.id, run.id)]);
      }).pipe(Effect.provide(life.layer));
    },
    LIVE,
  );

  it.live(
    "reports once after the target could not be reached while the run finished",
    () => {
      const s = stage();
      const life = s.boot();
      return Effect.gen(function* () {
        const { moves, handOff } = yield* begin(life);
        yield* handOff;
        const { run } = s.lastRun();
        yield* settled(life.world, rows, (current) => current[0]?.followedRunId === run.id);
        // The two machines lose each other; the run ends meanwhile.
        s.peer.unreachable = true;
        yield* s.finish();
        yield* askedAgain(life.world, s.peer, 4);
        expect(s.kept).toEqual([]);
        expect(yield* rows).toMatchObject([{ state: "following", deliveredRunIds: [] }]);
        s.peer.unreachable = false;
        yield* settled(life.world, rows, (current) => current[0]?.state === "idle");
        yield* moves.tick;
        expect(s.kept).toHaveLength(1);
        expect(s.kept[0]?.text).toContain("finished: completed");
      }).pipe(Effect.provide(life.layer));
    },
    LIVE,
  );

  it.live(
    "reports nothing for a run stopped on the target, then the run that finishes",
    () => {
      const s = stage();
      const life = s.boot();
      return Effect.gen(function* () {
        const { handOff } = yield* begin(life);
        const moved = yield* handOff;
        const first = s.lastRun().run;
        yield* settled(life.world, rows, (current) => current[0]?.followedRunId === first.id);
        yield* s.finish("interrupted");
        yield* settled(
          life.world,
          rows,
          (current) =>
            current[0]?.followedRunId === null && current[0]?.handoff?.awaiting === "run",
        );
        yield* askedAgain(life.world, s.peer);
        expect(s.kept).toEqual([]);
        expect(yield* rows).toMatchObject([{ state: "following", deliveredRunIds: [] }]);
        const second = s.peer.start(moved.threadId, { creationSource: "web" });
        s.changed.fire();
        yield* settled(life.world, rows, (current) => current[0]?.followedRunId === second.id);
        yield* s.finish();
        const [row] = yield* settled(life.world, rows, (current) => current[0]?.state === "idle");
        expect(s.kept.map((message) => message.commandId)).toEqual([wakeOf(row?.id, second.id)]);
      }).pipe(Effect.provide(life.layer));
    },
    LIVE,
  );

  it.live(
    "reports the run that was going when a message queued behind it is cancelled",
    () => {
      const s = stage();
      const life = s.boot();
      return Effect.gen(function* () {
        const { handOff } = yield* begin(life);
        const moved = yield* handOff;
        const first = s.lastRun().run;
        yield* settled(life.world, rows, (current) => current[0]?.followedRunId === first.id);
        yield* s.finish("interrupted");
        yield* settled(
          life.world,
          rows,
          (current) =>
            current[0]?.followedRunId === null && current[0]?.handoff?.awaiting === "run",
        );
        // A message starts a run there, and a second message waits behind it.
        const going = s.peer.start(moved.threadId, { creationSource: "web" });
        const queued = s.peer.start(moved.threadId, { status: "queued", creationSource: "web" });
        s.changed.fire();
        yield* settled(life.world, rows, (current) => current[0]?.followedRunId === going.id);
        s.peer.set(moved.threadId, queued.id, "cancelled");
        yield* askedAgain(life.world, s.peer);
        expect(s.kept).toEqual([]);
        s.peer.set(moved.threadId, going.id, "completed");
        s.changed.fire();
        const [row] = yield* settled(life.world, rows, (current) => current[0]?.state === "idle");
        expect(s.kept.map((message) => message.commandId)).toEqual([wakeOf(row?.id, going.id)]);
      }).pipe(Effect.provide(life.layer));
    },
    LIVE,
  );

  it.live(
    "wakes a launcher that was settled meanwhile, once, as a worker on the source does",
    () => {
      const s = stage();
      const life = s.boot();
      return Effect.gen(function* () {
        const { handOff } = yield* begin(life);
        yield* handOff;
        // A settled thread still takes a message; only an archived or deleted one does not.
        life.world.caller.settled = true;
        yield* s.finish();
        yield* settled(life.world, rows, (current) => current[0]?.state === "idle");
        expect(s.kept).toHaveLength(1);
        expect(s.kept[0]?.text).toContain("finished: completed");
      }).pipe(Effect.provide(life.layer));
    },
    LIVE,
  );

  for (const gone of ["deleted", "archived"] as const) {
    it.live(
      `never wakes a launcher that was ${gone} meanwhile`,
      () => {
        const s = stage();
        const life = s.boot();
        return Effect.gen(function* () {
          const { handOff } = yield* begin(life);
          yield* handOff;
          life.world.caller[gone] = true;
          yield* s.finish();
          yield* settled(life.world, rows, (current) => current[0]?.state === "disposed");
          expect(s.kept).toEqual([]);
          expect(life.world.wakes).toEqual([]);
        }).pipe(Effect.provide(life.layer));
      },
      LIVE,
    );
  }

  const notWaitedFor = [
    [
      "a worker a delegated child launched",
      (s: Stage) => {
        s.fixture.launcherIs = "subagent";
      },
    ],
    [
      "a thread no agent's thread launched",
      (s: Stage) => {
        s.fixture.startedBy = "user";
      },
    ],
    [
      "a thread that is itself a continuation of another machine's work",
      (s: Stage) => {
        s.fixture.workerIs = "continuation";
      },
    ],
  ] as const;
  for (const [what, arrange] of notWaitedFor) {
    it.live(
      `moves ${what} as before and follows nothing`,
      () => {
        const s = stage();
        const life = s.boot();
        return Effect.gen(function* () {
          const { handOff } = yield* begin(life);
          arrange(s);
          const moved = yield* handOff;
          expect(s.launches.map((launch) => launch.threadId)).toEqual([moved.threadId]);
          yield* s.finish();
          yield* quiet(life.world);
          expect(yield* rows).toEqual([]);
          expect(s.peer.calls).toEqual([]);
          expect(yield* keptCount(s.kept)).toBe(0);
        }).pipe(Effect.provide(life.layer));
      },
      LIVE,
    );
  }
});
