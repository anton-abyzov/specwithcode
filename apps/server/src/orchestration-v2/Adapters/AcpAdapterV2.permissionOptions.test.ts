import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  type ProviderApprovalDecision,
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
  ServerConfig.layerTest(process.cwd(), { prefix: "studio-acp-permission-options-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

/** The mock ACP agent, answering every prompt with `reply`. */
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

/** Runs one turn, answers every approval it raises with `decision`, and returns its terminal. */
const runTurn = (
  name: string,
  decision: ProviderApprovalDecision,
  env: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const instanceId = ProviderInstanceId.make(`acpRegistry_${name}`);
    const threadId = ThreadId.make(`thread-permission-options-${name}`);
    const adapter = makeAcpAdapterV2({
      crypto: yield* Crypto.Crypto,
      instanceId,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* ServerConfig.ServerConfig,
      selfInvocation: yield* resolveSelfInvocation(),
      flavor: {
        driver: ProviderDriverKind.make("acpRegistry"),
        capabilities: AcpProviderCapabilitiesV2,
        makeRuntime: mockRuntime(
          yield* ChildProcessSpawner.ChildProcessSpawner,
          yield* path.fromFileUrl(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url)),
          "Read it.",
          env,
        ),
      },
    });
    const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "approval-required",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const modelSelection = { instanceId, model: "default" } as const;
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`session-permission-options-${name}`),
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
        title: "ACP permission options",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "approval-required",
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
      Stream.tap((event) =>
        event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending"
          ? runtime
              .respondToRuntimeRequest({ requestId: event.runtimeRequest.id, decision })
              .pipe(Effect.forkScoped, Effect.asVoid)
          : Effect.void,
      ),
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

describe("AcpAdapterV2 permission options", () => {
  it.live("approves once and continues when Always allow meets an agent without that option", () =>
    Effect.gen(function* () {
      const { terminal, reply } = yield* runTurn("only-allow-once", "acceptForSession", {
        STUDIO_ACP_EMIT_TOOL_CALLS: "1",
        STUDIO_ACP_OMIT_ALLOW_ALWAYS: "1",
      });
      assert.equal(terminal.status, "completed");
      assert.equal(reply, "Read it.");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("answers Always allow with the agent's allow-always option when it has one", () =>
    Effect.gen(function* () {
      const { terminal } = yield* runTurn("allow-always", "acceptForSession", {
        STUDIO_ACP_EMIT_TOOL_CALLS: "1",
      });
      assert.equal(terminal.status, "completed");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
