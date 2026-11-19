// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * The transfer record between real machines in one process (1390): what is on
 * record before a thread is held and before its takeover leaves, and what each
 * machine does when a window closes, a server restarts or a packet is lost,
 * repeated or late. No case sleeps: a cut is a call that never returns, and a
 * restart is the same machine booted again over its document and records.
 */
import * as NodeFS from "node:fs";

import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  HANDOFF_LEASE_STALE_MS,
  type HandoffTransferDocument,
  type HandoffTransferRecord,
  isHandoffTransferFinished,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { unscopedGrant } from "../fleet/workGrantPolicy.ts";
import { ThreadLaunchError } from "../orchestration-v2/ThreadLaunchService.ts";
import { continuationThreadId, HandoffRefusal } from "./HandoffReceiver.ts";
import { findIncoming } from "./handoffState.ts";
import { makeRig, type Rig, type RigMachine } from "./handoffTransfer.test.fixture.ts";
import { putTransfer } from "./HandoffTransferStore.ts";
import { turnRefusal } from "./HandoffTurnGate.ts";
import type { TakeoverRequest } from "./handoffWire.ts";
import { previousMarkContinued } from "./previousRelease383.test.fixture.ts";

const temporary: Array<string> = [];
afterEach(() => {
  for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

class LaunchFailed extends Data.TaggedError("LaunchFailed")<{ readonly message: string }> {}

const t1 = ThreadId.make("thread:one");
const t2 = ThreadId.make("thread:two");
const three = [{ name: "a" }, { name: "b" }, { name: "c" }];

const transfersOf = (machine: RigMachine, threadId?: ThreadId): Array<HandoffTransferRecord> =>
  Object.values(machine.transfers.document.transfers).filter(
    (record) => threadId === undefined || record.lineage.sourceThreadId === threadId,
  );
const transferOf = (machine: RigMachine, threadId: ThreadId) => transfersOf(machine, threadId)[0];
const acceptancesOf = (machine: RigMachine) =>
  Object.values(machine.transfers.document.acceptances);
const leaseOf = (machine: RigMachine, threadId: ThreadId) =>
  machine.document.threads[threadId]?.lease ?? null;
const continuedOn = (machine: RigMachine, threadId: ThreadId) =>
  machine.document.threads[threadId]?.continuedOn ?? null;
const takeovers = (rig: Rig, to?: RigMachine) =>
  rig.callsOf("takeover", to).map((call) => call.request as TakeoverRequest);
const caller = (machine: RigMachine) => ({
  sourceEnvironmentId: machine.environmentId,
  grant: unscopedGrant(machine.environmentId),
});
const moved = (record: HandoffTransferRecord | undefined) =>
  record?.state === "resumed" || record?.state === "ready";
const handOff = (from: RigMachine, threadId: ThreadId, to: RigMachine) =>
  from.moves.handOff({ threadId, destinationEnvironmentId: to.environmentId });
const signal = (deferred: Deferred.Deferred<void>) =>
  Deferred.succeed(deferred, undefined).pipe(Effect.asVoid);

describe("the transfer record of a handoff", () => {
  it.effect("is written before the hold and reads sent before the takeover leaves", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      rig.addThread(a, t1, { running: true });
      const seen: {
        atHold: HandoffTransferRecord | undefined;
        atSend: HandoffTransferRecord | undefined;
      } = { atHold: undefined, atSend: undefined };
      a.onDocument = (document) =>
        Effect.sync(() => {
          if (seen.atHold === undefined && document.threads[t1]?.lease?.state === "handing-off") {
            seen.atHold = transferOf(a, t1);
          }
        });
      rig.network.rule = (call) => {
        if (call.path === "takeover") seen.atSend = transferOf(a, t1);
        return undefined;
      };

      const result = yield* handOff(a, t1, b);

      // On record before the first hold: the operation, the target, the checkpoint, the disposition.
      expect(seen.atHold).toMatchObject({
        state: "pending",
        targetEnvironmentId: b.environmentId,
        disposition: "resume",
        lineage: { sourceEnvironmentId: a.environmentId, sourceThreadId: t1, epoch: 2 },
      });
      expect(seen.atHold?.operationId).toMatch(/\S+/);
      expect(seen.atHold?.sequence).toBeGreaterThan(0);
      // "Sent" is on record before the takeover is on the wire.
      expect(seen.atSend).toMatchObject({ state: "sent", operationId: seen.atHold?.operationId });
      expect(seen.atSend?.sentAt).not.toBeNull();
      const request = takeovers(rig, b)[0];
      expect(request).toMatchObject({
        operationId: seen.atHold?.operationId,
        epoch: 2,
        sequence: seen.atSend?.sequence,
      });
      // One execution owner afterwards, and both machines say the same.
      const record = transferOf(a, t1);
      expect(record?.state).toBe("resumed");
      expect(record?.receipt?.threadId).toBe(result.threadId);
      expect(b.launches.map((launch) => launch.threadId)).toEqual([result.threadId]);
      expect(continuedOn(a, t1)?.threadId).toBe(result.threadId);
      expect(acceptancesOf(b)).toHaveLength(1);
      expect(acceptancesOf(b)[0]).toMatchObject({
        operationId: record?.operationId,
        verdict: "accepted",
        launched: true,
        lineage: { sourceEnvironmentId: a.environmentId, sourceThreadId: t1, epoch: 2 },
      });
    }),
  );

  it.effect("carries on when the window that asked for it closes", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      rig.addThread(a, t1);
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fenced = yield* Deferred.make<void>();
      rig.network.rule = (call) =>
        call.path === "takeover"
          ? { wait: signal(reached).pipe(Effect.andThen(Deferred.await(release))) }
          : undefined;
      a.onDocument = (document) =>
        document.threads[t1]?.continuedOn != null ? signal(fenced) : Effect.void;

      const window = yield* handOff(a, t1, b).pipe(Effect.forkChild);
      yield* Deferred.await(reached);
      // The window closes while the takeover is on its way.
      yield* Fiber.interrupt(window);
      yield* signal(release);
      yield* Deferred.await(fenced);

      expect(b.launches).toHaveLength(1);
      expect(continuedOn(a, t1)?.threadId).toBe(b.launches[0]?.threadId);
    }),
  );

  it.effect("moves two threads that cross between two machines, each once", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      rig.addThread(a, t1);
      rig.addThread(b, t2);
      const both = yield* Deferred.make<void>();
      let waiting = 0;
      // Neither takeover is delivered until both are on the wire.
      rig.network.rule = (call) =>
        call.path === "takeover"
          ? {
              wait: Effect.suspend(() => {
                waiting += 1;
                return waiting === 2 ? signal(both) : Deferred.await(both);
              }),
            }
          : undefined;

      const [there, back] = yield* Effect.all([handOff(a, t1, b), handOff(b, t2, a)], {
        concurrency: 2,
      });

      expect(b.launches.map((launch) => launch.threadId)).toEqual([there.threadId]);
      expect(a.launches.map((launch) => launch.threadId)).toEqual([back.threadId]);
      expect(continuedOn(a, t1)?.environmentId).toBe(b.environmentId);
      expect(continuedOn(b, t2)?.environmentId).toBe(a.environmentId);
      expect(moved(transferOf(a, t1))).toBe(true);
      expect(moved(transferOf(b, t2))).toBe(true);
      // Each machine is a source for one lineage and a destination for the other.
      expect(acceptancesOf(a).map((entry) => entry.lineage.sourceThreadId)).toEqual([t2]);
      expect(acceptancesOf(b).map((entry) => entry.lineage.sourceThreadId)).toEqual([t1]);
      yield* a.moves.tick;
      yield* b.moves.tick;
      expect([a.launches.length, b.launches.length]).toEqual([1, 1]);
    }),
  );

  it.effect("answers a repeated takeover with the first receipt and launches once", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      rig.addThread(a, t1);
      let lost = false;
      rig.network.rule = (call) => {
        if (call.path !== "takeover" || lost) return undefined;
        lost = true;
        return "lose-answer";
      };

      const first = yield* handOff(a, t1, b).pipe(Effect.flip);
      expect(first.code).toBe("unreachable");
      expect(b.launches).toHaveLength(1);
      // No answer: the thread starts nothing here.
      expect(leaseOf(a, t1)?.state).toBe("handing-off");
      expect(transferOf(a, t1)?.state).toBe("unknown");

      yield* a.moves.tick;
      const sent = takeovers(rig, b);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual(sent[0]);
      expect(b.launches).toHaveLength(1);
      expect(moved(transferOf(a, t1))).toBe(true);
      expect(transferOf(a, t1)?.receipt?.threadId).toBe(b.launches[0]?.threadId);
      expect(continuedOn(a, t1)?.threadId).toBe(b.launches[0]?.threadId);

      // The same packet twice more, at once.
      const again = yield* Effect.all(
        [b.receiver.takeover(caller(a), sent[0]!), b.receiver.takeover(caller(a), sent[0]!)],
        { concurrency: 2 },
      );
      expect(again[0]).toEqual(again[1]);
      expect(again[0]?.threadId).toBe(b.launches[0]?.threadId);
      expect(b.launches).toHaveLength(1);
      // Another operation for the lineage, and another checkpoint of this one, change nothing.
      const other = yield* b.receiver
        .takeover(caller(a), { ...sent[0]!, operationId: "another-operation" })
        .pipe(Effect.flip);
      expect(other.code).toBe("fenced");
      const divergent = yield* b.receiver
        .takeover(caller(a), { ...sent[0]!, sequence: sent[0]!.sequence + 1 })
        .pipe(Effect.flip);
      expect(divergent.code).toBe("fenced");
      expect(b.launches).toHaveLength(1);
      expect(acceptancesOf(b)).toHaveLength(1);
    }),
  );

  it.effect("finishes, once, a launch that a restart cut after the acceptance was written", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      rig.addThread(a, t1);
      const launching = yield* Deferred.make<void>();
      b.onLaunch = () => signal(launching).pipe(Effect.andThen(Effect.never));

      const window = yield* handOff(a, t1, b).pipe(Effect.forkChild);
      yield* Deferred.await(launching);
      // The acceptance is on record before anything is launched.
      expect(acceptancesOf(b)[0]).toMatchObject({ verdict: "accepted", launched: false });
      expect(b.launches).toHaveLength(0);

      // Both servers stop here and start again.
      b.onLaunch = null;
      yield* rig.restart(b);
      yield* rig.restart(a);
      yield* Fiber.interrupt(window);
      yield* a.moves.tick;

      expect(b.launches).toHaveLength(1);
      expect(acceptancesOf(b)).toHaveLength(1);
      expect(acceptancesOf(b)[0]).toMatchObject({
        launched: true,
        operationId: transferOf(a, t1)?.operationId,
      });
      expect(continuedOn(a, t1)?.threadId).toBe(b.launches[0]?.threadId);
      yield* a.moves.tick;
      expect(b.launches).toHaveLength(1);
    }),
  );

  it.effect("keeps a launch that failed in doubt, and finishes it once on the repeat", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      rig.addThread(a, t1);
      // The launch may have created the thread before it failed.
      b.onLaunch = () => Effect.fail(new LaunchFailed({ message: "no space left" }));

      const failure = yield* handOff(a, t1, b).pipe(Effect.flip);
      expect(failure.code).toBe("failed");
      // Not a "no": the acceptance stands, and the source starts nothing.
      expect(acceptancesOf(b)[0]).toMatchObject({ verdict: "accepted", launched: false });
      expect(leaseOf(a, t1)?.state).toBe("handing-off");
      expect(transferOf(a, t1)?.state).toBe("unknown");
      expect(turnRefusal(a.document, t1, a.environmentId)).not.toBeNull();
      yield* a.moves.resumeFenced;
      expect(leaseOf(a, t1)?.state).toBe("handing-off");

      b.onLaunch = null;
      yield* a.moves.tick;
      expect(b.launches).toHaveLength(1);
      expect(acceptancesOf(b)[0]).toMatchObject({ verdict: "accepted", launched: true });
      expect(continuedOn(a, t1)?.threadId).toBe(b.launches[0]?.threadId);
      expect(new Set(takeovers(rig, b).map((request) => request.operationId)).size).toBe(1);
    }),
  );

  it.effect("answers a definite no when the thread could not even be asked for", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      rig.addThread(a, t1);
      // The project is paused there: the launch stops before any thread is created.
      b.onLaunch = (input) =>
        Effect.fail(
          new ThreadLaunchError({
            operation: "resolve-project",
            commandId: input.commandId,
            projectId: input.projectId,
            cause: "Resume or restore the project before starting new threads.",
          }),
        );

      const failure = yield* handOff(a, t1, b).pipe(Effect.flip);

      expect(failure.code).toBe("failed");
      expect(acceptancesOf(b)[0]?.verdict).toBe("not-accepted");
      expect(b.launches).toHaveLength(0);
      // No lease is left there for a thread that was never created.
      expect(b.document.threads[continuationThreadId(a.environmentId, t1, 2)]).toBeUndefined();
      // The source runs it again; the hold does not wait for a launch that can never work.
      expect(leaseOf(a, t1)?.state).toBe("active");
      expect(transferOf(a, t1)?.state).toBe("failed");
      expect(turnRefusal(a.document, t1, a.environmentId)).toBeNull();
    }),
  );

  it.effect("keeps the hold when the destination could not write that it took its acceptance back", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      rig.addThread(a, t1);
      b.onLaunch = (input) =>
        Effect.fail(
          new ThreadLaunchError({
            operation: "resolve-project",
            commandId: input.commandId,
            projectId: input.projectId,
            cause: "Resume or restore the project before starting new threads.",
          }),
        );
      // Its records take the acceptance and then cannot be written again.
      b.transfers.failWrite = (next) =>
        Object.values(next.acceptances).some((entry) => entry.verdict === "not-accepted");

      yield* handOff(a, t1, b).pipe(Effect.flip);

      // The acceptance is still on file there, so a repeat would launch: not a "no".
      expect(acceptancesOf(b)[0]).toMatchObject({ verdict: "accepted", launched: false });
      expect(leaseOf(a, t1)?.state).toBe("handing-off");
      expect(transferOf(a, t1)?.state).toBe("unknown");
      expect(turnRefusal(a.document, t1, a.environmentId)).not.toBeNull();

      // The project is resumed there: the repeat launches once, and the source is fenced.
      b.onLaunch = null;
      b.transfers.failWrite = null;
      yield* a.moves.tick;
      expect(b.launches).toHaveLength(1);
      expect(leaseOf(a, t1)?.state).toBe("fenced");
    }),
  );

  it.effect("keeps the hold when it could not write that the handoff was refused", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      rig.addThread(a, t1);
      // The destination refuses the first send: its grant was withdrawn.
      const withdrawn = new HandoffRefusal({
        status: 409,
        code: "busy",
        message: "B no longer accepts work from this machine.",
        check: "grant",
      });
      rig.network.rule = (call) => (call.path === "takeover" ? { refuse: withdrawn } : undefined);
      // Only the write that ends the record fails.
      a.transfers.failWrite = (next) =>
        Object.values(next.transfers).some((record) => record.state === "failed");

      yield* handOff(a, t1, b).pipe(Effect.flip);

      // The record is still open, so it will be sent again: the thread is not run here.
      expect(transferOf(a, t1)?.state).toBe("sent");
      expect(leaseOf(a, t1)).toMatchObject({ state: "handing-off", epoch: 1 });
      expect(turnRefusal(a.document, t1, a.environmentId)).not.toBeNull();
      yield* rig.restart(a);
      yield* a.moves.tick;
      expect(leaseOf(a, t1)?.state).toBe("handing-off");
      expect(turnRefusal(a.document, t1, a.environmentId)).not.toBeNull();
      expect(b.launches).toHaveLength(0);

      // The disk is back: the destination says once more it never accepted, that is
      // written, and only then does the thread run here again. Nothing started there.
      rig.network.rule = null;
      a.transfers.failWrite = null;
      yield* a.moves.tick;
      expect(transferOf(a, t1)?.state).toBe("failed");
      expect(leaseOf(a, t1)).toMatchObject({ state: "active", epoch: 2 });
      expect(b.launches).toHaveLength(0);
    }),
  );

  it.effect("keeps the hold when a repeat is refused at the door of a machine that accepted", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      rig.addThread(a, t1);
      rig.network.rule = (call) => (call.path === "takeover" ? "lose-answer" : undefined);
      yield* handOff(a, t1, b).pipe(Effect.flip);
      expect(b.launches).toHaveLength(1);
      expect(transferOf(a, t1)?.state).toBe("unknown");

      // It is updating: every call is refused before its records are read.
      const updating = new HandoffRefusal({
        status: 503,
        code: "busy",
        message: "This machine is updating; try again in a minute.",
      });
      rig.network.rule = () => ({ refuse: updating });
      yield* a.moves.tick;
      expect(leaseOf(a, t1)?.state).toBe("handing-off");
      expect(transferOf(a, t1)?.state).toBe("unknown");
      expect(turnRefusal(a.document, t1, a.environmentId)).not.toBeNull();

      // Only the repeat is refused: what it says of the operation settles it.
      rig.network.rule = (call) => (call.path === "takeover" ? { refuse: updating } : undefined);
      yield* a.moves.tick;
      expect(leaseOf(a, t1)?.state).toBe("fenced");
      expect(continuedOn(a, t1)?.threadId).toBe(b.launches[0]?.threadId);
      expect(b.launches).toHaveLength(1);
    }),
  );

  it.effect("refuses a takeover that arrives after the source was told it was not accepted", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      rig.addThread(a, t1);
      let delayed: TakeoverRequest | null = null;
      rig.network.rule = (call) => {
        if (call.path !== "takeover" || delayed !== null) return undefined;
        delayed = call.request as TakeoverRequest;
        return "lose-request";
      };

      yield* handOff(a, t1, b).pipe(Effect.flip);
      const packet = delayed as unknown as TakeoverRequest;
      expect(leaseOf(a, t1)?.state).toBe("handing-off");

      // The question overtakes the takeover it asks about.
      const status = yield* b.receiver.transferStatus(caller(a), {
        sourceEnvironmentId: a.environmentId,
        sourceThreadId: t1,
        epoch: packet.epoch,
        operationId: packet.operationId ?? null,
      });
      expect(status.status).toBe("not-accepted");
      const late = yield* b.receiver.takeover(caller(a), packet).pipe(Effect.flip);
      expect(late.code).toBe("invalid");
      expect(b.launches).toHaveLength(0);

      // The source's replay gets the same definite answer and releases the hold.
      yield* a.moves.tick;
      expect(leaseOf(a, t1)).toMatchObject({ state: "active", epoch: 2 });
      expect(transferOf(a, t1)?.state).toBe("failed");

      const again = yield* handOff(a, t1, b);
      expect(takeovers(rig, b).at(-1)?.epoch).toBe(3);
      expect(b.launches.map((launch) => launch.threadId)).toEqual([again.threadId]);
      // The first packet, later still.
      yield* b.receiver.takeover(caller(a), packet).pipe(Effect.flip);
      expect(b.launches).toHaveLength(1);
    }),
  );

  it.effect("runs two starts of one thread to one machine as one operation", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      rig.addThread(a, t1);

      const [one, two] = yield* Effect.all([handOff(a, t1, b), handOff(a, t1, b)], {
        concurrency: 2,
      });

      expect(one.threadId).toBe(two.threadId);
      expect(b.launches).toHaveLength(1);
      expect(takeovers(rig)).toHaveLength(1);
      expect(transfersOf(a, t1).filter(moved)).toHaveLength(1);
    }),
  );

  it.effect("lets one of two starts to different machines win, and launches once", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary, three);
      const [a, b, c] = rig.machines as [RigMachine, RigMachine, RigMachine];
      rig.addThread(a, t1);

      const outcomes = yield* Effect.all(
        [handOff(a, t1, b).pipe(Effect.result), handOff(a, t1, c).pipe(Effect.result)],
        { concurrency: 2 },
      );

      expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1);
      expect(b.launches.length + c.launches.length).toBe(1);
      expect(takeovers(rig)).toHaveLength(1);
      expect(transfersOf(a, t1).filter(moved)).toHaveLength(1);
      expect(acceptancesOf(b).length + acceptancesOf(c).length).toBe(1);
    }),
  );

  it.effect("never picks another machine while the first has not answered", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary, three);
      const [a, b, c] = rig.machines as [RigMachine, RigMachine, RigMachine];
      rig.addThread(a, t1);
      rig.network.rule = (call) => (call.path === "takeover" ? "lose-answer" : undefined);

      yield* handOff(a, t1, b).pipe(Effect.flip);
      expect(b.launches).toHaveLength(1);
      const operationId = transferOf(a, t1)?.operationId;

      const elsewhere = yield* handOff(a, t1, c).pipe(Effect.flip);
      expect(elsewhere.code).toBe("busy");
      const batch = yield* a.moves.handOffMachine({
        destinationEnvironmentId: c.environmentId,
        reason: "manual",
        threadIds: [t1],
      });
      expect(batch.results.map((result) => result.outcome)).toEqual(["stayed"]);
      // "Resume this machine" releases only holds that were never sent.
      yield* a.moves.resumeFenced;
      expect(leaseOf(a, t1)?.state).toBe("handing-off");
      expect(turnRefusal(a.document, t1, a.environmentId)).not.toBeNull();
      expect(takeovers(rig, c)).toHaveLength(0);
      expect(c.launches).toHaveLength(0);
      expect(transfersOf(a, t1).map((record) => record.operationId)).toEqual([operationId]);

      rig.network.rule = null;
      yield* a.moves.tick;
      expect(continuedOn(a, t1)?.environmentId).toBe(b.environmentId);
      expect(b.launches).toHaveLength(1);
      expect(c.launches).toHaveLength(0);
    }),
  );

  it.effect.each(["fresh window", "lease tick", "resume here", "too old"] as const)(
    "a batch cut before the second thread was sent: %s",
    (next) =>
      Effect.gen(function* () {
        const rig = yield* makeRig(temporary);
        const [a, b] = rig.machines as [RigMachine, RigMachine];
        rig.addThread(a, t1);
        rig.addThread(a, t2, { running: true });
        const cut = yield* Deferred.make<void>();
        let planned: HandoffTransferDocument | null = null;
        a.onDocument = (document) =>
          Effect.sync(() => {
            if (planned === null && document.threads[t1]?.lease?.state === "handing-off") {
              planned = a.transfers.document;
            }
          });
        a.onDispatch = (command) =>
          command.type === "run.interrupt"
            ? signal(cut).pipe(Effect.andThen(Effect.never))
            : Effect.void;
        const input = {
          destinationEnvironmentId: b.environmentId,
          reason: "manual" as const,
          threadIds: [t1, t2],
        };

        const window = yield* a.moves.handOffMachine(input).pipe(Effect.forkChild);
        yield* Deferred.await(cut);

        // Before the first hold: the batch, and for each thread its operation, target,
        // checkpoint and disposition.
        const atFirstHold = planned as unknown as HandoffTransferDocument;
        const batch = Object.values(atFirstHold.batches)[0];
        expect(batch).toMatchObject({ targetEnvironmentId: b.environmentId });
        expect(batch?.operationIds).toHaveLength(2);
        const plannedRecords = batch!.operationIds.map((id) => atFirstHold.transfers[id]!);
        expect(plannedRecords.map((record) => record.lineage.sourceThreadId)).toEqual([t1, t2]);
        for (const record of plannedRecords) {
          expect(record).toMatchObject({
            targetEnvironmentId: b.environmentId,
            state: "pending",
            batchId: batch?.batchId,
          });
          expect(record.sequence).toBeGreaterThan(0);
          expect(["resume", "ready"]).toContain(record.disposition);
        }
        const second = plannedRecords[1]!.operationId;
        // Partly successful: the first thread moved, the second is held and was never sent.
        expect(b.launches).toHaveLength(1);
        expect(moved(transferOf(a, t1))).toBe(true);
        expect(transferOf(a, t2)).toMatchObject({ state: "held", operationId: second });
        expect(takeovers(rig).map((request) => request.sourceThreadId)).toEqual([t1]);

        // The server stops here and starts again; its turn died with it.
        a.onDispatch = null;
        a.onDocument = null;
        a.threads.get(t2)!.activeRunId = null;
        yield* rig.restart(a);
        yield* Fiber.interrupt(window);
        expect(leaseOf(a, t2)?.state).toBe("handing-off");

        if (next === "fresh window" || next === "lease tick") {
          if (next === "fresh window") {
            const run = yield* a.moves.handOffMachine(input);
            expect(run.results.map((result) => result.outcome)).toEqual(["moved", "moved"]);
          } else {
            yield* a.moves.tick;
          }
          // The same operation, to the same machine; the first thread is not moved twice.
          const sent = takeovers(rig).filter((request) => request.sourceThreadId === t2);
          expect(sent.map((request) => request.operationId)).toEqual([second]);
          expect(b.launches).toHaveLength(2);
          expect(transfersOf(a, t2)).toHaveLength(1);
          expect(moved(transferOf(a, t2))).toBe(true);
          expect(continuedOn(a, t2)?.threadId).toBe(b.launches[1]?.threadId);
          return;
        }
        if (next === "resume here") {
          yield* a.moves.resumeFenced;
        } else {
          yield* TestClock.adjust("16 minutes");
          yield* a.moves.tick;
        }
        // Nothing was sent, so the thread runs here again at the epoch it had.
        expect(leaseOf(a, t2)).toMatchObject({ state: "active", epoch: 1 });
        expect(transferOf(a, t2)?.state).toBe("stayed");
        expect(turnRefusal(a.document, t2, a.environmentId)).toBeNull();
        yield* a.moves.tick;
        expect(takeovers(rig).map((request) => request.sourceThreadId)).toEqual([t1]);
        expect(b.launches).toHaveLength(1);
      }),
  );

  it.effect("a batch cut after the destination received the second thread", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary, three);
      const [a, b, c] = rig.machines as [RigMachine, RigMachine, RigMachine];
      rig.addThread(a, t1);
      rig.addThread(a, t2);
      const delivered = yield* Deferred.make<void>();
      const second = (request: unknown) => (request as TakeoverRequest).sourceThreadId === t2;
      rig.network.rule = (call) =>
        call.path === "takeover" && second(call.request) ? "deliver-then-hang" : undefined;
      rig.network.afterDelivery = (call) =>
        call.path === "takeover" && second(call.request) ? signal(delivered) : Effect.void;
      const input = {
        destinationEnvironmentId: b.environmentId,
        reason: "manual" as const,
        threadIds: [t1, t2],
      };

      const window = yield* a.moves.handOffMachine(input).pipe(Effect.forkChild);
      yield* Deferred.await(delivered);
      expect(b.launches).toHaveLength(2);
      expect(transferOf(a, t2)?.state).toBe("sent");

      // The source stops before the answer reaches it, and starts again.
      rig.network.rule = null;
      rig.network.afterDelivery = null;
      yield* rig.restart(a);
      yield* Fiber.interrupt(window);
      // Acceptance unknown: it runs nothing here, releases nothing, picks no other machine.
      expect(turnRefusal(a.document, t2, a.environmentId)).not.toBeNull();
      yield* a.moves.resumeFenced;
      expect(leaseOf(a, t2)?.state).toBe("handing-off");
      const elsewhere = yield* a.moves.handOffMachine({
        ...input,
        destinationEnvironmentId: c.environmentId,
      });
      expect(elsewhere.results.map((result) => result.outcome)).toEqual(["skipped", "stayed"]);
      expect(takeovers(rig, c)).toHaveLength(0);
      expect(c.launches).toHaveLength(0);

      // A fresh window asks for the same batch again.
      const run = yield* a.moves.handOffMachine(input);
      expect(run.results.map((result) => result.outcome)).toEqual(["moved", "moved"]);
      const sent = takeovers(rig, b).filter(second);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual(sent[0]);
      expect(b.launches).toHaveLength(2);
      expect(continuedOn(a, t2)?.threadId).toBe(b.launches[1]?.threadId);
      expect(transferOf(a, t2)?.receipt?.threadId).toBe(b.launches[1]?.threadId);
      expect(transfersOf(a, t2)).toHaveLength(1);
    }),
  );

  it.effect("a batch cut after the destination resumed the turn, before the source knew", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary, three);
      const [a, b, c] = rig.machines as [RigMachine, RigMachine, RigMachine];
      rig.addThread(a, t1);
      rig.addThread(a, t2, { running: true });
      const delivered = yield* Deferred.make<void>();
      const second = (request: unknown) => (request as TakeoverRequest).sourceThreadId === t2;
      rig.network.rule = (call) =>
        call.path === "takeover" && second(call.request) ? "deliver-then-hang" : undefined;
      rig.network.afterDelivery = (call) =>
        call.path === "takeover" && second(call.request) ? signal(delivered) : Effect.void;

      const window = yield* a.moves
        .handOffMachine({
          destinationEnvironmentId: b.environmentId,
          reason: "manual",
          threadIds: [t1, t2],
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(delivered);
      // The destination runs the turn now.
      expect(b.launches).toHaveLength(2);
      expect(b.launches[1]?.initialMessage).toBeDefined();

      // The source restarts into a network where the destination does not answer.
      rig.network.afterDelivery = null;
      rig.network.rule = (call) => (call.to === b.environmentId ? "lose-request" : undefined);
      yield* rig.restart(a);
      yield* Fiber.interrupt(window);
      yield* a.moves.tick;
      yield* a.moves.resumeFenced;
      yield* a.moves.tick;
      expect(leaseOf(a, t2)?.state).toBe("handing-off");
      expect(continuedOn(a, t2)).toBeNull();
      expect(turnRefusal(a.document, t2, a.environmentId)).not.toBeNull();
      expect(["sent", "unknown"]).toContain(transferOf(a, t2)?.state);
      expect(rig.network.calls.filter((call) => call.to === c.environmentId && call.path === "takeover")).toHaveLength(0);

      // The destination answers again: the same operation is asked, and it says what it did.
      rig.network.rule = null;
      yield* a.moves.tick;
      expect(transferOf(a, t2)).toMatchObject({ state: "resumed", receipt: { resumed: true } });
      expect(continuedOn(a, t2)?.threadId).toBe(b.launches[1]?.threadId);
      expect(b.launches).toHaveLength(2);
      expect(c.launches).toHaveLength(0);
      const sent = takeovers(rig, b).filter(second);
      expect(new Set(sent.map((request) => request.operationId)).size).toBe(1);
    }),
  );

  it.effect("leaves the thread here when its turn does not stop in 45 seconds", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      rig.addThread(a, t1, { running: true });
      a.ignoreInterrupt = true;
      const asked = yield* Deferred.make<void>();
      a.onDispatch = (command) => (command.type === "run.interrupt" ? signal(asked) : Effect.void);

      const window = yield* handOff(a, t1, b).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(asked);
      for (let step = 0; step < 100; step += 1) yield* TestClock.adjust("500 millis");
      const outcome = yield* Fiber.join(window);

      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") {
        expect(outcome.failure.code).toBe("busy");
        expect(outcome.failure.message).toContain("45 seconds");
      }
      // The destination never starts a turn while this one still runs.
      expect(takeovers(rig)).toHaveLength(0);
      expect(b.launches).toHaveLength(0);
      expect(leaseOf(a, t1)).toMatchObject({ state: "active", epoch: 1 });
      expect(transferOf(a, t1)?.state).toBe("stayed");
      expect(a.threads.get(t1)?.activeRunId).not.toBeNull();
    }),
  );
});

