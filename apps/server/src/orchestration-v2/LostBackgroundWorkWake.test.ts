import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as Settings from "../serverSettings.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import {
  automaticChainLength,
  LOST_WORK_CLAUDE_ROUTES,
  LOST_WORK_WAKE_PROMPT,
  lostWorkWake,
  lostWorkWakeText,
  make,
} from "./LostBackgroundWorkWake.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instance = ProviderInstanceId.make("claudeAgent");
const PROJECT = ProjectId.make("project_lost_work");
const THREAD = ThreadId.make("thread_lost_work");
const PROVIDER_THREAD = ProviderThreadId.make("provider_thread_lost_work");
const SESSION = ProviderSessionId.make("provider_session_lost_work");
const START = DateTime.makeUnsafe("2026-11-11T10:00:00.000Z");
const at = (minute: number) => DateTime.add(START, { minutes: minute });
const NOW_MS = DateTime.toEpochMillis(at(30));

type Projection = OrchestrationV2ThreadProjection;
type Mutable = { -readonly [K in keyof Projection]: Projection[K] };
type Run = Projection["runs"][number];

const WORKFLOW = { kind: "task", label: "foundation build (id wf_1)", id: "wf_1" } as const;
const SHELL = { kind: "shell", label: "npm run dev (id sh_1)", id: "sh_1" } as const;

function thread(extra: Record<string, unknown> = {}) {
  return {
    id: THREAD,
    projectId: PROJECT,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    providerInstanceId: instance,
    creationSource: "user",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD },
    ...extra,
  } as unknown as Projection["thread"];
}

function run(id: string, ordinal: number, status: string, extra: Record<string, unknown> = {}) {
  return {
    id: RunId.make(id),
    ordinal,
    status,
    userMessageId: `message:user:${id}`,
    providerThreadId: PROVIDER_THREAD,
    providerInstanceId: instance,
    activeAttemptId: `attempt:${id}`,
    rootNodeId: NodeId.make(`root:${id}`),
    modelSelection: { instanceId: instance, model: "claude-test" },
    completedAt: status === "running" ? null : at(ordinal),
    ...extra,
  } as unknown as Run;
}

const settled = (extra: Record<string, unknown> = {}) =>
  run("run_1", 1, "completed", { restartCancelledBackgroundWork: [WORKFLOW], ...extra });

const decide = (input: {
  readonly thread?: Projection["thread"];
  readonly runs: ReadonlyArray<Run>;
  readonly providerTurns?: ReadonlyArray<{ runAttemptId: string | null; status: string }>;
  readonly interrupts?: ReadonlyArray<{ runId: string; cause?: string; message: string }>;
  readonly sent?: ReadonlyArray<string>;
  readonly latestFailureClass?: string;
  readonly nowMs?: number;
}) =>
  lostWorkWake({
    thread: input.thread ?? thread(),
    runs: input.runs,
    providerTurns: (input.providerTurns ?? []) as never,
    interrupts: input.interrupts ?? [],
    sentMessageIds: new Set(input.sent ?? []),
    latestFailureClass: input.latestFailureClass,
    nowMs: input.nowMs ?? NOW_MS,
  });

it("wakes a thread whose settled turn lost a Workflow it was waiting on (1302)", () => {
  const found = decide({ runs: [settled()] });
  assert.strictEqual(found?.run.id, "run_1");
  assert.deepEqual(found?.work, [WORKFLOW]);
});

it("wakes after recovery cancelled a waiting run it could not checkpoint", () => {
  assert.isDefined(decide({ runs: [settled({ status: "cancelled" })] }));
});

it("leaves a turn cut mid-way to its own restart continuation", () => {
  assert.isUndefined(
    decide({
      runs: [settled({ status: "cancelled" })],
      providerTurns: [{ runAttemptId: "attempt:run_1", status: "cancelled" }],
    }),
  );
  assert.isUndefined(decide({ runs: [settled({ status: "interrupted" })] }));
  assert.isUndefined(decide({ runs: [settled({ status: "failed" })] }));
});

