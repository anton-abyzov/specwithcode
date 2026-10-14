// Contract fixture, not evidence of authenticated Copilot behavior.
import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
const scenario = process.env.COPILOT_FIXTURE_SCENARIO;
const startup = scenario?.startsWith("startup-");
const negotiation = scenario?.startsWith("startup-negotiate");
const cliArgs = process.argv.slice(2);
const startupModel = cliArgs.find((arg) => arg.startsWith("--model="))?.slice(8);
if (process.env.COPILOT_FIXTURE_RECORD_LAUNCH === "1") {
  appendFileSync(
    process.env.COPILOT_FIXTURE_LOG,
    JSON.stringify({ method: "process/launch", args: cliArgs }) + "\n",
  );
}
if (cliArgs.includes("--version")) {
  process.stdout.write(`GitHub Copilot CLI ${process.env.COPILOT_FIXTURE_VERSION ?? "1.0.97"}.\n`);
  process.exit(0);
}
if (cliArgs.includes("--help")) {
  process.stdout.write(
    scenario === "startup-no-flag"
      ? "Usage: copilot\n"
      : "Usage: copilot\n  --model <model> Select model\n",
  );
  process.exit(0);
}
const models = {
  currentModelId: "claude-opus-5.5",
  availableModels: [
    { modelId: "claude-opus-5.5", name: "Claude Opus 5.5" },
    { modelId: "grok-4.7", name: "Grok 4.7" },
  ],
};
if (startup) {
  models.currentModelId =
    scenario === "startup-auto" || negotiation
      ? "auto"
      : scenario === "startup-mismatch"
        ? "other-model"
        : (startupModel ?? "auto");
  models.availableModels = [
    { modelId: "auto", name: "Auto" },
    ...(negotiation ? [{ modelId: "claude-opus-5.5", name: "Claude Opus 5.5" }] : []),
  ];
}
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
const autoOnlyConfig = scenario === "auto-config";
let configOptions =
  scenario === "config" || negotiation
    ? [modelOption(), effort]
    : autoOnlyConfig
      ? [
          {
            ...modelOption("model", "auto"),
            options: [
              { value: "auto", name: "Auto" },
              { value: "auto", name: "Auto" },
            ],
          },
          effort,
        ]
      : [];
let pendingPrompt;
const send = (data) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...data }) + "\n");
const answer = (id, result) => send({ id, result });
const setup = () => ({
  ...(scenario === "legacy" ? { models } : {}),
  ...(startup && scenario !== "startup-missing" ? { models } : {}),
  ...(scenario === "config" || autoOnlyConfig || negotiation ? { configOptions } : {}),
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
        version:
          scenario === "startup-version-change"
            ? "1.0.98"
            : startup || autoOnlyConfig
              ? "1.0.97"
              : "1.0.94",
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
    if (scenario === "startup-reject")
      send({ id, error: { code: -32602, message: "Requested startup model is unavailable" } });
    else if (scenario === "auth")
      send({ id, error: { code: -32000, message: "Authentication required" } });
    else answer(id, { sessionId: "copilot-fixture", ...setup() });
  } else if (method === "session/set_model") {
    if (startup && params.modelId !== "auto") {
      send({
        id,
        error: {
          code: -32602,
          message: `Invalid modelId '${params.modelId}': not one of this session's models.`,
        },
      });
      continue;
    }
    if (autoOnlyConfig && params.modelId === "unavailable-model") {
      send({ id, error: { code: -32602, message: "Requested model is unavailable" } });
      continue;
    }
    models.currentModelId = params.modelId;
    answer(id, {});
  } else if (method === "session/set_config_option") {
    if (scenario === "startup-negotiate-denied") {
      send({ id, error: { code: -32602, message: "Native model denied" } });
      continue;
    }
    if (scenario === "startup-negotiate-empty") {
      answer(id, { configOptions: [] });
      continue;
    }
    if (params.configId === "effort")
      configOptions = [modelOption("model-live"), { ...effort, currentValue: params.value }];
    else if (params.configId === configOptions[0]?.id)
      configOptions = [{ ...configOptions[0], currentValue: params.value }, configOptions[1]];
    else {
      send({ id, error: { code: -32602, message: "Stale config id" } });
      continue;
    }
    if (scenario === "startup-negotiate-auto") configOptions[0].currentValue = "auto";
    if (scenario === "startup-negotiate-wrong") configOptions[0].currentValue = "other-model";
    answer(id, { configOptions });
  } else if (method === "session/load") answer(id, setup());
  else if (method === "session/prompt") {
    if (startup) {
      answer(id, { stopReason: "end_turn" });
      continue;
    }
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
