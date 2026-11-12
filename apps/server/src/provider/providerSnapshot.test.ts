import { describe, expect, it } from "@effect/vitest";
import type { ModelCapabilities } from "@specweave-studio/contracts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { createModelCapabilities } from "@specweave-studio/shared/model";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  answerOrRetry,
  isCommandMissingCause,
  noAnswerMessage,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "./providerSnapshot.ts";

const OPENCODE_CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: [{ id: "medium", label: "Medium", isDefault: true }],
      currentValue: "medium",
    },
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "build", label: "Build", isDefault: true }],
      currentValue: "build",
    },
  ],
});

describe("providerModelsFromSettings", () => {
  it("applies the provided capabilities to custom models", () => {
    const models = providerModelsFromSettings(
      [],
      ["openai/gpt-5"],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "openai/gpt-5",
        name: "openai/gpt-5",
        isCustom: true,
        capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
      },
    ]);
  });

  it("keeps an entry's own name and capabilities over the driver default", () => {
    const capabilities = createModelCapabilities({
      optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
    });
    const models = providerModelsFromSettings(
      [],
      ["bare", { slug: "named", name: "Named", capabilities }],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "bare",
        name: "bare",
        isCustom: true,
        capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
      },
      { slug: "named", name: "Named", isCustom: true, capabilities },
    ]);
  });

  it("preserves a custom slug that collides with a provider alias", () => {
    const capabilities = createModelCapabilities({ optionDescriptors: [] });
    const models = providerModelsFromSettings(
      [
        {
          slug: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          isCustom: false,
          capabilities,
        },
      ],
      [" opus "],
      capabilities,
    );

    expect(models.map((model) => model.slug)).toEqual(["claude-opus-4-8", "opus"]);
    expect(models[1]?.isCustom).toBe(true);
  });
});

describe("parseGenericCliVersion", () => {
  it("parses a bare version", () => {
    expect(parseGenericCliVersion("1.14.19")).toBe("1.14.19");
  });

  it("parses a v-prefixed version", () => {
    expect(parseGenericCliVersion("opencode v2.0.3")).toBe("2.0.3");
    expect(parseGenericCliVersion("v22.19.0")).toBe("22.19.0");
  });

  it("parses a version embedded in other output", () => {
    expect(parseGenericCliVersion("codex-cli 0.53.0 (build abc)")).toBe("0.53.0");
  });

  it("returns null when no version is present", () => {
    expect(parseGenericCliVersion("no version here")).toBeNull();
  });

  it("ignores versions glued to other word characters", () => {
    expect(parseGenericCliVersion("build2.0.3artifact")).toBeNull();
  });
});

describe("ProviderCommandNotFoundError", () => {
  it("classifies normalized platform failures without parsing messages", () => {
    expect(
      isCommandMissingCause(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "arbitrary host detail",
        }),
      ),
    ).toBe(true);
    expect(isCommandMissingCause(new Error("spawn provider ENOENT"))).toBe(false);
  });

  it.effect("retains safe failed-command diagnostics without process output", () => {
    const stderr = "'codex' is not recognized: secret-token-value";
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(9009)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.encodeText(Stream.make(stderr)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
    return Effect.gen(function* () {
      const error = yield* spawnAndCollect(
        "C:\\tools\\codex.cmd",
        ChildProcess.make("codex", ["--version"]),
      ).pipe(
        Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.flip,
      );

      if (error._tag !== "ProviderCommandNotFoundError") {
        throw new Error(`Unexpected error: ${error._tag}`);
      }

      expect(error.binaryPath).toBe("C:\\tools\\codex.cmd");
      expect(error.exitCode).toBe(9009);
      expect(error.stdoutLength).toBe(0);
      expect(error.stderrLength).toBe(stderr.length);
      expect(error.message).toBe(
        "Provider command C:\\tools\\codex.cmd was not found (exit code 9009).",
      );
      expect(isCommandMissingCause(error)).toBe(true);
      expect(error).not.toHaveProperty("stdout");
      expect(error).not.toHaveProperty("stderr");
      expect(error.message).not.toContain("secret-token-value");
    });
  });
});

describe("a check that gives no answer", () => {
  /** A check that stays silent for its first `silent` runs, then answers. */
  const check = (silent: number) => {
    let runs = 0;
    const effect = Effect.suspend(() => {
      runs += 1;
      return runs <= silent ? Effect.never : Effect.succeed(`answer ${runs}`);
    });
    return { effect, runs: () => runs };
  };

  it.effect("is not run twice when it answers in time", () =>
    Effect.gen(function* () {
      const quick = check(0);
      expect(yield* answerOrRetry(quick.effect, 4_000)).toEqual(Option.some("answer 1"));
      expect(quick.runs()).toBe(1);
    }),
  );

  it.effect("runs once more with the longer limit before anything is shown", () =>
    Effect.gen(function* () {
      const slow = check(1);
      const fiber = yield* answerOrRetry(slow.effect, 4_000).pipe(Effect.forkChild);
      yield* TestClock.adjust("4 seconds");
      expect(yield* Fiber.join(fiber)).toEqual(Option.some("answer 2"));
      expect(slow.runs()).toBe(2);
    }),
  );

  it.effect("gives up after the second silence, and says how long it waited", () =>
    Effect.gen(function* () {
      const silent = check(5);
      const fiber = yield* answerOrRetry(silent.effect, 4_000).pipe(Effect.forkChild);
      yield* TestClock.adjust("4 seconds");
      yield* TestClock.adjust("14 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(fiber)).toEqual(Option.none());
      expect(silent.runs()).toBe(2);
      expect(noAnswerMessage("Claude Code")).toBe(
        "Could not check Claude Code: no answer in 15 seconds.",
      );
    }),
  );
});
