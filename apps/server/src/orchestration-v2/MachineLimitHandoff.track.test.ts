import { RunId, ThreadId } from "@specweave-studio/contracts";
import { it as itEffect } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import { accountFingerprint, accountPoolKey } from "../usage/providerUsageSummary.ts";
import { type LimitHandoffCheckInput } from "./MachineLimitHandoff.ts";
import {
  stoppedAt,
  resetsAt,
  claudeId,
  codexId,
  minis,
  m3,
  codex,
  sourcePool,
  limited,
  target,
  machine,
  trackEvidence,
  trackAnswer,
  noRoom,
  onTracks,
  daily,
  type Scenario,
  run,
} from "./MachineLimitHandoff.test.fixture.ts";

describe("the automatic start when a thread's track is out here (1390 T-13)", () => {
  const orders = ["other-machine-first", "same-machine-first"] as const;

  itEffect.effect.each(orders)(
    "a track with room on this machine asks no machine, under %s (AC-37)",
    (order) =>
      Effect.gen(function* () {
        const result = yield* run({
          settings: { ...onTracks, providerLimitTargetOrder: order },
          thread: daily,
          machines: [machine(minis, "Minis"), machine(m3, "M3")],
        });
        // The next model of the Daily track runs here; nothing was asked of Minis or M3.
        expect(result.checks).toEqual([]);
        expect(result.requests).toEqual([]);
        expect(result.dispatched[0]).toMatchObject({
          modelSelection: { instanceId: codexId, model: "gpt-6" },
        });
      }),
  );

  itEffect.effect.each(orders)("a track out on this machine hands off, under %s (AC-37)", (order) =>
    Effect.gen(function* () {
      const result = yield* run({
        settings: { ...onTracks, providerLimitTargetOrder: order },
        thread: daily,
        localSpent: true,
        machines: [machine(minis, "Minis"), machine(m3, "M3")],
        checks: { [minis]: trackAnswer("Minis", trackEvidence()) },
      });
      expect(result.requests).toHaveLength(1);
      expect(result.dispatched).toEqual([]);
    }),
  );

  itEffect.effect(
    "asks the machine for the thread's own track and moves onto the sign-in it confirmed (AC-38)",
    () =>
      Effect.gen(function* () {
        const confirmed = { instanceId: codexId, model: "gpt-6" };
        const result = yield* run(
          {
            settings: {
              ...onTracks,
              providerLimitSwitchAtPercent: 95,
              // Two saved targets on Minis: the machine is still asked once.
              providerLimitMachineTargets: [
                target(minis, "Minis"),
                { ...target(minis, "Minis"), modelSelection: confirmed },
                target(m3, "M3"),
              ],
              // An unknown reading never qualifies a track move, whatever this says.
              providerLimitUnknownUsageEligible: true,
            },
            thread: daily,
            localSpent: true,
            machines: [machine(minis, "Minis"), machine(m3, "M3")],
            checks: {
              [minis]: trackAnswer("Minis", trackEvidence({ modelSelection: confirmed })),
            },
          },
          3,
        );
        expect(result.checks).toHaveLength(1);
        expect(result.checks[0]).toMatchObject({
          environmentId: minis,
          input: { start: "automatic", thresholdPercent: 95 },
        });
        const asked = result.checks[0]!.input.threads[0]!;
        expect(asked).toMatchObject({
          sourceThreadId: limited.id,
          track: "daily",
          driverKind: "claudeAgent",
        });
        // Every pool the track ran out on here, on both providers.
        expect([...asked.accountFingerprints].sort()).toEqual(
          [sourcePool, accountFingerprint(accountPoolKey(codex(stoppedAt, 100))!)].sort(),
        );
        expect(result.requests).toHaveLength(1);
        expect(result.requests[0]).toMatchObject({
          destinationEnvironmentId: minis,
          modelSelection: confirmed,
          reason: "usage-limit",
          resume: true,
          idempotencyKey: "limit-handoff:t1:r1",
          sourceSummary: "Daily track out of tokens on M4",
          track: "daily",
        });
        expect(result.held).toBe(true);
        expect(result.shown?.track).toMatchObject({
          threadId: limited.id,
          track: "daily",
          trackOut: true,
          reason: "Daily track out of tokens on M4",
          everyMachineOut: false,
          target: {
            environmentId: minis,
            machineLabel: "Minis",
            modelSelection: confirmed,
            disposition: "resume",
          },
        });
      }),
  );

  itEffect.effect(
    "a machine on the same depleted pool or with stale usage adds nothing; the next is asked (AC-38)",
    () =>
      Effect.gen(function* () {
        const result = yield* run({
          settings: { ...onTracks, providerLimitUnknownUsageEligible: true },
          thread: daily,
          localSpent: true,
          machines: [machine(minis, "Minis"), machine(m3, "M3")],
          checks: {
            [minis]: trackAnswer(
              "Minis",
              trackEvidence({
                kind: "usage-unknown",
                automatic: false,
                line: "Usage unknown",
                usedPercent: null,
              }),
            ),
            [m3]: trackAnswer("M3", trackEvidence()),
          },
        });
        expect(result.checks.map((check) => check.environmentId)).toEqual([minis, m3]);
        expect(result.requests.map((request) => request.destinationEnvironmentId)).toEqual([m3]);
      }),
  );

  const everyOut = (minisReset: string | null, m3Reset: string | null): Scenario => ({
    settings: onTracks,
    thread: daily,
    localSpent: true,
    machines: [machine(minis, "Minis"), machine(m3, "M3")],
    checks: {
      [minis]: trackAnswer("Minis", { ...noRoom, resetsAt: minisReset }),
      [m3]: trackAnswer("M3", { ...noRoom, resetsAt: m3Reset }),
    },
  });

  itEffect.effect(
    "no machine has the track: no move, no other track, the earliest reset, asked once (AC-39)",
    () =>
      Effect.gen(function* () {
        const early = DateTime.formatIso(DateTime.makeUnsafe(stoppedAt + 100_000));
        // Sweeps at +30 s and +90 s: the reset at +100 s has not come.
        const result = yield* run(everyOut(resetsAt, early), 2);
        expect(result.requests).toEqual([]);
        expect(result.dispatched).toEqual([]);
        expect(result.held).toBe(false);
        expect(result.checks.map((check) => check.environmentId)).toEqual([minis, m3]);
        expect(result.shown?.track).toMatchObject({
          track: "daily",
          trackOut: true,
          target: null,
          everyMachineOut: true,
          earliestReset: { machineLabel: "M3", at: early },
          recheckAt: early,
        });
        expect(result.shown?.waiting).toBe("Daily track is out on every machine.");
        // The third sweep, at +150 s, is past that reset: the machines are asked again, once.
        const later = yield* run(everyOut(resetsAt, early), 3);
        expect(later.checks.map((check) => check.environmentId)).toEqual([minis, m3, minis, m3]);
        expect(later.requests).toEqual([]);
      }),
  );

  itEffect.effect(
    "with no reset time anywhere it says so, and does not ask each sweep (AC-39)",
    () =>
      Effect.gen(function* () {
        const result = yield* run(
          {
            ...everyOut(null, null),
            // This machine's own windows name no reset either.
            thread: { ...daily, usageLimitResetAt: null },
          },
          3,
        );
        expect(result.checks).toHaveLength(2);
        expect(result.requests).toEqual([]);
        expect(result.shown?.track).toMatchObject({ everyMachineOut: true, target: null });
      }),
  );

  itEffect.effect(
    "a machine from before the track start is never sent a thread: Needs update (EC2-04)",
    () =>
      Effect.gen(function* () {
        const result = yield* run({
          settings: { ...onTracks, providerLimitMachineTargets: [target(minis, "Minis")] },
          thread: daily,
          localSpent: true,
          machines: [machine(minis, "Minis")],
          checks: {
            // It plans hand offs and says it has room, and names no track start.
            [minis]: trackAnswer("Minis", trackEvidence(), ["handoff.v2", "handoff.plan"]),
          },
        });
        expect(result.requests).toEqual([]);
        expect(result.shown?.track?.machines).toMatchObject([
          { environmentId: minis, state: "needs-update" },
        ]);
        expect(result.shown?.track?.everyMachineOut).toBe(false);
      }),
  );

  itEffect.effect("a thread with Hand off automatically off is asked of no machine (AC-25)", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          settings: onTracks,
          thread: daily,
          localSpent: true,
          optedOut: true,
          machines: [machine(minis, "Minis"), machine(m3, "M3")],
          checks: { [minis]: trackAnswer("Minis", trackEvidence()) },
        },
        2,
      );
      expect(result.checks).toEqual([]);
      expect(result.requests).toEqual([]);
    }),
  );

  itEffect.effect("a thread whose track is not known starts nothing by itself", () =>
    Effect.gen(function* () {
      // No routing decision, and Opus is on both tracks.
      const result = yield* run({
        settings: {
          ...onTracks,
          modelLanes: {
            ...onTracks.modelLanes!,
            complex: [{ instanceId: claudeId, model: "opus" }],
          },
        },
        localSpent: true,
        machines: [machine(minis, "Minis")],
        checks: { [minis]: trackAnswer("Minis", trackEvidence()) },
      });
      expect(result.checks).toEqual([]);
      expect(result.requests).toEqual([]);
    }),
  );

  itEffect.effect("a project without tracks keeps its saved order and asks no track check", () =>
    Effect.gen(function* () {
      const result = yield* run({ machines: [machine(minis, "Minis"), machine(m3, "M3")] });
      expect(result.checks).toEqual([]);
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]).toMatchObject({
        destinationEnvironmentId: minis,
        sourceSummary: "Claude limit reached on M4",
      });
      expect(result.requests[0]?.track).toBeUndefined();
      expect(result.shown?.track ?? null).toBeNull();
    }),
  );
});

