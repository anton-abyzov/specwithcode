// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * A lid close the previous release sent, settled by this release's status route over
 * this release's handoff receiver (1390 AC-36), on the two in-memory machines of
 * `handoffMove.test.fixture.ts`. The M4 slept on the previous release and its away
 * intent reached Minis, also on that release, whose Away runner continued the M4's
 * thread at epoch 2 and stopped before the replica was marked continued. Minis then
 * updated, handed the continuation on to a third machine at epoch 3, and replicated
 * enough other threads that the M4's replica was evicted. The M4's wake check is the
 * tagged one (`previousRelease.awaySleep.test.fixture.ts`); every answer it reads comes
 * from the receiver's own evidence on Minis's handoff document.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  AWAY_INTENT_CANCEL_PATH,
  AWAY_INTENT_PATH,
  AWAY_INTENT_STATUS_PATH,
  type AwayConfig,
  type AwayIntentRecord,
  EnvironmentId,
  ThreadId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  m4,
  minis,
  registerCleanup,
  scenario,
  threadId,
} from "../handoff/handoffMove.test.fixture.ts";
import * as HandoffReceiver from "../handoff/HandoffReceiver.ts";
import {
  fenceRecord,
  findIncoming,
  HANDOFF_INCOMING_MAX,
  type HandoffDocument,
} from "../handoff/handoffState.ts";
import type { ReplicateMeta } from "../handoff/handoffWire.ts";
import * as PreviousReceiver from "../handoff/previousRelease.handoffReceiver.test.fixture.ts";
import { previousAwayAnswerKind } from "../handoff/previousRelease.test.fixture.ts";
import { makeAwayIntents, memoryIntentStore } from "./AwayIntents.ts";
import { cancelIntent, type IntentAnswer, intentStatus } from "./awayIntentRoute.ts";
import { AwayPeerError, type AwayPeerPost } from "./awayPeerCall.ts";
import { memoryWakeHoldStore } from "./AwayWakeHold.ts";
import * as PreviousIntents from "./previousRelease.awayIntents.test.fixture.ts";
import * as PreviousSleep from "./previousRelease.awaySleep.test.fixture.ts";

registerCleanup();

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-20T14:00:00.000Z");
/** The continuation Minis launched for the M4's thread at epoch 2. */
const continuation = HandoffReceiver.continuationThreadId(m4, threadId, 2);
/** The third machine the continuation moves on to. */
const third = EnvironmentId.make("env-m1");

/** The continuation moves on to the third machine at epoch 3, as a handoff from Minis does. */
const movedOn = (document: HandoffDocument): HandoffDocument => {
  const record = document.threads[continuation]!;
  return {
    ...document,
    threads: {
      ...document.threads,
      [continuation]: fenceRecord(
        { ...record, lease: { ...record.lease!, epoch: 3 } },
        {
          environmentId: third,
          machineLabel: "M1",
          threadId: ThreadId.make("handoff:onward-on-m1"),
          at: "2026-10-20T14:05:00.000Z",
        },
        "handoff",
      ),
    },
  };
};

const wireJson = (value: unknown) => JSON.parse(JSON.stringify(value ?? null)) as unknown;

