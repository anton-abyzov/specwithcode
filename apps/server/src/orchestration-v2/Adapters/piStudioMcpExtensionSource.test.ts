import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";

import {
  STUDIO_CONCISE_RESPONSE_STYLE_INSTRUCTIONS,
  STUDIO_DETAILED_RESPONSE_STYLE_INSTRUCTIONS,
  STUDIO_MEDIA_INSTRUCTIONS,
} from "../../provider/RuntimeInstructions.ts";
import { STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS } from "../../provider/StudioOrchestrationInstructions.ts";
import {
  PI_STUDIO_MCP_EXTENSION_SOURCE,
  STUDIO_PI_RESPONSE_STYLE_ENV,
  STUDIO_PI_RUNTIME_MODE_ENV,
} from "./piStudioMcpExtensionSource.ts";

type RequestHook = (
  event: { payload: unknown },
  ctx: { model: { provider: string } },
) => Record<string, unknown> | undefined;

async function loadHandlers(env: Record<string, string> = {}) {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  // Execute the shipped extension with MCP disabled; this path needs no Typebox.
  const source = NodeModule.stripTypeScriptTypes(
    PI_STUDIO_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "")
      .replace('import * as NodeCrypto from "node:crypto";', "")
      .replace("export default async function", "async function"),
  );
  await NodeVM.runInNewContext(`${source}\nstudioMcpExtension(pi)`, {
    process: { env },
    NodeCrypto,
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
    // Pi has no runtime_info block, so the one-image rule rides here.
    assert.include(concise, STUDIO_MEDIA_INSTRUCTIONS);
    // Without a Studio MCP session there are no Studio tools to orchestrate with.
    assert.notInclude(concise, STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    const detailed = await systemPromptFor({ [STUDIO_PI_RESPONSE_STYLE_ENV]: "detailed" });
    assert.include(detailed, STUDIO_DETAILED_RESPONSE_STYLE_INSTRUCTIONS);
    assert.notInclude(detailed, STUDIO_CONCISE_RESPONSE_STYLE_INSTRUCTIONS);
  });
});

type ToolCallHook = (
  event: { toolName: string; input: unknown },
  ctx: { ui: { confirm: (title: string, detail: string) => Promise<boolean> } },
) => Promise<{ block: true; reason: string } | undefined>;

describe("Pi tool approval details", () => {
  it("gives long calls that differ only past the shown text different details", async () => {
    const hook = (await loadHandlers({ [STUDIO_PI_RUNTIME_MODE_ENV]: "approval-required" })).get(
      "tool_call",
    ) as ToolCallHook | undefined;
    assert.isDefined(hook);
    const details: string[] = [];
    const ctx = {
      ui: {
        confirm: async (_title: string, detail: string) => {
          details.push(detail);
          return true;
        },
      },
    };
    const filler = "a".repeat(4_100);
    await hook!({ toolName: "bash", input: { command: `${filler}\necho one` } }, ctx);
    await hook!({ toolName: "bash", input: { command: `${filler}\necho one` } }, ctx);
    await hook!({ toolName: "bash", input: { command: `${filler}\necho two` } }, ctx);
    await hook!({ toolName: "bash", input: { command: "ls" } }, ctx);
    const [first, repeat, other, short] = details;
    // The session grant is keyed on this detail, so identical calls must match
    // and calls that differ anywhere in their arguments must not.
    assert.equal(first, repeat);
    assert.notEqual(first, other);
    const fullText = JSON.stringify({ command: `${filler}\necho one` }, null, 2);
    assert.isTrue(first!.startsWith(fullText.slice(0, 4_000)));
    assert.isBelow(first!.length, fullText.length);
    assert.match(first!, /\n\.\.\. \d+ more characters not shown \(sha256 [0-9a-f]{64}\)$/);
    assert.equal(short, JSON.stringify({ command: "ls" }, null, 2));
  });
});

async function loadRequestHook(): Promise<RequestHook> {
  const handlers = new Map<string, RequestHook>();
  // Execute the shipped extension with MCP disabled; this path needs no Typebox.
  const source = NodeModule.stripTypeScriptTypes(
    PI_STUDIO_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "")
      .replace('import * as NodeCrypto from "node:crypto";', "")
      .replace("export default async function", "async function"),
  );
  await NodeVM.runInNewContext(`${source}\nstudioMcpExtension(pi)`, {
    process: { env: {} },
    NodeCrypto,
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