it("never wakes what a person stopped, closed or already answered", () => {
  const stop = [{ runId: "run_1", cause: "user", message: "Stopped" }];
  assert.isUndefined(decide({ runs: [settled()], interrupts: stop }));
  // An update's own stop is no Stop.
  assert.isDefined(
    decide({
      runs: [settled()],
      interrupts: [{ runId: "run_1", cause: "service_update", message: "Update" }],
    }),
  );
  assert.isUndefined(decide({ runs: [settled()], thread: thread({ archivedAt: at(2) }) }));
  assert.isUndefined(decide({ runs: [settled()], thread: thread({ deletedAt: at(2) }) }));
  assert.isUndefined(decide({ runs: [settled()], thread: thread({ settledOverride: "settled" }) }));
  assert.isUndefined(decide({ runs: [settled()], thread: thread({ settledAt: at(2) }) }));
  // A later turn, running or queued, carries the note itself.
  assert.isUndefined(decide({ runs: [settled(), run("run_2", 2, "running")] }));
  assert.isUndefined(decide({ runs: [settled(), run("run_2", 2, "queued")] }));
  assert.isUndefined(decide({ runs: [settled(), run("run_2", 2, "completed")] }));
  // Messages the update cancelled are queued again.
  assert.isUndefined(
    decide({
      runs: [settled(), run("run_2", 2, "cancelled", { cancelledForUpdate: true })],
    }),
  );
});

it("never wakes a run an agent stopped", () => {
  assert.isUndefined(
    decide({
      runs: [settled()],
      interrupts: [{ runId: "run_1", cause: "agent", message: "Stopped by its coordinator" }],
    }),
  );
});

it("sends a wake once more when the provider failed before taking it", () => {
  const failed = run("run_2", 2, "failed", {
    userMessageId: "message:restart-continuation:run_1",
  });
  const found = decide({ runs: [settled(), failed] });
  assert.strictEqual(found?.run.id, "run_1");
  assert.strictEqual(found?.messageRun.id, "run_2");
  // Not before the provider had a few minutes, and not twice.
  assert.isUndefined(
    decide({ runs: [settled(), failed], nowMs: DateTime.toEpochMillis(at(2)) + 60_000 }),
  );
  assert.isUndefined(
    decide({ runs: [settled(), failed], sent: ["message:restart-continuation:run_2"] }),
  );
  const failedAgain = run("run_3", 3, "failed", {
    userMessageId: "message:restart-continuation:run_2",
  });
  assert.isUndefined(decide({ runs: [settled(), failed, failedAgain] }));
  // A turn the provider took and then failed has its own recovery, as does a limit.
  assert.isUndefined(
    decide({
      runs: [settled(), failed],
      providerTurns: [{ runAttemptId: "attempt:run_2", status: "failed" }],
    }),
  );
  assert.isUndefined(decide({ runs: [settled(), failed], latestFailureClass: "usage_limit" }));
  // A person's own failed message is theirs to send again.
  assert.isUndefined(decide({ runs: [settled(), run("run_2", 2, "failed")] }));
});

it("skips provider-native subagents, moved threads, old losses and sent wakes", () => {
  assert.isUndefined(
    decide({
      runs: [settled()],
      thread: thread({
        creationSource: "provider",
        lineage: {
          parentThreadId: ThreadId.make("thread_parent"),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make("thread_parent"),
        },
      }),
    }),
  );
  assert.isUndefined(
    decide({
      runs: [settled()],
      thread: thread({ providerInstanceId: ProviderInstanceId.make("codex") }),
    }),
  );
  const day = 24 * 60 * 60 * 1000;
  const endedMs = DateTime.toEpochMillis(at(1));
  assert.isDefined(decide({ runs: [settled()], nowMs: endedMs + day }));
  assert.isUndefined(decide({ runs: [settled()], nowMs: endedMs + day + 1 }));
  assert.isUndefined(decide({ runs: [settled()], sent: ["message:restart-continuation:run_1"] }));
  assert.isUndefined(decide({ runs: [settled({ restartCancelledBackgroundWork: [] })] }));
});

it("limits automatic turns in a row: shells once, awaited work three times", () => {
  const automatic = (id: string, ordinal: number, source: string, work: ReadonlyArray<unknown>) =>
    run(id, ordinal, "completed", {
      userMessageId: `message:restart-continuation:${source}`,
      restartCancelledBackgroundWork: work,
    });
  const first = run("run_1", 1, "completed", { restartCancelledBackgroundWork: [SHELL] });
  assert.isDefined(decide({ runs: [first] }));
  // A dev server lost again after the automatic turn restarted it stays down.
  const again = automatic("run_2", 2, "run_1", [SHELL]);
  assert.strictEqual(automaticChainLength(again, [first, again]), 1);
  assert.isUndefined(decide({ runs: [first, again] }));
  // A Workflow is finite work the agent waits for.
  const second = automatic("run_2", 2, "run_1", [WORKFLOW]);
  const third = automatic("run_3", 3, "run_2", [WORKFLOW]);
  const fourth = automatic("run_4", 4, "run_3", [WORKFLOW]);
  assert.isDefined(decide({ runs: [first, second] }));
  assert.isDefined(decide({ runs: [first, second, third] }));
  assert.strictEqual(automaticChainLength(fourth, [first, second, third, fourth]), 3);
  assert.isUndefined(decide({ runs: [first, second, third, fourth] }));
  // A person's message starts the count again.
  const person = run("run_5", 5, "completed", { restartCancelledBackgroundWork: [WORKFLOW] });
  assert.isDefined(decide({ runs: [first, second, third, fourth, person] }));
});