describe(`a lid close on ${PreviousSleep.PREVIOUS_RELEASE}, settled here (1390 AC-36)`, () => {
  it.effect(
    "continued, moved on, its replica evicted: the wake check fences it, never starts its queue",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const setup = yield* scenario();
        const { destination, destinationReceiver: receiver, asSource, fixture, wire } = setup;
        NodeFS.writeFileSync(NodePath.join(setup.destinationRoot, ".env.local"), "TOKEN=minis\n");
        // A turn end replicates the M4's thread to Minis; its request is kept so that other
        // threads can be replicated the same way.
        const sent: Array<ReplicateMeta> = [];
        wire.destination = {
          ...receiver,
          replicate: (caller, meta, bundle) => {
            sent.push(meta);
            return receiver.replicate(caller, meta, bundle);
          },
        };
        yield* setup.moves.preflight({ destinationEnvironmentId: minis, threadIds: [threadId] });
        wire.destination = receiver;
        expect(sent.length).toBeGreaterThan(0);
        const replicated = sent[0]!;
        expect(findIncoming(destination.document, m4, threadId)?.lease.epoch).toBe(1);

        // Minis before its update: the intents it keeps, and the receiver its Away runner
        // continued an intent's threads through (Continue here, as this machine).
        const store = memoryIntentStore();
        let ids = 0;
        const before = yield* PreviousIntents.makeAwayIntents({
          store,
          newId: Effect.sync(() => `intent-${++ids}`),
          heardAwake: () => Effect.succeed(false),
          act: () => Effect.succeed([]),
        });
        const earlierReceiver = yield* PreviousReceiver.make.pipe(
          Effect.provide(setup.destinationServices),
        );
        // The continuation launches, then the takeover stops before the replica is marked.
        yield* before.onIntentDue((intent: AwayIntentRecord) =>
          Effect.forEach(
            intent.threadIds,
            (sourceThreadId) =>
              Effect.gen(function* () {
                const source = intent.sourceEnvironmentId;
                const replica = findIncoming(destination.document, source, sourceThreadId);
                if (replica === undefined) return;
                fixture.launch = "fails-after-create";
                yield* Effect.result(
                  earlierReceiver.takeover(
                    { sourceEnvironmentId: source, grant: null, runtimeCeiling: null },
                    {
                      sourceEnvironmentId: source,
                      sourceThreadId: ThreadId.make(sourceThreadId),
                      epoch: replica.lease.epoch + 1,
                      sequence: replica.checkpoint.sequence,
                      reason: "continue-here",
                      modelSelection: null,
                    },
                  ),
                );
                fixture.launch = "starts";
              }),
            { discard: true },
          ),
        );
        // Minis on this release, reading the same intents.
        const intents = yield* makeAwayIntents({
          store,
          settleActed: () => Effect.succeed([]),
          continuation: receiver.continuation,
        });
        /** Minis's away routes as the M4 reaches them: the intent before Minis updated. */
        const route = (path: string, body: unknown): Effect.Effect<IntentAnswer> => {
          if (path === AWAY_INTENT_PATH)
            return PreviousIntents.recordIntent(before, asSource, body, []);
          if (path === AWAY_INTENT_CANCEL_PATH) return cancelIntent(intents, asSource, body);
          if (path === AWAY_INTENT_STATUS_PATH)
            return intentStatus(
              {
                latestState: intents.latestState,
                continuation: (sourceThreadId) =>
                  receiver.continuation(asSource.sourceEnvironmentId, sourceThreadId),
              },
              asSource,
              body,
              Effect.succeed([]),
              minis,
            );
          return Effect.succeed({ status: 404, body: { error: "not found" } });
        };
        const statusAnswers: Array<unknown> = [];
        const post: AwayPeerPost = (_target, path, body) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(route(path, wireJson(body)));
            const answer = exit._tag === "Success" ? exit.value : { status: 500, body: null };
            if (path === AWAY_INTENT_STATUS_PATH) statusAnswers.push(wireJson(answer.body));
            const kind = previousAwayAnswerKind(answer.status, answer.body);
            if (kind === "answered") return { status: answer.status, json: wireJson(answer.body) };
            return yield* new AwayPeerError({
              message: "Minis did not take it.",
              refused: kind === "refused",
              uncertain: kind === "uncertain",
              status: answer.status,
            });
          });

        // The M4 on the previous release: its lid close, wake hold and wake check.
        const session = PreviousSleep.memorySleepStore();
        const hold = memoryWakeHoldStore();
        const resumed: Array<string> = [];
        const fenced: Array<{ readonly sourceThreadId: string; readonly threadId: string }> = [];
        const m4Away = yield* PreviousSleep.makeAwaySleep({
          self: m4,
          store: session,
          hold,
          config: Effect.succeed<AwayConfig>({
            target: minis,
            sleepTrigger: "always",
            graceMinutes: 2,
            bringBack: "prompt",
            coordinatorScope: "live",
          }),
          ids: () => Effect.succeed({ projectIds: [], threadIds: [threadId] }),
          post,
          // Its handoff mode heartbeats Minis and fences each thread Minis names as continued.
          confirmContinued: (threadIds) =>
            Effect.gen(function* () {
              const beat = yield* receiver.heartbeat(asSource, {
                sourceEnvironmentId: m4,
                sourceLabel: "M4",
                leases: threadIds.map((held) => ({
                  sourceThreadId: ThreadId.make(held),
                  epoch: 1,
                })),
              });
              for (const entry of beat.continued)
                fenced.push({ sourceThreadId: entry.sourceThreadId, threadId: entry.threadId });
              return new Set<string>(beat.continued.map((entry) => entry.sourceThreadId));
            }).pipe(Effect.orDie),
          resumeQueues: (threadIds) => Effect.sync(() => void resumed.push(...threadIds)),
        });
        yield* (yield* m4Away.sleep({ onBattery: false })).send;
        expect(session.current()?.state).toBe("pending-intent");
        expect(hold.current()?.threads).toEqual([threadId]);

        // Minis acts after the grace, still on the previous release.
        yield* TestClock.setTime(T0 + 2 * MINUTE);
        expect((yield* before.tick)[0]).toMatchObject({ state: "done", threadIds: [threadId] });
        expect(destination.launches.map((launch) => launch.threadId)).toEqual([continuation]);
        expect(findIncoming(destination.document, m4, threadId)?.continuedThreadId).toBeNull();

        // Minis updates. Nothing asks it about the thread until the M4 wakes: it hands the
        // continuation on at epoch 3, and replicas of other threads evict the M4's replica,
        // the one never marked continued.
        destination.document = movedOn(destination.document);
        for (let index = 0; index < HANDOFF_INCOMING_MAX; index += 1) {
          const other = ThreadId.make(`thread:other-${index}`);
          yield* receiver.replicate(asSource, { ...replicated, sourceThreadId: other }, null);
        }
        expect(findIncoming(destination.document, m4, threadId)).toBeUndefined();
        expect(destination.document.threads[continuation]?.lease?.epoch).toBe(3);
        expect(destination.launches).toHaveLength(1);

        // The M4 wakes and runs its wake check against this release's status route.
        yield* TestClock.setTime(T0 + 30 * MINUTE);
        expect(yield* m4Away.wake({ onBattery: true })).toEqual({ outcome: "prompt" });
        // The thread continues elsewhere: it is never let go to run here, nor its queue started.
        expect(resumed).toEqual([]);
        expect(statusAnswers).toEqual([
          expect.objectContaining({
            intentState: "done",
            threads: [{ threadId, continuedThreadId: continuation }],
          }),
        ]);
        // Its copy is fenced with the continuation Minis launched, and the hold has done its job.
        expect(fenced).toEqual([{ sourceThreadId: threadId, threadId: continuation }]);
        expect(hold.current()).toBeNull();
        expect(session.current()?.state).toBe("wake-prompt");
        expect(destination.launches).toHaveLength(1);
      }),
    120_000,
  );
});
