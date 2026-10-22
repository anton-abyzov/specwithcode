import {
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "@effect/vitest";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { ContextHandoffBudgetError } from "./ContextHandoffDelivery.ts";
import {
  CONTEXT_RECOVERY_MAX_AGE_MS,
  CONTEXT_RECOVERY_SWEEP_INTERVAL_MS,
  contextRecoveryStep,
  isContextOverflowFailure,
  isContextRecoveryCandidate,
  makeSweep,
  providerSupportsCompaction,
  queueAllowsRecovery,
  recoveryCapReached,
} from "./ContextOverflowRecoveryWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { PROVIDER_FALLBACK_CONTINUE_TEXT } from "./unopenableFallback.ts";

const failedAt = Date.parse("2026-10-21T10:00:00.000Z");
const projectId = ProjectId.make("project-1");
const claude = ProviderInstanceId.make("claudeAgent");

const overflow = {
  class: "provider_error" as const,
  code: "prompt_too_long",
  message: "Claude stopped: the prompt exceeds the model's context window.",
  retryable: null,
};

const run = (input: {
  id: string;
  ordinal: number;
  message: string;
  status: "failed" | "completed" | "cancelled" | "queued" | "running";
  completedAt: number;
  requestedAt?: number;
  queueHeld?: boolean;
}) => ({
  id: RunId.make(input.id),
  threadId: ThreadId.make("t1"),
  ordinal: input.ordinal,
  providerInstanceId: claude,
  userMessageId: input.message as never,
  rootNodeId: `${input.id}-root` as never,
  status: input.status,
  requestedAt: DateTime.makeUnsafe(input.requestedAt ?? input.completedAt - 10_000),
  completedAt: DateTime.makeUnsafe(input.completedAt),
  ...(input.queueHeld === undefined ? {} : { queueHeld: input.queueHeld }),
});
type Run = ReturnType<typeof run>;

const errorItem = (
  failed: Run,
  failure: Omit<typeof overflow, "code"> & { readonly code: string | null },
) =>
  ({
    type: "error",
    id: `${failed.id}-error`,
    status: "failed",
    runId: failed.id,
    nodeId: failed.rootNodeId,
    ordinal: 1,
    updatedAt: failed.completedAt,
    failure,
  }) as unknown as OrchestrationV2TurnItem;

const shell = (latest: Run, overrides: Record<string, unknown> = {}) => ({
  id: ThreadId.make("t1"),
  projectId,
  status: latest.status,
  modelSelection: { instanceId: claude, model: "claude-opus" },
  lastErrorClass: latest.status === "failed" ? "provider_error" : null,
  latestRunId: latest.id,
  latestRunCompletedAt: latest.completedAt,
  activeRunId: null,
  pendingRuntimeRequest: null,
  activityRunStatus: null,
  heldQueuedCount: 0,
  settledOverride: null,
  archivedAt: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make("t1") },
  ...overrides,
});

const message = (id: string, text: string) => ({
  id,
  threadId: ThreadId.make("t1"),
  role: "user",
  text,
  attachments: [],
});

