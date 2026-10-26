import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, RunId, ThreadId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { apiCreditDetourResumeRefused } from "./providerOpenFailure.ts";
import { limitRecoveryCommand, waitRuleArmsResume } from "./UsageLimitRecoveryWorker.ts";
import { claudeLimitStop, claudeSweepHarness } from "./UsageLimitRecoveryWorker.testkit.ts";
import { updateLimitRecovery } from "./usageLimitRecovery.ts";

const claudeMax = ProviderInstanceId.make("claudeAgent");
const claudeApi = ProviderInstanceId.make("claude-api");
const threadId = ThreadId.make("claude-limited");

/** A thread the API-credit rule moved from its Max subscription to an API key, stopped there. */
const onApiCredits = (resetMs: number) => ({
  ...claudeLimitStop(resetMs),
  providerInstanceId: claudeApi,
});
const subscriptionRun = {
  id: RunId.make("subscription-run"),
  ordinal: 1,
  providerInstanceId: claudeMax,
  modelSelection: { instanceId: claudeMax, model: "claude-opus-5-5" },
  userMessageId: "message-1",
};
/** The continuation the API-credit rule sent: `limit-api:<thread>:<stopped run>`. */
const detourRun = {
  id: RunId.make("failed-run"),
  ordinal: 2,
  providerInstanceId: claudeApi,
  modelSelection: { instanceId: claudeApi, model: "claude-opus-5-5" },
  userMessageId: `limit-api:${threadId}:subscription-run`,
};
/** The same stop on an API-key instance a person chose. */
const chosenRun = { ...detourRun, userMessageId: "message-2" };

const switchRule = (providerLimitUseApiCredits: boolean) => ({
  providerLimitAction: "switch" as const,
  providerLimitWaitUnderMinutes: 10,
  providerLimitUseApiCredits,
});

it("refuses to resume an API-credit detour once the rule is off, not a person's own API choice", () => {
  const thread = { id: threadId, providerInstanceId: claudeApi };
  const runs = [subscriptionRun, detourRun] as never;
  assert.isTrue(apiCreditDetourResumeRefused(thread, runs, switchRule(false)));
  assert.isFalse(apiCreditDetourResumeRefused(thread, runs, switchRule(true)));
  assert.isFalse(
    apiCreditDetourResumeRefused(thread, [subscriptionRun, chosenRun] as never, switchRule(false)),
  );
});

it("arms and resumes nothing for a refused detour, even where the wait rule would arm", () => {
  const stopMs = Date.parse("2026-10-25T12:00:00.000Z");
  const resetMs = stopMs + 2 * 60_000;
  const thread = { ...onApiCredits(resetMs), latestRunCompletedAt: DateTime.makeUnsafe(stopMs) };
  const arms = waitRuleArmsResume(thread, switchRule(false), stopMs + 1000);
  assert.isTrue(arms);
  assert.isNull(limitRecoveryCommand(thread, arms, stopMs + 1000, false, false, null, true));
  const arm = limitRecoveryCommand(thread, arms, stopMs + 1000);
  assert.equal(arm?.type, "thread.metadata.update");
  if (arm?.type !== "thread.metadata.update" || !arm.limitRecovery) return;
  const armed = {
    ...thread,
    limitRecovery: updateLimitRecovery(null, arm.limitRecovery, arm.commandId, true)!,
  };
  assert.equal(limitRecoveryCommand(armed, true, resetMs + 1000)?.type, "message.dispatch");
  assert.isNull(limitRecoveryCommand(armed, true, resetMs + 1000, false, false, null, true));
});

const sweepAtReset = (input: {
  readonly useApiCredits: boolean;
  readonly runs: ReadonlyArray<Record<string, unknown>>;
}) =>
  Effect.gen(function* () {
    // A short API rate-limit reset, inside the project's 10-minute wait.
    const resetMs = 2 * 60_000;
    const { state, sweep } = claudeSweepHarness({
      thread: onApiCredits(resetMs),
      runs: input.runs as never,
      settings: switchRule(input.useApiCredits),
    });
    yield* sweep;
    yield* TestClock.adjust("3 minutes");
    yield* sweep;
    yield* sweep;
    return state.commands;
  });

it.effect("leaves a stopped API-credit detour to the way back when the rule is off", () =>
  Effect.gen(function* () {
    const commands = yield* sweepAtReset({
      useApiCredits: false,
      runs: [subscriptionRun, detourRun],
    });
    assert.deepEqual(commands, []);
  }),
);

it.effect("still resumes a detour the rule allows, and an API instance a person chose", () =>
  Effect.gen(function* () {
    const allowed = yield* sweepAtReset({
      useApiCredits: true,
      runs: [subscriptionRun, detourRun],
    });
    assert.isTrue(allowed.some((command) => command.type === "message.dispatch"));
    const chosen = yield* sweepAtReset({
      useApiCredits: false,
      runs: [subscriptionRun, chosenRun],
    });
    assert.isTrue(chosen.some((command) => command.type === "message.dispatch"));
  }),
);