/** A hold as the latest release leaves it: the lease held, and no transfer record. */
const legacyHold = (rig: Rig, source: RigMachine, copies: ReadonlyArray<RigMachine>) =>
  Effect.gen(function* () {
    rig.addThread(source, t1);
    for (const copy of copies) {
      yield* source.moves.preflight({
        destinationEnvironmentId: copy.environmentId,
        threadIds: [t1],
      });
    }
    const record = source.document.threads[t1]!;
    expect(record.replicas.map((replica) => replica.environmentId)).toEqual(
      copies.map((copy) => copy.environmentId),
    );
    source.document = {
      ...source.document,
      threads: {
        ...source.document.threads,
        [t1]: { ...record, lease: { ...record.lease!, state: "handing-off" } },
      },
    };
    return record.checkpoint!.sequence;
  });

describe("a hold from before transfer records", () => {
  it.effect("stays held until the machine that holds a copy says it never accepted", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      const sequence = yield* legacyHold(rig, a, [b]);
      rig.network.rule = (call) => (call.to === b.environmentId ? "lose-request" : undefined);

      yield* a.moves.tick;
      yield* a.moves.resumeFenced;
      // No answer proves nothing.
      expect(leaseOf(a, t1)?.state).toBe("handing-off");
      expect(transferOf(a, t1)).toMatchObject({ legacy: true, state: "unknown" });
      expect(turnRefusal(a.document, t1, a.environmentId)).not.toBeNull();

      rig.network.rule = null;
      yield* a.moves.tick;
      // Proven: the copy's machine wrote "not accepted" before it answered.
      expect(leaseOf(a, t1)).toMatchObject({ state: "active", epoch: 2 });
      expect(transferOf(a, t1)?.state).toBe("failed");
      expect(turnRefusal(a.document, t1, a.environmentId)).toBeNull();
      expect(acceptancesOf(b)[0]).toMatchObject({ verdict: "not-accepted" });
      // The takeover the old hold may have sent, arriving now.
      const late = yield* b.receiver
        .takeover(caller(a), {
          sourceEnvironmentId: a.environmentId,
          sourceThreadId: t1,
          epoch: 2,
          sequence,
          reason: "handoff",
          modelSelection: null,
        })
        .pipe(Effect.flip);
      expect(late.status).toBe(409);
      expect(b.launches).toHaveLength(0);
    }),
  );

  it.effect("is fenced, never released, when the copy's machine did continue it", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      const sequence = yield* legacyHold(rig, a, [b]);
      // The destination continued it under the latest release's rules; the answer was lost.
      const request = {
        sourceEnvironmentId: a.environmentId,
        sourceThreadId: t1,
        epoch: 2,
        sequence,
        reason: "handoff" as const,
        modelSelection: null,
      };
      const response = {
        threadId: continuationThreadId(a.environmentId, t1, 2),
        machineLabel: "B",
        modelSelection: null,
        resumed: true,
        notice: null,
      };
      b.document = previousMarkContinued(b.document, request, response, "2026-11-19T14:00:00.000Z");

      yield* a.moves.tick;

      expect(continuedOn(a, t1)?.threadId).toBe(response.threadId);
      expect(leaseOf(a, t1)?.state).toBe("fenced");
      expect(transferOf(a, t1)).toMatchObject({ legacy: true, state: "resumed" });
      expect(b.launches).toHaveLength(0);
    }),
  );

  it.effect("needs every machine that holds a copy to answer before it is released", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary, three);
      const [a, b, c] = rig.machines as [RigMachine, RigMachine, RigMachine];
      yield* legacyHold(rig, a, [b, c]);
      rig.network.rule = (call) => (call.to === c.environmentId ? "lose-request" : undefined);

      yield* a.moves.tick;
      expect(leaseOf(a, t1)?.state).toBe("handing-off");
      expect(
        transferOf(a, t1)?.candidates.map((candidate) => [candidate.environmentId, candidate.verdict]),
      ).toEqual([
        [b.environmentId, "not-accepted"],
        [c.environmentId, "unasked"],
        // This machine's own receiver is asked too: a move to another model stays here.
        [a.environmentId, "not-accepted"],
      ]);

      rig.network.rule = null;
      yield* a.moves.tick;
      expect(leaseOf(a, t1)).toMatchObject({ state: "active", epoch: 2 });
      expect(b.launches.length + c.launches.length).toBe(0);
    }),
  );

  it.effect.each(["failed", "stayed"] as const)(
    "finishes the release of a move that ended as %s just before the server stopped",
    (state) =>
      Effect.gen(function* () {
        const rig = yield* makeRig(temporary);
        const [a, b] = rig.machines as [RigMachine, RigMachine];
        yield* legacyHold(rig, a, [b]);
        // The record was ended; the stop came before the hold was given back.
        const now = "2026-11-19T14:00:00.000Z";
        a.transfers.document = putTransfer(a.transfers.document, {
          operationId: "ended-before-release",
          batchId: null,
          lineage: { sourceEnvironmentId: a.environmentId, sourceThreadId: t1, epoch: 2 },
          projectId: a.projectId,
          targetEnvironmentId: b.environmentId,
          sequence: 1,
          disposition: "resume",
          state,
          legacy: false,
          candidates: [],
          trigger: { kind: "manual" },
          reason: "handoff",
          modelSelection: null,
          receipt: null,
          detail: null,
          createdAt: now,
          updatedAt: now,
          sentAt: state === "failed" ? now : null,
        });
        rig.network.rule = (call) => (call.to === b.environmentId ? "lose-request" : undefined);

        yield* a.moves.tick;

        // No machine is asked again: the record already says how it ended. A move that
        // was sent used its epoch up; one that never left keeps the epoch it had.
        expect(leaseOf(a, t1)).toMatchObject({ state: "active", epoch: state === "failed" ? 2 : 1 });
        expect(transfersOf(a, t1)).toHaveLength(1);
        expect(rig.callsOf("transfer-status")).toHaveLength(0);
      }),
  );

  it.effect("re-sends an unanswered takeover it kept on file to the same machine only", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary, three);
      const [a, b, c] = rig.machines as [RigMachine, RigMachine, RigMachine];
      yield* legacyHold(rig, a, [b, c]);
      // The checkpoint the takeover named is the one that machine holds.
      const sequence = findIncoming(b.document, a.environmentId, t1)!.checkpoint.sequence;
      const record = a.document.threads[t1]!;
      a.document = {
        ...a.document,
        threads: {
          ...a.document.threads,
          [t1]: {
            ...record,
            pendingTakeover: {
              destinationEnvironmentId: b.environmentId,
              request: {
                sourceEnvironmentId: a.environmentId,
                sourceThreadId: t1,
                epoch: 2,
                sequence,
                reason: "handoff",
                modelSelection: null,
              },
            },
          },
        },
      };

      yield* a.moves.tick;

      expect(b.launches).toHaveLength(1);
      expect(continuedOn(a, t1)?.threadId).toBe(b.launches[0]?.threadId);
      expect(takeovers(rig, c)).toHaveLength(0);
      expect(c.launches).toHaveLength(0);
    }),
  );
});

