import { TeamRules, teamRulesOf } from "../teamRules/TeamRules.ts";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  HandoffModeError,
  type OrchestratorMcpMachine,
  ProviderDriverKind,
  type ProviderLimitMachineTarget,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import { it as itEffect } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";
import { PERSONAL_ASSISTANT_PRIVATE_MESSAGE } from "@specweave-studio/shared/personalAssistant";

import { PAUSED_OFFLINE_REFUSAL } from "../handoff/HandoffTurnGate.ts";
import * as PreviousRelease from "../handoff/handoffReviewLock.previousRelease.test.fixture.ts";
import {
  EMPTY_HANDOFF_DOCUMENT,
  emptyThreadRecord,
  type HandoffDocument,
} from "../handoff/handoffState.ts";
import { makeLimitHandoffPort } from "./LimitHandoffAdapter.ts";
import {
  LIMIT_PREMOVE_RECENT_MS,
  type LimitHandoffOutcome,
  type LimitHandoffRequest,
  limitHandoffTrigger,
  limitResumable,
} from "./MachineLimitHandoff.ts";
import {
  stoppedAt,
  resetsAt,
  claudeId,
  codexId,
  minis,
  m4,
  m3,
  project,
  sourcePool,
  otherPool,
  limited,
  target,
  machine,
  run,
} from "./MachineLimitHandoff.test.fixture.ts";

// Built out here: a test body is an Effect generator.
const previousCandidate = Schema.decodeUnknownSync(PreviousRelease.LimitHandoffCandidate);

