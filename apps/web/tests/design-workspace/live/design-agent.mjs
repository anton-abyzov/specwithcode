#!/usr/bin/env node
/**
 * A model-free ACP agent for the Design from code and canvas live checks. On
 * each prompt it reads the design id from the prompt, then calls design_get and
 * design_apply through the thread's own studio-code MCP credential, as a real
 * agent would. Every call and its result is written to <result.json>.
 * Usage: design-agent.mjs <result.json>
 */
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const { writeFileSync } = NodeFS;
const { createInterface } = NodeReadline;

const [resultFile] = process.argv.slice(2);
const sessions = new Map();
const calls = [];

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

function mcpEndpoint(mcpServers) {
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

async function mcpSession(endpoint) {
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
      clientInfo: { name: "design-agent", version: "1" },
    },
  });
  if (initialized.status !== 200)
    throw new Error(`MCP initialize ${initialized.status}: ${await initialized.text()}`);
  const session = initialized.headers.get("mcp-session-id");
  await read(initialized);
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
  let id = 1;
  return async (name, args) => {
    const response = await post(
      { jsonrpc: "2.0", id: (id += 1), method: "tools/call", params: { name, arguments: args } },
      session,
    );
    const body = await read(response);
    const content = body?.result?.structuredContent ?? null;
    const call = { name, status: response.status, isError: body?.result?.isError ?? false };
    calls.push({ ...call, text: body?.result?.content?.[0]?.text?.slice(0, 600) ?? null });
    if (call.isError || content === null)
      throw new Error(`${name}: ${JSON.stringify(body).slice(0, 800)}`);
    return content;
  };
}

async function prompt(id, params) {
  const text = (params.prompt ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  const result = { prompt: text, calls, error: null, designId: null, revision: null };
  try {
    // Design from code names "…, id <designId>, file …"; the editor's "Start a thread"
    // brief names the design key ("design <key> with the user"), whose last part is the id.
    const designId =
      text.match(/, id ([A-Za-z0-9_-]+), file /)?.[1] ??
      text.match(/design (?:p\.[^\s.]+\.|pg\.)([A-Za-z0-9_-]+) with the user/)?.[1];
    if (!designId) throw new Error("no design id in the prompt");
    result.designId = designId;
    const endpoint = sessions.get(params.sessionId);
    if (!endpoint) throw new Error("no studio-code MCP server was given to this session");
    const call = await mcpSession(endpoint);
    const read = await call("design_get", { designId });
    const page = read.document.pages[0];
    const frame = page.nodes.find((node) => node.type === "frame");
    const applied = await call("design_apply", {
      designId,
      expectedRevision: read.document.revision,
      operations: [
        {
          op: "add_node",
          pageId: page.id,
          node: {
            id: "agent_heading",
            parentId: frame?.id ?? null,
            type: "text",
            x: 64,
            y: 64,
            width: 640,
            height: 56,
            text: "Notifications",
            fontSize: 40,
            fontWeight: 700,
            color: "#16243d",
          },
        },
        {
          op: "add_node",
          pageId: page.id,
          node: {
            id: "agent_panel",
            parentId: frame?.id ?? null,
            type: "rect",
            x: 64,
            y: 160,
            width: 720,
            height: 360,
            fill: "#e9f0ff",
            radius: 16,
          },
        },
      ],
    });
    result.revision = applied.document.revision;
    result.thread = applied.document.thread ?? null;
    say(params.sessionId, `Added a heading and a panel to ${designId}.`);
  } catch (error) {
    result.error = String(error?.stack ?? error);
    say(params.sessionId, `Design agent failed: ${result.error.slice(0, 400)}`);
  }
  writeFileSync(resultFile, JSON.stringify(result, null, 2));
  send({ id, result: { stopReason: "end_turn" } });
}

const models = {
  currentModelId: "design-agent",
  availableModels: [{ modelId: "design-agent", name: "Design agent" }],
};
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined || message.method === undefined) return;
  switch (message.method) {
    case "initialize":
      return send({
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, mcpCapabilities: { http: true, sse: false } },
          authMethods: [],
          agentInfo: { name: "design-agent", version: "1" },
        },
      });
    case "session/new": {
      const sessionId = `design-agent-${sessions.size + 1}`;
      sessions.set(sessionId, mcpEndpoint(message.params?.mcpServers));
      return send({ id: message.id, result: { sessionId, models } });
    }
    case "session/prompt":
      return void prompt(message.id, message.params);
    default:
      return send({ id: message.id, result: {} });
  }
});
