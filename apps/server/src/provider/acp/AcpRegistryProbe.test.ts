// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AcpRegistrySettings, ProviderInstanceId } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as EffectAcpErrors from "@specweave-studio/effect-acp/errors";

import type { AcpSessionRuntimeStartResult } from "./AcpSessionRuntime.ts";
import {
  acpRegistryProbeFailure,
  acpRegistryProbeResult,
  listAcpRegistrySessions,
  logoutAcpRegistry,
  normalizeAcpRegistryAuthMethods,
  normalizeAcpRegistryCommands,
  rewriteAcpSlashSkillMentions,
  rewriteAcpUserText,
  probeAcpRegistryConfiguration,
} from "./AcpRegistryProbe.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";

const instanceId = ProviderInstanceId.make("acpRegistry_codex");
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

describe("ACP Registry probe", () => {
  it("returns advertised auth methods and de-duplicated models", () => {
    const result = acpRegistryProbeResult(instanceId, {
      sessionId: "probe-session",
      initializeResult: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          auth: { logout: {} },
          sessionCapabilities: { list: {}, resume: {} },
        },
        authMethods: [
          { id: "chatgpt", name: "ChatGPT" },
          {
            id: "api-key",
            name: "API key",
            type: "env_var",
            vars: [{ name: "OPENAI_API_KEY", label: "OpenAI API key" }],
          },
          { id: "login", name: "Terminal login", type: "terminal" },
        ],
      },
      sessionSetupResult: {
        sessionId: "probe-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "gpt-5.4",
            options: [
              { value: "gpt-5.4", name: "GPT-5.4" },
              { value: "gpt-5.4", name: "Duplicate" },
            ],
          },
        ],
      },
      modelConfigId: "model",
    } satisfies AcpSessionRuntimeStartResult);

    expect(result).toEqual({
      instanceId,
      ready: true,
      icon: null,
      authMethods: [
        { id: "chatgpt", name: "ChatGPT", description: null, type: "agent" },
        {
          id: "api-key",
          name: "API key",
          description: null,
          type: "env_var",
          envVarNames: ["OPENAI_API_KEY"],
        },
        { id: "login", name: "Terminal login", description: null, type: "terminal" },
      ],
      models: [{ id: "gpt-5.4", name: "GPT-5.4", description: null }],
      currentModelId: "gpt-5.4",
      configOptions: [],
      sessionManagement: {
        canList: true,
        canLoad: true,
        canResume: true,
        canLogout: true,
        canDelete: false,
        canConfigureProviders: false,
      },
    });
  });

  it("composes runnable terminal auth commands from the resolved spawn recipe", () => {
    const methods = normalizeAcpRegistryAuthMethods(
      [
        {
          id: "login",
          name: "Terminal login",
          type: "terminal",
          args: ["auth", "log in"],
          env: { FORCE_TTY: "1" },
        },
      ],
      { command: "/opt/agents/devin", args: ["--acp"] },
    );

    expect(methods).toEqual([
      {
        id: "login",
        name: "Terminal login",
        description: null,
        type: "terminal",
        command: "FORCE_TTY=1 /opt/agents/devin --acp auth 'log in'",
      },
    ]);
  });

  it("omits unsafe truncated auth commands instead of publishing broken shell", () => {
    const methods = normalizeAcpRegistryAuthMethods(
      [
        {
          id: "login",
          name: "Terminal login",
          type: "terminal",
          args: ["x".repeat(2_048)],
        },
      ],
      { command: "/opt/agents/devin", args: ["--acp"] },
    );

    expect(methods[0]).not.toHaveProperty("command");
  });

  it("omits overlong opaque auth method and environment variable ids", () => {
    const methods = normalizeAcpRegistryAuthMethods([
      { id: "x".repeat(129), name: "Invalid" },
      {
        id: "api-key",
        name: "API key",
        type: "env_var",
        vars: [
          { name: "y".repeat(129), label: "Invalid" },
          { name: "OPENAI_API_KEY", label: "OpenAI API key" },
        ],
      },
    ]);

    expect(methods).toEqual([
      {
        id: "api-key",
        name: "API key",
        description: null,
        type: "env_var",
        envVarNames: ["OPENAI_API_KEY"],
      },
    ]);
  });

  it("falls back to model-category configuration options", () => {
    const result = acpRegistryProbeResult(instanceId, {
      sessionId: "probe-session",
      initializeResult: { protocolVersion: 1 },
      sessionSetupResult: {
        sessionId: "probe-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "sonnet",
            options: [
              { value: "sonnet", name: "Sonnet", description: "Balanced" },
              { value: "haiku", name: "Haiku" },
            ],
          },
        ],
      },
      modelConfigId: "model",
    } satisfies AcpSessionRuntimeStartResult);

    expect(result.models).toEqual([
      { id: "sonnet", name: "Sonnet", description: "Balanced" },
      { id: "haiku", name: "Haiku", description: null },
    ]);
    expect(result.currentModelId).toBe("sonnet");
  });

  it("omits overlong opaque model ids instead of publishing mutated ids", () => {
    const result = acpRegistryProbeResult(instanceId, {
      sessionId: "probe-session",
      initializeResult: { protocolVersion: 1 },
      sessionSetupResult: {
        sessionId: "probe-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "x".repeat(129),
            options: [
              { value: "x".repeat(129), name: "Too long" },
              { value: "valid", name: "Valid" },
            ],
          },
        ],
      },
      modelConfigId: "model",
    } satisfies AcpSessionRuntimeStartResult);

    expect(result.models).toEqual([{ id: "valid", name: "Valid", description: null }]);
    expect(result.currentModelId).toBeNull();
  });

  it("preserves grouped model values and advertises reasoning choices", () => {
    const codexModel = '["codex","gpt-6.1-sol"]';
    const goModel = '["opencode-go","deepseek-v4.1-flash"]';
    const result = acpRegistryProbeResult(instanceId, {
      sessionId: "probe-session",
      initializeResult: { protocolVersion: 1 },
      sessionSetupResult: {
        sessionId: "probe-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: goModel,
            options: [
              {
                groupId: "codex",
                name: "Codex",
                options: [{ value: codexModel, name: "GPT-6.1 Sol" }],
              },
              {
                groupId: "opencode-go",
                name: "OpenCode Go",
                options: [{ value: goModel, name: "DeepSeek V4.1 Flash" }],
              },
            ],
          },
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: "high",
            options: [
              {
                groupId: "effort",
                name: "Effort",
                options: [
                  { value: "medium", name: "Medium" },
                  { value: "high", name: "High" },
                ],
              },
            ],
          },
        ],
      },
      modelConfigId: "model",
    } satisfies AcpSessionRuntimeStartResult);

    expect(result.models).toEqual([
      { id: codexModel, name: "GPT-6.1 Sol", description: null },
      { id: goModel, name: "DeepSeek V4.1 Flash", description: null },
    ]);
    expect(result.currentModelId).toBe(goModel);
    expect(result.configOptions).toEqual([
      {
        id: "reasoning",
        label: "Reasoning",
        type: "select",
        currentValue: "high",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
      },
    ]);
  });

  it("omits a current model that falls outside the bounded model catalog", () => {
    const result = acpRegistryProbeResult(instanceId, {
      sessionId: "probe-session",
      initializeResult: { protocolVersion: 1 },
      sessionSetupResult: {
        sessionId: "probe-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "model-256",
            options: Array.from({ length: 257 }, (_, index) => ({
              value: `model-${index}`,
              name: `Model ${index}`,
            })),
          },
        ],
      },
      modelConfigId: "model",
    } satisfies AcpSessionRuntimeStartResult);

    expect(result.models).toHaveLength(256);
    expect(result.currentModelId).toBeNull();
  });

  it("bounds and de-duplicates advertised commands", () => {
    const commands = normalizeAcpRegistryCommands([
      {
        name: "create_plan",
        description: " Create a plan ",
        input: { type: "text", hint: " topic " },
      },
      { name: "CREATE_PLAN", description: "duplicate" },
      ...Array.from({ length: 140 }, (_, index) => ({
        name: `command_${index}`,
        description: "",
      })),
    ]);

    expect(commands.slashCommands).toHaveLength(128);
    expect(commands.slashCommands[0]).toEqual({
      name: "create_plan",
      description: "Create a plan",
      input: { hint: "topic" },
    });
    expect(
      commands.slashCommands.filter((command) => command.name.toLowerCase() === "create_plan"),
    ).toHaveLength(1);
    expect(commands.skills).toEqual([]);
  });

  it("routes dollar-prefixed ACP commands to the provider skill menu", () => {
    expect(
      normalizeAcpRegistryCommands([
        { name: "$workspace-skill", description: "Run the workspace skill" },
        { name: "$WORKSPACE-SKILL", description: "duplicate" },
        { name: "$", description: "empty" },
        { name: "review", description: "Review changes" },
      ]),
    ).toEqual({
      slashCommands: [{ name: "review", description: "Review changes" }],
      skills: [
        {
          name: "workspace-skill",
          description: "Run the workspace skill",
          path: "acp://skill/workspace-skill",
          scope: "agent",
          enabled: true,
        },
      ],
    });
  });

  it("lists Copilot's skill commands as skills it runs with a slash", () => {
    // Shape of Copilot CLI 1.0.98's advertisement: built-ins and skills side by side.
    const commands = normalizeAcpRegistryCommands([
      {
        name: "compact",
        description: "Summarize history",
        input: { type: "text", hint: "focus instructions" },
      },
      { name: "skills", description: "Manage skills", input: { type: "text", hint: "" } },
      {
        name: "unslop",
        description: "Cut AI tells from any writing.",
        input: { type: "text", hint: "instructions for the skill" },
      },
    ]);
    expect(commands.slashCommands.map((command) => command.name)).toEqual(["compact", "skills"]);
    expect(commands.skills).toEqual([
      {
        name: "unslop",
        description: "Cut AI tells from any writing.",
        path: "acp://command/unslop",
        scope: "agent",
        enabled: true,
      },
    ]);
  });

  it("sends a picked Copilot skill as /name and leaves every other $ token alone", () => {
    const commands = normalizeAcpRegistryCommands([
      { name: "$workspace-skill", description: "Reads $workspace-skill" },
      {
        name: "unslop",
        description: "Skill",
        input: { type: "text", hint: "instructions for the skill" },
      },
      {
        name: "review",
        description: "Built-in",
        input: { type: "text", hint: "additional instructions" },
      },
    ]);
    expect(rewriteAcpSlashSkillMentions("$unslop the README", commands)).toBe("/unslop the README");
    expect(rewriteAcpSlashSkillMentions("then $unslop it", commands)).toBe("then /unslop it");
    expect(rewriteAcpSlashSkillMentions("$workspace-skill now", commands)).toBe(
      "$workspace-skill now",
    );
    expect(rewriteAcpSlashSkillMentions("$review and echo $HOME", commands)).toBe(
      "$review and echo $HOME",
    );
    expect(rewriteAcpSlashSkillMentions("$unslop", undefined)).toBe("$unslop");
  });

  it("leaves skill mentions inside code alone", () => {
    const commands = normalizeAcpRegistryCommands([
      {
        name: "unslop",
        description: "Skill",
        input: { type: "text", hint: "instructions for the skill" },
      },
      {
        name: "HOME",
        description: "Skill",
        input: { type: "text", hint: "instructions for the skill" },
      },
    ]);
    expect(
      rewriteAcpSlashSkillMentions(
        "$unslop this:\n```sh\necho $HOME\n$unslop\n```\nand `$HOME` then $HOME",
        commands,
      ),
    ).toBe("/unslop this:\n```sh\necho $HOME\n$unslop\n```\nand `$HOME` then /HOME");
    expect(rewriteAcpSlashSkillMentions("```\n$unslop unfinished fence", commands)).toBe(
      "```\n$unslop unfinished fence",
    );
    expect(rewriteAcpSlashSkillMentions("~~~text\n$unslop\n~~~\n$unslop", commands)).toBe(
      "~~~text\n$unslop\n~~~\n/unslop",
    );
    expect(rewriteAcpSlashSkillMentions("~~~\n$unslop unfinished", commands)).toBe(
      "~~~\n$unslop unfinished",
    );
    expect(rewriteAcpSlashSkillMentions("````md\n```\n$unslop\n````\n$unslop", commands)).toBe(
      "````md\n```\n$unslop\n````\n/unslop",
    );
    expect(rewriteAcpSlashSkillMentions("```\n```\n$unslop", commands)).toBe("```\n```\n/unslop");
    expect(rewriteAcpSlashSkillMentions("run ``a ` $unslop`` then $unslop", commands)).toBe(
      "run ``a ` $unslop`` then /unslop",
    );
    // A fence closes only on its own character.
    expect(
      rewriteAcpSlashSkillMentions("```\n$unslop\n```~\n$unslop\n```\n$unslop", commands),
    ).toBe("```\n$unslop\n```~\n$unslop\n```\n/unslop");
    expect(rewriteAcpSlashSkillMentions("``` $unslop", commands)).toBe("``` $unslop");
    // CRLF line endings close a fence like LF does.
    expect(rewriteAcpSlashSkillMentions("```\r\n$unslop\r\n```\r\n$unslop", commands)).toBe(
      "```\r\n$unslop\r\n```\r\n/unslop",
    );
    expect(rewriteAcpSlashSkillMentions("~~~\r\n$unslop\r\n~~~  \r\n$unslop", commands)).toBe(
      "~~~\r\n$unslop\r\n~~~  \r\n/unslop",
    );
    // A backtick fence's info string holds no backtick: this is an inline span.
    expect(rewriteAcpSlashSkillMentions("```npm i``` then run $unslop", commands)).toBe(
      "```npm i``` then run /unslop",
    );
    // An inline span never crosses a fence or a blank line.
    expect(
      rewriteAcpSlashSkillMentions(
        "Press the ` key.\n```sh\necho `date` $unslop\n```\nthen $unslop",
        commands,
      ),
    ).toBe("Press the ` key.\n```sh\necho `date` $unslop\n```\nthen /unslop");
    expect(rewriteAcpSlashSkillMentions("a ` b\n\n$unslop ` c", commands)).toBe(
      "a ` b\n\n/unslop ` c",
    );
    // A span may still wrap inside one paragraph.
    expect(rewriteAcpSlashSkillMentions("a `b\n$unslop` c $unslop", commands)).toBe(
      "a `b\n$unslop` c /unslop",
    );
    // A mention must follow whitespace in the whole prompt, not just after code.
    expect(rewriteAcpSlashSkillMentions("see `x`$unslop now", commands)).toBe("see `x`$unslop now");
  });

  it("handles long unmatched backtick runs in linear time", () => {
    const commands = normalizeAcpRegistryCommands([
      {
        name: "unslop",
        description: "Skill",
        input: { type: "text", hint: "instructions for the skill" },
      },
    ]);
    const prompt = `x ${"`".repeat(200_000)} ${"` `` ".repeat(20_000)}$unslop`;
    const started = performance.now();
    expect(rewriteAcpSlashSkillMentions(prompt, commands).endsWith("/unslop")).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
    // Unmatched runs of many distinct lengths stay linear too.
    let distinct = "x ";
    for (let length = 1; distinct.length < 2_000_000; length += 1) {
      distinct += `${"`".repeat(length)} `;
    }
    const distinctStarted = performance.now();
    expect(rewriteAcpSlashSkillMentions(`${distinct}$unslop`, commands).endsWith("/unslop")).toBe(
      true,
    );
    expect(performance.now() - distinctStarted).toBeLessThan(500);
  });

  it("rewrites against the turn's own session before the instance's latest list", () => {
    const skill = (name: string) => ({
      name,
      description: "Skill",
      input: { type: "text" as const, hint: "instructions for the skill" },
    });
    const instance = normalizeAcpRegistryCommands([skill("other")]);
    expect(rewriteAcpUserText("$unslop it", [skill("unslop")], instance)).toBe("/unslop it");
    expect(rewriteAcpUserText("$other it", [skill("unslop")], instance)).toBe("$other it");
    expect(rewriteAcpUserText("$other it", undefined, instance)).toBe("/other it");
  });

  it.effect("captures commands advertised just after session creation", () =>
    Effect.gen(function* () {
      const result = yield* probeAcpRegistryConfiguration({
        instanceId,
        settings: decodeSettings({ agentId: "mock-agent" }),
        cwd: process.cwd(),
        environment: process.env,
      });

      expect(result.slashCommands).toEqual([
        {
          name: "review",
          description: "Review the current changes",
          input: { hint: "focus" },
        },
      ]);
      expect(result.skills).toEqual([
        {
          name: "workspace-skill",
          description: "Run the workspace skill",
          path: "acp://skill/workspace-skill",
          scope: "agent",
          enabled: true,
        },
      ]);
    }).pipe(
      Effect.provideService(
        AcpRegistrySupport.AcpRegistryCatalog,
        AcpRegistrySupport.AcpRegistryCatalog.of({
          search: () => Effect.die("unused search"),
          prepare: () => Effect.die("unused prepare"),
          inspect: () => Effect.die("unused inspect"),
          uninstallManagedBinary: () => Effect.die("unused uninstall"),
          resolve: () =>
            Effect.succeed({
              agent: {
                id: "mock-agent",
                name: "Mock Agent",
                version: "1.0.0",
                description: "ACP probe test agent",
                distribution: { npx: { package: "mock-agent@1.0.0" } },
              },
              distribution: "npx",
              spawn: {
                command: "node",
                args: [mockAgentPath],
                env: {
                  ...process.env,
                  STUDIO_ACP_COMMAND_ADVERTISEMENT_DELAY_MS: "25",
                },
              },
            }),
        }),
      ),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  );

  it.effect("includes package resolution in the probe timeout", () =>
    Effect.gen(function* () {
      const resolveStarted = yield* Deferred.make<void>();
      const catalog = AcpRegistrySupport.AcpRegistryCatalog.of({
        search: () => Effect.die("unused search"),
        prepare: () => Effect.die("unused prepare"),
        inspect: () => Effect.die("unused inspect"),
        uninstallManagedBinary: () => Effect.die("unused uninstall"),
        resolve: () =>
          Deferred.succeed(resolveStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const probe = yield* probeAcpRegistryConfiguration({
        instanceId,
        settings: decodeSettings({ agentId: "slow-agent" }),
        cwd: process.cwd(),
        environment: process.env,
      }).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Deferred.await(resolveStarted);
      yield* TestClock.adjust("60 seconds");

      expect(yield* Fiber.join(probe)).toMatchObject({
        reason: "probe_failed",
        message: expect.stringContaining("within 60 seconds"),
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("lists native sessions and logs out through generic ACP lifecycle methods", () => {
    const catalog = AcpRegistrySupport.AcpRegistryCatalog.of({
      search: () => Effect.die("unused search"),
      prepare: () => Effect.die("unused prepare"),
      inspect: () => Effect.die("unused inspect"),
      uninstallManagedBinary: () => Effect.die("unused uninstall"),
      resolve: () =>
        Effect.succeed({
          agent: {
            id: "mock-agent",
            name: "Mock Agent",
            version: "1.0.0",
            description: "ACP session management test agent",
            distribution: { npx: { package: "mock-agent@1.0.0" } },
          },
          distribution: "npx" as const,
          spawn: {
            command: "node",
            args: [mockAgentPath],
            env: {
              ...process.env,
              STUDIO_ACP_SESSION_LIFECYCLE: "1",
              STUDIO_ACP_AUTH_METHOD_ID: "mock-login",
            },
          },
        }),
    });
    const input = {
      instanceId,
      settings: decodeSettings({ agentId: "mock-agent" }),
      cwd: process.cwd(),
      environment: process.env,
    };

    return Effect.gen(function* () {
      const listed = yield* listAcpRegistrySessions(input);
      expect(listed).toMatchObject({
        canLoad: true,
        canResume: true,
        nextCursor: null,
        sessions: [
          {
            sessionId: "mock-session-1",
            cwd: process.cwd(),
            importedThreadId: null,
          },
        ],
      });
      yield* logoutAcpRegistry(input);
    }).pipe(
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    );
  });

  it.effect("preserves the ACP method error for unsupported session management", () => {
    const catalog = AcpRegistrySupport.AcpRegistryCatalog.of({
      search: () => Effect.die("unused search"),
      prepare: () => Effect.die("unused prepare"),
      inspect: () => Effect.die("unused inspect"),
      uninstallManagedBinary: () => Effect.die("unused uninstall"),
      resolve: () =>
        Effect.succeed({
          agent: {
            id: "mock-agent",
            name: "Mock Agent",
            version: "1.0.0",
            description: "ACP unsupported management test agent",
            distribution: { npx: { package: "mock-agent@1.0.0" } },
          },
          distribution: "npx" as const,
          spawn: {
            command: "node",
            args: [mockAgentPath],
            env: { ...process.env, STUDIO_ACP_OMIT_SESSION_LIST_HANDLER: "1" },
          },
        }),
    });

    return Effect.gen(function* () {
      const failure = yield* listAcpRegistrySessions({
        instanceId,
        settings: decodeSettings({ agentId: "mock-agent" }),
        cwd: process.cwd(),
        environment: process.env,
      }).pipe(Effect.flip);

      expect(failure).toMatchObject({
        reason: "session_list_unsupported",
        message: "The ACP agent does not advertise session listing.",
        cause: { _tag: "AcpRequestError", code: -32601 },
      });
    }).pipe(
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    );
  });

  it("distinguishes authentication failures from generic probe failures", () => {
    const advertised = normalizeAcpRegistryAuthMethods([
      { id: "grok-login", name: "Log in with Grok" },
    ]);
    const cause = new EffectAcpErrors.AcpRequestError({
      code: -32000,
      errorMessage: "login required",
    });
    const authFailure = acpRegistryProbeFailure(cause, advertised);
    expect(authFailure.reason).toBe("authentication_failed");
    expect(authFailure.message).toBe("The ACP agent could not complete authentication.");
    expect(authFailure.cause).toBe(cause);
    expect(authFailure.authMethods).toEqual([
      {
        id: "grok-login",
        name: "Log in with Grok",
        description: null,
        type: "agent",
      },
    ]);
    expect(
      acpRegistryProbeFailure(
        new EffectAcpErrors.AcpTransportError({
          detail: "Authentication required",
          cause: "credentials missing",
        }),
      ).reason,
    ).toBe("authentication_failed");
    const genericCause = new EffectAcpErrors.AcpTransportError({
      detail: "connection closed",
      cause: "closed",
    });
    const genericFailure = acpRegistryProbeFailure(genericCause);
    expect(genericFailure.reason).toBe("probe_failed");
    expect(genericFailure.message).toBe("The ACP agent could not create a test session.");
    expect(genericFailure.cause).toBe(genericCause);
    expect(
      acpRegistryProbeFailure(
        new EffectAcpErrors.AcpTransportError({
          detail: "Failed while logging request",
          cause: "logging failed",
        }),
      ).reason,
    ).toBe("probe_failed");
  });
});
