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
  /** Writes the whole JSON-RPC answer itself, as a hostile server would. */
  readonly raw?: (id: unknown) => Iterable<string | Uint8Array>;
}

const MiB = 1024 * 1024;

/** Writes `parts` with backpressure, stopping once the client hangs up. */
async function writeRaw(response: NodeHttp.ServerResponse, parts: Iterable<string | Uint8Array>) {
  response.writeHead(200, { "content-type": "application/json" });
  let written = 0;
  for (const part of parts) {
    if (response.destroyed) return written;
    written += typeof part === "string" ? Buffer.byteLength(part) : part.byteLength;
    if (!response.write(part))
      await new Promise<void>((done) => {
        const settle = () => {
          response.off("drain", settle).off("close", settle);
          done();
        };
        response.on("drain", settle).on("close", settle);
      });
  }
  response.end();
  return written;
}

const servers: NodeHttp.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
});

/** A stand-in for Figma desktop's local MCP server: stateless streamable HTTP on /mcp. */
async function fixtureFigma(tools: ReadonlyArray<FixtureTool>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rawWrites: number[] = [];
  const http = NodeHttp.createServer(async (request, response) => {
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const raw = tools.find(
      (tool) => body?.method === "tools/call" && tool.name === body.params?.name,
    )?.raw;
    if (raw) {
      calls.push({ name: body.params.name, args: body.params.arguments ?? {} });
      rawWrites.push(await writeRaw(response, raw(body.id)));
      return;
    }
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
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`,
    calls,
    rawWrites,
  };
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

  it("fails a call whose answer passes the 24 MiB limit", async () => {
    const filler = new Uint8Array(MiB).fill(0x78);
    const figma = await fixtureFigma([
      {
        name: "get_variable_defs",
        raw: function* (id) {
          yield `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{"content":[{"type":"text","text":"`;
          for (let index = 0; index < 40; index += 1) yield filler;
          yield `"}]}}`;
        },
      },
    ]);
    await expect(new FigmaDesktopMcpClient(figma.url).readVariables()).rejects.toThrow(
      /answer was too large: more than 25,165,824 bytes/,
    );
    expect(figma.calls.map((call) => call.name)).toEqual(["get_variable_defs"]);
  });

  it("fails a call whose answer has more than 100,000 values", async () => {
    const figma = await fixtureFigma([
      {
        name: "get_variable_defs",
        raw: (id) => [
          `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{"content":[${"0,".repeat(100_000)}0]}}`,
        ],
      },
    ]);
    await expect(new FigmaDesktopMcpClient(figma.url).readVariables()).rejects.toThrow(
      /answer was too large: more than 100,000 JSON values/,
    );
    expect(figma.rawWrites).toHaveLength(1);
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
