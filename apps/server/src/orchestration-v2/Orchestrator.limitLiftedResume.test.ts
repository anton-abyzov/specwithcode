import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import {
  LIMIT_LIFTED_SENTENCE,
  accountChangeArmCommand,
  isLimitBlockedThread,
  limitBlockedContinuation,
} from "./limitLifted.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

/**
 * A thread stopped on its usage limit, reset five hours out, with auto-continue
 * off. Half an hour later the instance is signed in to another subscription:
 * the arm for that change is accepted, and the resume it allows tells the
 * agent the limit is gone and repeats a message the limit kept from the
 * provider.
 */
const projectId = ProjectId.make("project:limit-lifted");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapterV2Shape;
const layerDatabase = fixtureProjectDatabase([projectId]);
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProviderReplayHarness.layerWithRegistry(
    { name: "limit-lifted" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const WAKE = "Fable build reported back: the level loads, tests pass.";

/** A thread whose only run stopped on the limit; `started` says whether the provider saw it. */
const limitedThread = (name: string, started: boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const events = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make(`limit-lifted:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`limit-lifted:create:${name}`),
      threadId,
      projectId,
      title: "Coordinator",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`limit-lifted:start:${name}`),
      threadId,
      messageId: MessageId.make(`limit-lifted:start:${name}`),
      text: WAKE,
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "agent",
      creationSource: "server",
    });
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    assert.isNull(run.startedAt);
    const now = yield* DateTime.now;
    const resetAt = DateTime.formatIso(DateTime.add(now, { hours: 5 }));
    yield* events.write({
      commandId: CommandId.make(`limit-lifted:failure:${name}`),
      events: [
        {
          id: EventId.make(`limit-lifted:run:${name}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...run,
            status: "failed",
            startedAt: started ? now : null,
            completedAt: now,
          },
        },
        {
          id: EventId.make(`limit-lifted:error:${name}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`limit-lifted:error:${name}`),
            type: "error",
            threadId,
            runId: run.id,
            nodeId: run.rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 2,
            status: "failed",
            title: "Usage limit reached",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            failure: {
              class: "usage_limit",
              message: "Claude's weekly Fable limit is used up.",
              code: "usageLimitExceeded",
              retryable: null,
              resetAt,
            },
          },
        },
      ],
    });
    const shell = Effect.map(orchestrator.getShellSnapshot(), (snapshot) =>
      snapshot.threads.find((thread) => thread.id === threadId)!,
    );
    const textOf = (messageId: string) =>
      Effect.map(
        orchestrator.getThreadProjection(threadId),
        (projection) => projection.messages.find((message) => message.id === messageId)?.text,
      );
    return { threadId, run, shell, textOf, stopMs: DateTime.toEpochMillis(now) };
  });

/** Arms the unarmed stop for the change, then builds the resume the worker would send. */
const armedResume = (thread: Effect.Success<ReturnType<typeof limitedThread>>, changedMs: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const unarmed = yield* thread.shell;
    assert.isNull(unarmed.limitRecovery ?? null);
    // Auto-continue is off: nothing arms or resumes the stop by itself.
    assert.isNull(limitRecoveryCommand(unarmed, false, nowMs));
    const arm = accountChangeArmCommand(unarmed, changedMs, nowMs)!;
    yield* orchestrator.dispatch(arm);
    const armed = yield* thread.shell;
    assert.equal(armed.limitRecovery?.autoResume, true);
    assert.equal(armed.limitRecovery?.requestId, arm.commandId);
    // The arm is a rule's, never recorded as the person's own.
    assert.notEqual(armed.limitRecovery?.explicitArm, true);
    return armed;
  });

it.layer(layerTest)("the resume after a subscription change", (it) => {
  it.effect("repeats the message of a run the provider never saw", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const thread = yield* limitedThread("undelivered", false);
      yield* TestClock.adjust("1 hour");
      const changedMs = thread.stopMs + 30 * 60_000;
      const armed = yield* armedResume(thread, changedMs);
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const resume = limitRecoveryCommand(armed, false, nowMs, false, false, changedMs)!;
      assert.equal(resume.type, "message.dispatch");
      assert.include(resume.commandId, `:acct:${changedMs}:`);
      yield* orchestrator.dispatch(resume);
      const runs = (yield* orchestrator.getThreadProjection(thread.threadId)).runs;
      assert.lengthOf(runs, 2);
      const text = yield* thread.textOf(resume.type === "message.dispatch" ? resume.messageId : "");
      assert.include(text, `Here it is again:\n\n${WAKE}`);
      assert.include(text, LIMIT_LIFTED_SENTENCE);
    }),
  );

  it.effect("says only that the limit is gone for a run that did start", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const thread = yield* limitedThread("started", true);
      yield* TestClock.adjust("1 hour");
      const changedMs = thread.stopMs + 30 * 60_000;
      const armed = yield* armedResume(thread, changedMs);
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const resume = limitRecoveryCommand(armed, false, nowMs, false, false, changedMs)!;
      yield* orchestrator.dispatch(resume);
      const text = yield* thread.textOf(resume.type === "message.dispatch" ? resume.messageId : "");
      assert.equal(text, `Continue where you left off.\n\n${LIMIT_LIFTED_SENTENCE}`);
    }),
  );

  it.effect("still says so when the resume leaves after the old reset", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const thread = yield* limitedThread("after-reset", false);
      yield* TestClock.adjust("1 hour");
      const changedMs = thread.stopMs + 30 * 60_000;
      const armed = yield* armedResume(thread, changedMs);
      yield* TestClock.adjust("5 hours");
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      // Past the reset the resume carries no mark of its own; the arm does.
      const resume = limitRecoveryCommand(armed, false, nowMs)!;
      assert.equal(resume.type, "message.dispatch");
      assert.notInclude(resume.commandId.replace(armed.limitRecovery!.requestId!, ""), ":acct:");
      yield* orchestrator.dispatch(resume);
      const text = yield* thread.textOf(resume.type === "message.dispatch" ? resume.messageId : "");
      assert.include(text, WAKE);
      assert.include(text, LIMIT_LIFTED_SENTENCE);
    }),
  );

  it.effect("a resume at the reset of a stop armed by the rule keeps its text", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const thread = yield* limitedThread("plain", false);
      const unarmed = yield* thread.shell;
      yield* orchestrator.dispatch(limitRecoveryCommand(unarmed, true, thread.stopMs)!);
      yield* TestClock.adjust("5 hours");
      yield* TestClock.adjust("1 minute");
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const resume = limitRecoveryCommand(yield* thread.shell, true, nowMs)!;
      yield* orchestrator.dispatch(resume);
      const text = yield* thread.textOf(resume.type === "message.dispatch" ? resume.messageId : "");
      assert.equal(text, "Continue where you left off.");
    }),
  );

  it.effect("a stop the person stopped is not resumed by the change", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const thread = yield* limitedThread("person-off", false);
      const unarmed = yield* thread.shell;
      // The person turns the resume off for this stop.
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("limit-lifted:person-off"),
        threadId: thread.threadId,
        limitRecovery: {
          runId: unarmed.latestRunId!,
          resetAt: unarmed.usageLimitResetAt ?? null,
          autoResume: false,
        },
      });
      yield* TestClock.adjust("1 hour");
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      assert.isNull(accountChangeArmCommand(yield* thread.shell, thread.stopMs + 60_000, nowMs));
    }),
  );

  it.effect("the message for a limit-blocked thread ends its Blocked state and starts a turn", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const events = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("limit-lifted:blocked");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("limit-lifted:create:blocked"),
        threadId,
        projectId,
        title: "Coordinator",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("limit-lifted:start:blocked"),
        threadId,
        messageId: MessageId.make("limit-lifted:start:blocked"),
        text: "Build the level.",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      yield* TestClock.adjust("10 minutes");
      const reportedAt = yield* DateTime.now;
      // The turn ends with a report whose blocker is the worker's usage limit.
      yield* events.write({
        commandId: CommandId.make("limit-lifted:report:blocked"),
        events: [
          {
            id: EventId.make("limit-lifted:report-run:blocked"),
            type: "run.updated",
            threadId,
            occurredAt: reportedAt,
            payload: {
              ...run,
              status: "completed",
              startedAt: reportedAt,
              completedAt: reportedAt,
            },
          },
          {
            id: EventId.make("limit-lifted:report-message:blocked"),
            type: "message.updated",
            threadId,
            occurredAt: reportedAt,
            payload: {
              createdBy: "agent",
              creationSource: "provider",
              id: MessageId.make("limit-lifted:report:blocked"),
              threadId,
              runId: run.id,
              nodeId: null,
              role: "assistant",
              text: "The worker stopped.\n\n**Blocker:** the weekly Fable 5.2 limit is used up and resets on November 13, 2026 at 02:00 UTC. Wait, or move to another model?",
              attachments: [],
              streaming: false,
              createdAt: reportedAt,
              updatedAt: reportedAt,
            },
          },
        ],
      });
      const shell = Effect.map(orchestrator.getShellSnapshot(), (snapshot) =>
        snapshot.threads.find((thread) => thread.id === threadId)!,
      );
      const blocked = yield* shell;
      assert.include(blocked.reportedBlocker, "weekly Fable 5.2 limit");
      yield* TestClock.adjust("20 minutes");
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const changedMs = nowMs - 60_000;
      // The real shell of an idle thread with such a report is what the sweep looks for.
      assert.isTrue(isLimitBlockedThread(blocked, changedMs, nowMs));
      const message = limitBlockedContinuation(blocked, "Claude", changedMs);
      yield* orchestrator.dispatch(message);
      const after = yield* shell;
      // A server-written message with the user role is newer than the report.
      assert.isNull(after.reportedBlocker ?? null);
      const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.lengthOf(runs, 2);
      assert.equal(runs[1]?.userMessageId, message.messageId);
      assert.isFalse(isLimitBlockedThread(after, changedMs, nowMs));
    }),
  );
});