it("names Claude Code's own recovery routes only for Claude", () => {
  assert.strictEqual(
    lostWorkWakeText("claudeAgent"),
    `${LOST_WORK_WAKE_PROMPT}\n\n${LOST_WORK_CLAUDE_ROUTES}`,
  );
  assert.strictEqual(lostWorkWakeText("codex"), LOST_WORK_WAKE_PROMPT);
});

function projection(input: {
  readonly thread?: Projection["thread"];
  readonly runs: ReadonlyArray<Run>;
  readonly roster?: ReadonlyArray<unknown>;
  readonly turnItems?: ReadonlyArray<unknown>;
  readonly subagents?: ReadonlyArray<unknown>;
}): Mutable {
  return {
    thread: input.thread ?? thread(),
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [
      {
        id: PROVIDER_THREAD,
        driver,
        providerInstanceId: instance,
        providerSessionId: SESSION,
        ownerNodeId: null,
        status: "idle",
        updatedAt: at(1),
        pendingBackgroundTasks: input.roster ?? [],
      },
    ],
    providerTurns: [],
    runs: input.runs,
    attempts: [],
    nodes: [],
    subagents: input.subagents ?? [],
    messages: [],
    turnItems: input.turnItems ?? [],
  } as unknown as Mutable;
}

const ROSTER = [
  { taskId: "wf_1", kind: "workflow", description: "foundation build" },
  { taskId: "sh_1", kind: "command", description: "pnpm build" },
];

/** An in-memory store that applies what the sweep commits and dispatches. */
function world(
  entry: Mutable,
  options: {
    readonly live?: () => boolean;
    readonly sessionOpen?: boolean;
    readonly held?: () => boolean;
    readonly continueAfterRestart?: boolean;
    readonly workspace?: Record<string, unknown>;
    readonly sweeps?: number;
  } = {},
) {
  const dispatched: Array<Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }>> = [];
  const apply = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "provider-thread.updated":
        entry.providerThreads = entry.providerThreads.map((candidate) =>
          candidate.id === event.payload.id ? event.payload : candidate,
        );
        return;
      case "run.background-work-cancelled":
        entry.runs = entry.runs.map((candidate) =>
          candidate.id === event.payload.runId
            ? {
                ...candidate,
                restartCancelledBackgroundWork: event.payload.restartCancelledBackgroundWork,
              }
            : candidate,
        );
        return;
      default:
        return;
    }
  };
  const layer = Layer.mergeAll(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getRecoveryThreadIds: () => Effect.succeed([entry.thread.id]),
      getThreadRecords: (_threadId, fields, filter) =>
        Effect.succeed({
          thread: entry.thread,
          ...Object.fromEntries(
            fields.map((field) => {
              let value = entry[field as keyof Mutable] as ReadonlyArray<never>;
              if (field === "turnItems" && filter !== undefined) {
                value = (value as ReadonlyArray<Projection["turnItems"][number]>).filter(
                  (item) =>
                    (filter.turnItemRunIds === undefined ||
                      filter.turnItemRunIds.includes(item.runId as never)) &&
                    (filter.turnItemTypes === undefined ||
                      filter.turnItemTypes.includes(item.type)),
                ) as never;
              }
              if (field === "messages" && filter?.messageIds !== undefined) {
                value = (value as ReadonlyArray<Projection["messages"][number]>).filter((message) =>
                  filter.messageIds!.includes(message.id),
                ) as never;
              }
              return [field, value];
            }),
          ),
        } as never),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeedSome({
          projectId: PROJECT,
          deletedAt: null,
          workspaceSettings: options.workspace ?? {},
        } as never),
    }),
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      get: () =>
        Effect.succeed(
          options.sessionOpen === false
            ? Option.none()
            : Option.some({
                liveBackgroundWork: () => Effect.sync(() => options.live?.() ?? false),
              } as never),
        ),
    }),
    Layer.mock(EventSink.EventSinkV2)({
      commitCommand: (input) =>
        Effect.sync(() => {
          input.events.forEach(apply);
          return { committed: true, cancelledEffectCount: 0 } as never;
        }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: (command) =>
        Effect.sync(() => {
          if (command.type !== "message.dispatch") return undefined as never;
          dispatched.push(command);
          // The message exists and its run is now the thread's latest.
          entry.messages = [...entry.messages, { id: command.messageId } as never];
          entry.runs = [
            ...entry.runs,
            run(`wake_${entry.runs.length + 1}`, entry.runs.length + 1, "running", {
              userMessageId: command.messageId,
            }),
          ];
          return undefined as never;
        }),
    }),
    Settings.layerTest({ continueThreadsAfterServerUpdate: options.continueAfterRestart ?? true }),
    IdAllocator.layer,
    options.held === undefined
      ? Layer.empty
      : Layer.mock(ServiceUpdateHold.ServiceUpdateHold)({
          isHeld: Effect.sync(() => options.held!()),
          awaitReleased: Effect.void,
          current: Effect.succeedNone,
          installGated: Effect.succeed(false),
          recordRefusal: () => Effect.void,
        }),
  );
  const sweep = Effect.gen(function* () {
    yield* TestClock.setTime(NOW_MS);
    const sweeper = yield* make;
    const results: Array<{ cleared: number; woken: number }> = [];
    for (let index = 0; index < (options.sweeps ?? 3); index += 1) {
      results.push(yield* sweeper.sweep());
    }
    return results;
  }).pipe(Effect.provide(layer));
  return { entry, dispatched, sweep };
}

