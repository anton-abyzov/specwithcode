import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AcpRegistrySettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import { resolveSelfInvocation } from "@specweave-studio/shared/nodeRuntime";
import { AcpRequestError } from "@specweave-studio/effect-acp/errors";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../../config.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import * as IdAllocator from "../IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import { makeAcpRegistryAdapterV2 } from "./AcpRegistryAdapterV2.ts";
import type { AcpAdapterV2RuntimeInput } from "./AcpAdapterV2.ts";

const layer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "studio-copilot-startup-adapter-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(layer), Effect.scoped);
const selected = "claude-opus-5.5";

const fixture = Effect.fn("startupRegistryAdapterFixture")(function* (
  scenario: string,
  otherAgent = false,
  captureRuntimeInputs = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "startup-registry-child-" });
  const log = path.join(cwd, "wire.jsonl");
  yield* fs.writeFileString(log, "");
  const script = yield* path.fromFileUrl(
    new URL("../../provider/acp/testing/copilot-acp.fixture.mjs", import.meta.url),
  );
  const agentId = otherAgent ? "other-agent" : "github-copilot-cli";
  const instanceId = ProviderInstanceId.make(`startup-${agentId}`);
  const threadId = ThreadId.make(`thread-${agentId}`);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runtimeInputs: AcpAdapterV2RuntimeInput[] = [];
  const adapter = makeAcpRegistryAdapterV2({
    instanceId,
    settings: Schema.decodeSync(AcpRegistrySettings)({ agentId }),
    environment: {},
    childProcessSpawner: spawner,
    crypto: yield* Crypto.Crypto,
    selfInvocation: yield* resolveSelfInvocation(),
    fileSystem: fs,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    serverConfig: yield* ServerConfig.ServerConfig,
    ...(captureRuntimeInputs
      ? {
          // This lane isolates the generic adapter's restart plumbing. Process-level
          // startup capability/argv/confirmation are exercised by the other tests.
          makeRuntime: (input: AcpAdapterV2RuntimeInput) =>
            Effect.gen(function* () {
              runtimeInputs.push(input);
              const context = yield* Layer.build(
                AcpSessionRuntime.layer({
                  ...input,
                  spawn: {
                    command: process.execPath,
                    args: [script],
                    cwd,
                    env: { COPILOT_FIXTURE_SCENARIO: scenario, COPILOT_FIXTURE_LOG: log },
                  },
                }).pipe(
                  Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
                ),
              );
              return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
                Effect.provide(context),
              );
            }),
        }
      : {}),
    resolver: {
      resolve: () =>
        Effect.succeed({
          agent: {
            id: agentId,
            name: otherAgent ? "Other" : "Copilot",
            version: "1.0.97",
            description: "Fixture",
            distribution: {
              npx: { package: otherAgent ? "other-agent@1.0.97" : "@github/copilot@1.0.97" },
            },
          },
          distribution: "npx" as const,
          spawn: {
            command: process.execPath,
            args: [script, "--no-auto-update", "--acp", "--stdio"],
            cwd,
            env: {
              COPILOT_FIXTURE_SCENARIO: scenario,
              COPILOT_FIXTURE_LOG: log,
              COPILOT_FIXTURE_RECORD_LAUNCH: "1",
              ...(otherAgent ? { COPILOT_FIXTURE_AGENT_NAME: "Other" } : {}),
            },
          },
        }),
    },
  });
  const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "approval-required",
    interactionMode: "default",
    cwd,
  });
  return {
    adapter,
    instanceId,
    threadId,
    runtimePolicy,
    runtimeInputs,
    input: {
      threadId,
      providerSessionId: ProviderSessionId.make(`session-${agentId}`),
      modelSelection: { instanceId, model: selected },
      runtimePolicy,
    },
    messages: fs.readFileString(log).pipe(
      Effect.map((text) =>
        text
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      ),
    ),
  };
});

