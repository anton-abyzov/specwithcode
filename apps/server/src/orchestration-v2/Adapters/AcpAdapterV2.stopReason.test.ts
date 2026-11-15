import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
} from "./AcpAdapterV2.ts";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "studio-acp-stop-reason-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

/** The mock ACP agent, answering every prompt with `reply` and ending it normally. */
const mockRuntime =
  (
    childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    mockAgentPath: string,
    reply: string,
    env: Readonly<Record<string, string>> = {},
  ): AcpAdapterV2Flavor["makeRuntime"] =>
  (runtimeInput) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          ...runtimeInput,
          spawn: {
            command: process.execPath,
            args: [mockAgentPath],
            cwd: runtimeInput.cwd,
            env: {
              STUDIO_ACP_SESSION_LIFECYCLE: "1",
              STUDIO_ACP_PROMPT_RESPONSE_TEXT: reply,
              ...env,
            },
          },
          authMethodId: "test",
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          ),
        ),
      );
      return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
    });

/** Runs one turn whose reply is `reply` and returns its terminal and its error items. */
const runTurn = (
  name: string,
  reply: string,
  specweaveTool = "",
  env: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const instanceId = ProviderInstanceId.make(`acpRegistry_${name}`);
    const threadId = ThreadId.make(`thread-stop-reason-${name}`);
    const adapter = makeAcpAdapterV2({
      crypto: yield* Crypto.Crypto,
      instanceId,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* ServerConfig.ServerConfig,
      selfInvocation: yield* resolveSelfInvocation(),
      flavor: {
        driver: ProviderDriverKind.make("acpRegistry"),
        specweaveTool,
        capabilities: AcpProviderCapabilitiesV2,
        makeRuntime: mockRuntime(
          yield* ChildProcessSpawner.ChildProcessSpawner,
          yield* path.fromFileUrl(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url)),
          reply,
          env,
        ),
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
      providerSessionId: ProviderSessionId.make(`session-stop-reason-${name}`),
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
        title: "ACP stop reason",
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
        text: "Continue where you left off.",
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
    });
    const events = yield* runtime.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
    );
    const terminal = events.find((event) => event.type === "turn.terminal");
    if (terminal?.type !== "turn.terminal") return yield* Effect.die("Missing terminal");
    const replies = events.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
        ? [event.turnItem.text]
        : [],
    );
    return { terminal, reply: replies.at(-1) };
  });

describe("AcpAdapterV2 unfinished stop reasons", () => {
  it.live("fails a turn the agent refused and says so", () =>
    Effect.gen(function* () {
      const { terminal } = yield* runTurn("refusal", "I can't help with that.", "", {
        STUDIO_ACP_PROMPT_STOP_REASON: "refusal",
      });
      assert.equal(terminal.status, "failed");
      assert.equal(terminal.failure?.class, "provider_error");
      assert.equal(terminal.failure?.code, "refusal");
      assert.equal(
        terminal.failure?.message,
        "The agent refused this request. Its next turn won't include this message or its reply.",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("fails a turn that stopped at the output token limit", () =>
    Effect.gen(function* () {
      const { terminal } = yield* runTurn("max-tokens", "Partial answer", "", {
        STUDIO_ACP_PROMPT_STOP_REASON: "max_tokens",
      });
      assert.equal(terminal.status, "failed");
      assert.equal(terminal.failure?.code, "max_tokens");
      assert.equal(
        terminal.failure?.message,
        "The agent stopped because its reply reached the output token limit.",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("fails a turn that stopped at the agent's request limit", () =>
    Effect.gen(function* () {
      const { terminal } = yield* runTurn("max-turn-requests", "Still working", "", {
        STUDIO_ACP_PROMPT_STOP_REASON: "max_turn_requests",
      });
      assert.equal(terminal.status, "failed");
      assert.equal(terminal.failure?.code, "max_turn_requests");
      assert.equal(
        terminal.failure?.message,
        "The agent stopped because it reached its request limit for this turn.",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("completes a turn that ended normally", () =>
    Effect.gen(function* () {
      const { terminal } = yield* runTurn("end-turn", "Done.", "", {
        STUDIO_ACP_PROMPT_STOP_REASON: "end_turn",
      });
      assert.equal(terminal.status, "completed");
      assert.isNull(terminal.failure);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