describe("Continue here on a machine that holds a copy", () => {
  const copyOn = (rig: Rig, source: RigMachine, copies: ReadonlyArray<RigMachine>) =>
    Effect.gen(function* () {
      rig.addThread(source, t1);
      for (const copy of copies) {
        yield* source.moves.preflight({
          destinationEnvironmentId: copy.environmentId,
          threadIds: [t1],
        });
      }
    });
  const continueHere = (on: RigMachine, source: RigMachine) =>
    on.moves.continueHere({ sourceEnvironmentId: source.environmentId, sourceThreadId: t1 });

  it.effect("asks the machine that runs the thread, which hands it over under its own record", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      yield* copyOn(rig, a, [b]);

      const result = yield* continueHere(b, a);

      expect(b.launches.map((launch) => launch.threadId)).toEqual([result.threadId]);
      expect(continuedOn(a, t1)?.threadId).toBe(result.threadId);
      expect(transferOf(a, t1)).toMatchObject({
        trigger: { kind: "pull" },
        targetEnvironmentId: b.environmentId,
      });
      expect(moved(transferOf(a, t1))).toBe(true);
      expect(acceptancesOf(b)[0]).toMatchObject({ verdict: "accepted", launched: true });
    }),
  );

  it.effect("starts nothing while the source is silent, however stale its lease", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      yield* copyOn(rig, a, [b]);
      rig.network.rule = (call) => (call.to === a.environmentId ? "lose-request" : undefined);
      const renewedAt = Date.parse(findIncoming(b.document, a.environmentId, t1)!.lease.renewedAt);
      yield* TestClock.setTime(renewedAt + HANDOFF_LEASE_STALE_MS + 60_000);

      const failure = yield* continueHere(b, a).pipe(Effect.flip);

      expect(failure.code).toBe("busy");
      expect(b.launches).toHaveLength(0);
      expect(findIncoming(b.document, a.environmentId, t1)?.continuedThreadId).toBeNull();
      // The source still runs it.
      expect(leaseOf(a, t1)?.state).toBe("active");
    }),
  );

  it.effect("asks the source for an agent too, and starts nothing when it is silent", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      yield* copyOn(rig, a, [b]);
      const input = { sourceEnvironmentId: a.environmentId, sourceThreadId: t1 };
      rig.network.rule = (call) => (call.to === a.environmentId ? "lose-request" : undefined);
      const renewedAt = Date.parse(findIncoming(b.document, a.environmentId, t1)!.lease.renewedAt);
      yield* TestClock.setTime(renewedAt + HANDOFF_LEASE_STALE_MS + 60_000);

      const failure = yield* b.moves.continueHere(input, { byAgent: true }).pipe(Effect.flip);

      expect(failure.code).toBe("busy");
      expect(rig.callsOf("transfer-pull", a)).toHaveLength(1);
      expect(b.launches).toHaveLength(0);
      expect(leaseOf(a, t1)?.state).toBe("active");

      // The source answers again: it hands the thread over under its own record.
      rig.network.rule = null;
      const result = yield* b.moves.continueHere(input, { byAgent: true });
      expect(b.launches.map((launch) => launch.threadId)).toEqual([result.threadId]);
      expect(transferOf(a, t1)).toMatchObject({ trigger: { kind: "pull" } });
      expect(takeovers(rig)).toHaveLength(1);
    }),
  );

  it.effect("starts one continuation when two machines ask at once, also after a lost answer", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary, three);
      const [a, b, c] = rig.machines as [RigMachine, RigMachine, RigMachine];
      yield* copyOn(rig, a, [b, c]);
      // The source acts on C's request, and what it answers C is lost.
      rig.network.rule = (call) =>
        call.path === "transfer-pull" && call.from === c.environmentId ? "lose-answer" : undefined;

      const outcomes = yield* Effect.all(
        [continueHere(b, a).pipe(Effect.result), continueHere(c, a).pipe(Effect.result)],
        { concurrency: 2 },
      );
      expect(b.launches.length + c.launches.length).toBe(1);
      const winner = b.launches.length === 1 ? b : c;
      expect(continuedOn(a, t1)?.environmentId).toBe(winner.environmentId);
      expect(outcomes[1]._tag).toBe("Failure");

      // The network is back and both ask again.
      rig.network.rule = null;
      const again = yield* Effect.all(
        [continueHere(b, a).pipe(Effect.result), continueHere(c, a).pipe(Effect.result)],
        { concurrency: 2 },
      );
      expect(b.launches.length + c.launches.length).toBe(1);
      const [won, lost] = winner === b ? [again[0], again[1]] : [again[1], again[0]];
      expect(won._tag === "Success" ? won.success.threadId : null).toBe(
        winner.launches[0]?.threadId,
      );
      expect(lost._tag).toBe("Failure");
      expect(transfersOf(a, t1).filter(moved)).toHaveLength(1);
    }),
  );

  it.effect("takes the same fence as a push that runs at the same time", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary, three);
      const [a, b, c] = rig.machines as [RigMachine, RigMachine, RigMachine];
      yield* copyOn(rig, a, [b, c]);

      yield* Effect.all([handOff(a, t1, c).pipe(Effect.result), continueHere(b, a).pipe(Effect.result)], {
        concurrency: 2,
      });

      expect(b.launches.length + c.launches.length).toBe(1);
      expect(takeovers(rig)).toHaveLength(1);
      expect(transfersOf(a, t1).filter(moved)).toHaveLength(1);
    }),
  );
});