function harness(options: { readonly providers?: ReadonlyArray<ServerProvider> } = {}) {
  const state = {
    threads: [] as ReturnType<typeof shell>[],
    runs: [] as Run[],
    turnItems: [] as OrchestrationV2TurnItem[],
    messages: [] as Array<ReturnType<typeof message> & Record<string, unknown>>,
    runtimeRequests: [] as unknown[],
    nodes: [] as unknown[],
    dispatched: [] as OrchestrationV2ServerCommand[],
    // Every dispatch tried, with the clock time it was tried at, including failed ones.
    attempted: [] as Array<{ readonly commandId: string; readonly at: number }>,
    failDispatch: false,
  };
  const deps = Layer.mergeAll(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () => Effect.sync(() => ({ threads: state.threads }) as never),
      getThreadShell: (threadId) =>
        Effect.sync(
          () => (state.threads.find((thread) => thread.id === threadId) ?? null) as never,
        ),
      getThreadRecords: (_threadId, _fields, filter) =>
        Effect.sync(
          () =>
            ({
              runs: state.runs.filter(
                (candidate) => filter?.runIds === undefined || filter.runIds.includes(candidate.id),
              ),
              turnItems: state.turnItems.filter(
                (item) =>
                  filter?.turnItemRunIds === undefined ||
                  filter.turnItemRunIds.includes(item.runId),
              ),
              messages: state.messages.filter(
                (candidate) =>
                  filter?.messageIds === undefined ||
                  filter.messageIds.includes(candidate.id as never),
              ),
              runtimeRequests: state.runtimeRequests,
              nodes: state.nodes,
            }) as never,
        ),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: (command) =>
        Effect.gen(function* () {
          const at = DateTime.toEpochMillis(yield* DateTime.now);
          state.attempted.push({ commandId: command.commandId as string, at });
          if (state.failDispatch)
            return yield* Effect.fail({ _tag: "OrchestratorDispatchError" } as never);
          state.dispatched.push(command);
          return { sequence: 1, storedEvents: [] } as never;
        }),
    }),
    options.providers === undefined
      ? Layer.empty
      : Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed(options.providers),
        }),
  );
  return Effect.gen(function* () {
    yield* TestClock.setTime(failedAt + 60_000);
    const sweep = yield* makeSweep;
    const next = Effect.gen(function* () {
      yield* TestClock.adjust(CONTEXT_RECOVERY_SWEEP_INTERVAL_MS);
      yield* sweep();
    });
    return { state, sweep, next };
  }).pipe(Effect.provide(deps));
}

/** The thread's latest run is now `latest`, as the orchestrator would report it. */
const settle = (state: { threads: ReturnType<typeof shell>[]; runs: Run[] }, latest: Run) => {
  state.runs = [...state.runs, latest];
  state.threads = [shell(latest)];
};

describe("isContextOverflowFailure", () => {
  it("recognises overflow codes and messages, and nothing else", () => {
    expect(isContextOverflowFailure(overflow)).toBe(true);
    expect(
      isContextOverflowFailure({
        class: "provider_error",
        code: "error_during_execution",
        message: "Claude stopped: the prompt exceeds the model's context window.",
      }),
    ).toBe(true);
    expect(
      isContextOverflowFailure({
        class: "provider_error",
        code: null,
        message: new ContextHandoffBudgetError().message,
      }),
    ).toBe(true);
    expect(
      isContextOverflowFailure({ class: "provider_error", code: "api_error_529", message: "x" }),
    ).toBe(false);
    expect(
      isContextOverflowFailure({
        class: "usage_limit",
        code: "prompt_too_long",
        message: "limit",
      }),
    ).toBe(false);
    expect(isContextOverflowFailure(null)).toBe(false);
  });

  it("gives the handoff budget error a stable code", () => {
    expect(new ContextHandoffBudgetError().code).toBe("context_handoff_budget");
  });
});

