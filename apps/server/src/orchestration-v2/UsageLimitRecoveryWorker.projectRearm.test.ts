import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2ServerCommand,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { policyRearmCommand } from "./UsageLimitRecoveryWorker.ts";
import { claudeLimitStop, claudeSweepHarness } from "./UsageLimitRecoveryWorker.testkit.ts";

const RESET = 5 * 60 * 60_000;
const resumes = (commands: ReadonlyArray<OrchestrationV2ServerCommand>) =>
  commands.filter((command) => command.type === "message.dispatch");

describe("turning on a project's auto-continue", () => {
  it.effect("arms a stop nothing armed yet, and resumes it at the reset", () =>
    Effect.gen(function* () {
      const h = claudeSweepHarness({ thread: claudeLimitStop(RESET) });
      const sweep = yield* h.running;
      yield* sweep;
      assert.strictEqual(h.state.current.limitRecovery ?? null, null as unknown);
      h.state.projectAutoResume = true;
      yield* TestClock.adjust("10 seconds");
      yield* sweep;
      assert.isTrue(h.state.current.limitRecovery?.autoResume);
      yield* TestClock.adjust(RESET);
      yield* sweep;
      assert.lengthOf(resumes(h.state.commands), 1);
    }),
  );

  it.effect("picks up a stop the snooze rule armed with auto-continue off", () =>
    Effect.gen(function* () {
      const h = claudeSweepHarness({
        thread: claudeLimitStop(RESET),
        settings: { snoozeLimitedThreads: true },
      });
      const sweep = yield* h.running;
      yield* sweep; // the snooze rule arms the stop with auto-continue off
      assert.isFalse(h.state.current.limitRecovery?.autoResume);
      h.state.projectAutoResume = true;
      yield* TestClock.adjust("10 seconds");
      yield* sweep;
      assert.isTrue(h.state.current.limitRecovery?.autoResume);
      assert.lengthOf(resumes(h.state.commands), 0);
      yield* TestClock.adjust(RESET);
      yield* sweep;
      assert.lengthOf(resumes(h.state.commands), 1);
    }),
  );

  it.effect("leaves a thread whose auto-continue the person turned off", () =>
    Effect.gen(function* () {
      const stop = claudeLimitStop(RESET);
      const h = claudeSweepHarness({
        thread: {
          ...stop,
          limitRecovery: {
            requestId: CommandId.make("person-turned-it-off"),
            runId: stop.latestRunId,
            resetAt: stop.usageLimitResetAt,
            autoResume: false,
          },
        },
        projectAutoResume: true,
      });
      const sweep = yield* h.running;
      yield* sweep;
      yield* TestClock.adjust(RESET);
      yield* sweep;
      assert.isFalse(h.state.current.limitRecovery?.autoResume);
      assert.lengthOf(resumes(h.state.commands), 0);
    }),
  );

  it.effect("waits for a thread moved to another instance to come back before re-arming", () =>
    Effect.gen(function* () {
      const h = claudeSweepHarness({
        thread: claudeLimitStop(RESET),
        settings: { snoozeLimitedThreads: true },
        runs: [
          {
            id: RunId.make("failed-run"),
            ordinal: 1,
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            userMessageId: MessageId.make("first"),
            startMessageId: MessageId.make("first"),
          },
        ],
      });
      const sweep = yield* h.running;
      yield* sweep;
      assert.isFalse(h.state.current.limitRecovery?.autoResume);
      h.state.current = {
        ...h.state.current,
        providerInstanceId: ProviderInstanceId.make("codex"),
      };
      h.state.projectAutoResume = true;
      yield* TestClock.adjust("10 seconds");
      yield* sweep;
      assert.isFalse(h.state.current.limitRecovery?.autoResume);
    }),
  );

  it("does nothing while the rule is off, or once the reset has passed", () => {
    const stop = claudeLimitStop(RESET);
    const waiting = {
      ...stop,
      limitRecovery: {
        requestId: CommandId.make(`limit-arm:${stop.id}:${stop.latestRunId}:${RESET}`),
        runId: stop.latestRunId,
        resetAt: stop.usageLimitResetAt,
        autoResume: false,
      },
    };
    assert.isNull(policyRearmCommand(waiting, false, 0));
    assert.isNull(policyRearmCommand(waiting, true, RESET));
    const rearm = policyRearmCommand(waiting, true, 0);
    assert.strictEqual(rearm?.type, "thread.metadata.update");
    assert.isTrue(rearm?.type === "thread.metadata.update" && rearm.limitRecoveryPolicyArm);
  });
});
