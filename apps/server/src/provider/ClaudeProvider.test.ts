import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings } from "@specweave-studio/contracts";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import { checkClaudeProviderStatus, claudeAuthMetadata } from "./ClaudeProvider.ts";
import { mergeClaudeNativeModels } from "./ClaudeNativeModels.ts";
import { BUNDLED_CLAUDE_MODEL_CATALOG, type ClaudeModelCatalog } from "./ClaudeModelCatalog.ts";

describe("native Claude authorization metadata", () => {
  it.each(["oauth_token", "oauth-token", "oauth token", undefined, "unknown"])(
    "does not authorize a claimed Max plan with %s",
    (authMethod) => {
      expect(claudeAuthMetadata({ subscriptionType: "max", authMethod })?.type).toBe(
        "subscription-auth-unverified",
      );
    },
  );
  it("preserves supported consumer OAuth and explicit API authorization", () => {
    expect(claudeAuthMetadata({ subscriptionType: "max", authMethod: "oauth" })?.type).toBe("max");
    expect(claudeAuthMetadata({ subscriptionType: "max", authMethod: "claude.ai" })?.type).toBe(
      "max",
    );
    expect(claudeAuthMetadata({ subscriptionType: "max", authMethod: "api-key" })?.type).toBe(
      "apiKey",
    );
  });
});

const nativeAuth = {
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  subscriptionType: "max",
  email: "subscriber@example.com",
};

// Actual native 2.1.295 SDK initialization: the subscription branch omits
// tokenSource. A synthetic `oauth` source hid this production regression.
const nativeCapabilities = {
  models: undefined as ReadonlyArray<ModelInfo> | undefined,
  subscriptionType: "Claude Max" as string | undefined,
  apiProvider: "firstParty",
  email: "subscriber@example.com",
  tokenSource: undefined as string | undefined,
  apiKeySource: undefined as string | undefined,
  slashCommands: [],
};

type Command = {
  command: string;
  args: ReadonlyArray<string>;
  options?: { env?: NodeJS.ProcessEnv; cwd?: string };
};

const checkNative = (
  input: {
    stdout?: string;
    code?: number;
    failure?: "spawn" | "timeout";
    started?: Deferred.Deferred<void>;
    capabilities?: Partial<typeof nativeCapabilities> | null;
    lastKnownCatalog?: ClaudeModelCatalog;
    record?: (command: Command, configDir: string, cwd: string) => void;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-auth-" });
    const configDir = path.join(cwd, "profile");
    yield* fs.makeDirectory(configDir);
    const encoder = new TextEncoder();
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const cmd = command as unknown as Command;
        input.record?.(cmd, configDir, cwd);
        const isAuth = cmd.args.join(" ") === "auth status";
        expect(isAuth || cmd.args.join(" ") === "--version").toBe(true);
        if (isAuth && input.started) yield* Deferred.succeed(input.started, undefined);
        if (isAuth && input.failure === "timeout") return yield* Effect.never;
        if (isAuth && input.failure === "spawn")
          return yield* PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "fixture failure",
          });
        const stdout = isAuth
          ? (input.stdout ?? JSON.stringify(nativeAuth))
          : "2.1.295 (Claude Code)\n";
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(isAuth ? (input.code ?? 0) : 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    const { models, ...capabilities } = { ...nativeCapabilities, ...input.capabilities };
    return yield* checkClaudeProviderStatus(
      Schema.decodeSync(ClaudeSettings)({
        binaryPath: "/synthetic/provider/claude",
        homePath: configDir,
      }),
      () =>
        Effect.succeed(
          input.capabilities === null
            ? undefined
            : { ...capabilities, ...(models === undefined ? {} : { models }) },
        ),
      { HOME: cwd, PATH: "/synthetic/bin", ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" },
      cwd,
      undefined,
      undefined,
      undefined,
      input.lastKnownCatalog,
    ).pipe(Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)));
  }).pipe(Effect.scoped);