it.effect("starts one turn after a restart recorded the lost work on a settled run", () => {
  const { dispatched, sweep } = world(projection({ runs: [settled()] }));
  return Effect.gen(function* () {
    const results = yield* sweep;
    assert.deepEqual(
      results.map((result) => result.woken),
      [1, 0, 0],
    );
    assert.strictEqual(dispatched.length, 1);
    const [command] = dispatched;
    assert.strictEqual(command!.messageId, "message:restart-continuation:run_1");
    assert.strictEqual(command!.commandId, "command:lost-work-wake:run_1");
    assert.deepEqual(command!.dispatchMode, { type: "start_immediately" });
    assert.strictEqual(command!.creationSource, "server");
    assert.include(command!.text, "cut off before it reported back");
    assert.include(command!.text, "resumeFromRunId");
    // A plain message: the turn start prepends the recorded note to it.
    assert.isUndefined(command!.restartContinuationOfRunId);
  });
});

it.effect("clears a roster whose process is gone, records the loss and wakes the thread", () => {
  const { entry, dispatched, sweep } = world(
    projection({ runs: [run("run_1", 1, "completed")], roster: ROSTER }),
    { sessionOpen: false },
  );
  return Effect.gen(function* () {
    const results = yield* sweep;
    // The first sweep only suspects; the second clears and wakes.
    assert.deepEqual(results, [
      { cleared: 0, woken: 0 },
      { cleared: 1, woken: 1 },
      { cleared: 0, woken: 0 },
    ]);
    assert.deepEqual(entry.providerThreads[0]!.pendingBackgroundTasks, []);
    assert.deepEqual(
      entry.runs[0]!.restartCancelledBackgroundWork?.map((work) => [work.kind, work.id]),
      [
        ["task", "wf_1"],
        ["shell", "sh_1"],
      ],
    );
    assert.strictEqual(dispatched.length, 1);
    assert.strictEqual(dispatched[0]!.messageId, "message:restart-continuation:run_1");
  });
});

it.effect("leaves a roster alone while its process still runs the work", () => {
  const { entry, dispatched, sweep } = world(
    projection({ runs: [run("run_1", 1, "completed")], roster: ROSTER }),
    { live: () => true },
  );
  return Effect.gen(function* () {
    const results = yield* sweep;
    assert.isTrue(results.every((result) => result.cleared === 0 && result.woken === 0));
    assert.strictEqual(entry.providerThreads[0]!.pendingBackgroundTasks?.length, 2);
    assert.strictEqual(dispatched.length, 0);
  });
});

it.effect("leaves a roster alone while a turn is in progress on it", () => {
  const { entry, dispatched, sweep } = world(
    projection({ runs: [run("run_1", 1, "running")], roster: ROSTER }),
    { sessionOpen: false },
  );
  return Effect.gen(function* () {
    yield* sweep;
    assert.strictEqual(entry.providerThreads[0]!.pendingBackgroundTasks?.length, 2);
    assert.strictEqual(dispatched.length, 0);
  });
});

