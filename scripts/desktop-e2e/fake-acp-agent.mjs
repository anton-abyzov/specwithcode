// Deterministic offline ACP agent for installed-e2e.mjs. It never contacts a
// model or network service. SpecWithCode registers it as a local ACP provider
// instance and runs it with the installed app executable as Node
// (ELECTRON_RUN_AS_NODE=1), so it must only use Node built-ins.
//
// Every prompt is answered with one message: "E2E fake agent reply <token>",
// where <token> is the first E2E-[A-Za-z0-9-]+ word in the prompt (or "none").
// Each received method is appended as one JSON line to $SWC_E2E_FAKE_ACP_LOG.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const LOG = process.env.SWC_E2E_FAKE_ACP_LOG;
const MODEL_ID = "fake-e2e-1";
const log = (entry) => {
  if (!LOG) return;
  try {
    NodeFS.appendFileSync(
      LOG,
      `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`,
    );
  } catch {}
};
const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
const models = {
  availableModels: [{ modelId: MODEL_ID, name: "Fake E2E 1" }],
  currentModelId: MODEL_ID,
};
let sessionCount = 0;

log({ event: "start", argv: process.argv.slice(1), cwd: process.cwd() });

NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === undefined) return;
  const { id, method, params = {} } = message;
  log({ event: "recv", method });
  if (method === "initialize") {
    return send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: {},
          mcpCapabilities: { http: false, sse: false },
        },
        // One agent-handled sign-in, so the installed app can confirm it the way a
        // person signs in; the coordinator only runs on a signed-in provider.
        authMethods: [{ id: "e2e-sign-in", name: "E2E sign-in", description: null }],
        agentInfo: { name: "swc-e2e-fake", version: "0.0.0-e2e" },
      },
    });
  }
  if (method === "authenticate") return send({ id, result: {} });
  if (method === "session/new") {
    sessionCount += 1;
    const sessionId = `e2e-session-${process.pid}-${sessionCount}`;
    log({ event: "session", sessionId, cwd: params.cwd ?? null });
    return send({ id, result: { sessionId, models } });
  }
  if (
    method === "session/set_model" ||
    method === "session/set_mode" ||
    method === "session/set_config_option"
  ) {
    return send({ id, result: {} });
  }
  if (method === "session/prompt") {
    const text = (params.prompt ?? []).map((part) => part.text ?? "").join(" ");
    const token = /\bE2E-[A-Za-z0-9-]+/u.exec(text)?.[0] ?? "none";
    const reply = `E2E fake agent reply ${token}`;
    log({ event: "prompt", sessionId: params.sessionId, token, reply, promptChars: text.length });
    send({
      method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } },
      },
    });
    return send({ id, result: { stopReason: "end_turn" } });
  }
  if (method === "session/cancel") return;
  if (id !== undefined) {
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});

process.stdin.on("end", () => {
  log({ event: "exit" });
  process.exit(0);
});
