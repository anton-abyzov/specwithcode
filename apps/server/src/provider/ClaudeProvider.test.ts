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
  it("names the renamed Ultra plan that Claude Code 2.1.302 reports", () => {
    expect(
      claudeAuthMetadata({ subscriptionType: "Claude Ultra", authMethod: "claude.ai" }),
    ).toEqual({ type: "Claude Ultra", label: "Claude Ultra Subscription" });
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
  email: "subscriber@example.com" as string | undefined,
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
    textStdout?: string;
    environment?: NodeJS.ProcessEnv;
    code?: number;
    failure?: "spawn" | "timeout";
    started?: Deferred.Deferred<void>;
    capabilities?: Partial<typeof nativeCapabilities> | null;
    lastKnownCatalog?: ClaudeModelCatalog;
    record?: (command: Command, configDir: string, cwd: string) => void;
    /** Written to the instance's `.claude.json`, where the CLI keeps its claude.ai login. */
    claudeJson?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "studio-claude-auth-" });
    const configDir = path.join(cwd, "profile");
    yield* fs.makeDirectory(configDir);
    if (input.claudeJson !== undefined) {
      yield* fs.writeFileString(path.join(configDir, ".claude.json"), input.claudeJson);
    }
    const encoder = new TextEncoder();
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const cmd = command as unknown as Command;
        input.record?.(cmd, configDir, cwd);
        const isText = cmd.args.join(" ") === "auth status --text";
        const isAuth = isText || cmd.args.join(" ") === "auth status";
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
        const stdout = isText
          ? (input.textStdout ?? "")
          : isAuth
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
      yield* Schema.decodeEffect(ClaudeSettings)({
        binaryPath: "/synthetic/provider/claude",
        homePath: configDir,
      }),
      () =>
        Effect.succeed(
          input.capabilities === null
            ? undefined
            : { ...capabilities, ...(models === undefined ? {} : { models }) },
        ),
      {
        HOME: cwd,
        PATH: "/synthetic/bin",
        ANTHROPIC_API_KEY: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
        ...input.environment,
      },
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

  it.effect("keys a complete subscription read by email, organization and plan", () =>
    Effect.gen(function* () {
      const usage = {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 12, resets_at: "2026-10-25T06:50:00Z" },
          seven_day: { utilization: 18, resets_at: "2026-10-30T08:59:00Z" },
        },
      };
      const read = (extra: Record<string, unknown>) =>
        checkNative({
          capabilities: { usage, organization: "Personal", ...extra } as Partial<
            typeof nativeCapabilities
          >,
        });
      const personal = yield* read({});
      const team = yield* read({ organization: "Team" });
      const apiKey = yield* read({
        subscriptionType: undefined,
        apiKeySource: "ANTHROPIC_API_KEY",
      });
      expect(personal.usageLimits?.subscriptionKey).toMatch(/^claude:sha256:[a-f0-9]{64}$/);
      expect(team.usageLimits?.subscriptionKey).toMatch(/^claude:sha256:[a-f0-9]{64}$/);
      expect(team.usageLimits?.subscriptionKey).not.toBe(personal.usageLimits?.subscriptionKey);
      expect(apiKey.usageLimits?.subscriptionKey).toBeUndefined();
    }),
  );

  it.effect("rejects native auth output from a failed command", () =>
    Effect.gen(function* () {
      const status = yield* checkNative({ code: 1 });
      expect(status.auth.status).toBe("unknown");
      expect(status.auth.type).toBe("subscription-auth-unverified");
    }),
  );

  it.effect("keeps process failures unverified", () =>
    Effect.gen(function* () {
      const status = yield* checkNative({ failure: "spawn" });
      expect(status.status).toBe("warning");
      expect(status.auth).toMatchObject({ status: "unknown", type: "status-check-failed" });
    }),
  );

  it.effect("bounds the auth command and keeps timeout unverified", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const fiber = yield* checkNative({ failure: "timeout", started }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("11 seconds");
      const status = yield* Fiber.join(fiber);
      expect(status.auth).toMatchObject({ status: "unknown", type: "status-check-failed" });
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
    // Claude Console sign-in ("API Usage Billing"): the CLI holds a managed key.
    ["none", "/login managed key", undefined, "apiKey", "ready"],
    [undefined, "/login managed key", undefined, "apiKey", "ready"],
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
  // Actual 2.1.302 output after `claude /login` with a Claude Console account.
  const consoleCapabilities = {
    subscriptionType: undefined,
    tokenSource: undefined,
    apiKeySource: undefined,
    email: undefined,
  };
  const consoleStatus = JSON.stringify({
    loggedIn: true,
    authMethod: "oauth_token",
    apiProvider: "firstParty",
  });
  const consoleText =
    "Profile: credentials-file \u00b7 user_oauth \u00b7 profile default\n" +
    "Organization: Example Org \u00b7 00000000-0000-0000-0000-000000000000\n" +
    "Email: console@example.com\n";

  it.effect("reads a Claude Console sign-in as ready and billed to API credits", () =>
    Effect.gen(function* () {
      const commands: Command[] = [];
      const status = yield* checkNative({
        capabilities: consoleCapabilities,
        stdout: consoleStatus,
        textStdout: consoleText,
        record: (command) => commands.push(command),
      });
      expect(commands.map((command) => command.args.join(" "))).toEqual([
        "--version",
        "auth status",
        "auth status --text",
      ]);
      expect(status.status).toBe("ready");
      expect(status.auth).toMatchObject({
        status: "authenticated",
        type: "apiKey",
        label: "Claude Console (API Usage Billing)",
        apiKeyBilling: true,
      });
    }),
  );

  it.effect("names the Console account and the subscription it takes precedence over", () =>
    Effect.gen(function* () {
      const status = yield* checkNative({
        capabilities: consoleCapabilities,
        stdout: consoleStatus,
        textStdout: consoleText,
        claudeJson: JSON.stringify({
          oauthAccount: { emailAddress: "plan@example.com", billingType: "stripe_subscription" },
        }),
      });
      expect(status.auth.email).toBe("console@example.com");
      expect(status.usageLimits?.unavailable).toEqual({
        reason: "unsupported",
        message:
          "Claude Code here uses a Claude Console API sign-in (console@example.com, Example Org), so turns bill the API and no subscription limits apply. It takes precedence over the claude.ai subscription plan@example.com. Sign out of the Console profile (~/.config/anthropic) to use that subscription again.",
      });
    }),
  );

  it.effect("explains a Console sign-in without a claude.ai login behind it", () =>
    Effect.gen(function* () {
      const status = yield* checkNative({
        capabilities: consoleCapabilities,
        stdout: consoleStatus,
        textStdout: consoleText,
      });
      expect(status.usageLimits?.unavailable?.message).toBe(
        "Claude Code here uses a Claude Console API sign-in (console@example.com, Example Org), so turns bill the API and no subscription limits apply.",
      );
    }),
  );

  it.effect.each([
    ["another profile kind", consoleStatus, consoleText.replace("user_oauth", "oidc_federation")],
    ["no profile line", consoleStatus, "Auth token: CLAUDE_CODE_OAUTH_TOKEN\n"],
    [
      "a claude.ai login",
      JSON.stringify({ ...nativeAuth, subscriptionType: undefined }),
      consoleText,
    ],
    ["signed out", JSON.stringify({ loggedIn: false, authMethod: "none" }), consoleText],
  ] as const)("keeps %s without a plan unverified", ([, stdout, textStdout]) =>
    Effect.gen(function* () {
      const status = yield* checkNative({ capabilities: consoleCapabilities, stdout, textStdout });
      expect(status.status).toBe("warning");
      expect(status.auth).toMatchObject({
        status: "unknown",
        type: "subscription-auth-unverified",
      });
      expect(status.auth.apiKeyBilling).toBeUndefined();
    }),
  );

  it.effect.each([
    ["CLAUDE_CODE_OAUTH_TOKEN"],
    ["ANTHROPIC_AUTH_TOKEN"],
    ["ANTHROPIC_BASE_URL"],
  ] as const)("does not read the Console profile when %s supplies the token", ([name]) =>
    Effect.gen(function* () {
      const commands: Command[] = [];
      const status = yield* checkNative({
        capabilities: consoleCapabilities,
        stdout: consoleStatus,
        textStdout: consoleText,
        environment: { [name]: "synthetic" },
        record: (command) => commands.push(command),
      });
      expect(commands.map((command) => command.args.join(" "))).toEqual(["--version"]);
      expect(status.auth.type).toBe("subscription-auth-unverified");
    }),
  );

  it.effect("keeps a Console status read that never finished unchecked", () =>
    Effect.gen(function* () {
      const status = yield* checkNative({
        capabilities: consoleCapabilities,
        failure: "spawn",
      });
      expect(status.status).toBe("warning");
      expect(status.auth).toMatchObject({ status: "unknown", type: "status-check-failed" });
    }),
  );
});
