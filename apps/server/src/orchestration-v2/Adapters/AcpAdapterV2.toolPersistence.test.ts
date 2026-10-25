import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type * as EffectAcpSchema from "@specweave-studio/effect-acp/compat";
import {
  MessageId,
  NodeId,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import { resolveSelfInvocation } from "@specweave-studio/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { type ProviderAdapterV2Event, ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "./AcpAdapterV2.ts";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "studio-acp-tool-persistence-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

type SessionUpdateHandler = Parameters<
  AcpSessionRuntime.AcpSessionRuntime["Service"]["handleSessionUpdate"]
>[0];

/** Cumulative output after `count` streamed lines, as an agent resends it. */
const outputAfter = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

const streamedUpdate = (lines: number): EffectAcpSchema.SessionUpdate => ({
  sessionUpdate: "tool_call_update",
  toolCallId: "streamed-command",
  status: "in_progress",
  rawOutput: { stdout: outputAfter(lines) },
});

/**
 * Runs one ACP turn whose prompt calls `script` with the session update
 * handler, and returns every event up to the terminal plus the streamed
 * command's turn item updates.
 */
const runTurn = (
  name: string,
  script: (input: {
    readonly send: (update: EffectAcpSchema.SessionUpdate) => Effect.Effect<void>;
    readonly cancelled: Deferred.Deferred<void>;
    readonly ready: Deferred.Deferred<void>;
    /** How many tool items the session tracks for coalescing right now. */
    readonly tracked: () => number;
  }) => Effect.Effect<EffectAcpSchema.PromptResponse>,
  options: { readonly interruptWhenReady?: boolean } = {},
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const mockAgentPath = yield* path.fromFileUrl(
      new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
    );
    const cancelled = yield* Deferred.make<void>();
    const ready = yield* Deferred.make<void>();
    let handler: SessionUpdateHandler | undefined;
    let trackedCount: () => number = () => -1;
    const tracked = () => trackedCount();
    const instanceId = ProviderInstanceId.make(`acp-tool-persistence-${name}`);
    const threadId = ThreadId.make(`thread-acp-tool-persistence-${name}`);
    const adapter = makeAcpAdapterV2({
      crypto: yield* Crypto.Crypto,
      instanceId,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* ServerConfig.ServerConfig,
      selfInvocation: yield* resolveSelfInvocation(),
      testHooks: {
        onToolItemPersistTracking: (read) => {
          trackedCount = read;
        },
      },
      flavor: {
        driver: ProviderDriverKind.make("acp-test"),
        capabilities: AcpProviderCapabilitiesV2,
        makeRuntime: (runtimeInput) =>
          Effect.gen(function* () {
            const context = yield* Layer.build(
              AcpSessionRuntime.layer({
                ...runtimeInput,
                spawn: {
                  command: process.execPath,
                  args: [mockAgentPath],
                  cwd: runtimeInput.cwd,
                  env: { STUDIO_ACP_SESSION_LIFECYCLE: "1" },
                },
                authMethodId: "test",
              }).pipe(
                Layer.provide(
                  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
                ),
              ),
            );
            const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
              Effect.provide(context),
            );
            return {
              ...runtime,
              handleSessionUpdate: (next) =>
                Effect.sync(() => {
                  handler = next;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(next))),
              cancel: Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid),
              prompt: () =>
                Effect.gen(function* () {
                  if (handler === undefined) return yield* Effect.die("no update handler");
                  const registered = handler;
                  const send = (update: EffectAcpSchema.SessionUpdate) =>
                    registered({ sessionId: "mock-session-1", update }).pipe(Effect.orDie);
                  return yield* script({ send, cancelled, ready, tracked });
                }),
            };
          }),
      },
    });
    const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const modelSelection = { instanceId, model: "default" } as const;
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`session-acp-tool-persistence-${name}`),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const now = yield* DateTime.now;
    const suffix = `${threadId}:1`;
    yield* runtime.startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make(`project:${threadId}`),
        title: "ACP tool persistence",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make(`run:${suffix}`),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make(`attempt:${suffix}`),
      rootNodeId: NodeId.make(`node:${suffix}`),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`message:${suffix}`),
        text: "Run the command.",
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
    });
    const collected: Array<ProviderAdapterV2Event> = [];
    if (options.interruptWhenReady === true) {
      yield* Deferred.await(ready);
      collected.push(
        ...(yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "provider_turn.updated"),
          Stream.runCollect,
          Effect.timeout("30 seconds"),
        )),
      );
      const started = collected.findLast((event) => event.type === "provider_turn.updated");
      if (started?.type !== "provider_turn.updated") {
        return yield* Effect.die("turn has no provider turn");
      }
      yield* runtime.interruptTurn({ providerThread, providerTurnId: started.providerTurn.id });
    }
    collected.push(
      ...(yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.timeout("30 seconds"),
      )),
    );
    const events: ReadonlyArray<ProviderAdapterV2Event> = collected;
    const commandItems = events.flatMap((event): ReadonlyArray<OrchestrationV2TurnItem> =>
      event.type === "turn_item.updated" &&
      event.turnItem.nativeItemRef?.nativeId === "streamed-command"
        ? [event.turnItem]
        : [],
    );
    const commandNodes = events.filter(
      (event) =>
        event.type === "node.updated" && event.node.nativeItemRef?.nativeId === "streamed-command",
    );
    return { events, commandItems, commandNodes, tracked };
  });

