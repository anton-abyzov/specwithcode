import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShellSnapshot,
  type OrchestrationV2TurnItem,
  type RuntimeMode,
} from "@specweave-studio/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as FullAccessApprovals from "./FullAccessApprovals.ts";
import { OrchestratorDispatchError } from "./Orchestrator.ts";
import * as ShellSnapshotCache from "./ShellSnapshotCache.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const coordinatorId = ThreadId.make("project-coordinator:full-access");
const workerId = ThreadId.make("thread:delegated-task:worker");
const claudeWorkerId = ThreadId.make("thread:delegated-task:claude-worker");
const nativeChildId = ThreadId.make("thread:provider-subagent:child");
const forkId = ThreadId.make("thread:person-fork");
const forkWorkerId = ThreadId.make("thread:delegated-task:fork-worker");
const grandWorkerId = ThreadId.make("thread:delegated-task:grand-worker");

type Lineage = {
  parentThreadId: ThreadId | null;
  relationshipToParent: "subagent" | "fork" | null;
};
const root: Lineage = { parentThreadId: null, relationshipToParent: null };
const childOf = (parentThreadId: ThreadId): Lineage => ({
  parentThreadId,
  relationshipToParent: "subagent",
});
const forkOf = (parentThreadId: ThreadId): Lineage => ({
  parentThreadId,
  relationshipToParent: "fork",
});

const thread = (
  runtimeMode: RuntimeMode,
  lineage: Lineage = root,
  creationSource: "provider" | "mcp" = "mcp",
  providerInstanceId = "codex",
) =>
  ({
    runtimeMode,
    lineage,
    creationSource,
    providerInstanceId,
    archivedAt: null,
    deletedAt: null,
  }) as unknown as OrchestrationV2AppThread;

const request = (
  id: string,
  kind: OrchestrationV2RuntimeRequest["kind"] = "command",
  status: OrchestrationV2RuntimeRequest["status"] = "pending",
) =>
  ({
    id,
    kind,
    status,
    responseCapability: { type: "live", providerSessionId: "provider-session:codex:shared" },
  }) as unknown as OrchestrationV2RuntimeRequest;

const elicitationItem = (requestId: string, decisions: ReadonlyArray<string>) =>
  ({
    type: "approval_request",
    requestId,
    requestKind: "mcp-elicitation",
    appName: "Linear",
    options: decisions.map((decision) => ({ decision, label: decision })),
  }) as unknown as OrchestrationV2TurnItem;

interface FakeThread {
  thread: OrchestrationV2AppThread;
  runtimeRequests: Array<OrchestrationV2RuntimeRequest>;
  subagents?: ReadonlyArray<{ childThreadId: ThreadId | null }>;
  turnItems?: ReadonlyArray<OrchestrationV2TurnItem>;
}

interface HarnessOptions {
  /** Answers that fail before one goes through. */
  readonly failAccepts?: number;
  /** Answers that fail for one prompt before one goes through. */
  readonly failAcceptsFor?: Readonly<Record<string, number>>;
  /** Wait before the second answer attempt. */
  readonly retryDelay?: number;
  /** A failed answer means the person got there first. */
  readonly answeredElsewhere?: boolean;
  readonly streamDomainEvents?: Stream.Stream<OrchestrationV2DomainEvent, never>;
  /** Serve shell snapshots through the shared cache, honouring `maxAgeMs`. */
  readonly sharedSnapshots?: boolean;
}

