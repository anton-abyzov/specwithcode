#!/usr/bin/env node
/**
 * A model-free ACP agent for the chaos rigs (1465). It spends no tokens and
 * reads its behaviour from a control file at every prompt, so a runner can
 * flip a usage limit on or off while the server keeps running:
 *
 *   chaos-agent.mjs --instance <id> --control <control.json> --log <turns.jsonl> [--model <id>]
 *
 * control.json: { "instances": { "<id>": { "limited": bool, "delayMs": n,
 *   "workThenLimit": bool, "crash": bool } } }. A missing file or entry means
 * "answer normally at once".
 *
 * - `limited` answers with a provider limit notice and no work, the way
 *   GitHub Copilot answers a spent quota. The server classifies that reply as a
 *   usage limit (packages/shared/src/usageLimitReply.ts) and names no reset.
 * - `workThenLimit` first reports a finished tool call, then the notice: a
 *   limit that stops a turn mid-stream after real work.
 * - `crash` exits the process during the turn.
 * - `delayMs` holds the turn that long before answering.
 *
 * A prompt line `MCP-CALL {"name","arguments"}` makes that studio-code MCP
 * call with the thread's own credential (any number of lines, in order), so a
 * coordinator can fan out `delegate_task` workers. A call whose arguments carry
 * a `clientRequestId` runs once across every instance (`<control>.calls/`): a
 * fallback's context handoff repeats the original message, and a replayed
 * launch would be the rig's doing, not the server's. A line `CHAOS-REPLY <text>`
 * is echoed in the answer; a line `CHAOS-RESULT <token>` is answered as
 * `Result <token> from <instance>.`, text that appears in no prompt, so the
 * checker can see a worker's answer reach its launcher. Every prompt is appended to the log with what the
 * agent did, so the checker has a witness that does not come from the server.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

function arg(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? null : (process.argv[at + 1] ?? null);
}
const instance = arg("--instance") ?? "chaos";
const controlFile = arg("--control");
const logFile = arg("--log");
const model = arg("--model") ?? "chaos";
const sessions = new Map();
const cwds = new Map();
const held = new Map();

/** The notice GitHub Copilot sends for a spent quota, minus its request id. */
const LIMIT_NOTICE = "Error: You've hit your usage limit.";

const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const say = (sessionId, text) =>
  send({
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });
const toolDone = (sessionId, title) =>
  send({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `chaos-${NodeCrypto.randomUUID()}`,
        title,
        kind: "read",
        status: "completed",
      },
    },
  });

function control() {
  if (!controlFile || !NodeFS.existsSync(controlFile)) return {};
  try {
    return JSON.parse(NodeFS.readFileSync(controlFile, "utf8")).instances?.[instance] ?? {};
  } catch {
    // A runner mid-write: answer normally rather than invent a fault.
    return {};
  }
}

/**
 * Claims the call key for this turn by creating its marker file, which fails
 * when another instance created it first (no read-then-write race). A call
 * that fails gives its claim back, so a later turn may retry it.
 */
function claimCall(key) {
  if (!controlFile) return () => {};
  const dir = `${controlFile}.calls`;
  NodeFS.mkdirSync(dir, { recursive: true });
  const marker = `${dir}/${key.replace(/[^\w.-]/g, "_")}`;
  try {
    NodeFS.closeSync(NodeFS.openSync(marker, "wx"));
  } catch {
    return null;
  }
  return () => NodeFS.rmSync(marker, { force: true });
}

function log(entry) {
  if (logFile)
    NodeFS.appendFileSync(
      logFile,
      JSON.stringify({ instance, at: new Date().toISOString(), ...entry }) + "\n",
    );
}

function mcpEndpoint(mcpServers) {
  if (process.env.STUDIO_ACP_MCP_ENDPOINT && process.env.STUDIO_ACP_MCP_AUTHORIZATION)
    return {
      url: process.env.STUDIO_ACP_MCP_ENDPOINT,
      authorization: process.env.STUDIO_ACP_MCP_AUTHORIZATION,
    };
  for (const server of mcpServers ?? []) {
    if (server.name !== "studio-code") continue;
    if (server.url) {
      const header = (server.headers ?? []).find(
        (entry) => entry.name.toLowerCase() === "authorization",
      );
      if (header) return { url: server.url, authorization: header.value };
    }
    const env = Object.fromEntries((server.env ?? []).map((entry) => [entry.name, entry.value]));
    if (env.STUDIO_ACP_MCP_ENDPOINT && env.STUDIO_ACP_MCP_AUTHORIZATION)
      return { url: env.STUDIO_ACP_MCP_ENDPOINT, authorization: env.STUDIO_ACP_MCP_AUTHORIZATION };
  }
  return null;
}

