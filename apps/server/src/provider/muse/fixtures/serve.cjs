// Deterministic MSP fixture. Never contacts a model, account, or external service.
const readline = require("node:readline");
const fs = require("node:fs");
let model = "muse-wonder-1.0";
let cursor = 0;
let pending;
const sessionId = "native-muse-session";
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
const notify = (method, params) =>
  send({ method, params: { sessionId, viewCursor: String(++cursor), ...params } });
const finish = (turnId, terminal = "completed") =>
  notify("turn/completed", { turnId, terminal, sourceRange: { first: 1, last: 1 } });
const item = (turnId, text, status = "inProgress", revision = 1) => ({
  itemId: "reply-" + turnId,
  turnId,
  kind: "agentMessage",
  text,
  status,
  revision,
});
const reply = (turnId) => {
  notify("item/started", { item: item(turnId, "") });
  setTimeout(() => {
    notify("item/delta", { itemId: "reply-" + turnId, delta: "Hello " });
    setTimeout(() => {
      notify("item/delta", { itemId: "reply-" + turnId, delta: "Muse" });
      notify("item/completed", { item: item(turnId, "Hello Muse", "completed", 2) });
      finish(turnId);
    }, 20);
  }, 20);
};
const approval = (turnId) => ({
  approvalId: "approve-one",
  turnId,
  toolCallId: "tool-one",
  toolName: "shell",
  rawArgs: '{"command":"echo fixture"}',
  currentRequirementId: { approvalId: "approve-one", sourceIndex: 0 },
  itemId: "tool-one",
  judgeEscalated: false,
  protectedWrite: false,
  taskId: "task-one",
  subject: { kind: "tool" },
  sourceRange: { first: 1, last: 1 },
  availableChoices: [
    { choiceId: "once", scope: "once", decision: "approved", label: "Allow once" },
    { choiceId: "forever", scope: "session", decision: "approved", label: "Always allow" },
    { choiceId: "deny", scope: "once", decision: "denied", label: "Deny" },
  ],
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params: p = {} } = JSON.parse(line);
  if (id === undefined) return;
  fs.appendFileSync("requests.jsonl", JSON.stringify({ method, params: p }) + "\n");
  const snapshot = {
    sessionId,
    modelId: model,
    workspaceRoot: process.env.MUSE_TEST_WRONG_CWD ? "/elsewhere" : process.cwd(),
    activeTurnId: null,
    status: "idle",
    providerId: "meta",
  };
  let result = {};
  switch (method) {
    case "initialize":
      result = {
        serverInfo: { name: "muse-fixture", version: "1.0.0" },
        schema: { version: "1", fingerprint: process.env.MUSE_TEST_FINGERPRINT },
        sessionDurability: process.env.MUSE_TEST_RESUME ? "durable" : "ephemeral",
        experimentalApi: false,
        grantedCapabilities: [],
        museHome: process.cwd(),
        platformFamily: "unix",
        platformOs: "macos",
        userAgent: "fixture",
      };
      break;
    case "model/list":
      result = {
        source: "providerCatalog",
        providerId: "meta",
        models: [
          {
            modelId: "muse-wonder-1.0",
            displayLabel: "Muse Wonder",
            isDefault: true,
            variants: ["high", "max"],
          },
          {
            modelId: "muse-wonder-full",
            displayLabel: "Muse Wonder Full",
            isDefault: false,
            variants: ["high", "max"],
          },
        ],
      };
      break;
    case "usage/read":
      result = {
        usage: {
          observedAtMs: Date.now(),
          tier: "power",
          window: { usedPercent: 10, resetsAtMs: Date.now() + 60000 },
          weekly: { usedPercent: 20, resetsAtMs: Date.now() + 600000 },
        },
      };
      break;
    case "session/start":
    case "session/resume":
      result = {
        session: snapshot,
        viewCursor: String(cursor),
        pendingRequests: [],
        history: { mode: "none", items: null, snapshot: null, noneReason: "excluded" },
      };
      if (process.env.MUSE_TEST_RESUME && method === "session/resume") {
        pending = "restored-turn";
        send({ id, result });
        notify("approval/requested", approval(pending));
        return;
      }
      break;
    case "approval/listPending":
      result = {
        approvals: process.env.MUSE_TEST_RESUME ? [approval("restored-turn")] : [],
        userInputs: [],
      };
      break;
    case "userInput/cancel":
      send({ id, result: {} });
      finish(pending, "cancelled");
      return;
    case "session/read":
      result = {
        session: snapshot,
        viewCursor: String(cursor),
        pendingRequests: [],
        history: { mode: "none", items: null, snapshot: null },
      };
      break;
    case "session/setApprovalMode":
      result = { effectiveMode: { mode: p.mode, source: "user", lastCommandId: p.commandId } };
      break;
    case "session/setModel":
      if (!process.env.MUSE_TEST_MODEL_REFUSAL) model = p.model.modelId;
      break;
    case "turn/start": {
      const turnId = p.commandId;
      result = {
        commandId: p.commandId,
        status: "accepted",
        disposition: "started",
        startedNewTurn: true,
        turnId,
      };
      send({ id, result });
      notify("turn/started", {
        turnId,
        commandId: p.commandId,
        sourceRange: { first: 1, last: 1 },
      });
      const text = p.input[0].text;
      if (text === "question") {
        pending = turnId;
        notify("userInput/requested", {
          userInputId: "question-one",
          turnId,
          itemId: "question-item",
          toolCallId: "question-tool",
          toolName: "askUser",
          questions: [],
        });
        return;
      }
      if (text === "wait") {
        pending = turnId;
        return;
      }
      if (text === "fail") {
        finish(turnId, "failed");
        return;
      }
      if (text === "crash") {
        process.exit(1);
      }
      if (text === "approve") {
        pending = turnId;
        notify("approval/requested", approval(turnId));
        return;
      }
      reply(turnId);
      return;
    }
    case "approval/decide":
      send({ id, result: {} });
      if (p.choiceId === "once") reply(pending);
      else finish(pending, "cancelled");
      return;
    case "turn/cancel":
      send({ id, result: {} });
      finish(p.turnId, "cancelled");
      return;
  }
  send({ id, result });
});