it.effect("clears the roster of work a person stopped without a note or a turn", () => {
  const { entry, dispatched, sweep } = world(
    projection({
      runs: [run("run_1", 1, "interrupted")],
      roster: ROSTER,
      turnItems: [
        {
          id: TurnItemId.make("stop_run_1"),
          runId: RunId.make("run_1"),
          type: "run_interrupt_request",
          cause: "user",
          message: "Stopped",
        },
      ],
    }),
    { sessionOpen: false },
  );
  return Effect.gen(function* () {
    const results = yield* sweep;
    assert.deepEqual(
      results.map((result) => result.cleared),
      [0, 1, 0],
    );
    assert.deepEqual(entry.providerThreads[0]!.pendingBackgroundTasks, []);
    assert.isUndefined(entry.runs[0]!.restartCancelledBackgroundWork);
    assert.strictEqual(dispatched.length, 0);
  });
});

it.effect("starts no turn when the project does not continue threads after a restart", () => {
  const { dispatched, sweep } = world(projection({ runs: [settled()] }), {
    continueAfterRestart: false,
  });
  return Effect.gen(function* () {
    yield* sweep;
    assert.strictEqual(dispatched.length, 0);
  });
});

it.effect("starts no turn in a paused or archived project", () =>
  Effect.gen(function* () {
    for (const workspace of [{ paused: true }, { archived: true }]) {
      const { dispatched, sweep } = world(projection({ runs: [settled()] }), { workspace });
      yield* sweep;
      assert.strictEqual(dispatched.length, 0);
    }
  }),
);

it.effect("does nothing while an update holds the service", () => {
  const { entry, dispatched, sweep } = world(projection({ runs: [settled()], roster: ROSTER }), {
    sessionOpen: false,
    held: () => true,
  });
  return Effect.gen(function* () {
    const results = yield* sweep;
    assert.isTrue(results.every((result) => result.cleared === 0 && result.woken === 0));
    assert.strictEqual(entry.providerThreads[0]!.pendingBackgroundTasks?.length, 2);
    assert.strictEqual(dispatched.length, 0);
  });
});

const PARENT = ThreadId.make("thread_parent");
const delegated = () =>
  thread({
    lineage: { parentThreadId: PARENT, relationshipToParent: "subagent", rootThreadId: PARENT },
  });
const task = (extra: Record<string, unknown> = {}) => ({
  childThreadId: THREAD,
  result: null,
  status: "running",
  runId: RunId.make("parent_run"),
  ...extra,
});

it.effect("wakes a delegated thread whose task its parent still waits on", () => {
  const { dispatched, sweep } = world(
    projection({ thread: delegated(), runs: [settled()], subagents: [task()] }),
  );
  return Effect.gen(function* () {
    yield* sweep;
    assert.strictEqual(dispatched.length, 1);
  });
});

it.effect("leaves a delegated thread whose task is over or whose parent was stopped", () =>
  Effect.gen(function* () {
    for (const extra of [
      { subagents: [] },
      { subagents: [task({ status: "completed", result: "done" })] },
      {
        subagents: [task()],
        turnItems: [
          {
            id: TurnItemId.make("stop_parent"),
            type: "run_interrupt_request",
            runId: RunId.make("parent_run"),
            cause: "user",
            message: "Stopped",
          },
        ],
      },
    ]) {
      const { dispatched, sweep } = world(
        projection({ thread: delegated(), runs: [settled()], ...extra }),
      );
      yield* sweep;
      assert.strictEqual(dispatched.length, 0);
    }
  }),
);

it.effect("keeps a roster while its open session reports live work", () => {
  const { entry, dispatched, sweep } = world(projection({ runs: [], roster: ROSTER }), {
    live: () => true,
  });
  return Effect.gen(function* () {
    const results = yield* sweep;
    assert.isTrue(results.every((result) => result.cleared === 0));
    assert.strictEqual(entry.providerThreads[0]!.pendingBackgroundTasks?.length, 2);
    assert.strictEqual(dispatched.length, 0);
  });
});

it.effect("leaves a roster whose session opened between the checks", () => {
  // Dead on the first two looks, alive on the look just before the commit.
  let looks = 0;
  const { entry, sweep } = world(projection({ runs: [], roster: ROSTER }), {
    live: () => (looks += 1) > 2,
    sweeps: 2,
  });
  return Effect.gen(function* () {
    const results = yield* sweep;
    assert.deepEqual(
      results.map((result) => result.cleared),
      [0, 0],
    );
    assert.strictEqual(entry.providerThreads[0]!.pendingBackgroundTasks?.length, 2);
  });
});
