/**
 * What a handed-off worker's delivery survives: either machine restarting,
 * the takeover replayed, a source that cannot record the follow, and a peer on
 * another release. The world is handoffFollow.testkit.ts; a restart is the
 * same machine built again over what it kept.
 */
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { RELEASED_PEER } from "../fleet/releasedPeer.testkit.ts";
import { allow, quiet, rows, settled } from "../fleet/remoteWorkers.testkit.ts";
import { launcher, removeStages, type Stage, stage, target, worker } from "./handoffFollow.testkit.ts";

afterEach(removeStages);

const LIVE = { timeout: 30_000 };

const begin = (life: ReturnType<Stage["boot"]>) =>
  Effect.andThen(allow("auto", target.id), life.start);

const keptCount = (s: Stage) => Effect.sync(() => s.kept.length);

describe("a handed-off worker's delivery", () => {
  it.live(
    `from a source with this change to a target on ${RELEASED_PEER.tag}: one message, through a replayed takeover and a restart of each machine`,
    () => {
      const s = stage();
      const first = s.boot();
      const second = s.boot();
      const third = s.boot();
      return Effect.gen(function* () {
        const run = yield* Effect.gen(function* () {
          const { handOff } = yield* begin(first);
          yield* handOff;
          const going = s.lastRun().run;
          yield* settled(first.world, rows, (current) => current[0]?.followedRunId === going.id);
          return going;
        }).pipe(Effect.provide(first.layer));
        // Nothing has ended on the target, so the launcher was told nothing.
        expect(s.kept).toEqual([]);

        // The target restarts, and the takeover the source sent reaches it once more.
        yield* s.restartTarget;
        const [request] = s.network.takeovers;
        if (request === undefined) return yield* Effect.die("The source sent no takeover.");
        const again = yield* s.replayTakeover(request);
        expect(again.threadId).toBe(s.launches[0]?.threadId);
        expect(s.launches).toHaveLength(1);
        expect(s.peer.threads.size).toBe(1);
        expect(s.lastRun().run.id).toBe(run.id);

        // The run ends while the source is down; the source's next life has only its folder.
        yield* s.finish();
        yield* Effect.gen(function* () {
          const { moves, handOff } = yield* second.start;
          yield* settled(second.world, keptCount(s), (count) => count === 1);
          const [row] = yield* settled(
            second.world,
            rows,
            (current) => current[0]?.state === "idle",
          );
          expect(s.kept).toMatchObject([
            { threadId: launcher, commandId: `remote-worker-wake:${row?.id}` },
          ]);
          // The same handoff asked again, and later heartbeats, add nothing.
          expect((yield* handOff).threadId).toBe(again.threadId);
          yield* moves.tick;
          yield* moves.tick;
          yield* quiet(second.world);
        }).pipe(Effect.provide(second.layer));

        // The source restarts after the delivery: it may send the same message again.
        yield* Effect.gen(function* () {
          yield* settled(
            third.world,
            Effect.sync(() => third.world.wakes.length),
            (sends) => sends >= 1,
          );
          yield* quiet(third.world);
          expect(yield* rows).toHaveLength(1);
        }).pipe(Effect.provide(third.layer));

        // Every send of all three lives went to the launcher under one id, which its
        // thread took once.
        const sends = [...first.world.wakes, ...second.world.wakes, ...third.world.wakes];
        expect(sends.length).toBeGreaterThanOrEqual(2);
        expect(new Set(sends.map((send) => send.threadId))).toEqual(new Set([launcher]));
        expect(new Set(sends.map((send) => send.commandId)).size).toBe(1);
        expect(s.kept).toHaveLength(1);
      });
    },
    LIVE,
  );

  it.live(
    "from a source on the release before this change to a target with it: the move is made as before and the launcher is told nothing (the baseline, not a delivery)",
    () => {
      const s = stage();
      const life = s.boot();
      return Effect.gen(function* () {
        const old = yield* s.makeMovesAlone;
        const moved = yield* s.handOffWith(old);
        expect(s.launches.map((launch) => launch.threadId)).toEqual([moved.threadId]);
        expect(s.documents.source.threads[worker]?.continuedOn?.threadId).toBe(moved.threadId);
        yield* s.finish();
        yield* old.tick;
        // A later life of that source finds nothing to follow: no row was ever written.
        yield* Effect.gen(function* () {
          yield* quiet(life.world);
          expect(yield* rows).toEqual([]);
        }).pipe(Effect.provide(life.layer));
        expect(s.peer.calls).toEqual([]);
        expect(s.kept).toEqual([]);
      });
    },
    LIVE,
  );

  const cannotRecord = [
    [
      "the follow cannot be written to disk",
      (s: Stage, life: ReturnType<Stage["boot"]>, broken: boolean) => {
        life.world.storeFails = broken;
        return s;
      },
    ],
    [
      "the thread that launched it cannot be read",
      (s: Stage, _life: ReturnType<Stage["boot"]>, broken: boolean) => {
        s.fixture.launcherLookupFails = broken;
        return s;
      },
    ],
  ] as const;
  for (const [why, arrange] of cannotRecord) {
    it.live(
      `does not move a waited-for worker while ${why}`,
      () => {
        const s = stage();
        const life = s.boot();
        return Effect.gen(function* () {
          const { handOff } = yield* begin(life);
          arrange(s, life, true);
          const declined = yield* handOff.pipe(Effect.flip);
          expect(declined.code).toBe("failed");
          // Nothing left the source, and the thread is its own again.
          expect(s.network.takeovers).toEqual([]);
          expect(s.launches).toEqual([]);
          expect(s.documents.source.threads[worker]).toMatchObject({
            lease: { state: "active", epoch: 1 },
            continuedOn: null,
          });
          expect(s.documents.source.threads[worker]?.pendingTakeover ?? null).toBeNull();
          expect(yield* rows).toEqual([]);
          // Once it can be recorded the same move goes through and reports once.
          arrange(s, life, false);
          const moved = yield* handOff;
          expect(yield* rows).toMatchObject([
            { state: "following", callerThreadId: launcher, remoteThreadId: moved.threadId },
          ]);
          yield* s.finish();
          yield* settled(life.world, rows, (current) => current[0]?.state === "idle");
          expect(s.kept).toMatchObject([{ threadId: launcher }]);
        }).pipe(Effect.provide(life.layer));
      },
      LIVE,
    );
  }

  it.live(
    "records the follow it could not write when a heartbeat fences the source, and writes it on a later tick",
    () => {
      const s = stage();
      const life = s.boot();
      return Effect.gen(function* () {
        // The takeover left a source that wrote no follow (the release before this
        // change), and its answer was lost: the target continued the thread unseen.
        const old = yield* s.makeMovesAlone;
        s.network.dropTakeoverAnswer = true;
        expect((yield* s.handOffWith(old).pipe(Effect.flip)).code).toBe("unreachable");
        s.network.dropTakeoverAnswer = false;
        expect(s.launches).toHaveLength(1);
        const continuation = s.launches[0]?.threadId;

        yield* Effect.gen(function* () {
          const { moves } = yield* begin(life);
          // The source learns of it from a heartbeat while its disk cannot be written.
          life.world.storeFails = true;
          yield* moves.tick;
          const fenced = s.documents.source.threads[worker];
          expect(fenced?.continuedOn?.threadId).toBe(continuation);
          expect(fenced?.followOwed).toMatchObject({
            destinationEnvironmentId: target.environmentId,
            epoch: 2,
            threadId: continuation,
          });
          expect(yield* rows).toEqual([]);
          // The disk is back: the next tick writes the row and owes nothing more.
          life.world.storeFails = false;
          yield* moves.tick;
          expect(s.documents.source.threads[worker]?.followOwed ?? null).toBeNull();
          expect(yield* rows).toMatchObject([
            { state: "following", callerThreadId: launcher, remoteThreadId: continuation },
          ]);
          yield* s.finish();
          const [row] = yield* settled(
            life.world,
            rows,
            (current) => current[0]?.state === "idle",
          );
          yield* moves.tick;
          yield* quiet(life.world);
          expect(s.kept.map((message) => message.commandId)).toEqual([
            `remote-worker-wake:${row?.id}`,
          ]);
        }).pipe(Effect.provide(life.layer));
      });
    },
    LIVE,
  );
});
