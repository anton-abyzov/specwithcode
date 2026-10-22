// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { assemble } from "../systems/assemble.ts";
import {
  FigmaDesktopMcpClient,
  FigmaDesktopUnavailable,
  collectFigmaVariables,
  parseVariableDefinitions,
  pickVariablesTool,
} from "./FigmaDesktopMcpClient.ts";

interface FixtureTool {
  readonly name: string;
  readonly properties?: ReadonlyArray<string>;
  readonly answer?: (args: Record<string, unknown>) => string;
}

const servers: NodeHttp.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
});

/** A stand-in for Figma desktop's local MCP server: stateless streamable HTTP on /mcp. */
async function fixtureFigma(tools: ReadonlyArray<FixtureTool>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const http = NodeHttp.createServer(async (request, response) => {
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const server = new Server(
      { name: "Figma Dev Mode MCP", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: `${tool.name} fixture`,
        inputSchema: {
          type: "object" as const,
          properties: Object.fromEntries(
            (tool.properties ?? []).map((property) => [property, { type: "string" }]),
          ),
        },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      const tool = tools.find((candidate) => candidate.name === call.params.name);
      const args = (call.params.arguments ?? {}) as Record<string, unknown>;
      calls.push({ name: call.params.name, args });
      if (!tool?.answer)
        return { isError: true, content: [{ type: "text" as const, text: "unknown tool" }] };
      return { content: [{ type: "text" as const, text: tool.answer(args) }] };
    });
    const transport = new StreamableHTTPServerTransport(
      {} as ConstructorParameters<typeof StreamableHTTPServerTransport>[0],
    );
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport as Transport);
    await transport.handleRequest(request, response, body);
  });
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  servers.push(http);
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, calls };
}

const VARIABLES = `{"Brand/Primary": "#5b6cff", "Spacing/sm": "8", "Surface/Canvas": "#f8f7f9"}`;

describe("FigmaDesktopMcpClient", () => {
  it("reports connected with the tools Figma lists", async () => {
    const figma = await fixtureFigma([
      { name: "get_code", properties: ["nodeId"] },
      {
        name: "get_variable_defs",
        properties: ["nodeId", "clientLanguages", "clientFrameworks"],
        answer: () => VARIABLES,
      },
    ]);
    const status = await new FigmaDesktopMcpClient(figma.url).status();
    expect(status).toMatchObject({
      state: "connected",
      endpoint: figma.url,
      variablesTool: "get_variable_defs",
      serverName: "Figma Dev Mode MCP",
    });
    expect(status.tools.map((tool) => tool.name)).toEqual(["get_code", "get_variable_defs"]);
  });

  it("reads variables only through a listed tool, for the selection or one node", async () => {
    const figma = await fixtureFigma([
      {
        name: "get_variable_defs",
        properties: ["nodeId", "clientLanguages"],
        answer: () => VARIABLES,
      },
    ]);
    const client = new FigmaDesktopMcpClient(figma.url);
    const selection = await client.readVariables();
    const node = await client.readVariables("12:34");
    expect(selection.tool).toBe("get_variable_defs");
    expect(figma.calls).toEqual([
      { name: "get_variable_defs", args: { clientLanguages: "css" } },
      { name: "get_variable_defs", args: { nodeId: "12:34", clientLanguages: "css" } },
    ]);
    const extraction = assemble([
      collectFigmaVariables(parseVariableDefinitions(node.text), {
        nodeId: "12:34",
        tool: node.tool,
        responseText: node.text,
      }),
    ]);
    expect(extraction.tokens.map((token) => [token.name, token.type])).toEqual([
      ["brand-primary", "color"],
      ["spacing-sm", "number"],
      ["surface-canvas", "color"],
    ]);
    expect(extraction.tokens[0]!.values.default!.provenance).toMatchObject({
      source: "figma-desktop",
      location: "12:34#Brand/Primary",
      context: "get_variable_defs",
      extractor: "figma-desktop@1",
    });
  });

  it("refuses to read when no variables tool is listed", async () => {
    const figma = await fixtureFigma([{ name: "get_code", properties: ["nodeId"] }]);
    const client = new FigmaDesktopMcpClient(figma.url);
    expect((await client.status()).variablesTool).toBeNull();
    await expect(client.readVariables()).rejects.toBeInstanceOf(FigmaDesktopUnavailable);
    expect(figma.calls).toEqual([]);
  });

  it("reports off when nothing listens", async () => {
    const http = NodeHttp.createServer();
    await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
    const port = (http.address() as AddressInfo).port;
    await new Promise((done) => http.close(done));
    const status = await new FigmaDesktopMcpClient(`http://127.0.0.1:${port}/mcp`).status();
    expect(status).toMatchObject({ state: "off", tools: [], variablesTool: null });
  });

  it("only talks to loopback", () => {
    expect(() => new FigmaDesktopMcpClient("http://example.com:3845/mcp")).toThrow(/loopback/);
  });
});

describe("parseVariableDefinitions", () => {
  it("reads strict JSON and Figma's looser object text", () => {
    expect(parseVariableDefinitions(VARIABLES)).toEqual([
      ["Brand/Primary", "#5b6cff"],
      ["Spacing/sm", "8"],
      ["Surface/Canvas", "#f8f7f9"],
    ]);
    expect(
      parseVariableDefinitions(
        "{Brand/Primary: #5b6cff, Shadow/Card: 0 1px 2px rgba(0, 0, 0, 0.2)}",
      ),
    ).toEqual([
      ["Brand/Primary", "#5b6cff"],
      ["Shadow/Card", "0 1px 2px rgba(0, 0, 0, 0.2)"],
    ]);
  });

  it("prefers the listed exact tool name", () => {
    expect(pickVariablesTool([{ name: "get_variables_v2" }, { name: "get_variable_defs" }])).toBe(
      "get_variable_defs",
    );
    // Only allowlisted read tools; a name that merely mentions variables is never called.
    expect(pickVariablesTool([{ name: "read_local_variables" }])).toBeNull();
    expect(pickVariablesTool([{ name: "set_variables" }, { name: "delete_variable" }])).toBeNull();
    expect(pickVariablesTool([{ name: "get_code" }])).toBeNull();
  });
});