describe("a thread that arrived by an automatic handoff", () => {
  const arrived = Effect.gen(function* () {
    const rig = yield* makeRig(temporary);
    const [a, b] = rig.machines as [RigMachine, RigMachine];
    rig.addThread(a, t1);
    const there = yield* a.moves.handOff({
      threadId: t1,
      destinationEnvironmentId: b.environmentId,
      trigger: {
        kind: "automatic",
        key: "limit-handoff:thread:one:run-1",
        usageWindowKey: "1970-01-01T05:00:00.000Z",
      },
    });
    const sendBack = (kind: "automatic" | "manual") =>
      b.moves.handOff({
        threadId: there.threadId,
        destinationEnvironmentId: a.environmentId,
        trigger: { kind, key: "limit-handoff:continued:run-1" },
      });
    return { rig, a, b, there, sendBack };
  });

  it.effect("is not sent back automatically for the same run and usage window", () =>
    Effect.gen(function* () {
      const { rig, a, b, there, sendBack } = yield* arrived;
      expect(acceptancesOf(b)[0]?.trigger).toMatchObject({ kind: "automatic" });
      const calls = rig.network.calls.length;

      const failure = yield* sendBack("automatic").pipe(Effect.flip);

      expect(failure.message).toContain("not sent back automatically");
      expect(rig.network.calls).toHaveLength(calls);
      expect(a.launches).toHaveLength(0);
      expect(leaseOf(b, there.threadId)?.state).toBe("active");
      expect(transfersOf(b, there.threadId)).toHaveLength(0);
    }),
  );

  it.effect.each(["by hand", "after the usage window reset", "on a later run"] as const)(
    "is sent back %s",
    (how) =>
      Effect.gen(function* () {
        const { a, b, there, sendBack } = yield* arrived;
        if (how === "after the usage window reset") yield* TestClock.setTime(6 * 60 * 60_000);
        if (how === "on a later run") {
          const record = b.document.threads[there.threadId]!;
          b.document = {
            ...b.document,
            threads: {
              ...b.document.threads,
              [there.threadId]: { ...record, runEpochs: { "run-1": 2, "run-2": 2 } },
            },
          };
        }

        const back = yield* sendBack(how === "by hand" ? "manual" : "automatic");

        expect(a.launches.map((launch) => launch.threadId)).toEqual([back.threadId]);
        expect(continuedOn(b, there.threadId)?.environmentId).toBe(a.environmentId);
        expect(isHandoffTransferFinished(transferOf(b, there.threadId)!.state)).toBe(true);
      }),
  );
});