describe("contextRecoveryStep", () => {
  const failed = run({ id: "r1", ordinal: 1, message: "m1", status: "failed", completedAt: 0 });
  it("compacts an overflowed run, then retries it, then stops", () => {
    expect(contextRecoveryStep("t1", failed, overflow)).toEqual({
      type: "compact",
      failedRunId: "r1",
    });
    const compact = {
      ...failed,
      id: RunId.make("r2"),
      userMessageId: "context-compact:t1:r1" as never,
    };
    expect(contextRecoveryStep("t1", { ...compact, status: "completed" }, null)).toEqual({
      type: "retry",
      failedRunId: "r1",
    });
    expect(
      contextRecoveryStep("t1", compact, { ...overflow, code: "api_error_529", message: "x" }),
    ).toEqual({ type: "retry", failedRunId: "r1" });
    expect(contextRecoveryStep("t1", compact, overflow)).toEqual({
      type: "stop",
      failedRunId: "r1",
      reason: "compact-overflowed",
    });
    expect(contextRecoveryStep("t1", { ...compact, status: "cancelled" }, null)).toBeNull();
    const retry = {
      ...failed,
      id: RunId.make("r3"),
      userMessageId: "context-retry:t1:r1" as never,
    };
    expect(contextRecoveryStep("t1", retry, overflow)).toEqual({
      type: "stop",
      failedRunId: "r1",
      reason: "retry-overflowed",
    });
    expect(contextRecoveryStep("t1", { ...retry, status: "completed" }, null)).toBeNull();
  });

  it("leaves a compaction that could not open or hit a limit to the other recoveries", () => {
    const compact = {
      ...failed,
      id: RunId.make("r2"),
      userMessageId: "context-compact:t1:r1" as never,
    };
    for (const failure of [
      { class: "provider_error" as const, code: "provider_unavailable", message: "Not prepared" },
      { class: "provider_error" as const, code: "provider_open_failed", message: "No session" },
      {
        class: "provider_error" as const,
        code: null,
        message: "Failed to open acpRegistry_copilot provider session: exited",
      },
      { class: "usage_limit" as const, code: null, message: "Limit reached" },
    ])
      expect(contextRecoveryStep("t1", compact, failure)).toBeNull();
    // An open failure is never read as an overflow, whatever its text says.
    expect(
      isContextOverflowFailure({
        class: "provider_error",
        code: "provider_open_failed",
        message: "Claude stopped: the prompt exceeds the model's context window.",
      }),
    ).toBe(false);
  });

  it("ignores failures that are not about context", () => {
    expect(
      contextRecoveryStep("t1", failed, { ...overflow, code: null, message: "Network down" }),
    ).toBeNull();
    expect(contextRecoveryStep("t1", { ...failed, status: "completed" }, null)).toBeNull();
  });
});

describe("isContextRecoveryCandidate", () => {
  const failed = run({
    id: "r1",
    ordinal: 1,
    message: "m1",
    status: "failed",
    completedAt: failedAt,
  });
  const now = failedAt + 60_000;
  it("leaves busy, waiting, settled, limited, old and subagent threads alone", () => {
    expect(isContextRecoveryCandidate(shell(failed) as never, now)).toBe(true);
    for (const overrides of [
      { activeRunId: "r9" },
      { pendingRuntimeRequest: { id: "q" } },
      { activityRunStatus: "running" },
      { settledOverride: "settled" },
      { lastErrorClass: "usage_limit" },
      { status: "running" },
      {
        lineage: {
          parentThreadId: ThreadId.make("p"),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make("p"),
        },
      },
    ])
      expect(isContextRecoveryCandidate(shell(failed, overrides) as never, now)).toBe(false);
    expect(
      isContextRecoveryCandidate(shell(failed) as never, failedAt + CONTEXT_RECOVERY_MAX_AGE_MS),
    ).toBe(false);
  });

  it("caps recoveries per thread", () => {
    expect(recoveryCapReached([now - 1, now - 2], now)).toBe(false);
    expect(recoveryCapReached([now - 1, now - 2, now - 3], now)).toBe(true);
  });

  it("lets only the failure's own hold stay queued", () => {
    const queued = (input: { queueHeld?: boolean; requestedAt: number }) =>
      run({ id: "q", ordinal: 2, message: "n", status: "queued", completedAt: 0, ...input });
    expect(queueAllowsRecovery([failed], failedAt)).toBe(true);
    expect(
      queueAllowsRecovery(
        [failed, queued({ queueHeld: true, requestedAt: failedAt - 1 })],
        failedAt,
      ),
    ).toBe(true);
    expect(queueAllowsRecovery([failed, queued({ requestedAt: failedAt - 1 })], failedAt)).toBe(
      false,
    );
    expect(
      queueAllowsRecovery(
        [failed, queued({ queueHeld: true, requestedAt: failedAt + 1 })],
        failedAt,
      ),
    ).toBe(false);
  });

  it("reads native compaction from the provider's slash commands", () => {
    const providers = [
      { instanceId: claude, slashCommands: [{ name: "compact" }] },
      { instanceId: ProviderInstanceId.make("copilot"), slashCommands: [{ name: "model" }] },
    ] as never;
    expect(providerSupportsCompaction(providers, claude)).toBe(true);
    expect(providerSupportsCompaction(providers, ProviderInstanceId.make("copilot"))).toBe(false);
    expect(providerSupportsCompaction(providers, ProviderInstanceId.make("gone"))).toBeNull();
  });
});