async function mcpCall(endpoint, name, args) {
  const post = (body, session) =>
    fetch(endpoint.url, {
      method: "POST",
      headers: {
        Authorization: endpoint.authorization,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
        ...(session ? { "Mcp-Session-Id": session } : {}),
      },
      body: JSON.stringify(body),
    });
  const read = async (response) => {
    const text = await response.text();
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream"))
      return text ? JSON.parse(text) : null;
    return text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)))
      .find((message) => message.id !== undefined);
  };
  const initialized = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "chaos-agent", version: "1" },
    },
  });
  if (initialized.status !== 200)
    return { status: initialized.status, body: await initialized.text() };
  const session = initialized.headers.get("mcp-session-id");
  await read(initialized);
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
  const called = await post(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
    session,
  );
  return { status: called.status, body: await read(called) };
}

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const text = (params.prompt ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  const behaviour = control();
  const base = { sessionId, cwd: cwds.get(sessionId) ?? null, text };
  if (behaviour.delayMs > 0) {
    held.set(sessionId, id);
    await new Promise((done) => setTimeout(done, behaviour.delayMs));
    if (held.get(sessionId) !== id) return log({ ...base, outcome: "cancelled" });
    held.delete(sessionId);
  }
  if (behaviour.crash) {
    log({ ...base, outcome: "crash" });
    process.exit(70);
  }
  if (behaviour.limited || behaviour.workThenLimit) {
    if (behaviour.workThenLimit) toolDone(sessionId, "Read the chaos fixture");
    say(sessionId, LIMIT_NOTICE);
    log({ ...base, outcome: behaviour.workThenLimit ? "work_then_limit" : "limit" });
    return send({ id, result: { stopReason: "end_turn" } });
  }
  const calls = [];
  for (const match of text.matchAll(/^MCP-CALL (\{.*\})$/gm)) {
    let outcome;
    try {
      const { name, arguments: args } = JSON.parse(match[1]);
      const release = args?.clientRequestId ? claimCall(args.clientRequestId) : () => {};
      if (release === null) continue;
      const endpoint = sessions.get(sessionId);
      try {
        outcome = endpoint
          ? await mcpCall(endpoint, name, args)
          : { status: 0, body: "no studio-code MCP server was given to this session" };
      } catch (error) {
        release();
        throw error;
      }
      // A JSON-RPC error answers 200 too; only a result that is not an error counts.
      const ok =
        outcome.status === 200 &&
        outcome.body?.result !== undefined &&
        outcome.body.result?.isError !== true;
      if (!ok) release();
      calls.push({
        name,
        status: outcome.status,
        error: ok
          ? false
          : String(
              outcome.body?.result?.content?.[0]?.text ??
                outcome.body?.error?.message ??
                outcome.body ??
                "failed",
            ).slice(0, 300),
      });
    } catch (error) {
      calls.push({ status: 0, error: String(error?.message ?? error) });
    }
    if (calls.length > 0) toolDone(sessionId, `MCP call ${calls.length}`);
  }
  const reply = [
    ...[...text.matchAll(/^CHAOS-REPLY ([^\n]+)$/gm)].map((m) => m[1]),
    ...[...text.matchAll(/^CHAOS-RESULT ([\w-]+)$/gm)].map(
      (m) => `Result ${m[1]} from ${instance}.`,
    ),
  ].join("\n");
  say(sessionId, `Chaos agent ${instance} answered.${reply ? `\n\n${reply}` : ""}`);
  log({ ...base, outcome: "answered", ...(calls.length > 0 ? { calls } : {}) });
  send({ id, result: { stopReason: "end_turn" } });
}

const models = {
  currentModelId: model,
  availableModels: [{ modelId: model, name: `Chaos ${model}` }],
};
NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "session/cancel") {
    const id = held.get(message.params?.sessionId);
    held.delete(message.params?.sessionId);
    if (id !== undefined) send({ id, result: { stopReason: "cancelled" } });
    if (message.id !== undefined) send({ id: message.id, result: {} });
    return;
  }
  if (message.id === undefined || message.method === undefined) return;
  switch (message.method) {
    case "initialize":
      return send({
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, mcpCapabilities: { http: true, sse: false } },
          authMethods: [{ id: "chaos-sign-in", name: "Chaos sign-in", description: null }],
          agentInfo: { name: "chaos-agent", version: "1" },
        },
      });
    case "session/new": {
      const sessionId = `chaos-${instance}-${NodeCrypto.randomUUID()}`;
      sessions.set(sessionId, mcpEndpoint(message.params?.mcpServers));
      cwds.set(sessionId, message.params?.cwd ?? null);
      return send({ id: message.id, result: { sessionId, models } });
    }
    case "session/prompt":
      return void prompt(message.id, message.params);
    default:
      return send({ id: message.id, result: {} });
  }
});