const startCommand: EffectAcpSchema.SessionUpdate = {
  sessionUpdate: "tool_call",
  toolCallId: "streamed-command",
  title: "Run build",
  kind: "execute",
  status: "in_progress",
  rawInput: { command: "build" },
};

const commandOutput = (item: OrchestrationV2TurnItem | undefined) =>
  item?.type === "command_execution" ? item.output : undefined;

describe("AcpAdapterV2 tool update persistence", () => {
  it.effect("stores a burst of tool output updates once, ending on the last chunk", () =>
    Effect.gen(function* () {
      const chunks = 200;
      const { commandItems, commandNodes } = yield* runTurn("burst", ({ send }) =>
        Effect.gen(function* () {
          yield* send(startCommand);
          // The test clock stands still, so every chunk lands inside one interval.
          for (let lines = 1; lines <= chunks; lines += 1) yield* send(streamedUpdate(lines));
          yield* send({
            sessionUpdate: "tool_call_update",
            toolCallId: "streamed-command",
            status: "completed",
          });
          return { stopReason: "end_turn" as const };
        }),
      );
      // Start, the newest held chunk, then the completion: the other 199
      // progress chunks are never stored.
      assert.deepEqual(
        commandItems.map((item) => [item.status, commandOutput(item)]),
        [
          ["running", undefined],
          ["running", outputAfter(chunks)],
          ["completed", outputAfter(chunks)],
        ],
      );
      assert.isAtMost(commandNodes.length, commandItems.length);
      const final = commandItems.at(-1);
      assert.equal(commandOutput(final), outputAfter(chunks));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("stores held progress when the turn settles without ending the tool", () =>
    Effect.gen(function* () {
      const { commandItems } = yield* runTurn("settle", ({ send }) =>
        Effect.gen(function* () {
          yield* send(startCommand);
          for (let lines = 1; lines <= 50; lines += 1) yield* send(streamedUpdate(lines));
          return { stopReason: "end_turn" as const };
        }),
      );
      // The held chunk lands first, then the turn ends the tool.
      assert.deepEqual(
        commandItems.map((item) => [item.status, commandOutput(item)]),
        [
          ["running", undefined],
          ["running", outputAfter(50)],
          ["completed", outputAfter(50)],
        ],
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("stores held progress before an interrupted tool ends", () =>
    Effect.gen(function* () {
      const { commandItems } = yield* runTurn(
        "interrupt",
        ({ send, cancelled, ready }) =>
          Effect.gen(function* () {
            yield* send(startCommand);
            for (let lines = 1; lines <= 80; lines += 1) yield* send(streamedUpdate(lines));
            yield* Deferred.succeed(ready, undefined);
            yield* Deferred.await(cancelled);
            return { stopReason: "cancelled" as const };
          }),
        { interruptWhenReady: true },
      );
      assert.isAtMost(commandItems.length, 3);
      const final = commandItems.at(-1);
      assert.equal(final?.status, "interrupted");
      assert.equal(commandOutput(final), outputAfter(80));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("forgets a tool once it ends, and every tool of a settled turn", () =>
    Effect.gen(function* () {
      const during: Array<number> = [];
      const { commandItems, tracked } = yield* runTurn("prune", ({ send, tracked }) =>
        Effect.gen(function* () {
          yield* send({ ...startCommand, toolCallId: "finished-command" });
          yield* send({
            sessionUpdate: "tool_call_update",
            toolCallId: "finished-command",
            status: "in_progress",
            rawOutput: { stdout: outputAfter(3) },
          });
          yield* send(startCommand);
          for (let lines = 1; lines <= 20; lines += 1) yield* send(streamedUpdate(lines));
          during.push(tracked());
          yield* send({
            sessionUpdate: "tool_call_update",
            toolCallId: "finished-command",
            status: "completed",
          });
          // The ended tool is gone; the one still streaming stays.
          during.push(tracked());
          return { stopReason: "end_turn" as const };
        }),
      );
      assert.deepEqual(during, [2, 1]);
      // The settled turn stored the held chunk and ended the tool, then let go of it.
      assert.equal(commandOutput(commandItems.at(-1)), outputAfter(20));
      assert.equal(commandItems.at(-1)?.status, "completed");
      assert.equal(tracked(), 0);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("stores streamed progress a few times a second while a tool runs", () =>
    Effect.gen(function* () {
      const chunks = 40;
      const { commandItems } = yield* runTurn("live", ({ send }) =>
        Effect.gen(function* () {
          yield* send(startCommand);
          for (let lines = 1; lines <= chunks; lines += 1) {
            yield* send(streamedUpdate(lines));
            yield* Effect.sleep("25 millis");
          }
          yield* send({
            sessionUpdate: "tool_call_update",
            toolCallId: "streamed-command",
            status: "completed",
          });
          return { stopReason: "end_turn" as const };
        }),
      );
      const running = commandItems.filter((item) => item.status === "running");
      // About one second of output: start, a few interval flushes, completion.
      assert.isAtLeast(running.length, 3);
      assert.isAtMost(commandItems.length, 10);
      // Each stored snapshot is newer than the last.
      const lengths = running.map((item) => commandOutput(item)?.length ?? 0);
      assert.deepEqual(
        lengths,
        lengths.toSorted((left, right) => left - right),
      );
      assert.equal(commandOutput(commandItems.at(-1)), outputAfter(chunks));
      assert.equal(commandItems.at(-1)?.status, "completed");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