describe("ContextOverflowRecoveryWorker sweep", () => {
  const r1 = run({ id: "r1", ordinal: 1, message: "m1", status: "failed", completedAt: failedAt });

  it.effect("compacts and resends the unanswered request once, and never loops", () =>
    Effect.gen(function* () {
      const { state, sweep, next } = yield* harness();
      state.messages = [message("m1", "Refactor the parser")];
      state.turnItems = [errorItem(r1, overflow)];
      settle(state, r1);
      state.runs = [r1];

      yield* sweep();
      expect(state.dispatched).toHaveLength(1);
      expect(state.dispatched[0]).toMatchObject({
        type: "message.dispatch",
        commandId: "context-compact:t1:r1",
        messageId: "context-compact:t1:r1",
        text: "/compact",
        dispatchMode: { type: "start_immediately" },
      });

      // A second sweep before anything changed sends nothing more.
      yield* next;
      expect(state.dispatched).toHaveLength(1);

      // The /compact run finishes: the request goes again under its own id.
      const r2 = run({
        id: "r2",
        ordinal: 2,
        message: "context-compact:t1:r1",
        status: "completed",
        completedAt: failedAt + 90_000,
      });
      settle(state, r2);
      yield* next;
      expect(state.dispatched).toHaveLength(2);
      expect(state.dispatched[1]).toMatchObject({
        commandId: "context-retry:t1:r1",
        messageId: "context-retry:t1:r1",
        text: "Refactor the parser",
        createdBy: "user",
      });
      yield* next;
      expect(state.dispatched).toHaveLength(2);

      // The retry overflows again: the failure stays, nothing new starts.
      const r3 = run({
        id: "r3",
        ordinal: 3,
        message: "context-retry:t1:r1",
        status: "failed",
        completedAt: failedAt + 120_000,
      });
      state.turnItems = [...state.turnItems, errorItem(r3, overflow)];
      settle(state, r3);
      yield* next;
      yield* next;
      expect(state.dispatched).toHaveLength(2);
    }),
  );

  it.effect("still resends when the /compact run fails for another reason", () =>
    Effect.gen(function* () {
      const { state, next } = yield* harness();
      const r2 = run({
        id: "r2",
        ordinal: 2,
        message: "context-compact:t1:r1",
        status: "failed",
        completedAt: failedAt + 30_000,
      });
      state.runs = [r1];
      state.turnItems = [
        errorItem(r1, overflow),
        errorItem(r2, { ...overflow, code: "api_error_529", message: "Overloaded" }),
      ];
      settle(state, r2);
      yield* next;
      expect(state.dispatched).toHaveLength(1);
      // No request message on record: the agent is asked to continue.
      expect(state.dispatched[0]).toMatchObject({
        commandId: "context-retry:t1:r1",
        text: PROVIDER_FALLBACK_CONTINUE_TEXT,
      });
    }),
  );

  it.effect("ignores failures that are not context overflows", () =>
    Effect.gen(function* () {
      const { state, sweep } = yield* harness();
      state.turnItems = [
        errorItem(r1, { ...overflow, code: "api_error_529", message: "Overloaded" }),
      ];
      settle(state, r1);
      state.runs = [r1];
      yield* sweep();
      expect(state.dispatched).toHaveLength(0);
    }),
  );

  it.effect("ignores busy threads and threads with queued work", () =>
    Effect.gen(function* () {
      const { state, sweep, next } = yield* harness();
      state.turnItems = [errorItem(r1, overflow)];
      state.runs = [r1];
      state.threads = [shell(r1, { activeRunId: RunId.make("r9"), activityRunStatus: "running" })];
      yield* sweep();
      state.threads = [shell(r1, { pendingRuntimeRequest: { id: "q" } })];
      yield* next;
      state.threads = [shell(r1)];
      state.runs = [
        r1,
        run({ id: "r4", ordinal: 2, message: "m4", status: "queued", completedAt: failedAt }),
      ];
      yield* next;
      expect(state.dispatched).toHaveLength(0);
      // Once the thread is free the recovery starts.
      state.runs = [r1];
      yield* next;
      expect(state.dispatched.map((command) => command.commandId)).toEqual([
        "context-compact:t1:r1",
      ]);
    }),
  );

  it.effect("leaves a failed /compact alone and recovers handoff budget failures", () =>
    Effect.gen(function* () {
      const { state, sweep, next } = yield* harness();
      state.messages = [message("m1", "/compact")];
      state.turnItems = [errorItem(r1, overflow)];
      settle(state, r1);
      state.runs = [r1];
      yield* sweep();
      expect(state.dispatched).toHaveLength(0);

      const r5 = run({
        id: "r5",
        ordinal: 2,
        message: "m5",
        status: "failed",
        completedAt: failedAt,
      });
      state.messages = [message("m5", "Continue the release")];
      state.turnItems = [
        errorItem(r5, {
          class: "provider_error",
          code: null as never,
          message: new ContextHandoffBudgetError().message,
          retryable: null,
        }),
      ];
      settle(state, r5);
      yield* next;
      expect(state.dispatched.map((command) => command.commandId)).toEqual([
        "context-compact:t1:r5",
      ]);
    }),
  );

  it.effect("retries a failed dispatch three times, further apart each time, then rests", () =>
    Effect.gen(function* () {
      const { state, sweep, next } = yield* harness();
      state.failDispatch = true;
      state.turnItems = [errorItem(r1, overflow)];
      settle(state, r1);
      state.runs = [r1];
      const start = DateTime.toEpochMillis(yield* DateTime.now);
      yield* sweep();
      for (let i = 0; i < 20; i++) yield* next;
      state.failDispatch = false;
      for (let i = 0; i < 20; i++) yield* next;
      // Tries one minute, then two minutes after the failure before them.
      expect(state.attempted).toEqual([
        { commandId: "context-compact:t1:r1", at: start },
        { commandId: "context-compact:t1:r1:retry-1", at: start + 60_000 },
        { commandId: "context-compact:t1:r1:retry-2", at: start + 180_000 },
      ]);
      expect(state.dispatched).toHaveLength(0);
    }),
  );

  it.effect("leaves the compaction to the fallback when the provider cannot open", () =>
    Effect.gen(function* () {
      const { state, next } = yield* harness();
      const r2 = run({
        id: "r2",
        ordinal: 2,
        message: "context-compact:t1:r1",
        status: "failed",
        completedAt: failedAt + 30_000,
      });
      state.messages = [message("m1", "Refactor the parser")];
      state.runs = [r1];
      state.turnItems = [
        errorItem(r1, overflow),
        errorItem(r2, {
          class: "provider_error",
          code: "provider_unavailable",
          message: "Copilot is not prepared",
          retryable: null,
        }),
      ];
      settle(state, r2);
      yield* next;
      yield* next;
      expect(state.attempted).toHaveLength(0);
    }),
  );

  it.effect("compacts behind the failure's held queue, and not behind a fresh send", () =>
    Effect.gen(function* () {
      const { state, sweep, next } = yield* harness();
      state.messages = [message("m1", "Refactor the parser")];
      state.turnItems = [errorItem(r1, overflow)];
      // A background-task notification queued during r1, held by r1's failure.
      const held = run({
        id: "r9",
        ordinal: 2,
        message: "notification-1",
        status: "queued",
        completedAt: 0,
        requestedAt: failedAt - 5_000,
        queueHeld: true,
      });
      // A message someone queued after the failure, not held: their turn comes first.
      const fresh = run({
        id: "r8",
        ordinal: 3,
        message: "m8",
        status: "queued",
        completedAt: 0,
        requestedAt: failedAt + 5_000,
      });
      state.runs = [r1, held, fresh];
      state.threads = [shell(r1, { heldQueuedCount: 1 })];
      yield* sweep();
      expect(state.attempted).toHaveLength(0);

      state.runs = [r1, held];
      yield* next;
      expect(state.dispatched.map((command) => command.commandId)).toEqual([
        "context-compact:t1:r1",
      ]);

      // The /compact leaves the hold; the resend goes out with it still held.
      const r2 = run({
        id: "r2",
        ordinal: 4,
        message: "context-compact:t1:r1",
        status: "completed",
        completedAt: failedAt + 90_000,
      });
      state.runs = [r1, held, r2];
      state.threads = [shell(r2, { heldQueuedCount: 1 })];
      yield* next;
      expect(state.dispatched.map((command) => command.commandId)).toEqual([
        "context-compact:t1:r1",
        "context-retry:t1:r1",
      ]);
      expect(state.dispatched[1]).toMatchObject({ createdBy: "user", text: "Refactor the parser" });
    }),
  );

  it.effect("sends no /compact to a provider without native compaction", () =>
    Effect.gen(function* () {
      const { state, sweep, next } = yield* harness({
        providers: [{ instanceId: claude, slashCommands: [{ name: "model" }] }] as never,
      });
      state.messages = [message("m1", "Refactor the parser")];
      state.turnItems = [errorItem(r1, overflow)];
      settle(state, r1);
      state.runs = [r1];
      yield* sweep();
      yield* next;
      yield* next;
      expect(state.attempted).toHaveLength(0);
    }),
  );

  it.effect("waits for the provider snapshot, then compacts where the provider can", () =>
    Effect.gen(function* () {
      const providers: Array<ServerProvider> = [];
      const { state, sweep, next } = yield* harness({ providers });
      state.messages = [message("m1", "Refactor the parser")];
      state.turnItems = [errorItem(r1, overflow)];
      settle(state, r1);
      state.runs = [r1];
      yield* sweep();
      expect(state.attempted).toHaveLength(0);
      providers.push({ instanceId: claude, slashCommands: [{ name: "compact" }] } as never);
      yield* next;
      expect(state.dispatched.map((command) => command.commandId)).toEqual([
        "context-compact:t1:r1",
      ]);
    }),
  );

  it.effect("starts at most three recoveries per thread, counting a re-tried dispatch once", () =>
    Effect.gen(function* () {
      const { state, sweep, next } = yield* harness();
      const nowMs = () => DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
      let ordinal = 0;
      const end = (id: string, messageId: string, status: "failed" | "completed", at: number) => {
        const ended = run({ id, ordinal: ++ordinal, message: messageId, status, completedAt: at });
        if (status === "failed") state.turnItems = [...state.turnItems, errorItem(ended, overflow)];
        settle(state, ended);
      };
      /** One overflow on `failed`, compacted and answered by a resend that completes. */
      const cycle = (failed: string, compacted: string, retried: string) =>
        Effect.gen(function* () {
          state.messages = [...state.messages, message(`m-${failed}`, `Request ${failed}`)];
          end(failed, `m-${failed}`, "failed", yield* nowMs());
          yield* next;
          // Room for a dispatch that failed once to go again.
          for (let i = 0; i < 4; i++) yield* next;
          end(compacted, `context-compact:t1:${failed}`, "completed", yield* nowMs());
          yield* next;
          end(retried, `context-retry:t1:${failed}`, "completed", yield* nowMs());
          yield* next;
        });
      yield* sweep();
      // The first compaction's dispatch fails once and goes again under its own id.
      state.failDispatch = true;
      state.messages = [message("m-r1", "Request r1")];
      end("r1", "m-r1", "failed", yield* nowMs());
      yield* next;
      state.failDispatch = false;
      for (let i = 0; i < 4; i++) yield* next;
      end("r2", "context-compact:t1:r1", "completed", yield* nowMs());
      yield* next;
      end("r3", "context-retry:t1:r1", "completed", yield* nowMs());
      yield* next;
      yield* cycle("r4", "r5", "r6");
      yield* cycle("r7", "r8", "r9");
      // The fourth overflow stays failed; later sweeps send nothing for it.
      state.messages = [...state.messages, message("m-r10", "Request r10")];
      end("r10", "m-r10", "failed", yield* nowMs());
      for (let i = 0; i < 5; i++) yield* next;

      expect(state.attempted.map((attempt) => attempt.commandId)).toEqual([
        "context-compact:t1:r1",
        "context-compact:t1:r1:retry-1",
        "context-retry:t1:r1",
        "context-compact:t1:r4",
        "context-retry:t1:r4",
        "context-compact:t1:r7",
        "context-retry:t1:r7",
      ]);
    }),
  );
});

