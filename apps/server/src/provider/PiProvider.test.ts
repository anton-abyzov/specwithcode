import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { resolveProviderFallback } from "@specweave-studio/shared/providerFallback";

import {
  checkPiProviderStatus,
  MINIMUM_PI_VERSION,
  parseDiscoveredModels,
  piDefaultModel,
  piModelsFromSettings,
} from "./PiProvider.ts";

const encoder = new TextEncoder();

function processHandle(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}) {
  const bytes = (value: string | undefined) =>
    value === undefined || value.length === 0
      ? Stream.empty
      : Stream.succeed(encoder.encode(value));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_001),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: bytes(input.stdout),
    stderr: bytes(input.stderr),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function piProbeSpawner(version: string) {
  return ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args : [];
    return Effect.succeed(
      args.includes("--version")
        ? processHandle({ stdout: `pi ${version}\n` })
        : processHandle({ stderr: "RPC startup failed", exitCode: 1 }),
    );
  });
}

const settings = {
  enabled: true,
  binaryPath: "pi",
  launchArgs: "",
  customModels: [],
} as const;

describe("PiProvider", () => {
  it.effect("requires the first published Pi version with entries and settlement hooks", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.80.3")),
      );
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.version, "0.80.3");
      assert.include(snapshot.message ?? "", `Pi ${MINIMUM_PI_VERSION} or newer`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not report a compatible binary as ready when RPC startup fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.84.3")),
      );
      assert.equal(snapshot.status, "warning");
      assert.isTrue(snapshot.installed);
      assert.equal(snapshot.auth.status, "unknown");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
      assert.include(snapshot.message ?? "", "RPC startup failed");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("carries each discovered model's capabilities and billing", () => {
    const cost = (input: number, output: number) => ({
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
    });
    const models = parseDiscoveredModels(
      {
        models: [
          // As Pi's get_available_models returns an OpenRouter model.
          {
            type: "chat",
            id: "deepseek/deepseek-v4-flash",
            name: "DeepSeek: DeepSeek V4 Flash 0423",
            api: "openai-completions",
            baseUrl: "https://openrouter.ai/api/v1",
            provider: "openrouter",
            reasoning: true,
            thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null },
            input: ["text"],
            cost: { input: 0.04186, output: 0.08372, cacheRead: 0.008372, cacheWrite: 0 },
            contextWindow: 1048576,
            maxTokens: 131072,
          },
          {
            id: "qwen3-coder-30b",
            name: "Qwen3 Coder 30B",
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:1234/v1",
            provider: "lmstudio",
            reasoning: false,
            input: ["text"],
            cost: cost(0, 0),
            contextWindow: 32768,
            maxTokens: 0,
          },
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            provider: "openai",
            reasoning: true,
            input: ["text", "image"],
            cost: cost(1.5, 6),
            contextWindow: 400000,
            maxTokens: 128000,
          },
          // Claude Pro/Max and an Anthropic key look the same over RPC.
          {
            id: "claude-opus-4-5",
            name: "Claude Opus 4.5",
            api: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
            provider: "anthropic",
            reasoning: true,
            input: ["text", "image"],
            cost: cost(5, 25),
            contextWindow: 200000,
            maxTokens: 64000,
          },
          {
            id: "gemini-3-pro",
            name: "Gemini 3 Pro (Antigravity)",
            api: "google-gemini-cli",
            baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
            provider: "google-antigravity",
            reasoning: true,
            input: ["text", "image"],
            cost: cost(5, 25),
            contextWindow: 1048576,
            maxTokens: 65535,
          },
          { id: "bare", provider: "custom", name: "Bare" },
        ],
      },
      "medium",
    );
    const facts = (slug: string) => {
      const model = models.find((entry) => entry.slug === slug);
      assert.isDefined(model, slug);
      return {
        billing: model?.billing,
        toolCalls: model?.toolCalls,
        reasoning: model?.reasoning,
        imageInput: model?.imageInput,
        contextWindow: model?.contextWindow,
        maxOutput: model?.maxOutput,
      };
    };

    assert.deepEqual(facts("openrouter/deepseek/deepseek-v4-flash"), {
      billing: "paid-router",
      toolCalls: undefined,
      reasoning: "optional",
      imageInput: false,
      contextWindow: 1048576,
      maxOutput: 131072,
    });
    assert.deepEqual(facts("lmstudio/qwen3-coder-30b"), {
      billing: "local",
      toolCalls: undefined,
      reasoning: "none",
      imageInput: false,
      contextWindow: 32768,
      maxOutput: undefined,
    });
    assert.equal(facts("openai/gpt-5.4").billing, "api");
    assert.equal(facts("openai/gpt-5.4").imageInput, true);
    assert.equal(facts("anthropic/claude-opus-4-5").billing, "unknown");
    assert.equal(facts("google-antigravity/gemini-3-pro").billing, "unknown");
    assert.deepEqual(facts("custom/bare"), {
      billing: "unknown",
      toolCalls: undefined,
      reasoning: undefined,
      imageInput: undefined,
      contextWindow: undefined,
      maxOutput: undefined,
    });
  });

  describe("the default model", () => {
    const openRouterModel = {
      id: "anthropic/claude-sonnet-5",
      name: "Anthropic: Claude Sonnet 5",
      baseUrl: "https://openrouter.ai/api/v1",
      provider: "openrouter",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      contextWindow: 1000000,
      maxTokens: 64000,
    };
    const discovered = parseDiscoveredModels({ models: [openRouterModel] }, "medium");

    it("carries the billing and facts of the model Pi's settings name", () => {
      const model = piDefaultModel({ model: openRouterModel }, discovered);
      assert.equal(model.slug, "default");
      assert.equal(model.billing, "paid-router");
      assert.equal(model.imageInput, true);
      assert.equal(model.contextWindow, 1000000);
      // A state model missing from get_available_models is classified itself.
      assert.equal(piDefaultModel({ model: openRouterModel }, []).billing, "paid-router");
      assert.isUndefined(piDefaultModel({}, discovered).billing);
    });

    it("is never the any-ready fallback when it bills OpenRouter", () => {
      const nowMs = Date.parse("2026-10-22T12:00:00.000Z");
      const checkedAt = "2026-10-22T11:59:00.000Z";
      const pi: ServerProvider = {
        instanceId: ProviderInstanceId.make("pi"),
        driver: ProviderDriverKind.make("pi"),
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated", type: "pi" },
        checkedAt,
        version: null,
        models: [
          ...piModelsFromSettings(
            [],
            discovered,
            piDefaultModel({ model: openRouterModel }, discovered),
          ),
        ],
        slashCommands: [],
        skills: [],
      };
      const claude: ServerProvider = {
        ...pi,
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        auth: { status: "authenticated" },
        models: [
          { slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, capabilities: null },
        ],
        usageLimits: {
          checkedAt,
          windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 100 }],
        },
      };
      const fallback = (provider: ServerProvider) =>
        resolveProviderFallback({
          providers: [claude, provider],
          currentInstanceId: claude.instanceId,
          currentModel: "claude-opus-5-5",
          rule: { providerLimitFallbackModelSelection: null, defaultModelSelection: null },
          nowMs,
          anyReady: true,
        });
      assert.equal(pi.models[0]?.slug, "default");
      assert.isNull(fallback(pi));
      // Without the carried billing the same snapshot would fall back to Pi's default.
      const unflagged = { ...pi, models: [...piModelsFromSettings([], discovered)] };
      assert.deepEqual(fallback(unflagged), { instanceId: pi.instanceId, model: "default" });
    });
  });
});
