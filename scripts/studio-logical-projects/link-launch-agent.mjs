#!/usr/bin/env node
/**
 * A model-free ACP agent for the logical-project verifier (0948 AC-04). Each
 * prompt makes one studio_thread_launch call through the thread's own
 * studio-code MCP credential, so the launch runs exactly as a coordinator's
 * agent would start a worker on another machine. Usage:
 *   link-launch-agent.mjs <launch-arguments.json> <result.json>
 * The arguments file is read at prompt time, so the verifier can write it
 * after the server (and this agent) started.
 *
 * With `--echo <result.json>` it runs no tool: each prompt records the
 * session's working directory and the prompt text, so the verifier can prove
 * where a launched worker's run executed. A prompt line `MCP-CALL {"name",
 * "arguments"}` also makes that one call with the thread's own credential and
 * records its outcome as `mcp`, so a verifier can act as the thread itself.
 *
 * Every echo prompt is also appended to `<result.json>.jsonl`, so a verifier
 * can count the turns each instance ran. A prompt containing `HOLD-TURN`
 * stays running until the client cancels it (`session/cancel`).
 *
 * Only the first prompt launches. Later prompts (the worker's report back to
 * this thread) are recorded in `<result.json>.later` and launch nothing.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const echo = process.argv[2] === "--echo";
const [argumentsFile, resultFile] = echo ? [null, process.argv[3]] : process.argv.slice(2);
const sessions = new Map();
const cwds = new Map();
/** Held prompts by session: the request id `session/cancel` answers. */
const held = new Map();
let launched = false;

const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (sessionId, text) =>
  send({
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });

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
      clientInfo: { name: "link-launch-agent", version: "1" },
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
  if (echo) {
    const cwd = cwds.get(params.sessionId) ?? null;
    const text = (params.prompt ?? [])
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    const call = text.match(/MCP-CALL (\{.*\})/)?.[1];
    let mcp;
    if (call) {
      const { name, arguments: args } = JSON.parse(call);
      const endpoint = sessions.get(params.sessionId);
      try {
        mcp = endpoint
          ? await mcpCall(endpoint, name, args)
          : { status: 0, body: "no studio-code MCP server was given to this session" };
      } catch (error) {
        mcp = { status: 0, body: String(error?.stack ?? error) };
      }
    }
    writeFileSync(
      resultFile,
      JSON.stringify({ sessionId: params.sessionId, cwd, text, ...(call ? { mcp } : {}) }, null, 2),
    );
    appendFileSync(
      `${resultFile}.jsonl`,
      JSON.stringify({ sessionId: params.sessionId, cwd, text, at: new Date().toISOString() }) +
        "\n",
    );
    update(params.sessionId, `Echo worker ran in ${cwd}`);
    if (text.includes("HOLD-TURN")) return void held.set(params.sessionId, id);
    return send({ id, result: { stopReason: "end_turn" } });
  }
  if (launched) {
    const text = (params.prompt ?? [])
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    writeFileSync(`${resultFile}.later`, JSON.stringify({ text }, null, 2));
    update(params.sessionId, "Noted.");
    return send({ id, result: { stopReason: "end_turn" } });
  }
  launched = true;
  const endpoint = sessions.get(params.sessionId);
  let outcome;
  try {
    outcome = endpoint
      ? await mcpCall(
          endpoint,
          "studio_thread_launch",
          JSON.parse(readFileSync(argumentsFile, "utf8")),
        )
      : { status: 0, body: "no studio-code MCP server was given to this session" };
  } catch (error) {
    outcome = { status: 0, body: String(error?.stack ?? error) };
  }
  writeFileSync(resultFile, JSON.stringify(outcome, null, 2));
  update(params.sessionId, "studio_thread_launch: " + JSON.stringify(outcome.body).slice(0, 2000));
  send({ id, result: { stopReason: "end_turn" } });
}

const models = {
  currentModelId: "link-launch",
  availableModels: [{ modelId: "link-launch", name: "Link launch" }],
};
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "session/cancel") {
    const sessionId = message.params?.sessionId;
    const id = held.get(sessionId);
    held.delete(sessionId);
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
          authMethods: [],
          agentInfo: { name: "link-launch-agent", version: "1" },
        },
      });
    case "session/new": {
      const sessionId = `link-launch-${sessions.size + 1}`;
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
