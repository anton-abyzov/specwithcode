// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * Handoff between two machines when a takeover answer is lost or re-sent, when
 * a machine sleeps, and when replica machines or this machine's network go
 * silent. Shares its fixture with `handoffMove.test.ts`.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { continuationThreadId } from "./HandoffReceiver.ts";
import { EMPTY_HANDOFF_TRANSFER_DOCUMENT } from "./HandoffTransferStore.ts";
import { PAUSED_OFFLINE_REFUSAL, turnRefusal } from "./HandoffTurnGate.ts";
import {
  handOff,
  m4,
  minis,
  registerCleanup,
  scenario,
  suspend,
  threadId,
} from "./handoffMove.test.fixture.ts";
import * as PreviousReceiver from "./previousRelease.handoffReceiver.test.fixture.ts";

registerCleanup();

describe("handoff: lost takeovers, sleep and silence", () => {
  it.effect("stays paused when the takeover answer is lost, then a heartbeat fences it", () =>
    Effect.gen(function* () {
      const { source, destination, moves, network, destinationRoot } = yield* scenario();
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      network.dropTakeoverAnswer = true;
      const failure = yield* handOff(moves).pipe(Effect.flip);
      expect(failure.code).toBe("unreachable");
      // The destination did continue; the source must not run the thread again.
      expect(destination.launches).toHaveLength(1);
      expect(source.document.threads[threadId]?.lease?.state).toBe("handing-off");
      // A retry re-sends the same takeover; the destination repeats, never launches twice.
      const retry = yield* handOff(moves).pipe(Effect.flip);
      expect(retry.code).toBe("unreachable");
      expect(destination.launches).toHaveLength(1);
      network.dropTakeoverAnswer = false;
      yield* moves.tick;
      expect(source.document.threads[threadId]?.continuedOn?.threadId).toBe(
        destination.launches[0]?.threadId,
      );
      expect(destination.launches).toHaveLength(1);
    }),
  );

  it.effect("re-sends a takeover lost before it reached the destination", () =>
    Effect.gen(function* () {
      const { source, destination, moves, network, destinationRoot } = yield* scenario();
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      network.dropTakeoverRequest = true;
      const failure = yield* handOff(moves).pipe(Effect.flip);
      expect(failure.code).toBe("unreachable");
      expect(destination.launches).toHaveLength(0);
      const record = source.document.threads[threadId];
      expect(record?.lease?.state).toBe("handing-off");
      expect(record?.pendingTakeover?.request.epoch).toBe(2);
      // The destination answers heartbeats again without having continued the thread.
      network.dropTakeoverRequest = false;
      yield* moves.tick;
      expect(destination.launches).toHaveLength(1);
      expect(source.document.threads[threadId]?.continuedOn?.threadId).toBe(
        destination.launches[0]?.threadId,
      );
      expect(source.document.threads[threadId]?.pendingTakeover).toBeNull();
      yield* moves.tick;
      expect(destination.launches).toHaveLength(1);
    }),
  );

  it.effect(
    "sends a move that was asked for and never delivered once, at the same epoch, after a lid close",
    () =>
      Effect.gen(function* () {
        const setup = yield* scenario();
        const { source, destination, moves, network, destinationRoot, transfers } = setup;
        NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
        const continuation = continuationThreadId(m4, threadId, 2);
        const operations = () => Object.values(transfers.document.transfers);
        network.dropTakeoverRequest = true;
        expect((yield* handOff(moves).pipe(Effect.flip)).code).toBe("unreachable");
        expect(destination.launches).toEqual([]);
        // Both machines keep transfer records: the move is on file as one operation.
        const held = source.document.threads[threadId];
        const [operation] = operations();
        expect(operations()).toHaveLength(1);
        expect(held?.lease).toMatchObject({ state: "handing-off", epoch: 1 });
        expect(held?.pendingTakeover).toMatchObject({
          destinationEnvironmentId: minis,
          request: { reason: "handoff", epoch: 2, operationId: operation?.operationId },
        });
        expect(operation).toMatchObject({
          targetEnvironmentId: minis,
          lineage: { sourceEnvironmentId: m4, sourceThreadId: threadId, epoch: 2 },
        });
        // The lid closes: nothing is released, moved or sent, and the operation is as it was.
        yield* suspend(moves);
        expect(source.document.threads[threadId]).toEqual(held);
        expect(operations()).toEqual([operation]);
        expect(destination.launches).toEqual([]);
        // Minis is reached again: the same operation goes out at the same epoch, once.
        network.dropTakeoverRequest = false;
        yield* moves.tick;
        expect(destination.launches.map((launch) => launch.threadId)).toEqual([continuation]);
        expect(destination.document.threads[continuation]?.lease?.epoch).toBe(2);
        const record = source.document.threads[threadId];
        expect(record?.continuedOn).toMatchObject({ environmentId: minis, threadId: continuation });
        expect(record?.lease).toMatchObject({ state: "fenced", epoch: 2 });
        expect(record?.pendingTakeover).toBeNull();
        expect(turnRefusal(source.document, threadId, m4)).not.toBeNull();
        expect(operations()).toHaveLength(1);
        expect(operations()[0]).toMatchObject({
          operationId: operation?.operationId,
          targetEnvironmentId: minis,
          lineage: { epoch: 2 },
          receipt: { threadId: continuation },
        });
        yield* moves.tick;
        expect(destination.launches).toHaveLength(1);
        expect(operations()).toHaveLength(1);
      }),
  );

  it.effect(
    "never sends a takeover sleep started again, and gives it back only on its own not started",
    () =>
      Effect.gen(function* () {
        const setup = yield* scenario();
        const { source, destination, moves, network, destinationRoot, wire } = setup;
        NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
        network.dropTakeoverRequest = true;
        yield* handOff(moves).pipe(Effect.flip);
        // As an earlier release saved it: the lid closed and the takeover got no answer.
        const saved = source.document.threads[threadId]!;
        const pendingTakeover = {
          ...saved.pendingTakeover!,
          request: { ...saved.pendingTakeover!.request, reason: "sleep" as const },
        };
        source.document = {
          ...source.document,
          threads: { ...source.document.threads, [threadId]: { ...saved, pendingTakeover } },
        };
        // That release kept no transfer record of it.
        setup.transfers.document = EMPTY_HANDOFF_TRANSFER_DOCUMENT;
        network.dropTakeoverRequest = false;
        // Minis has not updated: it answers every heartbeat, and never says what did not
        // start. That answer settles nothing, and the takeover is not sent again: a
        // receiver on that release would start it.
        wire.destination = yield* PreviousReceiver.make.pipe(
          Effect.provide(setup.destinationServices),
        );
        yield* moves.tick;
        yield* moves.tick;
        expect(destination.launches).toEqual([]);
        expect(source.document.threads[threadId]?.lease?.state).toBe("handing-off");
        expect(source.document.threads[threadId]?.pendingTakeover).toEqual(pendingTakeover);
        expect(turnRefusal(source.document, threadId, m4)).not.toBeNull();
        // No transfer record adopts it, so nothing here asks about it or sends it.
        expect(setup.transfers.document.transfers).toEqual({});
        // Minis updated: it answers, for that takeover, that nothing started there.
        wire.destination = setup.destinationReceiver;
        yield* moves.tick;
        expect(destination.launches).toEqual([]);
        const record = source.document.threads[threadId];
        expect(record?.lease?.state).toBe("active");
        expect(record?.pendingTakeover).toBeNull();
        expect(record?.continuedOn).toBeNull();
        expect(turnRefusal(source.document, threadId, m4)).toBeNull();
      }),
  );

  it.effect.each(["fenced", "busy"] as const)(
    "releases a re-sent takeover only on a definite answer (%s)",
    (refusal) =>
      Effect.gen(function* () {
        const { source, destination, moves, network, destinationRoot } = yield* scenario();
        NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
        network.dropTakeoverRequest = true;
        yield* handOff(moves).pipe(Effect.flip);
        expect(source.document.threads[threadId]?.lease?.state).toBe("handing-off");
        network.dropTakeoverRequest = false;

        network.refuseTakeover = refusal;
        if (refusal === "fenced") {
          // A newer epoch on the destination, which cannot be asked what became of this
          // operation: the thread stays paused.
          network.down = true;
          yield* moves.tick;
          expect(source.document.threads[threadId]?.lease?.state).toBe("handing-off");
          expect(destination.launches).toHaveLength(0);
          network.down = false;
        }
        // "Not accepted", from the destination itself, gives the thread back; the epoch
        // that was sent is used up.
        yield* moves.tick;
        const record = source.document.threads[threadId];
        expect(record?.lease).toMatchObject({ state: "active", epoch: 2 });
        expect(record?.pendingTakeover).toBeNull();
        expect(record?.continuedOn).toBeNull();
        expect(destination.launches).toHaveLength(0);
      }),
  );

  it.effect("moves nothing because the machine goes to sleep (1390 AC-36)", () =>
    Effect.gen(function* () {
      const { source, destination, moves, fixture, destinationRoot } = yield* scenario();
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      fixture.activeRunId = "run-1";
      const refused = yield* moves
        .handOffMachine({ destinationEnvironmentId: minis, reason: "sleep" })
        .pipe(Effect.flip);
      expect(refused).toMatchObject({ code: "invalid" });
      // The run keeps going here, and the other machine starts nothing.
      expect(source.dispatched).toEqual([]);
      expect(source.document.threads[threadId]?.fencedBy ?? null).toBeNull();
      expect(source.document.machineRun).toBeNull();
      expect(destination.launches).toEqual([]);
      // The same move asked for by hand still goes through.
      const run = yield* moves.handOffMachine({
        destinationEnvironmentId: minis,
        reason: "manual",
      });
      expect(run.results).toEqual([
        expect.objectContaining({ threadId, outcome: "moved", resumed: true }),
      ]);
      expect(destination.launches).toHaveLength(1);
      expect(source.document.machineRun?.reason).toBe("manual");
    }),
  );

  it.effect("refuses a delayed takeover at a stale epoch", () =>
    Effect.gen(function* () {
      const { source, moves, destinationRoot, destination, destinationReceiver, asSource } =
        yield* scenario();
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      // A newer epoch reached the destination first, so this takeover is stale.
      yield* handOff(moves).pipe(Effect.ignore);
      const stale = yield* destinationReceiver
        .takeover(asSource, {
          sourceEnvironmentId: m4,
          sourceThreadId: threadId,
          epoch: 1,
          sequence: 1,
          reason: "handoff",
          modelSelection: null,
        })
        .pipe(Effect.flip);
      expect(stale).toMatchObject({ code: "fenced", check: "lease" });
      expect(destination.launches).toHaveLength(1);
      expect(source.document.threads[threadId]?.lease?.state).toBe("fenced");
    }),
  );

  it.effect("keeps running when its replica machines go silent while its own network works", () =>
    Effect.gen(function* () {
      const { source, moves, fixture, network } = yield* scenario();
      yield* moves.preflight({ destinationEnvironmentId: minis, threadIds: [threadId] });
      fixture.activeRunId = "run-1";
      yield* moves.tick;
      // Minis went to sleep; M4 still reaches SpecWithCode Connect.
      network.down = true;
      for (let tick = 0; tick < 4; tick += 1) {
        yield* TestClock.adjust("60 seconds");
        yield* moves.tick;
      }
      expect(network.connectProbes).toBeGreaterThan(0);
      expect(source.dispatched).toHaveLength(0);
      expect(fixture.activeRunId).toBe("run-1");
      expect(source.document.pausedSince).toBeNull();
      expect(source.document.threads[threadId]?.fencedBy).toBeNull();
      // New turns still start here.
      expect(turnRefusal(source.document, threadId, m4)).toBeNull();
    }),
  );

  it.effect("fences a running copy only when its own network is down as well", () =>
    Effect.gen(function* () {
      const { source, moves, fixture, network } = yield* scenario();
      yield* moves.preflight({ destinationEnvironmentId: minis, threadIds: [threadId] });
      fixture.activeRunId = "run-1";
      yield* moves.tick;
      expect(source.dispatched).toHaveLength(0);
      network.down = true;
      network.connect = "offline";
      yield* TestClock.adjust("60 seconds");
      yield* moves.tick;
      expect(source.dispatched).toHaveLength(0);
      yield* TestClock.adjust("60 seconds");
      yield* moves.tick;
      expect(source.dispatched[0]).toMatchObject({ type: "run.interrupt", threadId });
      expect(source.dispatched[0]?.reason).toContain("lost its network");
      expect(source.document.threads[threadId]?.fencedBy).toBe("sleep");
      expect(source.document.pausedSince).not.toBeNull();
      expect(turnRefusal(source.document, threadId, m4)).toBe(PAUSED_OFFLINE_REFUSAL);
      // Connect answers again while Minis still sleeps. Minis may have continued the
      // thread before it slept, so the pause stands until Minis itself answers.
      network.connect = "online";
      yield* TestClock.adjust("30 seconds");
      yield* moves.tick;
      expect(source.document.pausedSince).not.toBeNull();
      expect(turnRefusal(source.document, threadId, m4)).toBe(PAUSED_OFFLINE_REFUSAL);
      network.down = false;
      yield* moves.tick;
      expect(source.document.pausedSince).toBeNull();
      expect(turnRefusal(source.document, threadId, m4)).toBeNull();
      expect(source.document.threads[threadId]?.continuedOn).toBeNull();
    }),
  );

  it.effect("lifts a network pause once the peer answers again", () =>
    Effect.gen(function* () {
      const { source, moves, fixture, network } = yield* scenario();
      yield* moves.preflight({ destinationEnvironmentId: minis, threadIds: [threadId] });
      fixture.activeRunId = "run-1";
      yield* moves.tick;
      network.down = true;
      network.connect = "offline";
      yield* TestClock.adjust("120 seconds");
      yield* moves.tick;
      expect(source.document.pausedSince).not.toBeNull();
      network.down = false;
      yield* moves.tick;
      expect(source.document.pausedSince).toBeNull();
      expect(source.document.threads[threadId]?.continuedOn).toBeNull();
    }),
  );

  it.effect("never fences when no Connect relay is configured to show isolation", () =>
    Effect.gen(function* () {
      const { source, moves, fixture, network } = yield* scenario();
      yield* moves.preflight({ destinationEnvironmentId: minis, threadIds: [threadId] });
      fixture.activeRunId = "run-1";
      yield* moves.tick;
      network.down = true;
      network.connect = "unknown";
      yield* TestClock.adjust("120 seconds");
      yield* moves.tick;
      yield* TestClock.adjust("120 seconds");
      yield* moves.tick;
      expect(source.dispatched).toHaveLength(0);
      expect(source.document.pausedSince).toBeNull();
      // A pause left by an older build is cleared on the next tick, though no peer answers.
      source.document = { ...source.document, pausedSince: "2026-10-20T14:05:00.000Z" };
      yield* moves.tick;
      expect(source.document.pausedSince).toBeNull();
    }),
  );

  it.effect("counts only replicas holding a usable checkpoint", () =>
    Effect.gen(function* () {
      const { source, moves, fixture, network } = yield* scenario();
      yield* moves.preflight({ destinationEnvironmentId: minis, threadIds: [threadId] });
      fixture.activeRunId = "run-1";
      yield* moves.tick;
      network.down = true;
      network.connect = "offline";
      const record = source.document.threads[threadId]!;
      // Minis holds no checkpoint it could continue (it needs a grant).
      source.document = {
        ...source.document,
        threads: {
          ...source.document.threads,
          [threadId]: {
            ...record,
            replicas: record.replicas.map((replica) => ({
              ...replica,
              state: "needs-grant" as const,
              sequence: null,
            })),
          },
        },
      };
      yield* TestClock.adjust("120 seconds");
      yield* moves.tick;
      expect(source.dispatched).toHaveLength(0);
      expect(source.document.pausedSince).toBeNull();
    }),
  );

  it.effect("fences a thread whose handoff was turned off, since its copies stay continuable", () =>
    Effect.gen(function* () {
      const { source, moves, fixture, network } = yield* scenario();
      yield* moves.preflight({ destinationEnvironmentId: minis, threadIds: [threadId] });
      fixture.activeRunId = "run-1";
      yield* moves.tick;
      network.down = true;
      network.connect = "offline";
      const record = source.document.threads[threadId]!;
      source.document = {
        ...source.document,
        threads: { ...source.document.threads, [threadId]: { ...record, mode: "off" } },
      };
      yield* TestClock.adjust("120 seconds");
      yield* moves.tick;
      expect(source.dispatched[0]).toMatchObject({ type: "run.interrupt", threadId });
      expect(source.document.pausedSince).not.toBeNull();
      expect(turnRefusal(source.document, threadId, m4)).toBe(PAUSED_OFFLINE_REFUSAL);
    }),
  );
});