describe("limit handoff in the fallback sweep", () => {
  // A review by Claude of work an OpenAI model wrote, stopped on Claude's limit here (1390 AC-40).
  const reviewRouting = {
    taskClass: "review",
    confidence: "high",
    moved: false,
    tier: null,
    selection: limited.modelSelection,
    baseline: { instanceId: codexId, model: "gpt-6" },
    escalation: null,
    billing: "unknown",
    reason: "Review by Claude; it stays on Claude models.",
    signals: [],
    reviewFamily: "claude",
    decidedAt: "2026-10-09T11:00:00.000Z",
  };
  const review = { title: "Review the fix", routing: reviewRouting };
  const codexRow = {
    providerInstanceId: codexId,
    driverKind: ProviderDriverKind.make("codex"),
    models: ["gpt-6"],
    available: true,
    usage: {
      accountFingerprint: otherPool,
      usedPercent: 10,
      resetsAt,
      signedIn: true,
      observedAt: DateTime.formatIso(DateTime.makeUnsafe(stoppedAt)),
    },
  };
  /** A machine that keeps a reviewer lock, with these sign-ins. */
  const keepsLock = (
    environmentId: EnvironmentId,
    label: string,
    holds: "claude" | "codex" | "both",
  ) => {
    const base = machine(environmentId, label, { handoffReviewLock: true });
    return {
      ...base,
      providers:
        holds === "claude"
          ? base.providers
          : holds === "codex"
            ? [codexRow]
            : [codexRow, ...(base.providers ?? [])],
    } as OrchestratorMcpMachine;
  };

  itEffect.effect(
    "a review stays when the other machine holds only the author's family: Review stays here",
    () =>
      Effect.gen(function* () {
        const result = yield* run(
          {
            settings: { providerLimitMachineTargets: [target(minis, "Minis")] },
            machines: [keepsLock(minis, "Minis", "codex")],
            thread: review,
            localSpent: true,
          },
          3,
        );
        expect(result.requests).toHaveLength(0);
        expect(result.held).toBe(false);
        expect(result.shown?.candidates).toEqual([
          expect.objectContaining({
            environmentId: minis,
            eligible: false,
            reason: "refused",
            review: "no_reviewer",
            text: "Review stays here: no permitted reviewer on Minis",
          }),
        ]);
        // The row says it once; the wait text does not wrap it in another sentence.
        expect(result.shown?.waiting).toBe("Review stays here: no permitted reviewer on Minis.");
      }),
  );

  itEffect.effect("a review moves to a machine with a permitted reviewer, on that reviewer", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          machines: [keepsLock(minis, "Minis", "codex"), keepsLock(m3, "M3", "claude")],
          thread: review,
          localSpent: true,
        },
        3,
      );
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]).toMatchObject({
        threadId: limited.id,
        destinationEnvironmentId: m3,
        modelSelection: { instanceId: claudeId, model: "opus" },
        resume: true,
      });
      expect(result.held).toBe(true);
    }),
  );

  itEffect.effect(
    "a review asks the other machine for a permitted model, not the saved one of the author's family",
    () =>
      Effect.gen(function* () {
        const saved: ProviderLimitMachineTarget = {
          environmentId: m3,
          label: "M3",
          modelSelection: { instanceId: codexId, model: "gpt-6" },
          modelLabel: "GPT-6",
        };
        const scenario = {
          settings: { providerLimitMachineTargets: [saved] },
          machines: [keepsLock(m3, "M3", "both")],
          localSpent: true,
        };
        // Any other thread goes to the saved model.
        const ordinary = yield* run(scenario, 1);
        expect(ordinary.requests[0]?.modelSelection).toEqual({
          instanceId: codexId,
          model: "gpt-6",
        });
        const result = yield* run({ ...scenario, thread: review }, 1);
        expect(result.requests).toHaveLength(1);
        expect(result.requests[0]?.modelSelection).toEqual({ instanceId: claudeId, model: "opus" });
        expect(result.requests[0]?.modelLabel).toBeUndefined();
      }),
  );

  itEffect.effect(
    "an older Adversarial review thread with no routing is locked to its own model's family",
    () =>
      Effect.gen(function* () {
        const older = { title: "Adversarial review: Fix the build" };
        const stays = yield* run(
          {
            settings: { providerLimitMachineTargets: [target(minis, "Minis")] },
            machines: [keepsLock(minis, "Minis", "codex")],
            thread: older,
            localSpent: true,
          },
          2,
        );
        expect(stays.requests).toHaveLength(0);
        expect(stays.shown?.candidates[0]).toMatchObject({ review: "no_reviewer" });
        const moves = yield* run(
          { machines: [keepsLock(m3, "M3", "claude")], thread: older, localSpent: true },
          2,
        );
        expect(moves.requests.map((request) => request.destinationEnvironmentId)).toEqual([m3]);
      }),
  );

  itEffect.effect(
    "a machine on the previous release is never a target for a review: it would drop the lock",
    () =>
      Effect.gen(function* () {
        expect(PreviousRelease.PREVIOUS_RELEASE).toBe("v1.0.386");
        // That release's descriptor names no reviewer lock, so its row carries none.
        expect(PreviousRelease.peerRules(PreviousRelease.descriptor(minis, "Minis"))).toEqual({
          carried: true,
        });
        const older = [machine(minis, "Minis"), machine(m3, "M3")];
        const result = yield* run({ machines: older, thread: review, localSpent: true }, 3);
        expect(result.requests).toHaveLength(0);
        expect(result.held).toBe(false);
        expect(result.shown?.candidates.map((candidate) => candidate.text)).toEqual([
          "Review stays here: update SpecWithCode on Minis",
          "Review stays here: update SpecWithCode on M3",
        ]);
        for (const candidate of result.shown?.candidates ?? []) {
          expect(candidate).toMatchObject({
            eligible: false,
            reason: "update_needed",
            review: "update_needed",
          });
          // A window on that release still reads the row.
          expect(previousCandidate(JSON.parse(JSON.stringify(candidate)))).toMatchObject({
            reason: "update_needed",
            eligible: false,
          });
        }
        // The same machines still take a thread that is no review.
        const ordinary = yield* run({ machines: older, localSpent: true }, 1);
        expect(ordinary.requests).toHaveLength(1);
        // And that release, sending, never offered a marked review to any machine.
        expect(PreviousRelease.limitTargets({ routing: reviewRouting }, [minis, m3])).toEqual([]);
      }),
  );

  itEffect.effect("a machine that was not read keeps its own verdict and takes no review", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          settings: { providerLimitMachineTargets: [target(minis, "Minis")] },
          machines: [{ ...keepsLock(minis, "Minis", "claude"), status: "unreachable" }],
          thread: review,
          localSpent: true,
        },
        2,
      );
      expect(result.requests).toHaveLength(0);
      expect(result.shown?.candidates[0]).toMatchObject({ reason: "offline", eligible: false });
      expect(result.shown?.candidates[0]?.review).toBeUndefined();
    }),
  );

  itEffect.effect("hands a turn stopped on the limit to the first eligible machine", () =>
    Effect.gen(function* () {
      const result = yield* run({ machines: [machine(minis, "Minis"), machine(m3, "M3")] }, 3);
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]).toMatchObject({
        threadId: limited.id,
        destinationEnvironmentId: minis,
        modelSelection: { instanceId: claudeId, model: "opus" },
        reason: "usage-limit",
        resume: true,
        idempotencyKey: "limit-handoff:t1:r1",
        sourceSummary: "Claude limit reached on M4",
      });
      // Nothing continues here, now or on later sweeps.
      expect(result.dispatched).toEqual([]);
      expect(result.held).toBe(true);
    }),
  );

  itEffect.effect("skips a machine signed in to the same account and says why", () =>
    Effect.gen(function* () {
      const result = yield* run({
        machines: [
          machine(minis, "Minis", {}, { accountFingerprint: sourcePool }),
          machine(m3, "M3", { status: "unreachable", providers: undefined }),
        ],
      });
      expect(result.requests).toEqual([]);
      // No machine qualifies, so the same-machine fallback model continues it.
      expect(result.dispatched).toHaveLength(1);
      expect(result.dispatched[0]).toMatchObject({
        type: "message.dispatch",
        modelSelection: { instanceId: codexId, model: "gpt-6" },
      });
      expect(result.held).toBe(false);
      expect(result.shown?.candidates.map((row) => row.text)).toEqual([
        "Minis: same Claude account as M4",
        "M3: offline",
      ]);
      expect(result.shown?.order).toBe("other-machine-first");
    }),
  );

  itEffect.effect("names a missing project grant", () =>
    Effect.gen(function* () {
      const result = yield* run({
        localSpent: true,
        machines: [machine(minis, "Minis", { project: { match: "none" } })],
      });
      expect(result.requests).toEqual([]);
      expect(result.dispatched).toEqual([]);
      expect(result.shown?.candidates[0]?.text).toBe("Minis: no work grant for EasyChamp");
      expect(result.shown?.waiting).toContain("Minis: no work grant for EasyChamp");
    }),
  );

  itEffect.effect("uses the same-machine model first when the order says so", () =>
    Effect.gen(function* () {
      const result = yield* run({
        settings: { providerLimitTargetOrder: "same-machine-first" },
        machines: [machine(minis, "Minis")],
      });
      expect(result.requests).toEqual([]);
      expect(result.dispatched[0]).toMatchObject({
        modelSelection: { instanceId: codexId, model: "gpt-6" },
      });
    }),
  );

  itEffect.effect("tries the next machine after a refusal and keeps the thread whole", () =>
    Effect.gen(function* () {
      const result = yield* run({
        localSpent: true,
        machines: [machine(minis, "Minis"), machine(m3, "M3")],
        answers: {
          [minis]: {
            type: "refused",
            code: "secrets_missing",
            message: "secrets missing: STRIPE_KEY",
            retryable: false,
          },
          [m3]: {
            type: "refused",
            code: "files_missing",
            message: "files missing: .env.local",
            retryable: false,
          },
        },
      });
      expect(result.requests.map((request) => request.destinationEnvironmentId)).toEqual([
        minis,
        m3,
      ]);
      expect(result.dispatched).toEqual([]);
      expect(result.held).toBe(false);
      expect(result.shown?.candidates.map((row) => [row.reason, row.text])).toEqual([
        ["refused", "Minis: secrets missing: STRIPE_KEY"],
        ["refused", "M3: files missing: .env.local"],
      ]);
    }),
  );

  itEffect.effect("never continues here while a move is in doubt, and asks the same machine", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          machines: [machine(minis, "Minis"), machine(m3, "M3")],
          answers: { [minis]: "die" },
        },
        3,
      );
      expect(result.requests.map((request) => request.destinationEnvironmentId)).toEqual([
        minis,
        minis,
        minis,
      ]);
      expect(new Set(result.requests.map((request) => request.idempotencyKey)).size).toBe(1);
      expect(result.dispatched).toEqual([]);
      expect(result.held).toBe(true);
      expect(result.shown?.waiting).toBe(
        "Minis hasn't confirmed the handoff yet; the thread stays here until it answers.",
      );
    }),
  );

  itEffect.effect("a person's Stop after a refused move holds the next machine", () =>
    Effect.gen(function* () {
      const refused = {
        type: "refused" as const,
        code: "secrets_missing",
        message: "secrets missing: STRIPE_KEY",
        retryable: false,
      };
      // Read 1 is the sweep's check, read 2 admits Minis, read 3 would admit M3.
      const result = yield* run(
        {
          localSpent: true,
          machines: [machine(minis, "Minis"), machine(m3, "M3")],
          answers: { [minis]: refused },
          stopFromRead: 3,
        },
        2,
      );
      expect(result.requests.map((request) => request.destinationEnvironmentId)).toEqual([minis]);
      expect(result.dispatched).toEqual([]);
      expect(result.held).toBe(false);
    }),
  );

  itEffect.effect("a person's Stop during the fleet probe moves nothing", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { localSpent: true, machines: [machine(minis, "Minis")], stopFromRead: 2 },
        2,
      );
      expect(result.requests).toEqual([]);
      expect(result.dispatched).toEqual([]);
    }),
  );

  itEffect.effect("never moves a thread the user stopped", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          thread: { status: "interrupted", lastErrorClass: null },
          machines: [machine(minis, "Minis")],
        },
        2,
      );
      expect(result.requests).toEqual([]);
      expect(result.dispatched).toEqual([]);
    }),
  );

  itEffect.effect("never hands off to a model the user excluded from fallback", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          settings: { providerLimitExcludedModels: [{ model: "opus" }] },
          machines: [machine(minis, "Minis"), machine(m3, "M3")],
        },
        2,
      );
      expect(result.requests).toEqual([]);
      expect(result.shown?.candidates.map((row) => [row.eligible, row.reason])).toEqual([
        [false, "unavailable"],
        [false, "unavailable"],
      ]);
      // It continues here on the same-machine fallback model instead.
      expect(result.dispatched[0]).toMatchObject({
        type: "message.dispatch",
        modelSelection: { instanceId: codexId, model: "gpt-6" },
      });
    }),
  );

  itEffect.effect("never hands a personal assistant's thread to another machine", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { personal: true, machines: [machine(minis, "Minis"), machine(m3, "M3")] },
        2,
      );
      expect(result.requests).toEqual([]);
      expect(result.held).toBe(false);
      expect(result.shown?.candidates.map((row) => [row.eligible, row.reason, row.text])).toEqual([
        [false, "refused", `Minis: ${PERSONAL_ASSISTANT_PRIVATE_MESSAGE}`],
        [false, "refused", `M3: ${PERSONAL_ASSISTANT_PRIVATE_MESSAGE}`],
      ]);
      // It continues here on the same-machine fallback model instead.
      expect(result.dispatched[0]).toMatchObject({
        type: "message.dispatch",
        modelSelection: { instanceId: codexId, model: "gpt-6" },
      });
      const spent = yield* run({
        personal: true,
        localSpent: true,
        machines: [machine(minis, "Minis")],
      });
      expect(spent.requests).toEqual([]);
      expect(spent.dispatched).toEqual([]);
    }),
  );

  itEffect.effect("changes nothing until a handoff port is bound", () =>
    Effect.gen(function* () {
      const result = yield* run({ unbound: true, machines: [machine(minis, "Minis")] });
      expect(result.requests).toEqual([]);
      expect(result.dispatched[0]).toMatchObject({
        modelSelection: { instanceId: codexId, model: "gpt-6" },
      });
      expect(result.shown?.available).toBe(false);
      expect(result.shown?.candidates[0]?.text).toBe(
        "Minis: the paired machines aren't loaded yet",
      );
      expect(result.shown?.waiting).toBe(
        "This SpecWithCode version can't hand threads to another machine yet.",
      );
    }),
  );

  itEffect.effect("names a refusal worth retrying in the wait text, then runs the local step", () =>
    Effect.gen(function* () {
      const result = yield* run({
        machines: [machine(minis, "Minis"), machine(m3, "M3")],
        answers: {
          [minis]: {
            type: "refused",
            code: "unreachable",
            message: "Minis did not answer.",
            retryable: true,
          },
          [m3]: {
            type: "refused",
            code: "invalid",
            message: "M3: no .env.local; M3: Claude not signed in",
            retryable: false,
          },
        },
      });
      expect(result.requests.map((request) => request.destinationEnvironmentId)).toEqual([
        minis,
        m3,
      ]);
      // Nothing moved anywhere, so the same-machine fallback continues it.
      expect(result.dispatched).toHaveLength(1);
      expect(result.dispatched[0]).toMatchObject({
        modelSelection: { instanceId: codexId, model: "gpt-6" },
      });
      expect(result.shown?.waiting).toBe(
        "No other machine has room: Minis did not answer.; M3: no .env.local; M3: Claude not signed in.",
      );
    }),
  );

  itEffect.effect("a failed preflight keeps the thread here with 0967's exact reasons", () =>
    Effect.gen(function* () {
      const message = "Minis: no .env.local; Minis: Claude not signed in";
      const notes: unknown[] = [];
      const result = yield* run(
        {
          settings: { providerLimitMachineTargets: [target(minis, "Minis")] },
          machines: [machine(minis, "Minis")],
          handoffDocument: EMPTY_HANDOFF_DOCUMENT,
          port: makeLimitHandoffPort({
            environmentId: m4,
            document: Effect.succeed(EMPTY_HANDOFF_DOCUMENT),
            handOff: () => Effect.fail(new HandoffModeError({ code: "invalid", message })),
            recordNote: (input) => Effect.sync(() => void notes.push(input)),
          }),
        },
        2,
      );
      // Shown once, as given, not "Minis: Minis: no .env.local".
      expect(result.shown?.candidates.map((row) => [row.reason, row.text])).toEqual([
        ["refused", message],
      ]);
      expect(result.shown?.waiting).toBe(`No other machine has room: ${message}.`);
      // Nothing is held: the same-machine fallback continues it here, once.
      expect(result.held).toBe(false);
      expect(result.dispatched).toHaveLength(1);
      expect(result.dispatched[0]).toMatchObject({
        type: "message.dispatch",
        modelSelection: { instanceId: codexId, model: "gpt-6" },
      });
      expect(notes).toEqual([]);
    }),
  );

  itEffect.effect("asks with the target's model label, for the thread's notice", () =>
    Effect.gen(function* () {
      const result = yield* run({
        settings: {
          providerLimitMachineTargets: [
            { ...target(minis, "Minis"), modelLabel: "Claude Opus 5.5" },
          ],
        },
        machines: [machine(minis, "Minis")],
      });
      expect(result.requests[0]).toMatchObject({
        sourceSummary: "Claude limit reached on M4",
        modelLabel: "Claude Opus 5.5",
      });
    }),
  );

  itEffect.effect("an in-doubt answer holds the thread and asks the same machine again", () =>
    Effect.gen(function* () {
      const result = yield* run(
        {
          machines: [machine(minis, "Minis"), machine(m3, "M3")],
          answers: { [minis]: { type: "in-doubt", message: "Minis did not answer." } },
        },
        2,
      );
      expect(result.requests.map((request) => request.destinationEnvironmentId)).toEqual([
        minis,
        minis,
      ]);
      expect(result.dispatched).toEqual([]);
      expect(result.held).toBe(true);
      expect(result.shown?.waiting).toBe(
        "Minis hasn't confirmed the handoff yet; the thread stays here until it answers.",
      );
    }),
  );

  itEffect.effect("a move slower than the wait is never interrupted, only stopped waiting on", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const calls: LimitHandoffRequest[] = [];
      let interrupted = false;
      let finished = false;
      const moved: LimitHandoffOutcome = {
        type: "moved",
        machineLabel: "Minis",
        threadId: "remote-t1",
        notice: null,
      };
      const result = yield* run(
        {
          machines: [machine(minis, "Minis"), machine(m3, "M3")],
          port: {
            available: true,
            handOff: (request) => {
              calls.push(request);
              // The first call is 0967 mid-takeover past the 10-minute wait; the repeat
              // returns its first result, as 0967's per-thread idempotency does.
              if (calls.length > 1) return Effect.succeed(moved);
              return Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.sleep("11 minutes")),
                Effect.tap(() => Effect.sync(() => (finished = true))),
                Effect.as(moved),
                Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))),
              );
            },
          },
          before: () =>
            Deferred.await(started).pipe(
              Effect.andThen(TestClock.adjust("11 minutes")),
              Effect.forkChild,
              Effect.asVoid,
            ),
        },
        2,
      );
      expect(interrupted).toBe(false);
      expect(finished).toBe(true);
      expect(calls.map((request) => request.destinationEnvironmentId)).toEqual([minis, minis]);
      expect(result.dispatched).toEqual([]);
      expect(result.held).toBe(true);
    }),
  );

  itEffect.effect("after a restart, a thread still handing off never continues here", () =>
    Effect.gen(function* () {
      // Restarted: nothing in memory, only the handoff state on disk.
      const document: HandoffDocument = {
        ...EMPTY_HANDOFF_DOCUMENT,
        threads: {
          [limited.id]: {
            ...emptyThreadRecord(project.id),
            lease: {
              holderEnvironmentId: m4,
              holderLabel: "M4",
              holderThreadId: limited.id,
              epoch: 2,
              renewedAt: "2026-10-20T13:54:00.000Z",
              state: "handing-off",
            },
          },
        },
      };
      const asked: unknown[] = [];
      const result = yield* run(
        {
          machines: [machine(minis, "Minis"), machine(m3, "M3")],
          handoffDocument: document,
          port: makeLimitHandoffPort({
            environmentId: m4,
            document: Effect.succeed(document),
            handOff: (input) =>
              Effect.sync(() => asked.push(input)).pipe(Effect.andThen(Effect.die("x"))),
          }),
        },
        3,
      );
      expect(asked).toEqual([]);
      expect(result.dispatched).toEqual([]);
      expect(result.shown?.waiting).toBe(
        "This thread is being handed off; it starts no turn until the handoff finishes.",
      );
    }),
  );

  itEffect.effect("a machine that woke paused shows why, not a wait on the target", () =>
    Effect.gen(function* () {
      const document: HandoffDocument = {
        ...EMPTY_HANDOFF_DOCUMENT,
        config: { ...EMPTY_HANDOFF_DOCUMENT.config, defaultMode: "on" },
        pausedSince: "2026-10-20T13:50:00.000Z",
        threads: {
          [limited.id]: {
            ...emptyThreadRecord(project.id),
            lease: {
              holderEnvironmentId: m4,
              holderLabel: "M4",
              holderThreadId: limited.id,
              epoch: 2,
              renewedAt: "2026-10-20T13:54:00.000Z",
              state: "active",
            },
            replicas: [
              {
                environmentId: minis,
                machineLabel: "Minis",
                state: "current",
                sequence: 1,
                detail: null,
                updatedAt: "2026-10-20T13:54:00.000Z",
              },
            ],
          },
        },
      };
      const asked: unknown[] = [];
      const result = yield* run(
        {
          machines: [machine(minis, "Minis"), machine(m3, "M3")],
          handoffDocument: document,
          port: makeLimitHandoffPort({
            environmentId: m4,
            document: Effect.succeed(document),
            handOff: (input) =>
              Effect.sync(() => asked.push(input)).pipe(Effect.andThen(Effect.die("x"))),
          }),
        },
        2,
      );
      expect(asked).toEqual([]);
      expect(result.dispatched).toEqual([]);
      expect(result.shown?.waiting).toBe(PAUSED_OFFLINE_REFUSAL);
    }),
  );

  itEffect.effect("offers no machine under reach.machines none; the local step still runs", () =>
    Effect.gen(function* () {
      const result = yield* run({
        settings: { providerLimitMachineTargets: [target(minis, "Minis")] },
        machines: [machine(minis, "Minis")],
      }).pipe(
        Effect.provideService(
          TeamRules,
          teamRulesOf({
            status: "active",
            rules: { version: 1, owner: "Acme", reach: { machines: "none" } },
            fingerprint: "3a9f",
            warnings: [],
          }),
        ),
      );
      expect(result.requests).toEqual([]);
    }),
  );

  itEffect.effect("skips a machine the rules refuse, naming it, and takes the next", () =>
    Effect.gen(function* () {
      const result = yield* run({
        settings: { providerLimitMachineTargets: [target(minis, "Minis"), target(m3, "M3")] },
        machines: [
          machine(minis, "Minis", {
            teamRulesRefused: "Acme allow only machines with the same rules.",
          }),
          machine(m3, "M3"),
        ],
      });
      expect(result.requests.map((request) => request.destinationEnvironmentId)).toEqual([m3]);
    }),
  );

  itEffect.effect("a thread continued elsewhere gets no local step, with or without targets", () =>
    Effect.gen(function* () {
      const document: HandoffDocument = {
        ...EMPTY_HANDOFF_DOCUMENT,
        threads: {
          [limited.id]: {
            ...emptyThreadRecord(project.id),
            continuedOn: {
              environmentId: minis,
              machineLabel: "Minis",
              threadId: ThreadId.make("remote-t1"),
              at: "2026-10-20T13:55:00.000Z",
            },
          },
        },
      };
      for (const targets of [[target(minis, "Minis")], []]) {
        const result = yield* run(
          {
            settings: { providerLimitMachineTargets: targets },
            machines: [machine(minis, "Minis")],
            handoffDocument: document,
            port: makeLimitHandoffPort({
              environmentId: m4,
              document: Effect.succeed(document),
              handOff: () => Effect.die("never asked"),
            }),
          },
          2,
        );
        expect(result.dispatched).toEqual([]);
        expect(result.requests).toEqual([]);
      }
    }),
  );

  itEffect.effect("never hands off a stopped, completed or cancelled turn for resume", () =>
    Effect.gen(function* () {
      for (const status of ["interrupted", "completed", "cancelled", "failed"] as const) {
        const answers: Array<"handled" | "skipped"> = [];
        const result = yield* run({
          localSpent: true,
          machines: [machine(minis, "Minis")],
          // The sweep's own trigger never fires for these; ask directly.
          thread: { status, lastErrorClass: status === "failed" ? "provider_error" : null },
          before: (handoff) =>
            Effect.gen(function* () {
              const shell = { ...limited, status, lastErrorClass: null };
              answers.push(
                yield* handoff.consider({
                  thread: shell as never,
                  rule: {
                    ...DEFAULT_SERVER_SETTINGS,
                    providerLimitAction: "switch",
                    providerLimitMachineTargets: [target(minis, "Minis")],
                  },
                  trigger: { reason: "usage-limit", resume: true, key: "limit-handoff:t1:r1" },
                  providers: [],
                  projectTitle: "EasyChamp",
                  nowMs: stoppedAt,
                  admit: Effect.succeed(true),
                }),
              );
            }),
        });
        expect(answers).toEqual(["skipped"]);
        // A completed idle thread may still move at the threshold, never resumed.
        expect(result.requests.filter((request) => request.resume)).toEqual([]);
        expect(result.dispatched.filter((command) => command.type === "message.dispatch")).toEqual(
          [],
        );
      }
    }),
  );
});

