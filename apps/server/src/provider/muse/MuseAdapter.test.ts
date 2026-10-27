import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk";
import {
  MessageId,
  NodeId,
  type OrchestrationV2TurnItem,
  ProjectId,
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
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import {
  type ProviderAdapterV2Event,
  ProviderAdapterV2RuntimePolicy,
} from "../../orchestration-v2/ProviderAdapter.ts";
import { makeAcpAdapterV2 } from "../../orchestration-v2/Adapters/AcpAdapterV2.ts";
import { museAdapterFlavor } from "../Drivers/MuseDriver.ts";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "studio-muse-adapter-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

/** The deterministic MSP fixture replaying a real Muse 1.4.13 turn, in its own directory. */
const fixtureDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "studio-muse-adapter-" });
  for (const [name, target] of [
    ["serve.cjs", "serve"],
    ["muse-1.4.13-turn.json", "muse-1.4.13-turn.json"],
  ] as const) {
    const source = yield* path.fromFileUrl(new URL(`./fixtures/${name}`, import.meta.url));
    yield* fs.copyFile(source, path.join(cwd, target));
  }
  return cwd;
});

describe("Muse turns in SpecWithCode threads", () => {
  it.live("project the reply and the command, and wait for the person's approval", () =>
    Effect.gen(function* () {
      const cwd = yield* fixtureDirectory;
      const instanceId = ProviderInstanceId.make("muse-adapter-test");
      const threadId = ThreadId.make("thread-muse-adapter-test");
      const adapter = makeAcpAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ServerConfig.ServerConfig,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: museAdapterFlavor(
          { enabled: true, binaryPath: process.execPath },
          { ...process.env, MUSE_TEST_FINGERPRINT: EXPECTED_SCHEMA_FINGERPRINT },
        ),
      });
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd,
      });
      const modelSelection = { instanceId, model: "muse-wonder-1.0" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("session-muse-adapter-test"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const suffix = `${threadId}:1`;
      yield* runtime.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make(`project:${threadId}`),
          title: "Muse acceptance",
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
          text: "recorded",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });

      const beforeApproval: ProviderAdapterV2Event[] = [
        ...(yield* runtime.events.pipe(
          Stream.takeUntil(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runCollect,
          Effect.timeout("30 seconds"),
        )),
      ];
      const pending = Option.fromNullishOr(beforeApproval.at(-1));
      if (Option.isNone(pending) || pending.value.type !== "runtime_request.updated")
        return yield* Effect.die("Muse approval never reached SpecWithCode");
      // The command must not have run while the person has not answered.
      const ranEarly = beforeApproval.some(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "command_execution" &&
          event.turnItem.status === "completed",
      );
      assert.isFalse(ranEarly);
      yield* runtime.respondToRuntimeRequest({
        requestId: pending.value.runtimeRequest.id,
        decision: "accept",
      });
      const afterApproval: ProviderAdapterV2Event[] = [
        ...(yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.timeout("30 seconds"),
        )),
      ];
      const events = [...beforeApproval, ...afterApproval];
      const items = new Map<string, OrchestrationV2TurnItem>();
      for (const event of events)
        if (event.type === "turn_item.updated") items.set(event.turnItem.id, event.turnItem);
      const assistant = [...items.values()].flatMap((item) =>
        item.type === "assistant_message" ? [item.text] : [],
      );
      assert.include(assistant.join("\n"), "MUSE_TURN_OK");
      assert.include(assistant.join("\n"), "MUSE_APPROVAL_OK");
      const command = [...items.values()].find((item) => item.type === "command_execution");
      assert.equal(command?.type, "command_execution");
      if (command?.type === "command_execution") {
        assert.equal(command.input, "echo MUSE_APPROVAL_OK");
        assert.include(command.output ?? "", "MUSE_APPROVAL_OK");
        assert.equal(command.exitCode, 0);
        assert.equal(command.status, "completed");
      }
      const terminal = events.at(-1);
      assert.equal(terminal?.type, "turn.terminal");
      if (terminal?.type === "turn.terminal") assert.equal(terminal.status, "completed");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