describe("what changes between the check and the send (1390 T-13, round 1)", () => {
  const out = {
    settings: onTracks,
    thread: daily,
    localSpent: true,
    machines: [machine(minis, "Minis"), machine(m3, "M3")],
    checks: { [minis]: trackAnswer("Minis", trackEvidence()) },
  };
  const weekly = "2026-10-23T18:00:00.000Z";
  const outForDays = {
    ...out,
    thread: { ...daily, usageLimitResetAt: weekly },
    localResetsAt: weekly,
    checks: {
      [minis]: trackAnswer("Minis", { ...noRoom, resetsAt: weekly }),
      [m3]: trackAnswer("M3", { ...noRoom, resetsAt: weekly }),
    },
  };
  const askedFor = (result: {
    readonly checks: ReadonlyArray<{ input: LimitHandoffCheckInput }>;
  }) => result.checks.map((check) => check.input.threads[0]?.sourceThreadId);

  itEffect.effect(
    "a sign-in that reset here while a machine answered keeps the thread (AC-37)",
    () =>
      Effect.gen(function* () {
        const result = yield* run({
          ...out,
          duringCheck: (world) => Effect.sync(() => void (world.localReset = true)),
        });
        expect(result.checks).toHaveLength(1);
        expect(result.requests).toEqual([]);
        expect(result.held).toBe(false);
      }),
  );

  itEffect.effect("a machine taken off the list while it answered is not sent the thread", () =>
    Effect.gen(function* () {
      const result = yield* run({
        ...out,
        duringCheck: (world) => world.update({ providerLimitMachineTargets: [target(m3, "M3")] }),
      });
      expect(result.checks[0]?.environmentId).toBe(minis);
      expect(result.requests).toEqual([]);
    }),
  );

  itEffect.effect("Off chosen while a machine answered keeps the thread (AC-25)", () =>
    Effect.gen(function* () {
      const result = yield* run({
        ...out,
        duringCheck: (world) => Effect.sync(() => void (world.optedOut = true)),
      });
      expect(result.checks).toHaveLength(1);
      expect(result.requests).toEqual([]);
      expect(result.shown?.waiting).toBe("Hand off automatically is off for this thread.");
    }),
  );

  itEffect.effect("Off keeps a thread of a project without tracks too (AC-25)", () =>
    Effect.gen(function* () {
      const result = yield* run({ machines: [machine(minis, "Minis")], optedOut: true });
      expect(result.requests).toEqual([]);
      expect(result.shown?.waiting).toBe("Hand off automatically is off for this thread.");
    }),
  );

  itEffect.effect("a review told only by its title asks no machine for a track", () =>
    Effect.gen(function* () {
      const result = yield* run({
        ...out,
        // No routing marker: Opus is on the Daily track alone, so the model would name it.
        thread: { title: "Adversarial review: the fix" },
      });
      expect(result.checks).toEqual([]);
      expect(result.requests.filter((request) => request.track !== undefined)).toEqual([]);
    }),
  );

  itEffect.effect("the move names the run, the disposition and the window's end (EC2-08)", () =>
    Effect.gen(function* () {
      const result = yield* run(out);
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]).toMatchObject({
        idempotencyKey: "limit-handoff:t1:r1",
        runId: "r1",
        resume: true,
        track: "daily",
        usageWindowKey: resetsAt,
      });
    }),
  );

  itEffect.effect("a move off a project without tracks names its run and window too", () =>
    Effect.gen(function* () {
      const result = yield* run({ machines: [machine(minis, "Minis")] });
      expect(result.requests[0]).toMatchObject({ runId: "r1", usageWindowKey: resetsAt });
    }),
  );

  itEffect.effect("a wait for a weekly reset is kept, and shown, past a day (AC-39)", () =>
    Effect.gen(function* () {
      const result = yield* run({ ...outForDays, between: () => TestClock.adjust("25 hours") }, 2);
      // Each machine was asked once; nothing is asked again before the reset.
      expect(result.checks.map((check) => check.environmentId)).toEqual([minis, m3]);
      expect(result.requests).toEqual([]);
      expect(result.shown?.track).toMatchObject({
        everyMachineOut: true,
        earliestReset: { at: weekly },
        recheckAt: weekly,
      });
    }),
  );

  itEffect.effect("another thread's decision never drops a wait before its reset (AC-39)", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          ...outForDays,
          second: { id: ThreadId.make("t2") },
          // A day on, the second thread stops on a new run and is decided again.
          between: (world) =>
            TestClock.adjust("25 hours").pipe(
              Effect.andThen(
                Effect.sync(() => {
                  world.second = { ...world.second, latestRunId: RunId.make("r2") };
                }),
              ),
            ),
        },
        3,
      );
      expect(askedFor(result).filter((id) => id === "t1")).toHaveLength(2);
      expect(askedFor(result).filter((id) => id === "t2")).toHaveLength(4);
    }),
  );
});
