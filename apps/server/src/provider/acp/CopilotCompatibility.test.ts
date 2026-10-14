import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { AcpRegistrySettings, ProviderInstanceId } from "@specweave-studio/contracts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { applyAcpModelSelection, resetAcpModelSelection } from "./AcpModelSelection.ts";
import {
  acpRegistryProbeResult,
  normalizeAcpRegistryAuthMethods,
  normalizeAcpRegistryLiveConfiguration,
} from "./AcpRegistryProbe.ts";
import { acpRegistryLaunchArgs, acpRegistryInstallEnvironment } from "./AcpRegistryLaunchPolicy.ts";
import { acpTerminalAuthInvocation } from "./AcpTerminalAuthentication.ts";
import { prepareCopilotStartupModel, resetCopilotStartupModel } from "./CopilotStartupModel.ts";

const fixture = Effect.fn("copilotCompatibilityFixture")(function* (
  scenario: string,
  resumeMethod?: "load" | "resume",
  agentName?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "studio-copilot-contract-" });
  const log = path.join(cwd, "wire.jsonl");
  yield* fs.writeFileString(log, "");
  const runtime = yield* AcpSessionRuntime.make({
    ...(resumeMethod ? { resumeMethod, resumeSessionId: "saved-session" } : {}),
    cwd,
    clientInfo: { name: "studio-copilot-contract", version: "1" },
    spawn: {
      command: process.execPath,
      args: [
        yield* path.fromFileUrl(new URL("./testing/copilot-acp.fixture.mjs", import.meta.url)),
      ],
      cwd,
      env: {
        COPILOT_FIXTURE_SCENARIO: scenario,
        COPILOT_FIXTURE_LOG: log,
        COPILOT_FIXTURE_WRITE: path.join(cwd, "write.txt"),
        ...(agentName ? { COPILOT_FIXTURE_AGENT_NAME: agentName } : {}),
      },
    },
  });
  return {
    runtime,
    fs,
    cwd,
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

const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const startupFixture = Effect.fn("copilotStartupFixture")(function* (
  scenario: string,
  model = "claude-opus-5.5",
  options: { readonly version?: string; readonly resumeSessionId?: string } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "studio-copilot-startup-" });
  const log = path.join(cwd, "wire.jsonl");
  yield* fs.writeFileString(log, "");
  const spawn = {
    command: process.execPath,
    args: [
      yield* path.fromFileUrl(new URL("./testing/copilot-acp.fixture.mjs", import.meta.url)),
      "--no-auto-update",
      "--acp",
      "--stdio",
    ],
    cwd,
    env: {
      COPILOT_FIXTURE_SCENARIO: scenario,
      COPILOT_FIXTURE_LOG: log,
      COPILOT_FIXTURE_RECORD_LAUNCH: "1",
      ...(options.version === undefined ? {} : { COPILOT_FIXTURE_VERSION: options.version }),
    },
  };
  const prepared = yield* prepareCopilotStartupModel({
    settings: yield* Schema.decodeUnknownEffect(AcpRegistrySettings)({
      agentId: "github-copilot-cli",
    }),
    resolved: {
      agent: {
        id: "github-copilot-cli",
        name: "Copilot",
        version: "1.0.97",
        description: "Fixture",
        distribution: { npx: { package: "@github/copilot@1.0.97" } },
      },
      distribution: "npx",
      spawn,
    },
    model,
    ...options,
    spawner,
  });
  const native = yield* AcpSessionRuntime.make({
    cwd,
    spawn: prepared?.spawn ?? spawn,
    clientInfo: { name: "startup-fixture", version: "1" },
    ...(options.resumeSessionId === undefined ? {} : { resumeSessionId: options.resumeSessionId }),
  });
  return {
    runtime: prepared?.acknowledge(native) ?? native,
    prepared: prepared !== undefined,
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

describe("Copilot ACP compatibility", () => {
  it.effect(
    "seeds the exact model in argv before ACP and consumes native startup confirmation once",
    () =>
      scoped(
        Effect.gen(function* () {
          const { runtime, messages } = yield* startupFixture("startup-model");
          const started = yield* runtime.start();
          yield* applyAcpModelSelection(runtime, started, "claude-opus-5.5");
          const frames = yield* messages;
          expect(frames.slice(0, 3).map((frame) => frame.method)).toEqual([
            "process/launch",
            "process/launch",
            "process/launch",
          ]);
          expect(frames[0].args).toContain("--version");
          expect(frames[1].args).toContain("--help");
          expect(frames[2].args).toContain("--model=claude-opus-5.5");
          expect(frames[2].args).toContain("--no-auto-update");
          expect(frames.slice(3).map((frame) => frame.method)).toEqual([
            "initialize",
            "session/new",
          ]);
          expect(started.sessionSetupResult.models?.availableModels).toEqual([
            { modelId: "auto", name: "Auto" },
          ]);
          expect(yield* resetCopilotStartupModel(runtime)).toBe(true);
          expect((yield* messages).at(-1)).toMatchObject({
            method: "session/set_model",
            params: { modelId: "auto" },
          });
          const second = yield* applyAcpModelSelection(runtime, started, "claude-opus-5.5").pipe(
            Effect.result,
          );
          expect(second._tag).toBe("Failure");
          expect((yield* messages).at(-1)).toMatchObject({
            method: "session/set_model",
            params: { modelId: "claude-opus-5.5" },
          });
        }),
      ),
  );

  for (const scenario of [
    "startup-auto",
    "startup-mismatch",
    "startup-reject",
    "startup-version-change",
  ]) {
    it.effect(`fails closed for ${scenario} before model writes or prompts`, () =>
      scoped(
        Effect.gen(function* () {
          const { runtime, messages } = yield* startupFixture(scenario);
          expect((yield* runtime.start().pipe(Effect.result))._tag).toBe("Failure");
          expect((yield* messages).map((frame) => frame.method)).not.toContain("session/set_model");
          expect((yield* messages).map((frame) => frame.method)).not.toContain("session/prompt");
        }),
      ),
    );
  }

  it.effect("negotiates an advertised exact model after initial Auto before prompting", () =>
    scoped(
      Effect.gen(function* () {
        const { runtime, messages } = yield* startupFixture("startup-negotiate");
        const started = yield* runtime.start();
        yield* applyAcpModelSelection(runtime, started, "claude-opus-5.5");
        yield* runtime.prompt({ prompt: [{ type: "text", text: "Fixture only" }] });
        const calls = (yield* messages).filter((frame) => frame.method.startsWith("session/"));
        expect(calls.map((frame) => frame.method)).toEqual([
          "session/new",
          "session/set_config_option",
          "session/prompt",
        ]);
        expect(calls[1].params).toMatchObject({ value: "claude-opus-5.5" });
      }),
    ),
  );

  it.effect("negotiated model to default to model performs real native config changes", () =>
    scoped(
      Effect.gen(function* () {
        const { runtime, messages } = yield* startupFixture("startup-negotiate");
        const started = yield* runtime.start();
        yield* applyAcpModelSelection(runtime, started, "claude-opus-5.5");
        expect(yield* resetCopilotStartupModel(runtime)).toBe(true);
        yield* applyAcpModelSelection(runtime, started, "claude-opus-5.5");
        yield* runtime.prompt({ prompt: [{ type: "text", text: "Fixture only" }] });
        const calls = (yield* messages).filter(
          (frame) => frame.method === "session/set_config_option",
        );
        expect(calls.map((frame) => frame.params.value)).toEqual([
          "claude-opus-5.5",
          "auto",
          "claude-opus-5.5",
        ]);
        expect((yield* messages).map((frame) => frame.method)).not.toContain("session/set_model");
      }),
    ),
  );

  for (const suffix of ["denied", "auto", "wrong", "empty"]) {
    it.effect(`refuses negotiation ${suffix} before a prompt`, () =>
      scoped(
        Effect.gen(function* () {
          const { runtime, messages } = yield* startupFixture(`startup-negotiate-${suffix}`);
          expect((yield* runtime.start().pipe(Effect.result))._tag).toBe("Failure");
          const calls = (yield* messages).map((frame) => frame.method);
          expect(calls.filter((method) => method === "session/set_config_option")).toHaveLength(1);
          expect(calls).not.toContain("session/set_model");
          expect(calls).not.toContain("session/prompt");
        }),
      ),
    );
  }

  it.effect("does not treat an absent current model as confirmation", () =>
    scoped(
      Effect.gen(function* () {
        const { runtime, messages } = yield* startupFixture("startup-missing");
        const started = yield* runtime.start();
        expect(
          (yield* applyAcpModelSelection(runtime, started, "claude-opus-5.5").pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        expect((yield* messages).at(-1)).toMatchObject({
          method: "session/set_model",
          params: { modelId: "claude-opus-5.5" },
        });
      }),
    ),
  );

  it.effect("keeps model text in one literal argv item without shell expansion", () =>
    scoped(
      Effect.gen(function* () {
        const model = "literal-$(printf forbidden); model";
        const { runtime, messages } = yield* startupFixture("startup-model", model);
        const started = yield* runtime.start();
        expect(started.sessionSetupResult.models?.currentModelId).toBe(model);
        yield* applyAcpModelSelection(runtime, started, model);
        expect((yield* messages)[2].args).toContain(`--model=${model}`);
      }),
    ),
  );

  it.effect("leaves unverified CLI versions and initial resumed sessions on native selection", () =>
    scoped(
      Effect.gen(function* () {
        const older = yield* startupFixture("startup-model", "claude-opus-5.5", {
          version: "1.0.95",
        });
        expect(older.prepared).toBe(false);
        yield* older.runtime.start();
        expect(
          (yield* older.messages).filter((frame) => frame.method === "process/launch"),
        ).toHaveLength(2);
        expect(
          (yield* older.messages)[1].args.some((arg: string) => arg.startsWith("--model=")),
        ).toBe(false);
        const resumed = yield* startupFixture("startup-model", "claude-opus-5.5", {
          resumeSessionId: "saved-session",
        });
        expect(resumed.prepared).toBe(false);
        yield* resumed.runtime.start();
        expect(
          (yield* resumed.messages).filter((frame) => frame.method === "process/launch"),
        ).toHaveLength(1);
        expect((yield* resumed.messages).map((frame) => frame.method)).toContain("session/load");
      }),
    ),
  );

  it.effect("rejects a missing --model capability before ACP launch", () =>
    scoped(
      Effect.gen(function* () {
        expect((yield* startupFixture("startup-no-flag").pipe(Effect.result))._tag).toBe("Failure");
      }),
    ),
  );

  it.effect("surfaces the captured 1.0.94 auth gate without starting interactive login", () =>
    scoped(
      Effect.gen(function* () {
        const { runtime, messages } = yield* fixture("auth");
        const initialized = yield* runtime.initialize();
        const methods = normalizeAcpRegistryAuthMethods(initialized.authMethods, {
          command: "/managed/copilot",
          args: ["--no-auto-update", "--acp", "--stdio"],
        });
        expect(methods).toMatchObject([
          {
            id: "copilot-login",
            type: "terminal",
            command: "/managed/copilot-native --no-auto-update login",
          },
        ]);
        const result = yield* runtime.start().pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(yield* messages).toMatchObject([
          { method: "initialize" },
          { method: "session/new" },
        ]);
        expect((yield* messages).map((m) => m.method)).not.toContain("authenticate");
      }),
    ),
  );

  it.effect("discovers legacy models and forwards custom model IDs to session/set_model", () =>
    scoped(
      Effect.gen(function* () {
        const { runtime, messages } = yield* fixture("legacy");
        const started = yield* runtime.start();
        const result = acpRegistryProbeResult(ProviderInstanceId.make("copilot"), started);
        expect(result.models.map((m) => m.id)).toEqual(["claude-opus-5.5", "grok-4.7"]);
        expect(result.currentModelId).toBe("claude-opus-5.5");
        yield* applyAcpModelSelection(runtime, started, "account-custom-model");
        expect((yield* messages).at(-1)).toMatchObject({
          method: "session/set_model",
          params: { sessionId: "copilot-fixture", modelId: "account-custom-model" },
        });
      }),
    ),
  );

  it.effect("uses the live config option id after the provider replaces its model selector", () =>
    scoped(
      Effect.gen(function* () {
        const { runtime, messages } = yield* fixture("config");
        const started = yield* runtime.start();
        yield* runtime.setConfigOption("effort", "low");
        yield* applyAcpModelSelection(runtime, started, "grok-4.7");
        expect((yield* messages).at(-1)).toMatchObject({
          method: "session/set_config_option",
          params: { sessionId: "copilot-fixture", configId: "model-live", value: "grok-4.7" },
        });
        expect(
          normalizeAcpRegistryLiveConfiguration(yield* runtime.getConfigOptions).currentModelId,
        ).toBe("grok-4.7");
      }),
    ),
  );

  it.effect("forwards a custom model to Copilot when it advertises no model catalog", () =>
    scoped(
      Effect.gen(function* () {
        // Signed-in @github/copilot 1.0.95 returns no model metadata from session/new.
        const { runtime, messages } = yield* fixture("none");
        const started = yield* runtime.start();
        expect(acpRegistryProbeResult(ProviderInstanceId.make("copilot"), started).models).toEqual(
          [],
        );
        expect(yield* applyAcpModelSelection(runtime, started, "claude-opus-5.5")).toBe(
          "claude-opus-5.5",
        );
        expect((yield* messages).at(-1)).toMatchObject({
          method: "session/set_model",
          params: { sessionId: "copilot-fixture", modelId: "claude-opus-5.5" },
        });
      }),
    ),
  );

  it.effect("returns Copilot to auto routing when leaving a forwarded custom model", () =>
    scoped(
      Effect.gen(function* () {
        const { runtime, messages } = yield* fixture("none");
        const started = yield* runtime.start();
        yield* applyAcpModelSelection(runtime, started, "claude-opus-5.5");
        expect(yield* resetAcpModelSelection(runtime, started)).toBe(true);
        expect((yield* messages).at(-1)).toMatchObject({
          method: "session/set_model",
          params: { sessionId: "copilot-fixture", modelId: "auto" },
        });
      }),
    ),
  );

  it.effect("forwards an exact custom model through Copilot 1.0.97's auto-only config", () =>
    scoped(
      Effect.gen(function* () {
        const { runtime, messages } = yield* fixture("auto-config");
        const started = yield* runtime.start();
        expect(started.initializeResult.agentInfo?.version).toBe("1.0.97");
        expect(yield* runtime.getConfigOptions).toMatchObject([
          { id: "model", options: [{ value: "auto" }, { value: "auto" }] },
          { id: "effort" },
        ]);
        expect(yield* applyAcpModelSelection(runtime, started, "claude-opus-5.5")).toBe(
          "claude-opus-5.5",
        );
        expect((yield* messages).at(-1)).toMatchObject({
          method: "session/set_model",
          params: { sessionId: "copilot-fixture", modelId: "claude-opus-5.5" },
        });
        // Reset is explicit user selection of default, never failure fallback.
        expect(yield* resetAcpModelSelection(runtime, started)).toBe(true);
        expect((yield* messages).at(-1)).toMatchObject({
          method: "session/set_model",
          params: { sessionId: "copilot-fixture", modelId: "auto" },
        });
        expect((yield* messages).map((m) => m.method)).not.toContain("session/set_config_option");
      }),
    ),
  );

  it.effect("preserves native model rejection without retrying Copilot's auto model", () =>
    scoped(
      Effect.gen(function* () {
        const { runtime, messages } = yield* fixture("auto-config");
        const started = yield* runtime.start();
        expect(
          yield* applyAcpModelSelection(runtime, started, "unavailable-model").pipe(Effect.result),
        ).toMatchObject({
          _tag: "Failure",
          failure: { code: -32602, errorMessage: "Requested model is unavailable" },
        });
        expect((yield* messages).filter((m) => m.method?.startsWith("session/set"))).toMatchObject([
          {
            method: "session/set_model",
            params: { sessionId: "copilot-fixture", modelId: "unavailable-model" },
          },
        ]);
      }),
    ),
  );

  it.effect("preserves current advertised auto without a legacy model RPC", () =>
    scoped(
      Effect.gen(function* () {
        const { runtime, messages } = yield* fixture("auto-config");
        const started = yield* runtime.start();
        yield* applyAcpModelSelection(runtime, started, "auto");
        expect((yield* messages).map((m) => m.method)).toEqual(["initialize", "session/new"]);
      }),
    ),
  );

  it.effect("sends no reset to an agent that advertises a catalog or is not Copilot", () =>
    scoped(
      Effect.gen(function* () {
        const legacy = yield* fixture("legacy");
        expect(yield* resetAcpModelSelection(legacy.runtime, yield* legacy.runtime.start())).toBe(
          false,
        );
        const config = yield* fixture("config");
        expect(yield* resetAcpModelSelection(config.runtime, yield* config.runtime.start())).toBe(
          false,
        );
        const other = yield* fixture("none", undefined, "Other Agent");
        expect(yield* resetAcpModelSelection(other.runtime, yield* other.runtime.start())).toBe(
          false,
        );
        for (const { messages } of [legacy, config, other]) {
          expect((yield* messages).map((m) => m.method)).toEqual(["initialize", "session/new"]);
        }
      }),
    ),
  );

  it.effect("rejects an explicit model when another agent advertises no selection mechanism", () =>
    scoped(
      Effect.gen(function* () {
        const { runtime, messages } = yield* fixture("none", undefined, "Other Agent");
        const started = yield* runtime.start();
        const result = yield* applyAcpModelSelection(runtime, started, "claude-opus-5.5").pipe(
          Effect.result,
        );
        expect(result).toMatchObject({ _tag: "Failure", failure: { code: -32601 } });
        expect((yield* messages).map((m) => m.method)).toEqual(["initialize", "session/new"]);
      }),
    ),
  );

  it.effect("streams fixture content, forwards denial, and loads an advertised continuation", () =>
    scoped(
      Effect.gen(function* () {
        const { runtime, fs, cwd, messages } = yield* fixture("legacy");
        const chunks: string[] = [];
        yield* runtime.getEvents().pipe(
          Stream.runForEach((event) => {
            if (event._tag === "EventStreamBarrier")
              return Deferred.succeed(event.acknowledge, undefined);
            if (event._tag === "ContentDelta") chunks.push(event.text);
            return Effect.void;
          }),
          Effect.forkChild,
        );
        yield* runtime.handleRequestPermission(() =>
          Effect.succeed({ outcome: { outcome: "selected", optionId: "deny" } }),
        );
        const started = yield* runtime.start();
        const prompt = yield* runtime.prompt({
          prompt: [{ type: "text", text: "Fixture write request" }],
        });
        yield* runtime.drainEvents;
        expect(prompt.stopReason).toBe("end_turn");
        expect(chunks.join("")).toBe("Fixture stream");
        expect(yield* fs.exists(`${cwd}/write.txt`)).toBe(false);
        expect((yield* messages).find((m) => m.id === "permission")).toMatchObject({
          result: { outcome: { outcome: "selected", optionId: "deny" } },
        });
        expect((yield* runtime.loadSession(started.sessionId)).sessionId).toBe(started.sessionId);
      }),
    ),
  );

  it.effect("refuses unsupported session/resume before sending it to the agent", () =>
    scoped(
      Effect.gen(function* () {
        const { runtime, messages } = yield* fixture("legacy", "resume");
        expect(yield* runtime.start().pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { code: -32601 },
        });
        expect((yield* messages).map((m) => m.method)).toEqual(["initialize"]);
      }),
    ),
  );

  it("does not replace an authoritative empty model config catalog with legacy entries", () => {
    const result = normalizeAcpRegistryLiveConfiguration(
      [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "old",
          options: [],
        },
      ],
      undefined,
      { currentModelId: "old", availableModels: [{ modelId: "old", name: "Old" }] },
    );
    expect(result.models).toEqual([]);
    expect(result.currentModelId).toBeNull();
  });

  it("pins only verified official package launches and keeps installer auth homes separate", () => {
    expect(
      acpRegistryLaunchArgs("github-copilot-cli", "@github/copilot@1.0.94", ["--acp"]),
    ).toEqual(["--no-auto-update", "--acp"]);
    expect(
      acpRegistryLaunchArgs("grok-build", "@xai-official/grok@1.0.50", ["agent", "stdio"]),
    ).toEqual(["--no-auto-update", "agent", "stdio"]);
    expect(acpRegistryLaunchArgs("github-copilot-cli", "@other/agent@1.0.0", ["--acp"])).toEqual([
      "--acp",
    ]);
    const nativeEnv = { HOME: "/user", GROK_HOME: "/user/account", PATH: "/bin" };
    expect(
      acpRegistryInstallEnvironment("@xai-official/grok@1.0.50", nativeEnv, "/studio/install"),
    ).toEqual({ ...nativeEnv, GROK_HOME: "/studio/install", GROK_INSTALL_COMPLETIONS: "0" });
    expect(nativeEnv.GROK_HOME).toBe("/user/account");
    expect(
      acpTerminalAuthInvocation(
        {
          id: "bad",
          name: "Bad",
          _meta: { "terminal-auth": { command: "relative", args: ["login"] } },
        },
        { command: "/agent", args: [] },
      ),
    ).toBeUndefined();
  });
});