describe("ContextOverflowRecoveryWorker sweep, around other runs", () => {
  const r1 = run({ id: "r1", ordinal: 1, message: "m1", status: "failed", completedAt: failedAt });
  /** A background-task notification the server delivered to the thread. */
  const wake = (id: string) => ({
    ...message(id, "Background task finished."),
    createdBy: "system",
    notification: { kind: "background-task" },
  });
  const commandIds = (state: { dispatched: OrchestrationV2ServerCommand[] }) =>
    state.dispatched.map((command) => command.commandId);

  it.effect("keeps recovering the overflow when wakes run before and after its /compact", () =>
    Effect.gen(function* () {
      const { state, sweep, next } = yield* harness();
      state.messages = [message("m1", "Refactor the parser"), wake("w2"), wake("w4")];
      state.turnItems = [errorItem(r1, overflow)];
      state.runs = [r1];
      // A wake reached the idle thread before the sweep, and ran.
      settle(
        state,
        run({
          id: "r2",
          ordinal: 2,
          message: "w2",
          status: "completed",
          completedAt: failedAt + 20_000,
        }),
      );
      yield* sweep();
      expect(commandIds(state)).toEqual(["context-compact:t1:r1"]);

      settle(
        state,
        run({
          id: "r3",
          ordinal: 3,
          message: "context-compact:t1:r1",
          status: "completed",
          completedAt: failedAt + 90_000,
        }),
      );
      // Another wake ran after the /compact, before the resend.
      settle(
        state,
        run({
          id: "r4",
          ordinal: 4,
          message: "w4",
          status: "completed",
          completedAt: failedAt + 95_000,
        }),
      );
      yield* next;
      expect(commandIds(state)).toEqual(["context-compact:t1:r1", "context-retry:t1:r1"]);
      expect(state.dispatched[1]).toMatchObject({ text: "Refactor the parser", createdBy: "user" });
      yield* next;
      expect(state.dispatched).toHaveLength(2);
    }),
  );

  it.effect("recovers the request, not a wake that overflowed after it", () =>
    Effect.gen(function* () {
      const { state, sweep } = yield* harness();
      state.messages = [message("m1", "Refactor the parser"), wake("w2")];
      const r2 = run({
        id: "r2",
        ordinal: 2,
        message: "w2",
        status: "failed",
        completedAt: failedAt + 20_000,
      });
      state.turnItems = [errorItem(r1, overflow), errorItem(r2, overflow)];
      state.runs = [r1];
      settle(state, r2);
      yield* sweep();
      expect(commandIds(state)).toEqual(["context-compact:t1:r1"]);
    }),
  );

  it.effect("never repeats a step a wake ran after", () =>
    Effect.gen(function* () {
      const { state, sweep } = yield* harness();
      state.messages = [message("m1", "Refactor the parser"), wake("w4")];
      state.turnItems = [errorItem(r1, overflow)];
      state.runs = [
        r1,
        run({
          id: "r2",
          ordinal: 2,
          message: "context-compact:t1:r1",
          status: "completed",
          completedAt: failedAt + 30_000,
        }),
        run({
          id: "r3",
          ordinal: 3,
          message: "context-retry:t1:r1",
          status: "completed",
          completedAt: failedAt + 40_000,
        }),
      ];
      settle(
        state,
        run({
          id: "r4",
          ordinal: 4,
          message: "w4",
          status: "completed",
          completedAt: failedAt + 50_000,
        }),
      );
      yield* sweep();
      expect(state.attempted).toHaveLength(0);
    }),
  );

  for (const [name, continuation] of [
    ["provider-ready retry", "provider-retry:t1:r2"],
    ["provider fallback", "provider-fallback:t1:r2"],
    ["limit recovery", "limit-resume:t1:r2:1792130400000:legacy"],
  ] as const)
    it.effect(`resends the request once the ${name} of a failed /compact completes`, () =>
      Effect.gen(function* () {
        const { state, sweep } = yield* harness();
        state.messages = [message("m1", "Refactor the parser")];
        const r2 = run({
          id: "r2",
          ordinal: 2,
          message: "context-compact:t1:r1",
          status: "failed",
          completedAt: failedAt + 30_000,
        });
        state.turnItems = [
          errorItem(r1, overflow),
          errorItem(r2, {
            class: "provider_error",
            code: "provider_open_failed",
            message: "No session",
            retryable: null,
          }),
        ];
        state.runs = [r1, r2];
        const r3 = run({
          id: "r3",
          ordinal: 3,
          message: continuation,
          status: "completed",
          completedAt: failedAt + 60_000,
        });
        settle(state, r3);
        yield* sweep();
        expect(commandIds(state)).toEqual(["context-retry:t1:r1"]);
        expect(state.dispatched[0]).toMatchObject({ text: "Refactor the parser" });

        // A continuation that overflowed again leaves nothing smaller to resend into.
        const { state: again, next: nextAgain } = yield* harness();
        again.messages = state.messages;
        const r3Overflowed = { ...r3, status: "failed" as const };
        again.turnItems = [...state.turnItems, errorItem(r3Overflowed, overflow)];
        again.runs = [r1, r2];
        settle(again, r3Overflowed);
        yield* nextAgain;
        expect(again.attempted).toHaveLength(0);
      }),
    );

  it.effect("does not wait on a question answered by message, or one an earlier run left", () =>
    Effect.gen(function* () {
      for (const request of [
        { kind: "user_input", responseCapability: { type: "message" }, nodeId: "r1-root" },
        { kind: "command", responseCapability: { type: "live" }, nodeId: "r0-root" },
      ]) {
        const { state, sweep } = yield* harness();
        state.messages = [message("m1", "Refactor the parser")];
        state.turnItems = [errorItem(r1, overflow)];
        state.runtimeRequests = [{ id: "q", status: "pending", ...request }];
        state.nodes = [
          { id: "r0-root", runId: "r0" },
          { id: "r1-root", runId: "r1" },
        ];
        state.runs = [r1];
        state.threads = [shell(r1, { pendingRuntimeRequest: { id: "q", kind: request.kind } })];
        yield* sweep();
        expect(commandIds(state)).toEqual(["context-compact:t1:r1"]);
      }
      // An approval the failed run itself waits on still holds it.
      const { state, sweep } = yield* harness();
      state.turnItems = [errorItem(r1, overflow)];
      state.runtimeRequests = [
        {
          id: "q",
          status: "pending",
          kind: "command",
          responseCapability: { type: "live" },
          nodeId: "r1-root",
        },
      ];
      state.nodes = [{ id: "r1-root", runId: "r1" }];
      state.runs = [r1];
      state.threads = [shell(r1, { pendingRuntimeRequest: { id: "q", kind: "command" } })];
      yield* sweep();
      expect(state.attempted).toHaveLength(0);
    }),
  );
});
