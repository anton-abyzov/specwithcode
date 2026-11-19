// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * A handoff between a machine on the previous release and one on this release
 * (1390 AC-36), both ways, over the two in-memory machines of
 * `handoffMove.test.fixture.ts`. The previous release is the tag's own code:
 * its takeover sender (`previousRelease.handoffMoves.test.fixture.ts`) and its
 * receiver (`previousRelease.handoffReceiver.test.fixture.ts`), run on the
 * same stores a machine keeps when it updates.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { AwayConfig } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { AwayPeerPost } from "../away/awayPeerCall.ts";
import { makeAwaySleep, memorySleepStore } from "../away/awaySleepRoute.ts";
import { HandoffPeers } from "./handoffPeers.ts";
import * as HandoffReceiver from "./HandoffReceiver.ts";
import { turnRefusal } from "./HandoffTurnGate.ts";
import {
  handOff,
  m4,
  minis,
  registerCleanup,
  scenario,
  threadId,
} from "./handoffMove.test.fixture.ts";
import * as PreviousMoves from "./previousRelease.handoffMoves.test.fixture.ts";
import * as PreviousReceiver from "./previousRelease.handoffReceiver.test.fixture.ts";
import { PREVIOUS_RELEASE } from "./previousRelease.test.fixture.ts";

registerCleanup();

type Setup = Effect.Success<ReturnType<typeof scenario>>;

/** The continuation a takeover of the thread at epoch 2 launches on Minis. */
const continuation = HandoffReceiver.continuationThreadId(m4, threadId, 2);

/** M4 before it updated: the previous release's moves on M4's own stores and network. */
const previousSource = (setup: Setup) =>
  Effect.gen(function* () {
    const receiver = yield* HandoffReceiver.make;
    return yield* PreviousMoves.make.pipe(
      Effect.provideService(HandoffReceiver.HandoffReceiver, receiver),
    );
  }).pipe(
    Effect.provide(Layer.mergeAll(setup.sourceServices, Layer.succeed(HandoffPeers, setup.peers))),
  );

type PreviousSource = Effect.Success<ReturnType<typeof previousSource>>;

/** Minis before it updated: the previous release's receiver on Minis's own stores. */
const previousDestination = (setup: Setup) =>
  PreviousReceiver.make.pipe(Effect.provide(setup.destinationServices));

/** What the previous release's desktop asks when the lid closes on M4. */
const lidCloses = (previous: PreviousSource) =>
  previous.handOffMachine({ destinationEnvironmentId: minis, reason: "sleep" });

/**
 * M4 is running the thread on the previous release, its lid closes, and Minis is
 * still on that release too: Minis saves the continuation's lease, then its launch
 * fails (`launch`), and M4 hears that refusal or not (`answer`). Minis then updates.
 */
const earlierLidClose = (
  setup: Setup,
  previous: PreviousSource,
  launch: "fails" | "fails-after-create",
  answer: "heard" | "lost",
) =>
  Effect.gen(function* () {
    setup.wire.destination = yield* previousDestination(setup);
    setup.fixture.launch = launch;
    setup.network.dropTakeoverRefusal = answer === "lost";
    const run = yield* lidCloses(previous);
    expect(setup.destination.document.threads[continuation]?.lease?.epoch).toBe(2);
    setup.wire.destination = setup.destinationReceiver;
    setup.fixture.launch = "starts";
    setup.network.dropTakeoverRefusal = false;
    return run;
  });

const started = (setup: Setup) =>
  Effect.gen(function* () {
    NodeFS.writeFileSync(NodePath.join(setup.destinationRoot, ".env.local"), "TOKEN=minis\n");
    setup.fixture.activeRunId = "run-1";
    return yield* previousSource(setup);
  });

const dispatchedTypes = (setup: Setup) => setup.source.dispatched.map((command) => command.type);

