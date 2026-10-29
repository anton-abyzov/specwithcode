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
  const replyText = process.env.MUSE_TEST_REPLY_TEXT ?? "Hello Muse";
  const splitAt = Math.ceil(replyText.length / 2);
  notify("item/started", { item: item(turnId, "") });
  setTimeout(() => {
    notify("item/delta", { itemId: "reply-" + turnId, delta: replyText.slice(0, splitAt) });
    setTimeout(() => {
      notify("item/delta", { itemId: "reply-" + turnId, delta: replyText.slice(splitAt) });
      notify("item/completed", { item: item(turnId, replyText, "completed", 2) });
      finish(turnId);
    }, 20);
  }, 20);
};
// Wire frames of a real Muse 1.4.13 turn: reasoning, a reply, a shell approval,
// the bash call and its output, the final answer and Muse's reminder children.
let recorded;
const recordedFrames = (turnId) => {
  const fixture = JSON.parse(fs.readFileSync(__dirname + "/muse-1.4.13-turn.json", "utf8"));
  return JSON.parse(JSON.stringify(fixture.events).replaceAll(fixture.turnId, turnId));
};
const replay = (frames) => {
  for (const frame of frames) notify(frame.method, frame.params);
};
const startRecorded = (turnId, hidden) => {
  const frames = recordedFrames(turnId);
  if (hidden) {
    replay(
      frames.filter(
        (f) => f.params.item?.kind === "reminderChild" || f.method === "turn/completed",
      ),
    );
    return;
  }
  const review = frames.findIndex((f) => f.method === "approval/reviewing");
  const resolved = frames.findIndex((f) => f.method === "approval/resolved");
  replay(frames.slice(0, review));
  // The ask-me profile hands the same request to the client instead of Muse's reviewer.
  const { change: _change, ...request } = frames[review].params;
  recorded = {
    turnId,
    request,
    resolved: frames[resolved].params,
    rest: frames.slice(resolved + 1),
  };
  notify("approval/requested", request);
};
const decideRecorded = (choiceId) => {
  const { turnId, request, resolved, rest } = recorded;
  recorded = undefined;
  if (choiceId !== "allow_once") {
    notify("approval/resolved", {
      ...resolved,
      decision: "abort",
      policyResult: "deny",
      resolvedBy: "user",
    });
    finish(turnId, "cancelled");
    return;
  }
  notify("approval/resolved", { ...resolved, resolvedBy: "user", commandId: request.approvalId });
  replay(rest);
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
        schema: {
          version: process.env.MUSE_TEST_SCHEMA_VERSION ?? "1",
          fingerprint: process.env.MUSE_TEST_FINGERPRINT,
        },
        sessionDurability: process.env.MUSE_TEST_RESUME ? "durable" : "ephemeral",
        experimentalApi: false,
        grantedCapabilities:
          process.env.MUSE_TEST_GRANT_SESSION_MCP &&
          (p.capabilities?.requestedCapabilities ?? []).includes("sessionMcp")
            ? ["sessionMcp"]
            : [],
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
      // SpecWithCode threads add their instructions around the prompt; the scenario is a line of its own.
      const lines = p.input.flatMap((part) => String(part.text ?? "").split("\n"));
      const scenario = ["recorded", "recorded-hidden"].find((name) =>
        lines.some((line) => line.trim() === name),
      );
      if (scenario === "recorded" || scenario === "recorded-hidden") {
        pending = turnId;
        startRecorded(turnId, scenario === "recorded-hidden");
        return;
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
      if (recorded) {
        decideRecorded(p.choiceId);
        return;
      }
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