describe("limitResumable", () => {
  it("allows a running turn or one stopped on the usage limit only", () => {
    expect(limitResumable(limited)).toBe(true);
    expect(limitResumable({ ...limited, activeRunId: RunId.make("r2") })).toBe(true);
    for (const status of ["interrupted", "completed", "cancelled"] as const)
      expect(limitResumable({ ...limited, status, lastErrorClass: null })).toBe(false);
    expect(limitResumable({ ...limited, lastErrorClass: "provider_error" as never })).toBe(false);
  });
});

describe("limitHandoffTrigger", () => {
  const rule = {
    providerLimitAction: "switch" as const,
    providerLimitMachineTargets: [target(minis, "Minis")],
    providerLimitTargetOrder: "other-machine-first" as const,
  };
  const base = {
    thread: limited,
    rule,
    nowMs: stoppedAt + 60_000,
    stopped: true,
    atThreshold: false,
    localStep: null,
    windowKey: "five_hour",
  };

  it("resumes a turn stopped on the limit, keyed by its run", () => {
    expect(limitHandoffTrigger(base)).toEqual({
      reason: "usage-limit",
      resume: true,
      key: "limit-handoff:t1:r1",
    });
  });

  it("needs targets, the switch action and no running or pending turn", () => {
    expect(
      limitHandoffTrigger({ ...base, rule: { ...rule, providerLimitMachineTargets: [] } }),
    ).toBeNull();
    expect(
      limitHandoffTrigger({ ...base, rule: { ...rule, providerLimitAction: "wait" } }),
    ).toBeNull();
    expect(
      limitHandoffTrigger({ ...base, thread: { ...limited, activeRunId: RunId.make("r2") } }),
    ).toBeNull();
    expect(
      limitHandoffTrigger({ ...base, thread: { ...limited, settledOverride: "settled" } }),
    ).toBeNull();
  });

  it("leaves redeeming and credits to the local step", () => {
    expect(limitHandoffTrigger({ ...base, localStep: "redeem" })).toBeNull();
    expect(limitHandoffTrigger({ ...base, localStep: "switch" })).not.toBeNull();
    expect(
      limitHandoffTrigger({
        ...base,
        localStep: "switch",
        rule: { ...rule, providerLimitTargetOrder: "same-machine-first" },
      }),
    ).toBeNull();
  });

  it("moves an idle thread at the threshold once per window, without resuming", () => {
    const idle = { ...limited, status: "completed" as const, lastErrorClass: null };
    const premove = { ...base, thread: idle, stopped: false, atThreshold: true };
    expect(limitHandoffTrigger(premove)).toEqual({
      reason: "threshold",
      resume: false,
      key: "limit-premove:t1:claudeAgent:five_hour",
    });
    expect(
      limitHandoffTrigger({ ...premove, nowMs: stoppedAt + LIMIT_PREMOVE_RECENT_MS + 1 }),
    ).toBeNull();
    expect(limitHandoffTrigger({ ...premove, atThreshold: false })).toBeNull();
  });
});