describe(`a machine on ${PREVIOUS_RELEASE} sends a takeover from a lid close (1390 AC-36)`, () => {
  it.effect("nothing began on the destination: refused, the thread and its turn go on", () =>
    Effect.gen(function* () {
      const setup = yield* scenario();
      const previous = yield* started(setup);
      const run = yield* lidCloses(previous);
      expect(run.results).toEqual([
        expect.objectContaining({ threadId, outcome: "stayed", continuedThreadId: null }),
      ]);
      expect(run.results[0]?.detail).toContain("sleep and silence start nothing");
      const record = setup.source.document.threads[threadId];
      expect(record?.lease).toMatchObject({ state: "active", epoch: 1 });
      expect(record?.pendingTakeover).toBeNull();
      expect(record?.continuedOn).toBeNull();
      expect(record?.lastError).toBeNull();
      // The previous release stopped the turn for the move, then started it again here.
      expect(dispatchedTypes(setup)).toEqual(["run.interrupt", "message.dispatch"]);
      expect(setup.source.dispatched[1]).toMatchObject({ manualContinuationOfRunId: "run-1" });
      expect(turnRefusal(setup.source.document, threadId, m4)).toBeNull();
      expect(setup.destination.launches).toEqual([]);
    }),
  );

  it.effect("a lease saved before a failed launch: the same epoch launches nothing", () =>
    Effect.gen(function* () {
      const setup = yield* scenario();
      const previous = yield* started(setup);
      const first = yield* earlierLidClose(setup, previous, "fails", "heard");
      expect(first.results[0]).toMatchObject({ outcome: "stayed" });
      expect(setup.source.document.threads[threadId]?.lease).toMatchObject({
        state: "active",
        epoch: 1,
      });
      // The turn runs on here, and the next lid close asks for epoch 2 again.
      setup.fixture.activeRunId = "run-2";
      const again = yield* lidCloses(previous);
      expect(setup.destination.launches).toEqual([]);
      expect(again.results[0]).toMatchObject({ threadId, outcome: "skipped" });
      const record = setup.source.document.threads[threadId];
      expect(record?.lease).toMatchObject({ state: "active", epoch: 1 });
      expect(record?.pendingTakeover).toBeNull();
      expect(record?.continuedOn).toBeNull();
      expect(setup.source.dispatched.at(-1)).toMatchObject({
        type: "message.dispatch",
        manualContinuationOfRunId: "run-2",
      });
      expect(turnRefusal(setup.source.document, threadId, m4)).toBeNull();
    }),
  );

  it.effect("launched and never recorded: the same epoch gets that thread, nothing new", () =>
    Effect.gen(function* () {
      const setup = yield* scenario();
      const previous = yield* started(setup);
      yield* earlierLidClose(setup, previous, "fails-after-create", "heard");
      expect(setup.destination.launches.map((launch) => launch.threadId)).toEqual([continuation]);
      setup.fixture.activeRunId = "run-2";
      const again = yield* lidCloses(previous);
      expect(setup.destination.launches).toHaveLength(1);
      expect(again.results[0]).toMatchObject({
        threadId,
        outcome: "moved",
        continuedThreadId: continuation,
      });
      const record = setup.source.document.threads[threadId];
      expect(record?.continuedOn?.threadId).toBe(continuation);
      expect(record?.lease).toMatchObject({ state: "fenced", epoch: 2 });
    }),
  );

  it.effect("launched, then the destination's thread store does not read: no new launch", () =>
    Effect.gen(function* () {
      const setup = yield* scenario();
      const previous = yield* started(setup);
      yield* earlierLidClose(setup, previous, "fails-after-create", "heard");
      setup.fixture.destinationShellsUnreadable = true;
      setup.fixture.activeRunId = "run-2";
      const again = yield* lidCloses(previous);
      expect(setup.destination.launches).toHaveLength(1);
      // The previous release reads a refusal on a first send as nothing moved, whatever
      // its code: the thread is given back, as that release already did after the
      // failed launch it heard about.
      expect(again.results[0]).toMatchObject({ threadId, outcome: "skipped" });
      expect(setup.source.document.threads[threadId]?.lease?.state).toBe("active");
    }),
  );

  it.effect("its request never arrived: the re-send is refused and the thread comes back", () =>
    Effect.gen(function* () {
      const setup = yield* scenario();
      const previous = yield* started(setup);
      setup.network.dropTakeoverRequest = true;
      const first = yield* lidCloses(previous);
      expect(first.results[0]).toMatchObject({ outcome: "stayed" });
      expect(setup.source.document.threads[threadId]?.lease?.state).toBe("handing-off");
      setup.network.dropTakeoverRequest = false;
      // The previous release sends an unanswered takeover again as it was: sleep, epoch 2.
      const resent = yield* previous
        .handOff({ threadId, destinationEnvironmentId: minis })
        .pipe(Effect.flip);
      expect(resent.code).toBe("invalid");
      const record = setup.source.document.threads[threadId];
      expect(record?.lease).toMatchObject({ state: "active", epoch: 1 });
      expect(record?.pendingTakeover).toBeNull();
      expect(record?.lastError).toContain("sleep and silence start nothing");
      // A re-send that is refused gives the thread back without starting the turn it
      // stopped; the next message starts one.
      expect(dispatchedTypes(setup)).toEqual(["run.interrupt"]);
      expect(turnRefusal(setup.source.document, threadId, m4)).toBeNull();
      expect(setup.destination.launches).toEqual([]);
    }),
  );

  it.effect.each(["readable", "unreadable"] as const)(
    "a lease saved before a failed launch, its answer lost: it stays paused (%s store)",
    (store) =>
      Effect.gen(function* () {
        const setup = yield* scenario();
        const previous = yield* started(setup);
        yield* earlierLidClose(setup, previous, "fails", "lost");
        const pending = setup.source.document.threads[threadId]?.pendingTakeover;
        expect(pending?.request).toMatchObject({ reason: "sleep", epoch: 2 });
        setup.fixture.destinationShellsUnreadable = store === "unreadable";
        const resent = yield* previous
          .handOff({ threadId, destinationEnvironmentId: minis })
          .pipe(Effect.result);
        expect(setup.destination.launches).toEqual([]);
        expect(resent._tag).toBe("Failure");
        const record = setup.source.document.threads[threadId];
        expect(record?.lease?.state).toBe("handing-off");
        expect(record?.pendingTakeover).toEqual(pending);
        expect(record?.continuedOn).toBeNull();
        expect(record?.lastError).toContain("stays paused until that machine answers");
        expect(turnRefusal(setup.source.document, threadId, m4)).not.toBeNull();
      }),
  );

  it.effect("launched and never recorded, its answer lost: the re-send gets that thread", () =>
    Effect.gen(function* () {
      const setup = yield* scenario();
      const previous = yield* started(setup);
      yield* earlierLidClose(setup, previous, "fails-after-create", "lost");
      expect(setup.source.document.threads[threadId]?.lease?.state).toBe("handing-off");
      const resent = yield* previous
        .handOff({ threadId, destinationEnvironmentId: minis })
        .pipe(Effect.result);
      expect(setup.destination.launches).toHaveLength(1);
      expect(resent._tag).toBe("Success");
      if (resent._tag === "Success") expect(resent.success.threadId).toBe(continuation);
      const record = setup.source.document.threads[threadId];
      expect(record?.continuedOn?.threadId).toBe(continuation);
      expect(record?.lease).toMatchObject({ state: "fenced", epoch: 2 });
    }),
  );
});