function harness(threads: Record<string, FakeThread>, options: HarnessOptions = {}) {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  let failuresLeft = options.failAccepts ?? 0;
  const failuresFor = new Map(Object.entries(options.failAcceptsFor ?? {}));
  let snapshots = 0;
  const firstSnapshot = Deferred.makeUnsafe<void>();
  const settledPrompts = new Map<string, Deferred.Deferred<void>>();
  const settledPrompt = (requestId: string) => {
    let settled = settledPrompts.get(requestId);
    if (settled === undefined) {
      settled = Deferred.makeUnsafe<void>();
      settledPrompts.set(requestId, settled);
    }
    return settled;
  };
  // The snapshot is taken before `firstSnapshot` fires, so a test that waits
  // on it knows what that read saw.
  const readSnapshot = () =>
    Effect.sync(() => {
      snapshots++;
      const snapshot = {
        schemaVersion: 1,
        snapshotSequence: 0,
        threads: Object.entries(threads).map(([id, fake]) => ({
          ...fake.thread,
          id,
          pendingRuntimeRequest:
            fake.runtimeRequests.find((candidate) => candidate.status === "pending") ?? null,
        })),
        archivedThreads: [],
      } as unknown as OrchestrationV2ThreadShellSnapshot;
      Deferred.doneUnsafe(firstSnapshot, Effect.void);
      return snapshot;
    });
  const sharedSnapshots = options.sharedSnapshots
    ? Effect.runSync(ShellSnapshotCache.make(readSnapshot))
    : undefined;
  const service = {
    getThreadRecords: (threadId: ThreadId) =>
      Effect.sync(() => ({
        runtimeRequests: [],
        subagents: [],
        turnItems: [],
        ...threads[threadId],
      })),
    getShellSnapshot: (options?: ShellSnapshotCache.ShellSnapshotCacheOptions) =>
      sharedSnapshots === undefined ? readSnapshot() : sharedSnapshots.get(options),
    dispatch: (command: OrchestrationV2ServerCommand) =>
      Effect.suspend(() => {
        dispatched.push(command);
        if (command.type === "thread.runtime-mode.set") {
          const fake = threads[command.threadId]!;
          fake.thread = { ...fake.thread, runtimeMode: command.runtimeMode };
          return Effect.succeed({});
        }
        if (command.type !== "runtime-request.respond") return Effect.succeed({});
        const fake = threads[command.threadId]!;
        const settle = () => {
          fake.runtimeRequests = fake.runtimeRequests.map((candidate) =>
            candidate.id === command.requestId ? { ...candidate, status: "resolved" } : candidate,
          );
          Deferred.doneUnsafe(settledPrompt(command.requestId), Effect.void);
        };
        const failsFor = failuresFor.get(command.requestId) ?? 0;
        if (failsFor > 0) failuresFor.set(command.requestId, failsFor - 1);
        if (failuresLeft > 0 || failsFor > 0 || options.answeredElsewhere) {
          if (failsFor === 0) failuresLeft--;
          if (options.answeredElsewhere) settle();
          return Effect.fail(
            new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: "runtime-request.respond",
              cause: "Provider session is restarting.",
            }),
          );
        }
        settle();
        return Effect.succeed({});
      }),
    streamDomainEvents: options.streamDomainEvents ?? Stream.empty,
  } as unknown as ThreadManagementService.ThreadManagementServiceShape;
  const layer = FullAccessApprovals.layerWith({
    retryDelay: options.retryDelay ?? 1,
    streamRestartDelay: 1,
    sweepInterval: "1 hour",
  }).pipe(Layer.provide(Layer.succeed(ThreadManagementService.ThreadManagementService, service)));
  const use = <A>(
    body: (reactor: FullAccessApprovals.FullAccessApprovals["Service"]) => Effect.Effect<A>,
  ) =>
    Effect.gen(function* () {
      return yield* body(yield* FullAccessApprovals.FullAccessApprovals);
    }).pipe(Effect.provide(layer));
  const process = (event: Partial<OrchestrationV2DomainEvent>) =>
    use((reactor) => reactor.process(event as OrchestrationV2DomainEvent));
  const accepted = () =>
    dispatched.flatMap((command) =>
      command.type === "runtime-request.respond"
        ? [[command.threadId, command.requestId as string] as [ThreadId, string]]
        : [],
    );
  return {
    dispatched,
    accepted,
    process,
    use,
    snapshots: () => snapshots,
    /** Counts a projection write, as `ProjectionStore.apply` does. */
    write: sharedSnapshots?.invalidate ?? Effect.void,
    firstSnapshot: Deferred.await(firstSnapshot),
    settled: (requestId: string) => Deferred.await(settledPrompt(requestId)),
  };
}

