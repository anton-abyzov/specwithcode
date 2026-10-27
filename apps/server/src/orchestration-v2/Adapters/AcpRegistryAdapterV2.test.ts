import { providerFailureFallbackMessage } from "@specweave-studio/shared/orchestrationV2ThreadError";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
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
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as EffectAcpErrors from "@specweave-studio/effect-acp/errors";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  normalizeAcpRegistryCommands,
  type AcpRegistryAvailableCommands,
  type AcpRegistryLiveConfiguration,
} from "../../provider/acp/AcpRegistryProbe.ts";
import * as AcpRegistrySupport from "../../provider/acp/AcpRegistrySupport.ts";
import { ACP_SESSION_MODE_OPTION_ID } from "../../provider/acp/AcpSessionConfig.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import * as IdAllocator from "../IdAllocator.ts";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";
import { ProviderAdapterV2RuntimePolicy, providerSetupFailure } from "../ProviderAdapter.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import { BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2 } from "../builtInProviderAdapterDrivers.ts";
import {
  ACP_REGISTRY_PROVIDER,
  AcpRegistryAdapterV2Driver,
  makeAcpRegistryAdapterV2,
  acpRegistryPromptFailure,
  specweaveToolForAcpAgent,
  type AcpRegistryAdapterV2Options,
} from "./AcpRegistryAdapterV2.ts";

const registryUrl = "https://registry.test/registry.json";
const decodeAcpRegistryAdapterSettings = Schema.decodeUnknownEffect(
  AcpRegistryAdapterV2Driver.configSchema,
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "studio-acp-registry-v2-adapter-",
}).pipe(Layer.provide(NodeServices.layer));

const layerRegistry = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          version: "1.0.0",
          agents: [
            {
              id: "fixture-agent",
              name: "Fixture Agent",
              version: "1.0.0",
              description: "ACP V2 adapter fixture",
              distribution: {
                binary: {
                  "darwin-aarch64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                  "linux-x86_64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                  "windows-x86_64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent.exe",
                    args: [],
                  },
                },
              },
            },
          ],
        }),
      ),
    ),
  ),
);

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  layerServerConfig,
  layerRegistry,
  ServerSettings.layerTest(),
);

