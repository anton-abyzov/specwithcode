/**
 * Full access means no permission prompts, for every provider. Each case pins
 * the native setting a Full access thread runs with, so a mapping that starts
 * asking again fails here instead of in a user's thread.
 */
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, type RuntimeMode } from "@specweave-studio/contracts";
import type * as EffectAcpSchema from "@specweave-studio/effect-acp/compat";
import * as Effect from "effect/Effect";

import { acpPermissionDisposition } from "../provider/acp/AcpClientPolicy.ts";
import { synchronizeAcpPermissions } from "../provider/acp/AcpPermissions.ts";
import { antigravityPermissionMode } from "../provider/acp/AntigravityAcpSupport.ts";
import { GROK_SUPPORTED_RUNTIME_MODES, grokAcpSpawnArgs } from "../provider/acp/GrokAcpSupport.ts";
import { claudeRuntimeQueryPolicyForRuntimePolicy } from "./Adapters/ClaudeAdapterV2.ts";
import { buildCodexTurnStartParams } from "./Adapters/CodexAdapterV2.ts";
import { grokLaunchRuntimeMode } from "./Adapters/GrokAdapterV2.ts";
import { providerRuntimeMode } from "./RuntimePolicy.ts";

const policy = (runtimeMode: RuntimeMode) => ({
  runtimeMode,
  interactionMode: "default" as const,
  cwd: "/tmp/full-access-matrix",
});

const permissionRequest = (
  kind: NonNullable<EffectAcpSchema.RequestPermissionRequest["toolCall"]["kind"]>,
): EffectAcpSchema.RequestPermissionRequest => ({
  options: [],
  sessionId: "full-access-session",
  toolCall: { kind, toolCallId: "full-access-tool-call", title: "/bin/cat AGENTS.md" },
});

describe("Full access runs without prompts on every provider", () => {
  it("keeps Full access for providers that list no modes or list it", () => {
    assert.equal(providerRuntimeMode("full-access", undefined), "full-access");
    assert.equal(providerRuntimeMode("full-access", []), "full-access");
    assert.equal(providerRuntimeMode("full-access", GROK_SUPPORTED_RUNTIME_MODES), "full-access");
  });

  it.effect("Codex: approval policy never with the full-access sandbox", () =>
    Effect.gen(function* () {
      const build = (runtimeMode: RuntimeMode) =>
        buildCodexTurnStartParams({
          nativeThreadId: `native-${runtimeMode}`,
          codexInput: [{ type: "text", text: "cat AGENTS.md" }],
          runtimePolicy: policy(runtimeMode),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
          hasStudioMcp: true,
        });
      const fullAccess = yield* build("full-access");
      assert.equal(fullAccess.approvalPolicy, "never");
      assert.deepEqual(fullAccess.sandboxPolicy, { type: "dangerFullAccess" });
      // What a Supervised turn sends; the October 17 worker ran a turn like this.
      const supervised = yield* build("approval-required");
      assert.equal(supervised.approvalPolicy, "untrusted");
      assert.deepEqual(supervised.sandboxPolicy, { type: "readOnly" });
    }),
  );

  it("Claude: bypassPermissions with no permission callback", () => {
    const query = claudeRuntimeQueryPolicyForRuntimePolicy(policy("full-access"));
    assert.equal(query.permissionMode, "bypassPermissions");
    assert.equal(query.installPermissionCallback, false);
    assert.equal(query.allowDangerouslySkipPermissions, true);
  });

  it.effect("Copilot: Allow All on and every tool allowed", () =>
    Effect.gen(function* () {
      let current: string | boolean = "off";
      const option = (): EffectAcpSchema.SessionConfigOption => ({
        id: "allow_all",
        name: "Allow All",
        type: "select",
        currentValue: current as string,
        options: [
          { value: "on", name: "On" },
          { value: "off", name: "Off" },
        ],
      });
      yield* synchronizeAcpPermissions(
        {
          getConfigOptions: Effect.sync(() => [option()]),
          setConfigOption: (_id: string, value: string | boolean) =>
            Effect.sync(() => {
              current = value;
              return { configOptions: [option()] };
            }),
        },
        "full-access",
      );
      assert.equal(current, "on");
      for (const kind of ["execute", "edit", "delete", "fetch", "other"] as const) {
        assert.equal(
          acpPermissionDisposition(policy("full-access"), permissionRequest(kind)),
          "allow",
        );
      }
    }),
  );

  it("Grok: launched with always-approve", () => {
    assert.include(GROK_SUPPORTED_RUNTIME_MODES, "full-access");
    assert.equal(grokLaunchRuntimeMode(policy("full-access")), "full-access");
    assert.include(grokAcpSpawnArgs("full-access"), "--always-approve");
  });

  it("Gemini: Antigravity yolo, Gemini CLI tools allowed", () => {
    assert.equal(antigravityPermissionMode("full-access"), "yolo");
    assert.equal(
      acpPermissionDisposition(policy("full-access"), permissionRequest("execute")),
      "allow",
    );
  });
});