const pendingEvent = (threadId: ThreadId, payload: OrchestrationV2RuntimeRequest) =>
  ({ type: "runtime-request.updated", threadId, payload }) as Partial<OrchestrationV2DomainEvent>;

describe("FullAccessApprovals", () => {
  it("answers command, file, permission and confirm-only MCP prompts only", () => {
    for (const kind of [
      "command",
      "file-read",
      "file-change",
      "permission",
      "mcp-elicitation",
    ] as const)
      assert.isTrue(FullAccessApprovals.isFullAccessPrompt(request("r", kind)));
    for (const kind of ["user_input", "auth_refresh", "dynamic_tool_call"] as const)
      assert.isFalse(FullAccessApprovals.isFullAccessPrompt(request("r", kind)));
    assert.isFalse(FullAccessApprovals.isFullAccessPrompt(request("r", "command", "resolved")));
    const approval = (item: OrchestrationV2TurnItem) =>
      item as Extract<OrchestrationV2TurnItem, { type: "approval_request" }>;
    assert.isTrue(
      FullAccessApprovals.isConfirmOnlyElicitation(
        approval(elicitationItem("r", ["cancel", "decline", "accept"])),
      ),
    );
    assert.isFalse(
      FullAccessApprovals.isConfirmOnlyElicitation(
        approval(elicitationItem("r", ["cancel", "decline"])),
      ),
    );
    assert.isFalse(FullAccessApprovals.isConfirmOnlyElicitation(undefined));
  });

  it.effect("accepts a prompt that reaches a Full access thread from an older turn", () =>
    Effect.gen(function* () {
      const prompt = request("runtime-request:exec-1");
      const { dispatched, process } = harness({
        [workerId]: { thread: thread("full-access"), runtimeRequests: [prompt] },
      });
      yield* process(pendingEvent(workerId, prompt));
      assert.lengthOf(dispatched, 1);
      const [command] = dispatched as Array<
        Extract<OrchestrationV2ServerCommand, { type: "runtime-request.respond" }>
      >;
      assert.deepInclude(command, {
        type: "runtime-request.respond",
        threadId: workerId,
        requestId: "runtime-request:exec-1",
        decision: "accept",
      } as never);
      assert.match(command!.commandId, /^server:full-access-accept:runtime-request:exec-1:/);
    }),
  );

  it.effect("leaves prompts of a Supervised thread and questions to the person", () =>
    Effect.gen(function* () {
      const prompt = request("runtime-request:exec-2");
      const question = request("runtime-request:question", "user_input");
      const supervised = harness({
        [workerId]: { thread: thread("approval-required"), runtimeRequests: [prompt] },
      });
      yield* supervised.process(pendingEvent(workerId, prompt));
      yield* supervised.use((reactor) => reactor.sweep());
      assert.deepEqual(supervised.dispatched, []);
      const fullAccess = harness({
        [workerId]: { thread: thread("full-access"), runtimeRequests: [question] },
      });
      yield* fullAccess.process(pendingEvent(workerId, question));
      yield* fullAccess.use((reactor) => reactor.sweep());
      assert.deepEqual(fullAccess.dispatched, []);
    }),
  );

  it.effect("accepts a confirm-only MCP elicitation but not one that asks for data", () =>
    Effect.gen(function* () {
      const confirm = request("runtime-request:mcp-confirm", "mcp-elicitation");
      // Without Approve the elicitation asks for fields; it is left for the person.
      const noApprove = request("runtime-request:mcp-no-approve", "mcp-elicitation");
      // A question is never answered for the person.
      const form = request("runtime-request:mcp-form", "user_input");
      const { accepted, use } = harness({
        [workerId]: {
          thread: thread("full-access"),
          runtimeRequests: [confirm, noApprove, form],
          turnItems: [
            elicitationItem(confirm.id, ["cancel", "decline", "accept"]),
            elicitationItem(noApprove.id, ["cancel", "decline"]),
          ],
        },
      });
      yield* use((reactor) => reactor.sweep());
      assert.deepEqual(accepted(), [[workerId, "runtime-request:mcp-confirm"]]);
    }),
  );

  it.effect("accepts an MCP elicitation once its approval item lands after the request", () =>
    Effect.gen(function* () {
      const confirm = request("runtime-request:mcp-late-item", "mcp-elicitation");
      const worker: FakeThread = { thread: thread("full-access"), runtimeRequests: [confirm] };
      const { accepted, process } = harness({ [workerId]: worker });
      // Codex records the request before its approval item exists.
      yield* process(pendingEvent(workerId, confirm));
      assert.deepEqual(accepted(), []);
      const item = elicitationItem(confirm.id, ["cancel", "decline", "accept"]);
      worker.turnItems = [item];
      yield* process({
        type: "turn-item.updated",
        threadId: workerId,
        payload: item,
      } as Partial<OrchestrationV2DomainEvent>);
      assert.deepEqual(accepted(), [[workerId, "runtime-request:mcp-late-item"]]);
    }),
  );

  it.effect("raises the coordinator's app-owned workers and answers their prompts", () =>
    Effect.gen(function* () {
      const { dispatched, accepted, process } = harness({
        [coordinatorId]: {
          thread: thread("full-access"),
          runtimeRequests: [
            request("runtime-request:exec-3"),
            request("runtime-request:question", "user_input"),
          ],
          subagents: [{ childThreadId: nativeChildId }, { childThreadId: workerId }],
        },
        [nativeChildId]: {
          thread: thread("approval-required", childOf(coordinatorId), "provider"),
          runtimeRequests: [request("runtime-request:child-exec")],
        },
        [workerId]: {
          thread: thread("approval-required", childOf(coordinatorId), "mcp", "codex"),
          runtimeRequests: [request("runtime-request:worker-exec")],
        },
        [claudeWorkerId]: {
          thread: thread("approval-required", childOf(coordinatorId), "mcp", "claudeAgent"),
          runtimeRequests: [request("runtime-request:claude-worker-exec")],
        },
      });
      yield* process({
        type: "thread.runtime-mode-updated",
        threadId: coordinatorId,
        payload: thread("full-access"),
      } as Partial<OrchestrationV2DomainEvent>);
      assert.deepEqual(
        dispatched.flatMap((command) =>
          command.type === "thread.runtime-mode.set"
            ? [[command.threadId, command.runtimeMode, command.applyOnNextTurn]]
            : [],
        ),
        [
          [workerId, "full-access", true],
          [claudeWorkerId, "full-access", true],
        ],
      );
      assert.sameDeepMembers(accepted(), [
        [coordinatorId, "runtime-request:exec-3"],
        [nativeChildId, "runtime-request:child-exec"],
        [workerId, "runtime-request:worker-exec"],
        [claudeWorkerId, "runtime-request:claude-worker-exec"],
      ]);
    }),
  );

  it.effect("leaves a person's fork on its own mode when its parent is raised", () =>
    Effect.gen(function* () {
      const { dispatched, accepted, process, snapshots } = harness({
        [coordinatorId]: { thread: thread("full-access"), runtimeRequests: [] },
        [forkId]: {
          thread: thread("approval-required", forkOf(coordinatorId), "mcp"),
          runtimeRequests: [request("runtime-request:fork-exec")],
        },
        [forkWorkerId]: {
          thread: thread("approval-required", childOf(forkId), "mcp"),
          runtimeRequests: [request("runtime-request:fork-worker-exec")],
        },
        [workerId]: {
          thread: thread("approval-required", childOf(coordinatorId), "mcp", "codex"),
          runtimeRequests: [],
        },
        [grandWorkerId]: {
          thread: thread("approval-required", childOf(workerId), "mcp", "claudeAgent"),
          runtimeRequests: [request("runtime-request:grand-worker-exec")],
        },
      });
      yield* process({
        type: "thread.runtime-mode-updated",
        threadId: coordinatorId,
        payload: thread("full-access"),
      } as Partial<OrchestrationV2DomainEvent>);
      assert.deepEqual(
        dispatched.flatMap((command) =>
          command.type === "thread.runtime-mode.set" ? [command.threadId] : [],
        ),
        [workerId, grandWorkerId],
      );
      assert.deepEqual(accepted(), [[grandWorkerId, "runtime-request:grand-worker-exec"]]);
      assert.strictEqual(snapshots(), 1, "one shell snapshot covers every level");
    }),
  );

  it.effect("accepts what is pending on a thread created on Full access", () =>
    Effect.gen(function* () {
      const { accepted, process } = harness({
        [workerId]: {
          thread: thread("full-access", childOf(coordinatorId)),
          runtimeRequests: [request("runtime-request:early-exec")],
        },
      });
      yield* process({
        type: "thread.created",
        threadId: workerId,
        payload: thread("full-access", childOf(coordinatorId)),
      } as Partial<OrchestrationV2DomainEvent>);
      assert.deepEqual(accepted(), [[workerId, "runtime-request:early-exec"]]);
    }),
  );

  it.effect("answers a provider subagent's prompt by its parent's mode", () =>
    Effect.gen(function* () {
      const prompt = request("runtime-request:child-exec");
      const { dispatched, process } = harness({
        [coordinatorId]: { thread: thread("full-access"), runtimeRequests: [] },
        [nativeChildId]: {
          thread: thread("approval-required", childOf(coordinatorId), "provider"),
          runtimeRequests: [prompt],
        },
      });
      yield* process(pendingEvent(nativeChildId, prompt));
      assert.lengthOf(dispatched, 1);
    }),
  );

  it.effect("ignores a prompt the person already answered", () =>
    Effect.gen(function* () {
      const prompt = request("runtime-request:exec-4");
      const { dispatched, process } = harness(
        { [workerId]: { thread: thread("full-access"), runtimeRequests: [prompt] } },
        { answeredElsewhere: true },
      );
      yield* process(pendingEvent(workerId, prompt));
      assert.lengthOf(dispatched, 1);
    }),
  );

  it.live("retries a failed answer while the prompt is still pending", () =>
    Effect.gen(function* () {
      const prompt = request("runtime-request:exec-5");
      const { dispatched, accepted, process } = harness(
        { [workerId]: { thread: thread("full-access"), runtimeRequests: [prompt] } },
        { failAccepts: 2 },
      );
      yield* process(pendingEvent(workerId, prompt));
      assert.lengthOf(accepted(), 3);
      const ids = dispatched.map((command) => (command as { commandId: CommandId }).commandId);
      assert.lengthOf(new Set(ids), 3, "each attempt uses its own command ID");
    }),
  );

  it.effect("retries in the background without holding up the next event", () =>
    Effect.gen(function* () {
      const slow = request("runtime-request:slow");
      const next = request("runtime-request:next");
      const fakes: Record<string, FakeThread> = {
        [workerId]: { thread: thread("full-access"), runtimeRequests: [] },
        [claudeWorkerId]: { thread: thread("full-access"), runtimeRequests: [] },
      };
      const { accepted, use, firstSnapshot, settled } = harness(fakes, {
        failAcceptsFor: { [slow.id]: 1 },
        retryDelay: 1000,
        streamDomainEvents: Stream.never,
      });
      yield* use((reactor) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* reactor.start();
            // The start sweep has looked and found nothing pending.
            yield* firstSnapshot;
            fakes[workerId]!.runtimeRequests = [slow];
            fakes[claudeWorkerId]!.runtimeRequests = [next];
            yield* reactor.process(pendingEvent(workerId, slow) as OrchestrationV2DomainEvent);
            yield* reactor.process(
              pendingEvent(claudeWorkerId, next) as OrchestrationV2DomainEvent,
            );
            assert.deepEqual(accepted(), [
              [workerId, slow.id],
              [claudeWorkerId, next.id],
            ]);
            assert.strictEqual(fakes[workerId]!.runtimeRequests[0]!.status, "pending");
            // A sweep while the retry waits does not answer the prompt twice.
            yield* reactor.sweep();
            assert.lengthOf(accepted(), 2);
            yield* TestClock.adjust(1000);
            yield* settled(slow.id);
            assert.deepEqual(accepted(), [
              [workerId, slow.id],
              [claudeWorkerId, next.id],
              [workerId, slow.id],
            ]);
          }),
        ),
      );
    }),
  );

  it.live("answers prompts left pending before the start", () =>
    Effect.gen(function* () {
      const { accepted, use } = harness({
        [workerId]: {
          thread: thread("full-access"),
          runtimeRequests: [request("runtime-request:before-restart")],
        },
        [claudeWorkerId]: {
          thread: thread("approval-required"),
          runtimeRequests: [request("runtime-request:supervised")],
        },
      });
      yield* use((reactor) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* reactor.start();
            yield* Effect.sleep(50);
          }),
        ),
      );
      assert.deepEqual(accepted(), [[workerId, "runtime-request:before-restart"]]);
    }),
  );

  it.effect("catches up after a stream gap without reusing a snapshot from before it", () =>
    Effect.gen(function* () {
      const prompt = request("runtime-request:during-gap");
      const fakes: Record<string, FakeThread> = {
        [workerId]: { thread: thread("full-access"), runtimeRequests: [] },
      };
      let opened = 0;
      const { accepted, use, firstSnapshot, settled, write } = harness(fakes, {
        sharedSnapshots: true,
        // The first stream ends at once; the reopened one carries no events.
        streamDomainEvents: Stream.suspend(() => (++opened === 1 ? Stream.empty : Stream.never)),
      });
      yield* use((reactor) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* reactor.start();
            // The start sweep shares a snapshot taken before the prompt.
            yield* firstSnapshot;
            fakes[workerId]!.runtimeRequests = [prompt];
            yield* write;
            // Past the restart delay, well inside the sweeps' shared age.
            yield* TestClock.adjust(1);
            yield* settled(prompt.id);
            assert.deepEqual(accepted(), [[workerId, prompt.id]]);
          }),
        ),
      );
    }),
  );

  it.live("reopens the event stream after it fails", () =>
    Effect.gen(function* () {
      const prompt = request("runtime-request:after-reopen");
      let opened = 0;
      const fakes: Record<string, FakeThread> = {
        [workerId]: { thread: thread("full-access"), runtimeRequests: [] },
      };
      const { accepted, use } = harness(fakes, {
        streamDomainEvents: Stream.suspend(() => {
          opened++;
          if (opened === 1) return Stream.die("stream closed");
          fakes[workerId]!.runtimeRequests = [prompt];
          return Stream.make(pendingEvent(workerId, prompt) as OrchestrationV2DomainEvent).pipe(
            Stream.concat(Stream.never),
          );
        }),
      });
      yield* use((reactor) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* reactor.start();
            yield* Effect.sleep(80);
          }),
        ),
      );
      assert.isAtLeast(opened, 2);
      assert.deepEqual(accepted(), [[workerId, "runtime-request:after-reopen"]]);
    }),
  );
});