it.layer(NodeServices.layer)("native subscription status corroboration", (it) => {
  it.effect(
    "publishes newly discovered models and retains them on probe failure without authorizing a failed probe",
    () =>
      Effect.gen(function* () {
        const models = [
          {
            value: "haiku",
            resolvedModel: "claude-haiku-5-5",
            displayName: "Haiku",
            description: "Native model",
            supportsEffort: true,
            supportedEffortLevels: ["low", "max"],
          },
        ] satisfies ModelInfo[];
        const discovered = yield* checkNative({ capabilities: { models } });
        expect(discovered.models.find((model) => model.slug === "claude-haiku-5-5")?.isLegacy).toBe(
          false,
        );
        const lastKnownCatalog = mergeClaudeNativeModels(BUNDLED_CLAUDE_MODEL_CATALOG, models);
        const failed = yield* checkNative({ capabilities: null, lastKnownCatalog });
        expect(failed.models.some((model) => model.slug === "claude-haiku-5-5")).toBe(true);
        expect(failed.auth.status).toBe("unknown");
        const empty = yield* checkNative({ capabilities: { models: [] }, lastKnownCatalog });
        expect(empty.models.some((model) => model.slug === "claude-haiku-5-5")).toBe(false);
      }),
  );
  it.effect(
    "connects native Claude Max with missing SDK tokenSource using the same launch context",
    () =>
      Effect.gen(function* () {
        const authCommands: Command[] = [];
        const status = yield* checkNative({
          record: (command, configDir, cwd) => {
            if (command.args.join(" ") !== "auth status") return;
            authCommands.push(command);
            expect(command.command).toBe("/synthetic/provider/claude");
            expect(command.options?.cwd).toBe(cwd);
            expect(command.options?.env).toMatchObject({
              HOME: cwd,
              CLAUDE_CONFIG_DIR: configDir,
              ANTHROPIC_API_KEY: "",
              CLAUDE_CODE_OAUTH_TOKEN: "",
            });
          },
        });
        expect(authCommands).toHaveLength(1);
        expect(status.status).toBe("ready");
        expect(status.auth).toMatchObject({
          status: "authenticated",
          type: "Claude Max",
          email: nativeAuth.email,
        });
      }),
  );

  it.effect.each([
    ["signed out", JSON.stringify({ ...nativeAuth, loggedIn: false })],
    ["copied OAuth", JSON.stringify({ ...nativeAuth, authMethod: "oauth_token" })],
    ["API key", JSON.stringify({ ...nativeAuth, authMethod: "api_key" })],
    ["another backend", JSON.stringify({ ...nativeAuth, apiProvider: "bedrock" })],
    ["missing backend", JSON.stringify({ ...nativeAuth, apiProvider: undefined })],
    ["another account", JSON.stringify({ ...nativeAuth, email: "another@example.com" })],
    ["malformed output", "not JSON"],
  ] as const)("keeps %s unverified", ([, stdout]) =>
    Effect.gen(function* () {
      const status = yield* checkNative({ stdout });
      expect(status.status).toBe("warning");
      expect(status.auth).toMatchObject({
        status: "unknown",
        type: "subscription-auth-unverified",
      });
    }),
  );

  it.effect("rejects native auth output from a failed command", () =>
    Effect.gen(function* () {
      const status = yield* checkNative({ code: 1 });
      expect(status.auth.status).toBe("unknown");
    }),
  );

  it.effect("keeps process failures unverified", () =>
    Effect.gen(function* () {
      const status = yield* checkNative({ failure: "spawn" });
      expect(status.auth.status).toBe("unknown");
    }),
  );

  it.effect("bounds the auth command and keeps timeout unverified", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const fiber = yield* checkNative({ failure: "timeout", started }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("11 seconds");
      const status = yield* Fiber.join(fiber);
      expect(status.auth.status).toBe("unknown");
    }),
  );

  it.effect.each([
    ["ANTHROPIC_AUTH_TOKEN", "firstParty", "apiKey", "ready"],
    [undefined, "bedrock", "bedrock", "ready"],
    ["oauth_token", "firstParty", "subscription-auth-unverified", "warning"],
    ["unknown", "firstParty", "subscription-auth-unverified", "warning"],
  ] as const)(
    "preserves explicit source %s on %s without native fallback",
    ([tokenSource, apiProvider, type, expectedStatus]) =>
      Effect.gen(function* () {
        const commands: Command[] = [];
        const status = yield* checkNative({
          capabilities: { tokenSource, apiProvider },
          record: (command) => commands.push(command),
        });
        expect(commands.map((command) => command.args)).toEqual([["--version"]]);
        expect(status.status).toBe(expectedStatus);
        expect(status.auth.type).toBe(type);
      }),
  );

  it.effect.each([
    ["none", "ANTHROPIC_API_KEY", undefined, "apiKey", "ready"],
    // A login also sits in the home, but the key pays.
    ["claude.ai", "ANTHROPIC_API_KEY", undefined, "apiKey", "ready"],
    ["none", "apiKeyHelper", undefined, "apiKey", "ready"],
    // A reported plan means the subscription pays, whatever key is around.
    ["claude.ai", "ANTHROPIC_API_KEY", "Claude Max", "Claude Max", "ready"],
    ["claude.ai", "none", "Claude Max", "Claude Max", "ready"],
  ] as const)(
    "reads token source %s with key source %s and plan %s as %s",
    ([tokenSource, apiKeySource, subscriptionType, type, expectedStatus]) =>
      Effect.gen(function* () {
        const status = yield* checkNative({
          capabilities: { tokenSource, apiKeySource, subscriptionType, apiProvider: "firstParty" },
        });
        expect(status.status).toBe(expectedStatus);
        expect(status.auth.type).toBe(type);
      }),
  );
});
