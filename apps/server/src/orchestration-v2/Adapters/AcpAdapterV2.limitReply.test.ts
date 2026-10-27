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
import { acpRegistryPromptFailure } from "./AcpRegistryAdapterV2.ts";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "studio-acp-limit-reply-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

const COPILOT_QUOTA_REPLY =
  "Error: You have exceeded your monthly quota (Request ID: E1F2:3A4B:5C6D:7E8F:9A0B1C2D)";

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
  specweaveTool = "copilot",
  env: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const instanceId = ProviderInstanceId.make(`acpRegistry_${name}`);
    const threadId = ThreadId.make(`thread-limit-reply-${name}`);
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
        promptFailure: (cause) => acpRegistryPromptFailure("copilot", cause),
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
      providerSessionId: ProviderSessionId.make(`session-limit-reply-${name}`),
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
        title: "ACP limit reply",
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

describe("AcpAdapterV2 limit replies", () => {
  it.live("fails a turn whose only reply is Copilot's monthly quota notice", () =>
    Effect.gen(function* () {
      const { terminal, reply } = yield* runTurn("copilot-quota", COPILOT_QUOTA_REPLY);
      // The agent's text stays in the conversation; the run stops on the limit.
      assert.equal(reply, COPILOT_QUOTA_REPLY);
      assert.equal(terminal.status, "failed");
      assert.deepStrictEqual(
        { ...terminal.failure, resetAt: undefined },
        {
          class: "usage_limit",
          message: "Monthly quota used up on this provider.",
          code: null,
          retryable: null,
          resetAt: undefined,
        },
      );
      // A monthly quota resets at 00:00 UTC on the 1st of next month.
      assert.match(terminal.failure?.resetAt ?? "", /^\d{4}-\d{2}-01T00:00:00\.000Z$/);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("names no reset for another agent's monthly quota notice", () =>
    Effect.gen(function* () {
      const { terminal } = yield* runTurn("other-quota", COPILOT_QUOTA_REPLY, "");
      assert.equal(terminal.status, "failed");
      assert.equal(terminal.failure?.class, "usage_limit");
      // Its monthly cycle need not be the calendar month: the usual hold applies.
      assert.isNull(terminal.failure?.resetAt ?? null);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("completes a turn whose reply only talks about quotas", () =>
    Effect.gen(function* () {
      const { terminal } = yield* runTurn(
        "quota-answer",
        "Your Copilot monthly quota resets on the 1st; until then GPT-6.1 Sol requests are billed as premium.",
      );
      assert.equal(terminal.status, "completed");
      assert.isNull(terminal.failure);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("fails a turn that ran tools and then ended on Copilot's quota notice", () =>
    Effect.gen(function* () {
      const { terminal } = yield* runTurn("copilot-quota-worked", COPILOT_QUOTA_REPLY, "copilot", {
        STUDIO_ACP_EMIT_TOOL_CALLS: "1",
      });
      assert.equal(terminal.status, "failed");
      assert.equal(terminal.failure?.class, "usage_limit");
      assert.equal(terminal.failure?.message, "Monthly quota used up on this provider.");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("completes a turn that ran tools and answered normally", () =>
    Effect.gen(function* () {
      const { terminal } = yield* runTurn("copilot-worked", "Done.", "copilot", {
        STUDIO_ACP_EMIT_TOOL_CALLS: "1",
      });
      assert.equal(terminal.status, "completed");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("fails a prompt Copilot rejects with its quota notice as a usage limit", () =>
    Effect.gen(function* () {
      const { terminal } = yield* runTurn("copilot-quota-error", "unused", "copilot", {
        STUDIO_ACP_FAIL_PROMPT: "1",
        STUDIO_ACP_FAIL_PROMPT_MESSAGE:
          "You have exceeded your monthly quota (Request ID: E734:3158CA:51F2541)",
      });
      assert.equal(terminal.status, "failed");
      assert.equal(terminal.failure?.class, "usage_limit");
      assert.match(terminal.failure?.resetAt ?? "", /^\d{4}-\d{2}-01T00:00:00\.000Z$/);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("keeps any other prompt error a provider error", () =>
    Effect.gen(function* () {
      const { terminal } = yield* runTurn("copilot-other-error", "unused", "copilot", {
        STUDIO_ACP_FAIL_PROMPT: "1",
      });
      assert.equal(terminal.status, "failed");
      assert.equal(terminal.failure?.class, "provider_error");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
