import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ServerCommand,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

/**
 * A thread stopped on its usage limit with the reset five hours out. When the
 * instance moves to another account with room, recovery's resume is accepted
 * before that reset, under the thread lock, only for a stop that came before
 * the change. Wakes that arrive meanwhile wait in the queue, unheld, and follow
 * the resume instead of hitting the limit again.
 */
const projectId = ProjectId.make("project:account-change");
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
    { name: "account-change" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const limitedThread = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const events = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make(`account-change:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`account-change:create:${name}`),
      threadId,
      projectId,
      title: "Limited thread",
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
      commandId: CommandId.make(`account-change:start:${name}`),
      threadId,
      messageId: MessageId.make(`account-change:start:${name}`),
      text: "Work on this.",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    const now = yield* DateTime.now;
    const resetAt = DateTime.formatIso(DateTime.add(now, { hours: 5 }));
    yield* events.write({
      commandId: CommandId.make(`account-change:failure:${name}`),
      events: [
        {
          id: EventId.make(`account-change:run:${name}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...run, status: "failed", completedAt: now },
        },
        {
          id: EventId.make(`account-change:error:${name}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`account-change:error:${name}`),
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
              message: "Plan limit reached.",
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
    // Recovery armed for the reset, the way the worker's policy arm does it.
    yield* orchestrator.dispatch(
      limitRecoveryCommand(yield* shell, true, DateTime.toEpochMillis(now))!,
    );
    return { threadId, run, shell, stopMs: DateTime.toEpochMillis(now) };
  });

/** The resume recovery sends once the account changed at `changedMs`. */
const accountResume = (
  shell: Parameters<typeof limitRecoveryCommand>[0],
  nowMs: number,
  changedMs: number,
) => {
  const command = limitRecoveryCommand(shell, true, nowMs, false, false, changedMs);
  assert.equal(command?.type, "message.dispatch");
  return command as Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }>;
};

const wake = (threadId: ThreadId, name: string) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(`account-change:wake:${name}`),
  threadId,
  messageId: MessageId.make(`account-change:wake:${name}`),
  text: "#662: checks passed",
  notification: {
    source: { kind: "background_task" as const },
    outcome: "updated" as const,
    summary: "Checks passed",
  },
  attachments: [],
  dispatchMode: { type: "queue_after_active" as const },
  createdBy: "agent" as const,
  creationSource: "server" as const,
});

it.layer(layerTest)("resume after the account changed", (it) => {
  it.effect("a resume for an account changed after the stop starts before the old reset", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, shell, stopMs } = yield* limitedThread("early");
      yield* TestClock.adjust("1 hour");
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const command = accountResume(yield* shell, nowMs, stopMs + 30 * 60_000);
      assert.include(command.commandId, `:acct:${stopMs + 30 * 60_000}:`);
      yield* orchestrator.dispatch(command);
      const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.lengthOf(runs, 2);
      assert.equal(runs[1]?.userMessageId, command.messageId);
    }),
  );

  it.effect("a Codex stop whose pool check saw the old account change still resumes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, shell, stopMs, run } = yield* limitedThread("codex-pool-changed");
      yield* TestClock.adjust("1 hour");
      const armed = yield* shell;
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      // The availability check recorded that the pool it was armed for is gone.
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("account-change:pool-check"),
        threadId,
        limitAvailability: {
          runId: run.id,
          requestId: armed.limitRecovery?.requestId,
          expectedUpdatedAt: DateTime.formatIso(armed.updatedAt),
          observation: {
            checkedAt,
            retryAt: checkedAt,
            threadUpdatedAt: DateTime.formatIso(armed.updatedAt),
            status: "changed",
          },
        },
      });
      const checked = yield* shell;
      assert.equal(checked.limitRecovery?.availability?.status, "changed");
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const command = accountResume(checked, nowMs, stopMs + 30 * 60_000);
      yield* orchestrator.dispatch(command);
      const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.lengthOf(runs, 2);
      assert.equal(runs[1]?.userMessageId, command.messageId);
    }),
  );

  it.effect("a Codex stop whose pool changed resumes when the change is seen after the reset", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, shell, stopMs, run } = yield* limitedThread("codex-after-reset");
      yield* TestClock.adjust("1 hour");
      const armed = yield* shell;
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("account-change:pool-check-after-reset"),
        threadId,
        limitAvailability: {
          runId: run.id,
          requestId: armed.limitRecovery?.requestId,
          expectedUpdatedAt: DateTime.formatIso(armed.updatedAt),
          observation: {
            checkedAt,
            retryAt: checkedAt,
            threadUpdatedAt: DateTime.formatIso(armed.updatedAt),
            status: "changed",
          },
        },
      });
      // The sign-in moved just after the old reset, and the read saw it later.
      yield* TestClock.adjust("5 hours");
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const command = accountResume(yield* shell, nowMs, stopMs + 5 * 60 * 60_000 + 60_000);
      assert.include(command.commandId, ":acct:");
      yield* orchestrator.dispatch(command);
      const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.lengthOf(runs, 2);
      assert.equal(runs[1]?.userMessageId, command.messageId);
    }),
  );

  it.effect("a resume claiming a change from before the stop is refused", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, shell, stopMs } = yield* limitedThread("before-stop");
      yield* TestClock.adjust("1 hour");
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const honest = accountResume(yield* shell, nowMs, stopMs + 60_000);
      // The same resume, but for a change the server saw before the stop.
      const forged = {
        ...honest,
        commandId: CommandId.make(honest.commandId.replace(/:acct:\d+:/, `:acct:${stopMs - 1}:`)),
        messageId: MessageId.make(honest.messageId.replace(/:acct:\d+:/, `:acct:${stopMs - 1}:`)),
      };
      yield* orchestrator.dispatch(forged).pipe(Effect.exit);
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
    }),
  );

  it.effect("a resume claiming a change still ahead is refused", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, shell, stopMs } = yield* limitedThread("future");
      yield* TestClock.adjust("1 hour");
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const honest = accountResume(yield* shell, nowMs, stopMs + 60_000);
      const ahead = nowMs + 60 * 60_000;
      yield* orchestrator
        .dispatch({
          ...honest,
          commandId: CommandId.make(honest.commandId.replace(/:acct:\d+:/, `:acct:${ahead}:`)),
          messageId: MessageId.make(honest.messageId.replace(/:acct:\d+:/, `:acct:${ahead}:`)),
        })
        .pipe(Effect.exit);
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
    }),
  );

  it.effect("a settled thread keeps its stop when the account changes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, shell, stopMs } = yield* limitedThread("settled");
      yield* TestClock.adjust("1 hour");
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const command = accountResume(yield* shell, nowMs, stopMs + 60_000);
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("account-change:settle"),
        threadId,
      });
      assert.equal((yield* shell).settledOverride, "settled");
      yield* orchestrator.dispatch(command).pipe(Effect.exit);
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
    }),
  );

  it.effect("a wake on the stopped thread waits unheld, then follows the resume", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, run, shell, stopMs } = yield* limitedThread("wake");
      yield* TestClock.adjust("10 minutes");
      yield* orchestrator.dispatch(wake(threadId, "held"));
      const held = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.lengthOf(held, 2);
      assert.equal(held[1]?.status, "queued");
      // Never a person's hold: restart deliveries and later wakes stay unblocked.
      assert.notEqual(held[1]?.queueHeld, true);
      // The thread still shows its limit stop, so recovery keeps its arm.
      const stopped = yield* shell;
      assert.equal(stopped.lastErrorClass, "usage_limit");
      assert.equal(stopped.latestRunId, run.id);
      assert.equal(stopped.limitRecovery?.runId, run.id);
      yield* TestClock.adjust("50 minutes");
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      yield* orchestrator.dispatch(accountResume(stopped, nowMs, stopMs + 30 * 60_000));
      const after = (yield* orchestrator.getThreadProjection(threadId)).runs;
      const wakeRun = after.find((candidate) => candidate.id === held[1]?.id);
      assert.lengthOf(after, 3);
      assert.notEqual(wakeRun?.queueHeld, true);
    }),
  );

  it.effect("a wake queued before the reset runs after a later wake, never stranded", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId } = yield* limitedThread("strand");
      yield* TestClock.adjust("10 minutes");
      yield* orchestrator.dispatch(wake(threadId, "strand-w1"));
      const first = (yield* orchestrator.getThreadProjection(threadId)).runs[1];
      assert.equal(first?.status, "queued");
      assert.notEqual(first?.queueHeld, true);
      // The reset passes with no recovery resume (auto-continue off, say).
      yield* TestClock.adjust("5 hours");
      yield* orchestrator.dispatch(wake(threadId, "strand-w2"));
      const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
      // Nothing in the queue is held, so the earlier wake is not stuck behind
      // a hold only a person can release; it drains when the later turn ends.
      assert.isFalse(runs.some((candidate) => candidate.queueHeld === true));
      assert.isTrue(runs.some((candidate) => candidate.id === first?.id));
    }),
  );

  it.effect("a scheduled run a person created waits behind the stop like a wake", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, run, shell } = yield* limitedThread("scheduled");
      yield* TestClock.adjust("10 minutes");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("account-change:scheduled:run"),
        threadId,
        messageId: MessageId.make("account-change:scheduled:run"),
        scheduledTaskId: ScheduledTaskId.make("task-morning-check"),
        text: "Morning check",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        // The task's own author, a person; nobody is sending it now.
        createdBy: "user",
        creationSource: "server",
      });
      const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.lengthOf(runs, 2);
      assert.equal(runs[1]?.status, "queued");
      assert.notEqual(runs[1]?.queueHeld, true);
      // No failed run joins the re-arm chain: the stop is still the latest run.
      const stopped = yield* shell;
      assert.equal(stopped.lastErrorClass, "usage_limit");
      assert.equal(stopped.latestRunId, run.id);
    }),
  );

  it.effect("past the reported reset a wake starts as before", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId } = yield* limitedThread("after-reset");
      yield* TestClock.adjust("5 hours");
      yield* TestClock.adjust("1 minute");
      yield* orchestrator.dispatch(wake(threadId, "after-reset"));
      const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.lengthOf(runs, 2);
      assert.notEqual(runs[1]?.queueHeld, true);
      assert.notEqual(runs[1]?.status, "queued");
    }),
  );
});