describe("AcpRegistryAdapterV2", () => {
  it("preserves and sanitizes structured ACP errors without exposing arbitrary defects", () => {
    const limit = new EffectAcpErrors.AcpRequestError({
      code: -31001,
      errorMessage: "Rate limit exceeded for mistral (model: mistral-vibe-cli-latest).",
    });
    assert.deepEqual(acpRegistryPromptFailure("mistral-vibe", limit), {
      class: "usage_limit",
      message: limit.errorMessage,
      code: "-31001",
      retryable: null,
    });
    assert.equal(acpRegistryPromptFailure("other-agent", limit).class, "provider_error");
    assert.equal(
      acpRegistryPromptFailure("mistral-vibe", new Error("private defect")).message,
      providerFailureFallbackMessage("provider_error"),
    );
    const rejected = acpRegistryPromptFailure(
      "any-agent",
      new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Request rejected. api_key=private-key https://example.test/?token=secret",
      }),
    );
    assert.include(rejected.message, "Request rejected.");
    assert.notInclude(rejected.message, "private-key");
    assert.notInclude(rejected.message, "token=secret");
  });
  it("is registered as a generic provider driver with schema defaults", () => {
    assert.isTrue(BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2.has(ACP_REGISTRY_PROVIDER));
    assert.equal(AcpRegistryAdapterV2Driver.driverKind, ACP_REGISTRY_PROVIDER);
    assert.deepEqual(AcpRegistryAdapterV2Driver.defaultConfig(), {
      source: "registry",
      commandArgs: [],
      enabled: true,
      agentId: "",
      commandPath: "",
      authMethodId: "",
      distribution: "auto",
      customModels: [],
    });
  });

  describe("the agent's own mode picker", () => {
    type Frame = Record<string, unknown>;
    const outbound = (method: string, params: unknown = "<any>"): Frame => ({
      type: "expect_outbound",
      frame: { kind: "request", method, params },
    });
    const answer = (method: string, result: unknown): Frame => ({
      type: "emit_inbound",
      frame: { kind: "response", method, result },
    });
    const permissionModeOption = (currentValue: string) => ({
      id: "permission-mode",
      name: "Permission mode",
      category: "mode",
      type: "select",
      currentValue,
      options: ["ask", "auto"].map((value) => ({ value, name: value })),
    });

    // A scripted ACP v1 agent: initialize, session/new answered with `setup`,
    // then the frames Studio must send (and the agent's answers) to apply the
    // user's stored pick from the agent's mode picker.
    const openWithStoredModePick = Effect.fn("openWithStoredModePick")(function* (input: {
      readonly setup: unknown;
      readonly modeFrames: ReadonlyArray<Frame>;
      readonly storedModePick?: string;
      readonly storedModelPick?: string;
      readonly agentName?: string;
    }) {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const replayDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "studio-acp-registry-mode-pick-",
      });
      const statusPath = path.join(replayDir, "status.json");
      const transcript = yield* decodeAcpReplayTranscript(
        {
          provider: ACP_REGISTRY_PROVIDER,
          protocol: "acp.ndjson-jsonrpc",
          version: "1",
          scenario: "stored-mode-pick",
          entries: [
            outbound("initialize"),
            answer("initialize", {
              protocolVersion: 1,
              agentCapabilities: { loadSession: false },
              authMethods: [{ id: "test", name: "Test" }],
              ...(input.agentName === undefined
                ? {}
                : { agentInfo: { name: input.agentName, version: "1" } }),
            }),
            outbound("session/new"),
            answer("session/new", { sessionId: "agent-session", ...(input.setup as object) }),
            ...input.modeFrames,
          ] as never,
        },
        ACP_REGISTRY_PROVIDER,
      );
      const instanceId = ProviderInstanceId.make("acp-registry-mode-pick");
      const adapter = makeAcpRegistryAdapterV2({
        crypto: yield* Crypto.Crypto,
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({
          agentId: "fixture-agent",
          authMethodId: "test",
        }),
        environment: {},
        childProcessSpawner,
        fileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        resolver: { resolve: () => Effect.die("the runtime is injected") },
        serverConfig: yield* ServerConfig.ServerConfig,
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          scriptPath: yield* path.fromFileUrl(
            new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
          ),
          childProcessSpawner,
          fileSystem,
        }),
      });
      yield* adapter
        .openSession({
          threadId: ThreadId.make("thread-acp-registry-mode-pick"),
          providerSessionId: ProviderSessionId.make("provider-session-mode-pick"),
          modelSelection: {
            instanceId,
            model: input.storedModelPick ?? "default",
            options:
              input.storedModePick === undefined
                ? []
                : [{ id: ACP_SESSION_MODE_OPTION_ID, value: input.storedModePick }],
          },
          runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: replayDir,
          }),
        })
        .pipe(Effect.scoped);
      // Closing the session stops the agent, which writes its replay status in
      // the same tick as its last answer. The script must be consumed exactly.
      yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript);
    });

    it.effect("applies a requested legacy model through the real generic adapter", () =>
      openWithStoredModePick({
        setup: {
          models: {
            currentModelId: "initial",
            availableModels: [{ modelId: "initial", name: "Initial" }],
          },
        },
        modeFrames: [
          outbound("session/set_model", { sessionId: "agent-session", modelId: "account-custom" }),
          answer("session/set_model", {}),
        ],
        storedModelPick: "account-custom",
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect("fails opening an explicit model with no advertised model selection", () =>
      Effect.gen(function* () {
        const result = yield* openWithStoredModePick({
          setup: {},
          modeFrames: [],
          storedModelPick: "explicit-model",
        }).pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure")
          assert.include(JSON.stringify(result.failure), "model selection");
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect("forwards an explicit model to Copilot, which advertises no model selection", () =>
      openWithStoredModePick({
        setup: {},
        modeFrames: [
          outbound("session/set_model", { sessionId: "agent-session", modelId: "claude-opus-5.5" }),
          answer("session/set_model", {}),
        ],
        storedModelPick: "claude-opus-5.5",
        agentName: "Copilot",
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect("switches an agent that only advertises modes with session/set_mode", () =>
      openWithStoredModePick({
        setup: {
          modes: {
            currentModeId: "default",
            availableModes: ["default", "autoEdit"].map((id) => ({ id, name: id })),
          },
        },
        modeFrames: [
          outbound("session/set_mode", { sessionId: "agent-session", modeId: "autoEdit" }),
          answer("session/set_mode", {}),
        ],
        storedModePick: "autoEdit",
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect("switches a mode config option under its own id", () =>
      openWithStoredModePick({
        setup: { configOptions: [permissionModeOption("ask")] },
        modeFrames: [
          outbound("session/set_config_option", {
            sessionId: "agent-session",
            configId: "permission-mode",
            value: "auto",
          }),
          answer("session/set_config_option", { configOptions: [permissionModeOption("auto")] }),
        ],
        storedModePick: "auto",
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );
  });

  it.effect("offers client terminals to Devin only and client fs to no registry agent", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const advertisedCapabilities = Effect.fn("advertisedCapabilities")(function* (
        agentId: string,
      ) {
        let clientCapabilities: unknown;
        const instanceId = ProviderInstanceId.make(`acp-registry-capabilities-${agentId}`);
        const adapter = makeAcpRegistryAdapterV2({
          crypto: yield* Crypto.Crypto,
          selfInvocation: yield* resolveSelfInvocation(),
          instanceId,
          settings: yield* decodeAcpRegistryAdapterSettings({ agentId, authMethodId: "test" }),
          environment: {},
          childProcessSpawner,
          fileSystem,
          idAllocator,
          resolver: { resolve: () => Effect.die("the runtime is injected") },
          serverConfig,
          makeRuntime: (input) =>
            Effect.gen(function* () {
              clientCapabilities = input.clientCapabilities;
              const { processEnvironment: _processEnvironment, ...runtimeInput } = input;
              const context = yield* Layer.build(
                AcpSessionRuntime.layer({
                  ...runtimeInput,
                  spawn: {
                    command: process.execPath,
                    args: [mockAgentPath],
                    cwd: input.cwd,
                    env: { STUDIO_ACP_SESSION_LIFECYCLE: "1" },
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
            }),
        });
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        yield* adapter.openSession({
          threadId: ThreadId.make(`thread-acp-registry-capabilities-${agentId}`),
          providerSessionId: ProviderSessionId.make(`provider-session-capabilities-${agentId}`),
          modelSelection: { instanceId, model: "default" },
          runtimePolicy,
        });
        return clientCapabilities;
      });

      assert.deepInclude(yield* advertisedCapabilities("devin"), {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: true,
      });
      assert.deepInclude(yield* advertisedCapabilities("gemini"), {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("opens a real ACP child process resolved from registry configuration", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir: serverConfig.providerStatusCacheDir,
        toolsDir: serverConfig.baseDir + "/tools",
        registryUrl,
      });
      const settings = yield* decodeAcpRegistryAdapterSettings({
        agentId: "fixture-agent",
        commandPath: process.execPath,
        authMethodId: "test",
      });
      let startupActive = false;
      let startupCount = 0;
      const instanceId = ProviderInstanceId.make("acp-registry-fixture");
      const commandsPublished = yield* Deferred.make<{
        readonly instanceId: ProviderInstanceId;
        readonly commands: AcpRegistryAvailableCommands;
      }>();
      const configurationPublished = yield* Deferred.make<AcpRegistryLiveConfiguration>();
      const adapter = makeAcpRegistryAdapterV2({
        crypto: yield* Crypto.Crypto,
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings,
        environment: {
          STUDIO_ACP_SESSION_LIFECYCLE: "1",
          STUDIO_ACP_COMMAND_ADVERTISEMENT_DELAY_MS: "750",
        },
        childProcessSpawner,
        fileSystem,
        idAllocator,
        runtimeCoordinator: {
          withForegroundStartup: (agentId, effect) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                assert.equal(agentId, "fixture-agent");
                startupActive = true;
                startupCount += 1;
              }),
              () => effect,
              () =>
                Effect.sync(() => {
                  startupActive = false;
                }),
            ),
          runBackgroundProbe: (_agentId, effect) => effect.pipe(Effect.map(Option.some)),
          withSessionMutation: (effect) => effect,
          clearAvailableCommands: () => Effect.void,
          publishAvailableCommands: (publishedInstanceId, commands) =>
            Deferred.succeed(commandsPublished, {
              instanceId: publishedInstanceId,
              commands,
            }).pipe(Effect.asVoid),
          getAvailableCommands: () => Effect.succeed(Option.none()),
          watchAvailableCommands: () => Effect.never,
          clearLiveConfiguration: () => Effect.void,
          publishLiveConfiguration: (_publishedInstanceId, configuration) =>
            Deferred.succeed(configurationPublished, configuration).pipe(Effect.asVoid),
          getLiveConfiguration: () => Effect.succeed(Option.none()),
          watchLiveConfiguration: () => Effect.never,
          requestUrlAuthentication: () => Effect.succeed(false),
          acceptUrlAuthentication: () => Effect.succeed(false),
          getUrlAuthAction: () => Effect.succeed(Option.none()),
          watchUrlAuthAction: () => Effect.never,
        },
        resolver: {
          resolve: (configuredSettings, cwd, environment) =>
            Effect.sync(() => assert.isTrue(startupActive)).pipe(
              Effect.andThen(resolver.resolve(configuredSettings, cwd, environment)),
              Effect.map((resolved) => ({
                ...resolved,
                spawn: {
                  ...resolved.spawn,
                  args: [mockAgentPath],
                },
              })),
            ),
        },
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-registry-fixture");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-registry-fixture"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });

      assert.equal(runtime.providerSession.driver, "acpRegistry");
      assert.equal(startupCount, 1);
      assert.isFalse(startupActive);
      assert.equal(providerThread.nativeThreadRef?.nativeId, "mock-session-1");
      assert.equal(providerThread.nativeMetadata?.itemIdentityVersion, 2);
      assert.isTrue(runtime.providerSession.capabilities.threads.canReadThreadSnapshot);
      assert.isTrue(runtime.providerSession.capabilities.threads.canForkThread);
      assert.deepEqual(yield* Deferred.await(commandsPublished), {
        instanceId,
        commands: {
          slashCommands: [
            {
              name: "review",
              description: "Review the current changes",
              input: { hint: "focus" },
            },
          ],
          skills: [
            {
              name: "workspace-skill",
              description: "Run the workspace skill",
              path: "acp://skill/workspace-skill",
              scope: "agent",
              enabled: true,
            },
          ],
        },
      });
      const configuration = yield* Deferred.await(configurationPublished);
      assert.equal(configuration.currentModelId, "default");
      assert.deepInclude(configuration.models[0], {
        id: "default",
        name: "Auto",
        description: null,
      });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("starts the agent with its thread's SpecWeave variables over inherited ones", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir: serverConfig.providerStatusCacheDir,
        toolsDir: serverConfig.baseDir + "/tools",
        registryUrl,
      });
      const spawnedEnvironments: Array<NodeJS.ProcessEnv | undefined> = [];
      const recordingSpawner = ChildProcessSpawner.make((command) => {
        spawnedEnvironments.push(
          (command as unknown as { readonly options: { readonly env?: NodeJS.ProcessEnv } }).options
            .env,
        );
        return childProcessSpawner.spawn(command);
      });
      const instanceId = ProviderInstanceId.make("acp-registry-specweave-env");
      const adapter = makeAcpRegistryAdapterV2({
        crypto: yield* Crypto.Crypto,
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({
          agentId: "fixture-agent",
          commandPath: process.execPath,
          authMethodId: "test",
        }),
        environment: {
          STUDIO_ACP_SESSION_LIFECYCLE: "1",
          SPECWEAVE_STUDIO_THREAD_ID: "thread-of-the-server",
          SPECWEAVE_TOOL: "claude",
          SPECWEAVE_MODEL: "claude-opus-4-1",
        },
        childProcessSpawner: recordingSpawner,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        resolver: {
          resolve: (configuredSettings, cwd, environment) =>
            resolver.resolve(configuredSettings, cwd, environment).pipe(
              Effect.map((resolved) => ({
                ...resolved,
                spawn: { ...resolved.spawn, args: [mockAgentPath] },
              })),
            ),
        },
        serverConfig,
      });
      yield* adapter.openSession({
        threadId: ThreadId.make("thread-acp-registry-specweave-env"),
        providerSessionId: ProviderSessionId.make("provider-session-acp-registry-specweave-env"),
        modelSelection: { instanceId, model: "default" },
        runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        }),
      });

      assert.lengthOf(spawnedEnvironments, 1);
      assert.include(spawnedEnvironments[0], {
        SPECWEAVE_STUDIO_THREAD_ID: "thread-acp-registry-specweave-env",
        // An agent SpecWeave has no slug for masks the inherited "claude" with
        // "", so the CLI falls back to the agent's own markers.
        SPECWEAVE_TOOL: "",
        SPECWEAVE_MODEL: "",
      });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("sends a picked skill the agent runs as /name in that form", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir: serverConfig.providerStatusCacheDir,
        toolsDir: serverConfig.baseDir + "/tools",
        registryUrl,
      });
      const logDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-acp-skill-" });
      const requestLogPath = path.join(logDir, "requests.ndjson");
      // What Copilot CLI advertised on an earlier session of this instance.
      const advertised = normalizeAcpRegistryCommands([
        {
          name: "review",
          description: "Built-in",
          input: { type: "text", hint: "additional instructions" },
        },
        {
          name: "unslop",
          description: "Skill",
          input: { type: "text", hint: "instructions for the skill" },
        },
      ]);
      const instanceId = ProviderInstanceId.make("acp-registry-slash-skill");
      const adapter = makeAcpRegistryAdapterV2({
        crypto: yield* Crypto.Crypto,
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({
          agentId: "fixture-agent",
          commandPath: process.execPath,
          authMethodId: "test",
        }),
        environment: {
          STUDIO_ACP_SESSION_LIFECYCLE: "1",
          STUDIO_ACP_REQUEST_LOG_PATH: requestLogPath,
        },
        childProcessSpawner,
        fileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        runtimeCoordinator: {
          withForegroundStartup: (_agentId, effect) => effect,
          runBackgroundProbe: (_agentId, effect) => effect.pipe(Effect.map(Option.some)),
          withSessionMutation: (effect) => effect,
          clearAvailableCommands: () => Effect.void,
          publishAvailableCommands: () => Effect.void,
          getAvailableCommands: () => Effect.succeed(Option.some(advertised)),
          watchAvailableCommands: () => Effect.never,
          clearLiveConfiguration: () => Effect.void,
          publishLiveConfiguration: () => Effect.void,
          getLiveConfiguration: () => Effect.succeed(Option.none()),
          watchLiveConfiguration: () => Effect.never,
          requestUrlAuthentication: () => Effect.succeed(false),
          acceptUrlAuthentication: () => Effect.succeed(false),
          getUrlAuthAction: () => Effect.succeed(Option.none()),
          watchUrlAuthAction: () => Effect.never,
        },
        resolver: {
          resolve: (configuredSettings, cwd, environment) =>
            resolver.resolve(configuredSettings, cwd, environment).pipe(
              Effect.map((resolved) => ({
                ...resolved,
                spawn: { ...resolved.spawn, args: [mockAgentPath] },
              })),
            ),
        },
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-registry-slash-skill");
      const modelSelection = { instanceId, model: "default" } as const;
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-registry-slash-skill"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* session
        .startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project-acp-registry-slash-skill"),
            title: "Slash skill",
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
          runId: RunId.make("run-acp-registry-slash-skill"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("attempt-acp-registry-slash-skill"),
          rootNodeId: NodeId.make("node-acp-registry-slash-skill"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-acp-registry-slash-skill"),
            text: "$unslop tighten the README, then $review it",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkScoped);
      const readPrompts = fileSystem.readFileString(requestLogPath).pipe(
        Effect.orElseSucceed(() => ""),
        Effect.map((log) =>
          log
            .split("\n")
            .filter((line) => line.includes('"session/prompt"'))
            .map(
              (line) =>
                (JSON.parse(line) as { params: { prompt: Array<{ text?: string }> } }).params
                  .prompt,
            ),
        ),
      );
      let prompts = yield* readPrompts;
      for (let attempt = 0; prompts.length === 0 && attempt < 100; attempt += 1) {
        yield* Effect.sleep("100 millis");
        prompts = yield* readPrompts;
      }
      assert.lengthOf(prompts, 1);
      assert.strictEqual(prompts[0]![0]!.text, "/unslop tighten the README, then $review it");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it("maps known registry agents to SpecWeave tool slugs and leaves the rest to markers", () => {
    assert.equal(specweaveToolForAcpAgent("github-copilot-cli"), "copilot");
    assert.equal(specweaveToolForAcpAgent("gemini"), "gemini");
    assert.equal(specweaveToolForAcpAgent("grok-build"), "grok");
    assert.equal(specweaveToolForAcpAgent("codex-acp"), "codex");
    assert.equal(specweaveToolForAcpAgent("claude-acp"), "claude");
    // A local command has no registry id; an unknown agent keeps its markers.
    assert.equal(specweaveToolForAcpAgent(""), "");
    assert.equal(specweaveToolForAcpAgent("mistral-vibe"), "");
    assert.equal(specweaveToolForAcpAgent("toString"), "");
  });

  describe("session setup failures", () => {
    const instanceId = ProviderInstanceId.make("acpRegistry_copilot");
    const openWith = (resolve: AcpRegistryAdapterV2Options["resolver"]["resolve"]) =>
      Effect.gen(function* () {
        const adapter = makeAcpRegistryAdapterV2({
          crypto: yield* Crypto.Crypto,
          selfInvocation: yield* resolveSelfInvocation(),
          instanceId,
          settings: yield* decodeAcpRegistryAdapterSettings({ agentId: "github-copilot-cli" }),
          environment: {},
          childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
          fileSystem: yield* FileSystem.FileSystem,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          resolver: { resolve },
          serverConfig: yield* ServerConfig.ServerConfig,
        });
        return yield* adapter
          .openSession({
            threadId: ThreadId.make("thread-acp-registry-setup"),
            providerSessionId: ProviderSessionId.make("provider-session:setup-fixture"),
            modelSelection: { instanceId, model: "default" },
            runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: process.cwd(),
            }),
          })
          .pipe(Effect.scoped, Effect.flip);
      });

    it.effect("reports an agent that is not prepared as unavailable with its own detail", () =>
      Effect.gen(function* () {
        const detail =
          "GitHub Copilot 1.0.101 is not prepared. Use Install / update agent in Settings → Providers.";
        const error = yield* openWith(() =>
          Effect.fail(
            new AcpRegistrySupport.AcpRegistryError({ reason: "runner_unavailable", detail }),
          ),
        );
        assert.equal(error._tag, "ProviderAdapterOpenSessionError");
        assert.equal(error.message, detail);
        const setup = providerSetupFailure(error);
        assert.deepEqual(setup?.unavailable, { reason: "not_prepared" });
        assert.equal(setup?.instanceId, instanceId);
        assert.deepEqual(makeProviderFailure({ cause: error, class: "provider_error" }), {
          class: "provider_error",
          message: detail,
          code: "provider_unavailable",
          retryable: null,
        });
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect("marks a missing package manager as not installed", () =>
      Effect.gen(function* () {
        const detail =
          "ACP Registry agent github-copilot-cli requires 'npm', but it is not available on this environment's PATH.";
        const error = yield* openWith(() =>
          Effect.fail(
            new AcpRegistrySupport.AcpRegistryError({ reason: "runner_unavailable", detail }),
          ),
        );
        assert.equal(error.message, detail);
        assert.deepEqual(providerSetupFailure(error)?.unavailable, { reason: "not_installed" });
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect("replaces install output with curated text and keeps the failure retryable", () =>
      Effect.gen(function* () {
        const error = yield* openWith(() =>
          Effect.fail(
            new AcpRegistrySupport.AcpRegistryError({
              reason: "install_failed",
              detail:
                "ACP Registry install command 'npm' exited with code 1: npm ERR! /Users/private/.npm token=secret",
            }),
          ),
        );
        const setup = providerSetupFailure(error);
        assert.equal(
          error.message,
          "Could not install github-copilot-cli. Open Settings → Providers → Install / update agent.",
        );
        assert.isUndefined(setup?.unavailable);
        assert.notInclude(error.message, "token=secret");
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect("keeps a registry outage unmarked so it is retried", () =>
      Effect.gen(function* () {
        const error = yield* openWith(() =>
          Effect.fail(
            new AcpRegistrySupport.AcpRegistryError({
              reason: "registry_unavailable",
              detail: "ACP Registry request failed.",
            }),
          ),
        );
        assert.isUndefined(providerSetupFailure(error));
        assert.equal(makeProviderFailure({ cause: error, class: "provider_error" }).code, null);
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect("reports a resolved command missing on this machine as not installed", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const error = yield* openWith((_settings, cwd) =>
          Effect.succeed({
            distribution: "npx" as const,
            spawn: {
              command: path.join(process.cwd(), "missing-acp-agent-for-test"),
              args: [],
              cwd,
              env: {},
            },
          }),
        );
        assert.deepEqual(providerSetupFailure(error)?.unavailable, { reason: "not_installed" });
        assert.equal(
          error.message,
          "github-copilot-cli is not installed on this machine. Use Install / update agent in Settings → Providers.",
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );
  });
});
