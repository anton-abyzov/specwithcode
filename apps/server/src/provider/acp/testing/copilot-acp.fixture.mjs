// Contract fixture, not evidence of authenticated Copilot behavior.
import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
const scenario = process.env.COPILOT_FIXTURE_SCENARIO;
const models = {
  currentModelId: "claude-opus-5.5",
  availableModels: [
    { modelId: "claude-opus-5.5", name: "Claude Opus 5.5" },
    { modelId: "grok-4.7", name: "Grok 4.7" },
  ],
};
const modelOption = (id = "model-1", currentValue = models.currentModelId) => ({
  id,
  category: "model",
  name: "Model",
  type: "select",
  currentValue,
  options: [
    {
      group: "models",
      name: "Models",
      options: models.availableModels.map((m) => ({ value: m.modelId, name: m.name })),
    },
  ],
});
const effort = {
  id: "effort",
  category: "thought_level",
  name: "Effort",
  type: "select",
  currentValue: "high",
  options: [
    { value: "high", name: "High" },
    { value: "low", name: "Low" },
  ],
};
let configOptions = scenario === "config" ? [modelOption(), effort] : [];
let pendingPrompt;
const send = (data) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...data }) + "\n");
const answer = (id, result) => send({ id, result });
const setup = () => ({
  ...(scenario === "legacy" ? { models } : {}),
  ...(scenario === "config" ? { configOptions } : {}),
});
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  appendFileSync(process.env.COPILOT_FIXTURE_LOG, JSON.stringify(message) + "\n");
  const { id, method, params } = message;
  if (method === "initialize") {
    // Captured from unauthenticated @github/copilot 1.0.94; absolute install path redacted.
    answer(id, {
      protocolVersion: 1,
      agentInfo: {
        name: process.env.COPILOT_FIXTURE_AGENT_NAME ?? "Copilot",
        title: "Copilot",
        version: "1.0.94",
      },
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: true },
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: { close: {}, list: {} },
      },
      authMethods: [
        {
          id: "copilot-login",
          name: "Log in with Copilot CLI",
          description: "Run `copilot login` in the terminal",
          _meta: {
            "terminal-auth": {
              command: "/managed/copilot-native",
              args: ["login"],
              label: "Copilot Login",
            },
          },
        },
      ],
    });
  } else if (method === "session/new") {
    if (scenario === "auth")
      send({ id, error: { code: -32000, message: "Authentication required" } });
    else answer(id, { sessionId: "copilot-fixture", ...setup() });
  } else if (method === "session/set_model") {
    models.currentModelId = params.modelId;
    answer(id, {});
  } else if (method === "session/set_config_option") {
    if (params.configId === "effort")
      configOptions = [modelOption("model-live"), { ...effort, currentValue: params.value }];
    else if (params.configId === configOptions[0]?.id)
      configOptions = [{ ...configOptions[0], currentValue: params.value }, configOptions[1]];
    else {
      send({ id, error: { code: -32602, message: "Stale config id" } });
      continue;
    }
    answer(id, { configOptions });
  } else if (method === "session/load") answer(id, setup());
  else if (method === "session/prompt") {
    pendingPrompt = id;
    send({
      method: "session/update",
      params: {
        sessionId: "copilot-fixture",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Fixture stream" },
        },
      },
    });
    send({
      id: "permission",
      method: "session/request_permission",
      params: {
        sessionId: "copilot-fixture",
        toolCall: { toolCallId: "write", title: "Write file", kind: "edit", status: "pending" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    });
  } else if (id === "permission") {
    if (message.result?.outcome?.optionId === "allow")
      writeFileSync(process.env.COPILOT_FIXTURE_WRITE, "approved");
    answer(pendingPrompt, { stopReason: "end_turn" });
  } else if (id != null) send({ id, error: { code: -32601, message: "Unsupported in fixture" } });
}
