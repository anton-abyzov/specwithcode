import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import { followOccurrence } from "./ScheduledTaskOccurrence.ts";
import { fallbackOrigin, readRouteState } from "./ScheduledTaskProviderRoute.ts";
import {
  START,
  THREAD,
  NOT_PREPARED,
  taskInput,
  provider,
  copilotReady,
  copilotNotPrepared,
  codexReady,
  harness,
  insertRun,
  openFailure,
  occurrences,
} from "./ScheduledTaskService.providerGate.testkit.ts";

it.effect(
  "defers a 10-minute routine whose thread failed as provider_unavailable, then fires the same occurrence once a newer read is ready",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const { state, run, fireNext, taskRow, failRunOnCopilot } = yield* harness([
        copilotNotPrepared,
        codexReady,
      ]);
      yield* failRunOnCopilot("2026-10-21T06:45:00.000Z");
      yield* run((service) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(taskInput());
          const before = yield* taskRow;
          const fireKey = `${task.id}:${task.createdAt}:${before.next_run_at}:scheduled`;

          // 06:50:01: the hold on the failed open ends 07:15, so it waits 15 minutes.
          yield* fireNext;
          assert.deepEqual(state.sent, []);
          const deferred = yield* taskRow;
          assert.equal(deferred.last_run_status, "failed");
          assert.equal(
            deferred.last_run_error,
            `Deferred until 2026-10-21T07:05:01.000Z: GitHub Copilot cannot start on this machine: ${NOT_PREPARED}`,
          );
          // Not paused, the schedule is untouched, and nothing ran.
          assert.equal(deferred.enabled, 1);
          assert.equal(deferred.schedule_json, before.schedule_json);
          assert.equal(deferred.run_count, 0);
          assert.equal(deferred.next_run_at, "2026-10-21T07:05:01.000Z");

          // A ready read from before the failure does not clear it.
          state.providers = [copilotReady, codexReady];
          yield* fireNext;
          assert.deepEqual(state.sent, []);
          assert.equal((yield* taskRow).run_count, 0);

          state.providers = [
            { ...copilotReady, checkedAt: "2026-10-21T07:30:00.000Z" },
            codexReady,
          ];
          yield* fireNext;
          // An unpinned run keeps the thread's provider: no model is sent. It
          // is the first occurrence, under its own fire key.
          assert.deepEqual(state.sent, [{ threadId: THREAD, instanceId: undefined }]);
          assert.deepEqual(state.messageIds, [`scheduled-task-message:${fireKey}`]);
          const fired = yield* taskRow;
          assert.equal(fired.last_run_status, "succeeded");
          assert.isNull(fired.last_run_error);
          assert.equal(fired.run_count, 1);
        }),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("fires as before when the provider is unknown or awaiting its first check", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const awaiting = provider("acpRegistry_copilot", "acpRegistry", {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Provider status has not been checked in this session yet.",
    });
    const { state, run, fireNext, taskRow } = yield* harness([awaiting]);
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput());
        yield* fireNext;
        assert.equal(state.sent.length, 1);
        state.providers = [codexReady];
        yield* fireNext;
        assert.equal(state.sent.length, 2);
        assert.equal((yield* taskRow).last_run_status, "succeeded");
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "waits while the thread's latest run failed as provider_unavailable until a later check finds it ready",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      // The snapshot was taken before the failure and still reads ready.
      const { state, run, fireNext, taskRow, failRunOnCopilot } = yield* harness([copilotReady]);
      yield* failRunOnCopilot("2026-10-21T06:45:00.000Z");
      yield* run((service) =>
        Effect.gen(function* () {
          yield* service.upsert(taskInput());
          yield* fireNext;
          assert.deepEqual(state.sent, []);
          assert.equal(
            (yield* taskRow).last_run_error,
            `Deferred until 2026-10-21T07:05:01.000Z: GitHub Copilot cannot start on this machine: ${NOT_PREPARED}`,
          );

          state.providers = [{ ...copilotReady, checkedAt: "2026-10-21T07:30:00.000Z" }];
          yield* fireNext;
          assert.equal(state.sent.length, 1);
          assert.equal((yield* taskRow).last_run_status, "succeeded");
        }),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("checks a pinned routine's own provider and, with no rule to move it, waits", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run, fireNext, taskRow, failRunOnCopilot } = yield* harness([
      copilotNotPrepared,
      codexReady,
    ]);
    yield* failRunOnCopilot("2026-10-21T06:45:00.000Z");
    yield* run((service) =>
      Effect.gen(function* () {
        // Pinned to Codex: the thread's broken Copilot does not matter.
        const { task } = yield* service.upsert(
          taskInput({ modelPinned: true, modelSelection: { instanceId: "codex", model: "gpt-5" } }),
        );
        yield* fireNext;
        assert.deepEqual(state.sent, [{ threadId: THREAD, instanceId: "codex" }]);

        // Pinned to the broken Copilot: with no settings to read it waits, not moved to Codex.
        yield* service.upsert(
          taskInput({
            id: task.id,
            modelPinned: true,
            modelSelection: { instanceId: "acpRegistry_copilot", model: "claude-opus-5.5" },
          }),
        );
        yield* fireNext;
        assert.equal(state.sent.length, 1);
        assert.match((yield* taskRow).last_run_error ?? "", /^Deferred until .*: GitHub Copilot/);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("fires on a provider that reports warning but can still run turns", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    // Installed and checked, but subscription sign-in unverified: turns still run.
    const copilotWarning = provider("acpRegistry_copilot", "acpRegistry", {
      displayName: "GitHub Copilot",
      status: "warning",
      auth: { status: "unknown" },
      message: "Could not verify the subscription sign-in.",
    });
    const { state, run, fireNext, taskRow } = yield* harness([copilotWarning]);
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput());
        yield* fireNext;
        assert.equal(state.sent.length, 1);
        const fired = yield* taskRow;
        assert.equal(fired.last_run_status, "succeeded");
        assert.isNull(fired.last_run_error);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("checks a bound thread on the model its next turn resolves to", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    // The bound thread last ran on the broken Copilot; the user moved its
    // next turn to Codex to recover.
    const { state, run, fireNext, taskRow, failRunOnCopilot } = yield* harness([
      copilotNotPrepared,
      codexReady,
    ]);
    yield* failRunOnCopilot("2026-10-21T06:45:00.000Z");
    state.nextTurn = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput());
        yield* fireNext;
        assert.deepEqual(state.sent, [{ threadId: THREAD, instanceId: "codex" }]);
        assert.equal((yield* taskRow).last_run_status, "succeeded");

        // Back on the broken Copilot: it waits, with its reason.
        state.nextTurn = {
          instanceId: ProviderInstanceId.make("acpRegistry_copilot"),
          model: "claude-opus-5.5",
        };
        yield* fireNext;
        assert.equal(state.sent.length, 1);
        assert.equal(
          (yield* taskRow).last_run_error,
          `Deferred until 2026-10-21T07:15:00.000Z: GitHub Copilot cannot start on this machine: ${NOT_PREPARED}`,
        );
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("checks a routine that starts its own thread on the model the launch uses", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const copilotDisabled: ServerProvider = { ...copilotReady, enabled: false };
    const { state, run, fireNext, taskRow } = yield* harness([copilotDisabled, codexReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        // Unpinned: the launch still starts the thread on the routine's model.
        yield* service.upsert(
          taskInput({
            threadId: null,
            ownThread: true,
            modelSelection: { instanceId: "acpRegistry_copilot", model: "claude-opus-5.5" },
          }),
        );
        yield* fireNext;
        assert.deepEqual(state.launched, []);
        assert.equal(
          (yield* taskRow).last_run_error,
          "Deferred until 2026-10-21T07:05:01.000Z: GitHub Copilot cannot start on this machine: It is disabled.",
        );

        state.providers = [copilotReady, codexReady];
        yield* fireNext;
        assert.deepEqual(state.launched, ["acpRegistry_copilot"]);
        assert.equal((yield* taskRow).last_run_status, "succeeded");
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("waits on a signed-out or unavailable provider without any failed run", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const signedOut: ServerProvider = {
      ...copilotReady,
      auth: { status: "unauthenticated" },
    };
    const unavailable: ServerProvider = {
      ...copilotReady,
      availability: "unavailable",
      unavailableReason: "GitHub Copilot is not supported on this platform.",
    };
    const { state, run, fireNext, taskRow } = yield* harness([signedOut]);
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput());
        yield* fireNext;
        assert.equal(
          (yield* taskRow).last_run_error,
          "Deferred until 2026-10-21T07:05:01.000Z: GitHub Copilot cannot start on this machine: It is signed out.",
        );
        state.providers = [unavailable];
        yield* fireNext;
        assert.equal(
          (yield* taskRow).last_run_error,
          "Deferred until 2026-10-21T07:20:02.000Z: GitHub Copilot cannot start on this machine: GitHub Copilot is not supported on this platform.",
        );
        assert.deepEqual(state.sent, []);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("fires on states a session start repairs when no run failed on it", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    // An on-demand ACP agent whose binary is not on disk yet: a session start installs it.
    const notDownloaded = provider("acpRegistry_copilot", "acpRegistry", {
      displayName: "GitHub Copilot",
      installed: false,
      version: "1.0.101",
      status: "warning",
      message: "GitHub Copilot 1.0.101 has not been prepared.",
    });
    // One health probe timed out: a real start refreshes the status and runs.
    const probeTimedOut = provider("claudeAgent", "claudeAgent", {
      displayName: "Claude",
      status: "error",
      message: "Claude is installed but failed to run. Timed out.",
    });
    const { state, run, fireNext, taskRow } = yield* harness([notDownloaded, probeTimedOut]);
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(taskInput());
        yield* fireNext;
        assert.deepEqual(state.sent, [{ threadId: THREAD, instanceId: undefined }]);
        assert.equal((yield* taskRow).last_run_status, "succeeded");

        yield* service.upsert(
          taskInput({
            id: task.id,
            modelPinned: true,
            modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5.5" },
          }),
        );
        yield* fireNext;
        assert.deepEqual(state.sent[1], { threadId: THREAD, instanceId: "claudeAgent" });
        const fired = yield* taskRow;
        assert.equal(fired.last_run_status, "succeeded");
        assert.isNull(fired.last_run_error);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

const withModel = (entry: ServerProvider, slug: string): ServerProvider => ({
  ...entry,
  models: [{ slug, name: slug, isCustom: false, isDefault: true, capabilities: null }],
});
const codexWithModel = withModel(codexReady, "gpt-5");
const claudeReady = withModel(
  provider("claudeAgent", "claudeAgent", { displayName: "Claude" }),
  "claude-opus-5-5",
);
it.effect("moves a fire off a provider that cannot open under the switch rule", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run, fireNext, taskRow, failRunOnCopilot } = yield* harness(
      [copilotNotPrepared, codexWithModel],
      DEFAULT_SERVER_SETTINGS,
    );
    yield* failRunOnCopilot("2026-10-21T06:45:00.000Z");
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput());
        yield* fireNext;
        // The broken Copilot is excluded; Codex takes the run, and the thread moves with it.
        assert.deepEqual(state.sent, [{ threadId: THREAD, instanceId: "codex" }]);
        const fired = yield* taskRow;
        assert.equal(fired.last_run_status, "succeeded");
        assert.isNull(fired.last_run_error);
        assert.equal(fired.run_count, 1);
        const [occurrence] = yield* occurrences;
        assert.equal(occurrence?.state, "dispatched");
        assert.match(String(occurrence?.reason), /^Moved to Codex: GitHub Copilot cannot start/);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("waits instead of moving under the ask rule, even with another provider ready", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run, fireNext, taskRow, failRunOnCopilot } = yield* harness(
      [copilotNotPrepared, codexWithModel],
      { ...DEFAULT_SERVER_SETTINGS, providerLimitAction: "ask" },
    );
    yield* failRunOnCopilot("2026-10-21T06:45:00.000Z");
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput());
        yield* fireNext;
        assert.deepEqual(state.sent, []);
        const deferred = yield* taskRow;
        assert.equal(deferred.next_run_at, "2026-10-21T07:05:01.000Z");
        assert.match(deferred.last_run_error ?? "", /^Deferred until /);
        assert.deepEqual(
          (yield* occurrences).map((occurrence) => occurrence.state),
          ["deferred"],
        );
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "returns a thread the limit fallback moved to a provider that cannot open once its origin resets",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      // Claude stopped on its limit (resets 06:55); the fallback to Copilot failed to open.
      const { state, run, fireNext, taskRow } = yield* harness([copilotNotPrepared, claudeReady]);
      yield* insertRun({
        runId: "run-limit",
        ordinal: 1,
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
        status: "failed",
        completedAt: "2026-10-21T06:44:16.000Z",
        userMessageId: "user-message-1",
        startedAt: "2026-10-21T06:40:00.000Z",
        failure: {
          class: "usage_limit",
          message: "Claude usage limit reached.",
          resetAt: "2026-10-21T06:55:00.000Z",
          retryable: false,
        },
      });
      yield* insertRun({
        runId: "run-fallback",
        ordinal: 2,
        instanceId: "acpRegistry_copilot",
        status: "failed",
        completedAt: "2026-10-21T06:44:28.000Z",
        userMessageId: `limit-fallback:${THREAD}:run-limit`,
        failure: openFailure,
      });
      yield* run((service) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(taskInput());
          const first = (yield* taskRow).next_run_at;
          // 06:50:01: Claude has not reset and Copilot cannot open; it waits for the reset.
          yield* fireNext;
          assert.deepEqual(state.sent, []);
          assert.equal((yield* taskRow).next_run_at, "2026-10-21T06:55:01.000Z");

          yield* fireNext;
          assert.deepEqual(state.sent, [{ threadId: THREAD, instanceId: "claudeAgent" }]);
          assert.deepEqual(state.messageIds, [
            `scheduled-task-message:${task.id}:${task.createdAt}:${first}:scheduled`,
          ]);
          assert.equal((yield* taskRow).last_run_status, "succeeded");
        }),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "reports a run that failed to open without resending it, and follows the server's retry to success",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const { state, run, fireNext, taskRow } = yield* harness([copilotReady]);
      yield* run((service) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(taskInput());
          const first = (yield* taskRow).next_run_at;
          const key = `${task.id}:${task.createdAt}:${first}:scheduled`;
          yield* fireNext;
          assert.deepEqual(state.messageIds, [`scheduled-task-message:${key}`]);

          // The run fails to open 2 s after the dispatch.
          yield* insertRun({
            runId: "run-scheduled-1",
            ordinal: 1,
            instanceId: "acpRegistry_copilot",
            status: "failed",
            completedAt: "2026-10-21T06:50:03.000Z",
            userMessageId: `scheduled-task-message:${key}`,
            failure: openFailure,
          });
          yield* TestClock.setTime(Date.parse("2026-10-21T06:51:00.000Z"));
          yield* state.poll!;
          const failed = yield* taskRow;
          assert.equal(failed.last_run_status, "failed");
          assert.equal(failed.last_run_error, NOT_PREPARED);
          // The schedule is untouched: nothing is queued to resend it.
          assert.equal(failed.next_run_at, "2026-10-21T07:00:01.000Z");
          const [waiting] = yield* occurrences;
          assert.equal(waiting?.state, "dispatched");
          assert.equal(waiting?.runId, "run-scheduled-1");

          // The server's own retry, sent once Copilot reads ready, finishes it.
          yield* insertRun({
            runId: "run-provider-retry",
            ordinal: 2,
            instanceId: "acpRegistry_copilot",
            status: "completed",
            completedAt: "2026-10-21T06:56:00.000Z",
            userMessageId: `provider-retry:${THREAD}:run-scheduled-1`,
            startedAt: "2026-10-21T06:55:30.000Z",
          });
          yield* TestClock.setTime(Date.parse("2026-10-21T06:57:00.000Z"));
          yield* state.poll!;
          const restored = yield* taskRow;
          assert.equal(restored.last_run_status, "succeeded");
          assert.isNull(restored.last_run_error);
          const [done] = yield* occurrences;
          assert.equal(done?.state, "succeeded");
          assert.equal(done?.runId, "run-provider-retry");

          // The next fire is the next occurrence; the failed one is never posted again.
          yield* fireNext;
          assert.equal(state.messageIds.length, 2);
          assert.notInclude(state.messageIds[1]!, key);
          assert.isFalse(state.messageIds.some((id) => id.includes(":retry-")));
        }),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

for (const [name, continuation] of [
  ["limit fallback", `limit-fallback:${THREAD}:run-scheduled`],
  ["provider fallback", `provider-fallback:${THREAD}:run-scheduled`],
  ["provider retry", `provider-retry:${THREAD}:run-scheduled`],
  ["way back", `limit-return:${THREAD}:run-scheduled`],
  ["limit recovery", `limit-resume:${THREAD}:run-scheduled:1792130400000:legacy`],
  ["context recovery", `context-retry:${THREAD}:run-scheduled`],
] as const)
  it.effect(`follows a failed run into its ${name} continuation`, () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const { run, fireNext, taskRow, state } = yield* harness([copilotReady]);
      yield* run((service) =>
        Effect.gen(function* () {
          yield* service.upsert(taskInput());
          yield* fireNext;
          yield* insertRun({
            runId: "run-scheduled",
            ordinal: 1,
            instanceId: "acpRegistry_copilot",
            status: "failed",
            completedAt: "2026-10-21T06:50:03.000Z",
            userMessageId: state.messageIds[0]!,
            failure: openFailure,
          });
          yield* state.poll!;
          assert.equal((yield* taskRow).last_run_status, "failed");
          // A context retry comes after its `/compact`, which is not the work.
          if (name === "context recovery")
            yield* insertRun({
              runId: "run-compact",
              ordinal: 2,
              instanceId: "acpRegistry_copilot",
              status: "completed",
              completedAt: "2026-10-21T06:51:00.000Z",
              userMessageId: `context-compact:${THREAD}:run-scheduled`,
              startedAt: "2026-10-21T06:50:30.000Z",
            });
          yield* state.poll!;
          assert.equal((yield* occurrences)[0]?.state, "dispatched");
          yield* insertRun({
            runId: "run-continued",
            ordinal: 3,
            instanceId: "codex",
            status: "running",
            completedAt: null,
            userMessageId: continuation,
            startedAt: "2026-10-21T06:52:00.000Z",
          });
          yield* state.poll!;
          assert.equal((yield* occurrences)[0]?.runId, "run-continued");
          yield* insertRun({
            runId: "run-continued",
            ordinal: 3,
            instanceId: "codex",
            status: "completed",
            completedAt: "2026-10-21T06:53:00.000Z",
            userMessageId: continuation,
            startedAt: "2026-10-21T06:52:00.000Z",
          });
          yield* state.poll!;
          const row = yield* taskRow;
          assert.equal(row.last_run_status, "succeeded");
          assert.isNull(row.last_run_error);
          const [done] = yield* occurrences;
          assert.equal(done?.state, "succeeded");
          assert.equal(done?.runId, "run-continued");
          assert.equal(state.sent.length, 1);
        }),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
  );

it.effect("follows a chain: a fallback that failed to open, then the retry of that move", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { run, fireNext, taskRow, state } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput());
        yield* fireNext;
        yield* insertRun({
          runId: "run-scheduled",
          ordinal: 1,
          instanceId: "claudeAgent",
          status: "failed",
          completedAt: "2026-10-21T06:50:03.000Z",
          userMessageId: state.messageIds[0]!,
          failure: {
            class: "usage_limit",
            message: "Claude usage limit reached.",
            retryable: false,
          },
        });
        yield* insertRun({
          runId: "run-fallback",
          ordinal: 2,
          instanceId: "acpRegistry_copilot",
          status: "failed",
          completedAt: "2026-10-21T06:50:40.000Z",
          userMessageId: `limit-fallback:${THREAD}:run-scheduled`,
          failure: openFailure,
        });
        yield* state.poll!;
        const failed = yield* taskRow;
        assert.equal(failed.last_run_status, "failed");
        assert.equal(failed.last_run_error, NOT_PREPARED);
        yield* insertRun({
          runId: "run-retried",
          ordinal: 3,
          instanceId: "acpRegistry_copilot",
          status: "completed",
          completedAt: "2026-10-21T06:58:00.000Z",
          userMessageId: `provider-retry:${THREAD}:run-fallback`,
          startedAt: "2026-10-21T06:57:00.000Z",
        });
        yield* state.poll!;
        assert.equal((yield* taskRow).last_run_status, "succeeded");
        assert.equal((yield* occurrences)[0]?.runId, "run-retried");
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("follows a run into a fallback that answers the thread's older limit stop", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { run, fireNext, taskRow, state } = yield* harness([copilotReady]);
    // A limit fallback put the thread on Copilot before the routine fired.
    yield* insertRun({
      runId: "run-limit",
      ordinal: 1,
      instanceId: "claudeAgent",
      status: "failed",
      completedAt: "2026-10-21T06:20:00.000Z",
      userMessageId: "user-message-1",
      startedAt: "2026-10-21T06:10:00.000Z",
      failure: { class: "usage_limit", message: "Claude usage limit reached.", retryable: false },
    });
    yield* insertRun({
      runId: "run-moved",
      ordinal: 2,
      instanceId: "acpRegistry_copilot",
      status: "completed",
      completedAt: "2026-10-21T06:30:00.000Z",
      userMessageId: `limit-fallback:${THREAD}:run-limit`,
      startedAt: "2026-10-21T06:21:00.000Z",
    });
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput());
        yield* fireNext;
        yield* insertRun({
          runId: "run-scheduled",
          ordinal: 3,
          instanceId: "acpRegistry_copilot",
          status: "failed",
          completedAt: "2026-10-21T06:50:03.000Z",
          userMessageId: state.messageIds[0]!,
          failure: openFailure,
        });
        yield* insertRun({
          runId: "run-retried",
          ordinal: 4,
          instanceId: "acpRegistry_copilot",
          status: "failed",
          completedAt: "2026-10-21T06:51:00.000Z",
          userMessageId: `provider-retry:${THREAD}:run-scheduled`,
          failure: openFailure,
        });
        // The repeat moves the thread on as the next hop of the old limit stop.
        const hop = {
          runId: "run-hop",
          ordinal: 5,
          instanceId: "codex",
          userMessageId: `limit-fallback:${THREAD}:hop-1:run-limit`,
          startedAt: "2026-10-21T06:52:00.000Z",
        };
        yield* insertRun({ ...hop, status: "running", completedAt: null });
        yield* state.poll!;
        const [following] = yield* occurrences;
        assert.equal(following?.state, "dispatched");
        assert.equal(following?.runId, "run-hop");
        yield* insertRun({ ...hop, status: "completed", completedAt: "2026-10-21T06:53:00.000Z" });
        yield* state.poll!;
        assert.equal((yield* taskRow).last_run_status, "succeeded");
        const [done] = yield* occurrences;
        assert.equal(done?.state, "succeeded");
        assert.equal(done?.runId, "run-hop");
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("leaves a failed run failed once the thread ran something else since", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { run, fireNext, taskRow, state } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput());
        yield* fireNext;
        yield* insertRun({
          runId: "run-scheduled",
          ordinal: 1,
          instanceId: "acpRegistry_copilot",
          status: "failed",
          completedAt: "2026-10-21T06:50:03.000Z",
          userMessageId: state.messageIds[0]!,
          failure: openFailure,
        });
        yield* insertRun({
          runId: "run-person",
          ordinal: 2,
          instanceId: "acpRegistry_copilot",
          status: "completed",
          completedAt: "2026-10-21T06:52:00.000Z",
          userMessageId: "user-message-9",
          startedAt: "2026-10-21T06:51:00.000Z",
        });
        yield* state.poll!;
        assert.equal((yield* taskRow).last_run_status, "failed");
        const [settled] = yield* occurrences;
        assert.equal(settled?.state, "failed");
        assert.equal(settled?.runId, "run-scheduled");
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("prunes settled occurrences once they are out of the follow window", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const sql = yield* SqlClient.SqlClient;
    const { run, state } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(taskInput());
        const { task: once } = yield* service.upsert(
          taskInput({ schedule: { type: "once", at: "2026-10-22T07:00:00.000Z" } }),
        );
        const receipt = (owner: typeof task, key: string, ageMs: number, state: string) => {
          const at = DateTime.formatIso(DateTime.makeUnsafe(START - ageMs));
          return sql`INSERT INTO scheduled_task_run_receipts ${sql.insert({
            command_id: `scheduled-occurrence:${key}`,
            project_id: "aide",
            task_id: owner.id,
            task_created_at: owner.createdAt,
            started_at: at,
            result_json: JSON.stringify({
              kind: "scheduled-occurrence",
              state,
              fireKey: key,
              threadId: THREAD,
              messageId: `scheduled-task-message:${key}`,
              runId: null,
              dispatchedAt: at,
              reason: null,
            }),
          })}`.pipe(Effect.as(at));
        };
        const DAY = 24 * 60 * 60_000;
        for (const [key, ageMs, settled] of [
          ["old-succeeded", 3 * DAY, "succeeded"],
          ["old-failed", 3 * DAY, "failed"],
          ["old-lost", 3 * DAY, "lost"],
          ["old-deferred", 3 * DAY, "deferred"],
          ["recent-succeeded", 60 * 60_000, "succeeded"],
        ] as const)
          yield* receipt(task, key, ageMs, settled);
        // The run a one-time task reports is still read by its retirement.
        const onceAt = yield* receipt(once, "once-last", 3 * DAY, "succeeded");
        yield* sql`UPDATE scheduled_tasks SET last_run_at = ${onceAt}, last_run_status = 'succeeded'
          WHERE task_id = ${once.id}`;
        // An ordinary command receipt is never an occurrence.
        yield* sql`INSERT INTO scheduled_task_run_receipts ${sql.insert({
          command_id: "scheduled-task-run:old",
          project_id: "aide",
          task_id: task.id,
          task_created_at: task.createdAt,
          started_at: DateTime.formatIso(DateTime.makeUnsafe(START - 3 * DAY)),
          result_json: null,
        })}`;
        yield* state.poll!;
        const kept = yield* sql<{ readonly command_id: string }>`
          SELECT command_id FROM scheduled_task_run_receipts ORDER BY command_id`;
        assert.deepEqual(
          kept.map((row) => row.command_id),
          [
            "scheduled-occurrence:old-deferred",
            "scheduled-occurrence:once-last",
            "scheduled-occurrence:recent-succeeded",
            "scheduled-task-run:old",
          ],
        );
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("follows the newest occurrences first, and gives up on a run that never started", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const sql = yield* SqlClient.SqlClient;
    const { run, fireNext, taskRow, state } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(taskInput());
        // Sixty earlier occurrences whose runs sit held in their queue.
        for (let index = 0; index < 60; index++) {
          const at = DateTime.formatIso(DateTime.makeUnsafe(START - (61 - index) * 60_000));
          const messageId = `scheduled-task-message:held-${index}`;
          yield* sql`INSERT INTO scheduled_task_run_receipts ${sql.insert({
            command_id: `scheduled-occurrence:held-${index}`,
            project_id: "aide",
            task_id: task.id,
            task_created_at: task.createdAt,
            started_at: at,
            result_json: JSON.stringify({
              kind: "scheduled-occurrence",
              state: "dispatched",
              fireKey: `held-${index}`,
              threadId: THREAD,
              messageId,
              runId: null,
              dispatchedAt: at,
              reason: null,
            }),
          })}`;
          yield* insertRun({
            runId: `run-held-${index}`,
            ordinal: index + 1,
            instanceId: "acpRegistry_copilot",
            status: "queued",
            completedAt: null,
            userMessageId: messageId,
          });
        }
        yield* fireNext;
        yield* insertRun({
          runId: "run-scheduled",
          ordinal: 100,
          instanceId: "acpRegistry_copilot",
          status: "failed",
          completedAt: "2026-10-21T06:50:03.000Z",
          userMessageId: state.messageIds[0]!,
          startedAt: "2026-10-21T06:50:02.000Z",
          failure: { class: "provider_error", message: "The agent crashed.", retryable: false },
        });
        yield* state.poll!;
        const row = yield* taskRow;
        assert.equal(row.last_run_status, "failed");
        assert.equal(row.last_run_error, "The agent crashed.");

        // Six hours on, the held runs that never started are given up on,
        // a batch a poll, so the older ones get their turn too.
        const lost = Effect.map(
          occurrences,
          (rows) => rows.filter((occurrence) => occurrence.state === "lost").length,
        );
        yield* TestClock.setTime(START + 7 * 60 * 60_000);
        yield* state.poll!;
        assert.equal(yield* lost, 49);
        yield* state.poll!;
        assert.equal(yield* lost, 60);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("records the run id and keeps succeeded only once the run completes", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { run, fireNext, taskRow, state } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput());
        yield* fireNext;
        const messageId = state.messageIds[0]!;
        yield* insertRun({
          runId: "run-scheduled",
          ordinal: 1,
          instanceId: "acpRegistry_copilot",
          status: "running",
          completedAt: null,
          userMessageId: messageId,
          startedAt: "2026-10-21T06:50:02.000Z",
        });
        yield* state.poll!;
        const [followed] = yield* occurrences;
        assert.equal(followed?.state, "dispatched");
        assert.equal(followed?.runId, "run-scheduled");

        yield* insertRun({
          runId: "run-scheduled",
          ordinal: 1,
          instanceId: "acpRegistry_copilot",
          status: "completed",
          completedAt: "2026-10-21T06:52:00.000Z",
          userMessageId: messageId,
          startedAt: "2026-10-21T06:50:02.000Z",
        });
        yield* state.poll!;
        const [completed] = yield* occurrences;
        assert.equal(completed?.state, "succeeded");
        const row = yield* taskRow;
        assert.equal(row.last_run_status, "succeeded");
        assert.isNull(row.last_run_error);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("reports a run that started and then failed, and keeps following it", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { run, fireNext, taskRow, state } = yield* harness([copilotReady]);
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput());
        yield* fireNext;
        yield* insertRun({
          runId: "run-scheduled",
          ordinal: 1,
          instanceId: "acpRegistry_copilot",
          status: "failed",
          completedAt: "2026-10-21T06:55:00.000Z",
          userMessageId: state.messageIds[0]!,
          startedAt: "2026-10-21T06:50:02.000Z",
          failure: { class: "provider_error", message: "The agent crashed.", retryable: false },
        });
        yield* state.poll!;
        const row = yield* taskRow;
        assert.equal(row.last_run_status, "failed");
        assert.equal(row.last_run_error, "The agent crashed.");
        assert.equal(row.next_run_at, "2026-10-21T07:00:01.000Z");
        // Limit or context recovery may still continue it.
        const [followed] = yield* occurrences;
        assert.equal(followed?.state, "dispatched");
        assert.equal(followed?.reason, "The agent crashed.");
        assert.equal(state.sent.length, 1);
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "never drops a fixed-time occurrence that waited, even when the host was off past the grace",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const signedOut: ServerProvider = { ...copilotReady, auth: { status: "unauthenticated" } };
      const { state, run, fireNext, taskRow } = yield* harness([signedOut]);
      yield* run((service) =>
        Effect.gen(function* () {
          // A one-shot written as one weekday's fixed time.
          const { task } = yield* service.upsert(
            taskInput({ schedule: { type: "fixed_time", timeOfDay: "07:03" } }),
          );
          const slot = (yield* taskRow).next_run_at!;
          yield* fireNext;
          assert.deepEqual(state.sent, []);
          const waited = (yield* taskRow).next_run_at!;
          assert.equal(Date.parse(waited) - Date.parse(slot), 15 * 60_000 + 1_000);

          // Back three hours after the retry time, signed in again.
          state.providers = [copilotReady];
          yield* TestClock.setTime(Date.parse(waited) + 3 * 60 * 60_000);
          yield* state.poll!;
          assert.deepEqual(state.messageIds, [
            `scheduled-task-message:${task.id}:${task.createdAt}:${slot}:scheduled`,
          ]);
          assert.equal((yield* taskRow).last_run_status, "succeeded");
        }),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("moves only when a provider_open_failed repeats, never on one transient failure", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const { state, run, fireNext } = yield* harness(
      [copilotReady, codexWithModel],
      DEFAULT_SERVER_SETTINGS,
    );
    const openFailed = {
      class: "provider_error",
      code: "provider_open_failed",
      message: "Provider session failed to open",
      retryable: false,
    };
    yield* insertRun({
      runId: "run-open-1",
      ordinal: 1,
      instanceId: "acpRegistry_copilot",
      status: "failed",
      completedAt: "2026-10-21T06:45:00.000Z",
      userMessageId: "user-message-1",
      failure: openFailed,
    });
    yield* run((service) =>
      Effect.gen(function* () {
        yield* service.upsert(taskInput());
        // One open failure may be transient: the fire stays on Copilot.
        yield* fireNext;
        assert.deepEqual(state.sent, [{ threadId: THREAD, instanceId: undefined }]);

        yield* insertRun({
          runId: "run-open-2",
          ordinal: 2,
          instanceId: "acpRegistry_copilot",
          status: "failed",
          completedAt: "2026-10-21T06:50:03.000Z",
          userMessageId: "user-message-2",
          failure: openFailed,
        });
        // Twice in a row on the same provider: the next fire moves to Codex.
        yield* fireNext;
        assert.deepEqual(state.sent[1], { threadId: THREAD, instanceId: "codex" });
      }),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("finds the way back through a fallback continuation a steer restarted", () =>
  Effect.gen(function* () {
    yield* insertRun({
      runId: "run-limit",
      ordinal: 1,
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      status: "failed",
      completedAt: "2026-10-21T06:44:16.000Z",
      userMessageId: "user-message-1",
      failure: { class: "usage_limit", message: "Claude usage limit reached.", retryable: false },
    });
    // The steer restarted the continuation under its own message.
    yield* insertRun({
      runId: "run-fallback",
      ordinal: 2,
      instanceId: "codex",
      model: "gpt-6",
      status: "completed",
      completedAt: "2026-10-21T06:50:00.000Z",
      userMessageId: "message:web:steer",
      startMessageId: `limit-fallback:${THREAD}:run-limit`,
    });
    const state = yield* readRouteState({ id: "task" } as never, THREAD, START);
    assert.equal(state.runs[0]?.userMessageId, `limit-fallback:${THREAD}:run-limit`);
    assert.equal(fallbackOrigin(THREAD, "codex", state.runs)?.selection.instanceId, "claudeAgent");
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("follows a routine's run into a fallback continuation a steer restarted", () =>
  Effect.gen(function* () {
    const occurrence = {
      kind: "scheduled-occurrence",
      state: "dispatched",
      fireKey: "fire-1",
      threadId: THREAD,
      messageId: "scheduled:fire-1",
      runId: null,
      dispatchedAt: "2026-10-21T06:44:00.000Z",
      reason: null,
    };
    const nowMs = Date.parse("2026-10-21T06:55:00.000Z");
    yield* insertRun({
      runId: "run-limit",
      ordinal: 1,
      instanceId: "claudeAgent",
      status: "failed",
      completedAt: "2026-10-21T06:44:16.000Z",
      userMessageId: "scheduled:fire-1",
      startedAt: "2026-10-21T06:44:01.000Z",
      failure: { class: "usage_limit", message: "Claude usage limit reached.", retryable: false },
    });
    yield* insertRun({
      runId: "run-fallback",
      ordinal: 2,
      instanceId: "codex",
      model: "gpt-6",
      status: "completed",
      completedAt: "2026-10-21T06:50:00.000Z",
      startedAt: "2026-10-21T06:45:00.000Z",
      userMessageId: "message:web:steer",
      startMessageId: `limit-fallback:${THREAD}:run-limit`,
    });
    const outcome = yield* followOccurrence(occurrence as never, nowMs);
    assert.deepInclude(outcome, { type: "succeeded", runId: "run-fallback" });

    // A steer into the routine's own run still finds it by the fire's message.
    yield* insertRun({
      runId: "run-own",
      threadId: "thread:steered-own",
      ordinal: 1,
      instanceId: "claudeAgent",
      status: "completed",
      completedAt: "2026-10-21T06:50:00.000Z",
      startedAt: "2026-10-21T06:45:00.000Z",
      userMessageId: "message:web:steer-own",
      startMessageId: "scheduled:fire-2",
    });
    const own = yield* followOccurrence(
      { ...occurrence, threadId: "thread:steered-own", messageId: "scheduled:fire-2" } as never,
      nowMs,
    );
    assert.deepInclude(own, { type: "succeeded", runId: "run-own" });
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
