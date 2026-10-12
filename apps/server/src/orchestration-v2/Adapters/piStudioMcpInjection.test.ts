import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  PI_STUDIO_MCP_EXTENSION_FILENAME,
  STUDIO_MCP_BEARER_ENV,
  STUDIO_MCP_URL_ENV,
  STUDIO_PI_RESPONSE_STYLE_ENV,
  STUDIO_PI_RUNTIME_MODE_ENV,
} from "./piStudioMcpExtensionSource.ts";
import {
  buildPiRpcLaunch,
  materializePiStudioMcpExtension,
  resolvePiLaunchArgs,
} from "./piStudioMcpInjection.ts";

const threadId = ThreadId.make("thread-pi-studio-mcp");

const mcpSession = {
  environmentId: EnvironmentId.make("environment-pi-studio-mcp"),
  threadId,
  providerSessionId: "mcp-session-pi",
  providerInstanceId: ProviderInstanceId.make("pi"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer secret-pi-token",
  browserToolsAvailable: true,
};

describe("pi Studio MCP injection", () => {
  it("always adds the permission bridge and configures MCP when available", () => {
    const resolvedArgs = resolvePiLaunchArgs(
      "--extension=/home/user/.pi/agent/extensions/demo.ts --session-dir=/tmp/pi-sessions --provider=anthropic --model=claude-sonnet --tools='' --name=-review --extension-flag=kept",
    );
    assert.isTrue(resolvedArgs.ok);
    if (!resolvedArgs.ok) return;
    const launch = buildPiRpcLaunch({
      launchArgs: resolvedArgs.args,
      environment: { PATH: "/usr/bin" },
      mcpSession,
      extensionPath: "/tmp/cache/pi-studio-mcp-extension.ts",
      runtimeMode: "approval-required",
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--extension",
      "/home/user/.pi/agent/extensions/demo.ts",
      "--session-dir",
      "/tmp/pi-sessions",
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet",
      "--tools",
      "",
      "--name",
      "-review",
      "--extension-flag=kept",
      "--extension",
      "/tmp/cache/pi-studio-mcp-extension.ts",
    ]);
    assert.notInclude(launch.args, "--no-extensions");
    assert.equal(launch.env[STUDIO_MCP_URL_ENV], "http://127.0.0.1:43123/mcp");
    assert.equal(launch.env[STUDIO_MCP_BEARER_ENV], "secret-pi-token");
    assert.equal(launch.env[STUDIO_PI_RUNTIME_MODE_ENV], "approval-required");

    const permissionOnly = buildPiRpcLaunch({
      launchArgs: [],
      environment: {
        [STUDIO_MCP_URL_ENV]: "http://127.0.0.1:9999/stale",
        [STUDIO_MCP_BEARER_ENV]: "stale-token",
      },
      mcpSession: undefined,
      extensionPath: "/tmp/cache/pi-studio-mcp-extension.ts",
      runtimeMode: "auto-accept-edits",
    });
    assert.deepEqual(permissionOnly.args, [
      "--mode",
      "rpc",
      "--extension",
      "/tmp/cache/pi-studio-mcp-extension.ts",
    ]);
    assert.isFalse(permissionOnly.hasStudioMcp);
    assert.isUndefined(permissionOnly.env[STUDIO_MCP_URL_ENV]);
    assert.isUndefined(permissionOnly.env[STUDIO_MCP_BEARER_ENV]);
    assert.equal(permissionOnly.env[STUDIO_PI_RUNTIME_MODE_ENV], "auto-accept-edits");
  });

  it("falls back to Pi's first supported mode for legacy auto threads", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [],
      environment: {},
      mcpSession: undefined,
      extensionPath: "/tmp/cache/pi-studio-mcp-extension.ts",
      runtimeMode: "auto",
    });

    assert.equal(launch.env[STUDIO_PI_RUNTIME_MODE_ENV], "approval-required");
  });

  it("passes the chosen response style to the Studio extension, concise by default", () => {
    const launch = (responseStyle?: "concise" | "detailed") =>
      buildPiRpcLaunch({
        launchArgs: [],
        environment: { [STUDIO_PI_RESPONSE_STYLE_ENV]: "detailed" },
        mcpSession: undefined,
        extensionPath: "/tmp/cache/pi-studio-mcp-extension.ts",
        ...(responseStyle === undefined ? {} : { responseStyle }),
      }).env[STUDIO_PI_RESPONSE_STYLE_ENV];
    assert.equal(launch(), "concise");
    assert.equal(launch("concise"), "concise");
    assert.equal(launch("detailed"), "detailed");
  });

  it("forces tools and user extensions off for unattended text generation", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [
        "--tools",
        "read,write",
        "--extension",
        "/home/user/.pi/agent/extensions/demo.ts",
        "--extension=./second.ts",
        "--provider",
        "anthropic",
      ],
      environment: {},
      mcpSession,
      extensionPath: "/tmp/cache/pi-studio-mcp-extension.ts",
      ephemeral: true,
      disableExtensions: true,
      disableTools: true,
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--no-session",
      "--provider",
      "anthropic",
      "--no-extensions",
      "--no-tools",
    ]);
    assert.isFalse(launch.hasStudioMcp);
    assert.deepInclude(resolvePiLaunchArgs("--mode text"), {
      ok: false,
      message:
        "Pi launch argument '--mode' is controlled by SpecWithCode and cannot be overridden.",
    });
    assert.deepInclude(resolvePiLaunchArgs("--session old.jsonl"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("prompt pi immediately"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("--plan @instructions.md"), { ok: false });
  });

  it("rejects --provider without --model, which Pi 1.0 refuses at startup", () => {
    const rejection = {
      ok: false,
      message: "Pi launch argument '--provider' requires '--model'.",
    };
    assert.deepInclude(resolvePiLaunchArgs("--provider openrouter"), rejection);
    assert.deepInclude(resolvePiLaunchArgs("--provider=openrouter --models gpt-6"), rejection);
    assert.isTrue(resolvePiLaunchArgs("--provider openrouter --model=deepseek/v4").ok);
    assert.isTrue(resolvePiLaunchArgs("--model deepseek/v4").ok);
  });

  it.effect("materializes the MCP bridge with namespaced tool registration", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-pi-extensions-" });
      const mcpDest = yield* materializePiStudioMcpExtension(cacheDir);
      assert.isTrue(mcpDest.endsWith(PI_STUDIO_MCP_EXTENSION_FILENAME));
      const mcpSource = yield* fs.readFileString(mcpDest);
      assert.include(mcpSource, "export default async function studioMcpExtension");
      assert.include(mcpSource, "before_agent_start");
      assert.include(mcpSource, 'pi.on("tool_call"');
      assert.include(mcpSource, "Allow ${event.toolName}?");
      assert.include(mcpSource, '"mcp-protocol-version"');
      assert.include(mcpSource, '"tools/call"');
      assert.include(mcpSource, "mcp__studio-code__");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
