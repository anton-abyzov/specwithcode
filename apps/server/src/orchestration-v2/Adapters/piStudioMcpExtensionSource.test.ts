import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";

import {
  STUDIO_CONCISE_RESPONSE_STYLE_INSTRUCTIONS,
  STUDIO_DETAILED_RESPONSE_STYLE_INSTRUCTIONS,
} from "../../provider/RuntimeInstructions.ts";
import { STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS } from "../../provider/StudioOrchestrationInstructions.ts";
import {
  PI_STUDIO_MCP_EXTENSION_SOURCE,
  STUDIO_PI_RESPONSE_STYLE_ENV,
} from "./piStudioMcpExtensionSource.ts";

type RequestHook = (
  event: { payload: unknown },
  ctx: { model: { provider: string } },
) => Record<string, unknown> | undefined;

async function loadHandlers(env: Record<string, string> = {}) {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  // Execute the shipped extension with MCP disabled; this path needs no Typebox.
  const source = NodeModule.stripTypeScriptTypes(
    PI_STUDIO_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nstudioMcpExtension(pi)`, {
    process: { env },
    pi: {
      on: (name: string, handler: (...args: never[]) => unknown) => handlers.set(name, handler),
    },
  });
  return handlers;
}

async function systemPromptFor(env: Record<string, string> = {}): Promise<string> {
  const hook = (await loadHandlers(env)).get("before_agent_start") as
    | ((event: { systemPrompt: string }) => { systemPrompt: string })
    | undefined;
  assert.isDefined(hook);
  return hook!({ systemPrompt: "PI_BASE" }).systemPrompt;
}

describe("Pi response style", () => {
  it("adds the concise style by default and the detailed one when chosen, even without MCP", async () => {
    const concise = await systemPromptFor();
    assert.isTrue(concise.startsWith("PI_BASE\n\n"));
    assert.include(concise, STUDIO_CONCISE_RESPONSE_STYLE_INSTRUCTIONS);
    // Without a Studio MCP session there are no Studio tools to orchestrate with.
    assert.notInclude(concise, STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    const detailed = await systemPromptFor({ [STUDIO_PI_RESPONSE_STYLE_ENV]: "detailed" });
    assert.include(detailed, STUDIO_DETAILED_RESPONSE_STYLE_INSTRUCTIONS);
    assert.notInclude(detailed, STUDIO_CONCISE_RESPONSE_STYLE_INSTRUCTIONS);
  });
});

async function loadRequestHook(): Promise<RequestHook> {
  const handlers = new Map<string, RequestHook>();
  // Execute the shipped extension with MCP disabled; this path needs no Typebox.
  const source = NodeModule.stripTypeScriptTypes(
    PI_STUDIO_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nstudioMcpExtension(pi)`, {
    process: { env: {} },
    pi: { on: (name: string, handler: RequestHook) => handlers.set(name, handler) },
  });
  const hook = handlers.get("before_provider_request");
  assert.isDefined(hook);
  return hook!;
}

describe("Pi upstream output-budget workaround", () => {
  it.each(["max_tokens", "max_completion_tokens"])(
    "caps %s without changing the conversation or tools",
    async (key) => {
      const hook = await loadRequestHook();
      const payload = {
        model: "moonshotai/kimi-k2.6",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "read" } }],
        [key]: 231_969,
      };
      const result = hook({ payload }, { model: { provider: "openrouter" } });
      assert.equal(result?.[key], 32_768);
      assert.strictEqual(result?.messages, payload.messages);
      assert.strictEqual(result?.tools, payload.tools);
      assert.equal(result?.model, payload.model);
      assert.equal(payload[key], 231_969);
    },
  );

  it("preserves smaller budgets and other providers' payloads", async () => {
    const hook = await loadRequestHook();
    for (const payload of [{ max_tokens: 8192 }, { max_completion_tokens: 32_768 }, {}, null]) {
      assert.isUndefined(hook({ payload }, { model: { provider: "openrouter" } }));
    }
    assert.isUndefined(
      hook({ payload: { max_tokens: 231_969 } }, { model: { provider: "anthropic" } }),
    );
  });
});