describe("registry Copilot startup model integration", () => {
  it.effect(
    "passes the selection through the adapter before initialize and explicitly resets default",
    () =>
      scoped(
        Effect.gen(function* () {
          const test = yield* fixture("startup-model");
          const runtime = yield* test.adapter.openSession(test.input);
          const providerThread = yield* runtime.ensureThread(test.input);
          const before = yield* test.messages;
          expect(before[2].args).toContain(`--model=${selected}`);
          expect(before.filter((frame) => frame.method === "session/set_model")).toEqual([]);
          const now = yield* DateTime.now;
          const selection = { instanceId: test.instanceId, model: "default" };
          const turn: ProviderAdapterV2TurnInput = {
            appThread: {
              createdBy: "user",
              creationSource: "web",
              id: test.threadId,
              projectId: ProjectId.make("startup-project"),
              title: "Fixture",
              providerInstanceId: test.instanceId,
              modelSelection: selection,
              runtimeMode: "approval-required",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: providerThread.id,
              lineage: {
                parentThreadId: null,
                relationshipToParent: null,
                rootThreadId: test.threadId,
              },
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
            threadId: test.threadId,
            runId: RunId.make("startup-run"),
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: RunAttemptId.make("startup-attempt"),
            rootNodeId: NodeId.make("startup-node"),
            providerThread,
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: MessageId.make("startup-message"),
              text: "Fixture only",
              attachments: [],
            },
            modelSelection: selection,
            runtimePolicy: test.runtimePolicy,
          };
          yield* runtime.startTurn(turn);
          yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runDrain,
          );
          expect(
            (yield* test.messages).filter((frame) => frame.method === "session/set_model"),
          ).toMatchObject([{ params: { modelId: "auto" } }]);
          const back = yield* runtime
            .startTurn({
              ...turn,
              runId: RunId.make("startup-run-2"),
              runOrdinal: 2,
              providerTurnOrdinal: 2,
              modelSelection: test.input.modelSelection,
            })
            .pipe(Effect.result);
          expect(back._tag).toBe("Failure");
          expect(
            (yield* test.messages)
              .filter((frame) => frame.method === "session/set_model")
              .map((frame) => frame.params.modelId),
          ).toEqual(["auto", selected]);
          expect(
            (yield* test.messages).filter((frame) => frame.method === "session/prompt"),
          ).toHaveLength(1);
        }),
      ),
  );

  it.effect("rejects a native auto fallback while opening the adapter", () =>
    scoped(
      Effect.gen(function* () {
        const test = yield* fixture("startup-auto");
        expect((yield* test.adapter.openSession(test.input).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        const methods = (yield* test.messages).map((frame) => frame.method);
        expect(methods).not.toContain("session/prompt");
        expect(methods).not.toContain("session/set_model");
      }),
    ),
  );

  it.effect("loads an existing native session without seeding or bypassing its model setter", () =>
    scoped(
      Effect.gen(function* () {
        const test = yield* fixture("startup-model");
        const result = yield* test.adapter
          .openSession({
            ...test.input,
            initialNativeThreadId: "existing-native-session",
          })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        const frames = yield* test.messages;
        expect(frames.filter((frame) => frame.method === "process/launch")).toHaveLength(1);
        expect(frames[0].args.some((arg: string) => arg.startsWith("--model="))).toBe(false);
        expect(frames.filter((frame) => frame.method === "session/load")).toMatchObject([
          { params: { sessionId: "existing-native-session" } },
        ]);
        expect(frames.filter((frame) => frame.method === "session/set_model")).toMatchObject([
          { params: { modelId: selected } },
        ]);
        expect(
          frames.some(
            (frame) => frame.method === "session/new" || frame.method === "session/prompt",
          ),
        ).toBe(false);
      }),
    ),
  );

  it.effect("preserves another registry provider's launch and native model setter", () =>
    scoped(
      Effect.gen(function* () {
        const test = yield* fixture("legacy", true);
        yield* test.adapter.openSession(test.input);
        const frames = yield* test.messages;
        expect(frames.filter((frame) => frame.method === "process/launch")).toHaveLength(1);
        expect(frames[0].args.some((arg: string) => arg.startsWith("--model="))).toBe(false);
        expect(frames.filter((frame) => frame.method === "session/set_model")).toMatchObject([
          { params: { modelId: selected } },
        ]);
      }),
    ),
  );

  it.effect("passes the latest resumed selection into a replacement runtime", () =>
    scoped(
      Effect.gen(function* () {
        const test = yield* fixture("legacy", false, true);
        const runtime = yield* test.adapter.openSession(test.input);
        const providerThread = yield* runtime.ensureThread(test.input);
        expect(test.runtimeInputs.map((input) => input.modelSelection?.model)).toEqual([selected]);
        yield* test.runtimeInputs[0]!.onTermination(
          new AcpRequestError({
            code: -32000,
            errorMessage: "Fixture transport termination",
          }),
        );
        yield* runtime.resumeThread({
          providerThread,
          modelSelection: { instanceId: test.instanceId, model: "grok-4.7" },
          runtimePolicy: test.runtimePolicy,
        });
        expect(test.runtimeInputs.map((input) => input.modelSelection?.model)).toEqual([
          selected,
          "grok-4.7",
        ]);
        const frames = yield* test.messages;
        expect(frames.filter((frame) => frame.method === "session/load")).toHaveLength(1);
        expect(frames.filter((frame) => frame.method === "session/set_model").at(-1)).toMatchObject(
          {
            params: { modelId: "grok-4.7" },
          },
        );
      }),
    ),
  );
});