/** The lid closes on M4, now on this release: the desktop's notice, then a window's ask. */
const suspend = (setup: Setup) =>
  Effect.gen(function* () {
    const posted: Array<string> = [];
    const post: AwayPeerPost = (_target, path) =>
      Effect.sync(() => {
        posted.push(path);
        return { status: 200, json: {} };
      });
    const config: AwayConfig = {
      target: minis,
      sleepTrigger: "always",
      graceMinutes: 2,
      bringBack: "prompt",
      coordinatorScope: "live",
    };
    const away = yield* makeAwaySleep({
      self: m4,
      store: memorySleepStore(),
      config: Effect.succeed(config),
      post,
    });
    const notice = yield* away.sleep({ onBattery: true });
    yield* notice.send;
    expect(notice.answer).toEqual({ outcome: "skipped" });
    expect(posted).toEqual([]);
    const refused = yield* setup.moves
      .handOffMachine({ destinationEnvironmentId: minis, reason: "sleep" })
      .pipe(Effect.flip);
    expect(refused.code).toBe("invalid");
  });

describe(`a move by hand to a machine on ${PREVIOUS_RELEASE}, cut, then a lid close`, () => {
  it.effect("the answer was lost after Minis continued it: the same epoch fences it", () =>
    Effect.gen(function* () {
      const setup = yield* scenario();
      const { source, destination, moves, network, wire } = setup;
      NodeFS.writeFileSync(NodePath.join(setup.destinationRoot, ".env.local"), "TOKEN=minis\n");
      wire.destination = yield* previousDestination(setup);
      network.dropTakeoverAnswer = true;
      expect((yield* handOff(moves).pipe(Effect.flip)).code).toBe("unreachable");
      expect(destination.launches.map((launch) => launch.threadId)).toEqual([continuation]);
      const held = source.document.threads[threadId];
      expect(held?.pendingTakeover?.request).toMatchObject({ reason: "handoff", epoch: 2 });
      yield* suspend(setup);
      // The lid close released nothing.
      expect(source.document.threads[threadId]).toEqual(held);
      network.dropTakeoverAnswer = false;
      yield* moves.tick;
      const record = source.document.threads[threadId];
      expect(record?.continuedOn?.threadId).toBe(continuation);
      expect(record?.lease).toMatchObject({ state: "fenced", epoch: 2 });
      expect(record?.pendingTakeover).toBeNull();
      yield* moves.tick;
      expect(destination.launches).toHaveLength(1);
    }),
  );

  it.effect("the request never reached Minis: the same epoch is sent again and launches once", () =>
    Effect.gen(function* () {
      const setup = yield* scenario();
      const { source, destination, moves, network, wire } = setup;
      NodeFS.writeFileSync(NodePath.join(setup.destinationRoot, ".env.local"), "TOKEN=minis\n");
      wire.destination = yield* previousDestination(setup);
      network.dropTakeoverRequest = true;
      expect((yield* handOff(moves).pipe(Effect.flip)).code).toBe("unreachable");
      expect(destination.launches).toEqual([]);
      const held = source.document.threads[threadId];
      expect(held?.pendingTakeover?.request).toMatchObject({ reason: "handoff", epoch: 2 });
      yield* suspend(setup);
      expect(source.document.threads[threadId]).toEqual(held);
      network.dropTakeoverRequest = false;
      yield* moves.tick;
      expect(destination.launches.map((launch) => launch.threadId)).toEqual([continuation]);
      const record = source.document.threads[threadId];
      expect(record?.continuedOn?.threadId).toBe(continuation);
      expect(record?.lease).toMatchObject({ state: "fenced", epoch: 2 });
      yield* moves.tick;
      expect(destination.launches).toHaveLength(1);
    }),
  );
});
