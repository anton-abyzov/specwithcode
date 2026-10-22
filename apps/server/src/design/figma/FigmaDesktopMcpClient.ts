// @effect-diagnostics globalTimers:off - A plain promise client; the service wraps it in Effect.
/**
 * Figma desktop's own MCP server, when the user turns it on in Figma
 * (Preferences > Enable desktop MCP server). It listens on loopback only,
 * so this client never leaves the machine and needs no Figma account or
 * token. Each call connects, asks `tools/list`, and only ever calls a tool
 * that list contains; nothing about the tool set is assumed. When the server
 * is not listening the status is `off`, never an error dialog.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  FIGMA_DESKTOP_MCP_URL,
  type DesignSystemFinding,
  type FigmaDesktopStatus,
  type FigmaDesktopTool,
} from "@specweave-studio/contracts";

import packageJson from "../../../package.json" with { type: "json" };
import {
  type Collected,
  type MutableToken,
  clip,
  compareText,
  finding,
  sha256Hex,
} from "../systems/common.ts";
import { tokenNameFromPath } from "../systems/extractDtcg.ts";

export const FIGMA_DESKTOP_EXTRACTOR = "figma-desktop@1";
const CONNECT_TIMEOUT_MS = 2_500;
const CALL_TIMEOUT_MS = 20_000;
const MAX_TEXT = 4 * 1024 * 1024;

/** Preferred variables tool names, in order; otherwise any listed tool named like one. */
const VARIABLE_TOOLS = ["get_variable_defs", "get_variables"];

export class FigmaDesktopUnavailable extends Error {
  readonly state: "off" | "error";
  constructor(state: "off" | "error", message: string) {
    super(message);
    this.state = state;
  }
}

interface ListedTool extends FigmaDesktopTool {
  readonly properties: ReadonlyArray<string>;
}

/**
 * The read-only variables tool to call: only names on `VARIABLE_TOOLS`, never
 * a guess from a tool's name, so a listed `set_variables` is never called.
 */
export const pickVariablesTool = (tools: ReadonlyArray<{ readonly name: string }>): string | null =>
  VARIABLE_TOOLS.find((name) => tools.some((tool) => tool.name === name)) ?? null;

const isLoopback = (url: URL) => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);

const refused = (error: unknown): boolean => {
  const text = `${(error as { code?: unknown })?.code ?? ""} ${(error as Error)?.message ?? ""} ${(error as { cause?: { code?: unknown } })?.cause?.code ?? ""}`;
  return /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|fetch failed|timed out|aborted/i.test(text);
};

export class FigmaDesktopMcpClient {
  readonly endpoint: URL;

  constructor(endpoint: string = FIGMA_DESKTOP_MCP_URL) {
    const url = new URL(endpoint);
    if (!isLoopback(url) || url.protocol !== "http:") {
      throw new Error("The Figma desktop MCP endpoint must be a loopback http URL.");
    }
    this.endpoint = url;
  }

  private async connect(): Promise<{ client: Client; tools: ListedTool[]; serverName?: string }> {
    const client = new Client({
      name: "specwithcode-design-systems",
      version: packageJson.version,
    });
    const transport = new StreamableHTTPClientTransport(this.endpoint);
    try {
      await withTimeout(client.connect(transport as Transport), CONNECT_TIMEOUT_MS);
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS);
      const tools = listed.tools
        .map((tool) => ({
          name: tool.name.slice(0, 200),
          ...(tool.description ? { description: tool.description.slice(0, 4_000) } : {}),
          properties: Object.keys(
            (tool.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {},
          ).sort(compareText),
        }))
        .sort((left, right) => compareText(left.name, right.name));
      const serverName = client.getServerVersion()?.name;
      return { client, tools, ...(serverName ? { serverName } : {}) };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw new FigmaDesktopUnavailable(
        refused(error) ? "off" : "error",
        refused(error)
          ? "Figma desktop's MCP server is not running."
          : `Figma desktop's MCP server did not answer as expected: ${(error as Error).message}`,
      );
    }
  }

  async status(): Promise<FigmaDesktopStatus> {
    try {
      const { client, tools, serverName } = await this.connect();
      await client.close().catch(() => undefined);
      return {
        state: "connected",
        endpoint: this.endpoint.href,
        tools: tools.map(({ properties: _properties, ...tool }) => tool),
        variablesTool: pickVariablesTool(tools),
        ...(serverName ? { serverName: serverName.slice(0, 200) } : {}),
      };
    } catch (error) {
      const unavailable =
        error instanceof FigmaDesktopUnavailable
          ? error
          : new FigmaDesktopUnavailable("error", String(error));
      return {
        state: unavailable.state,
        endpoint: this.endpoint.href,
        tools: [],
        variablesTool: null,
        detail: unavailable.message.slice(0, 2_000),
      };
    }
  }

  /**
   * Reads variables through the listed variables tool for one node, or for
   * the current selection in Figma when `nodeId` is absent.
   */
  async readVariables(
    nodeId?: string,
  ): Promise<{ readonly tool: string; readonly text: string; readonly structured?: unknown }> {
    const { client, tools } = await this.connect();
    try {
      const name = pickVariablesTool(tools);
      if (name === null) {
        throw new FigmaDesktopUnavailable(
          "error",
          "Figma desktop's MCP server does not list a variables tool.",
        );
      }
      const tool = tools.find((candidate) => candidate.name === name)!;
      const args: Record<string, string> = {};
      if (nodeId !== undefined && tool.properties.includes("nodeId")) args.nodeId = nodeId;
      if (tool.properties.includes("clientLanguages")) args.clientLanguages = "css";
      if (tool.properties.includes("clientFrameworks")) args.clientFrameworks = "unknown";
      const result = await withTimeout(client.callTool({ name, arguments: args }), CALL_TIMEOUT_MS);
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .filter(
          (item): item is { type: "text"; text: string } =>
            (item as { type?: unknown }).type === "text",
        )
        .map((item) => item.text)
        .join("\n")
        .slice(0, MAX_TEXT);
      if (result.isError === true)
        throw new FigmaDesktopUnavailable("error", text.slice(0, 500) || `${name} failed`);
      return {
        tool: name,
        text,
        ...(result.structuredContent !== undefined ? { structured: result.structuredContent } : {}),
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

const withTimeout = <A>(promise: Promise<A>, ms: number): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/** `{ "Brand/Primary": "#5b6cff" }`, or Figma's looser `{Brand/Primary: #5b6cff, ...}` text. */
export const parseVariableDefinitions = (
  text: string,
  structured?: unknown,
): Array<readonly [string, string]> => {
  const fromObject = (value: unknown): Array<readonly [string, string]> | null => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const pairs: Array<readonly [string, string]> = [];
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === "string" || typeof entry === "number") pairs.push([key, String(entry)]);
      else if (entry && typeof entry === "object" && "value" in entry)
        pairs.push([key, String((entry as { value: unknown }).value)]);
    }
    return pairs;
  };
  const structuredPairs = fromObject(structured);
  if (structuredPairs && structuredPairs.length > 0) return structuredPairs;
  try {
    const parsed = fromObject(JSON.parse(text));
    if (parsed) return parsed;
  } catch {
    // Not strict JSON; read the looser form below.
  }
  const body = text.trim().replace(/^\{/, "").replace(/\}$/, "");
  const pairs: Array<readonly [string, string]> = [];
  let depth = 0;
  let current = "";
  const flush = () => {
    const index = current.indexOf(":");
    if (index > 0) {
      const key = current
        .slice(0, index)
        .trim()
        .replace(/^["']|["']$/g, "");
      const value = current
        .slice(index + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key && value) pairs.push([key, value]);
    }
    current = "";
  };
  for (const char of body) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if ((char === "," || char === "\n") && depth === 0) flush();
    else current += char;
  }
  flush();
  return pairs;
};

/** Variables read from Figma as tokens of one mode, with `figma-desktop` provenance. */
export const collectFigmaVariables = (
  pairs: ReadonlyArray<readonly [string, string]>,
  context: { readonly nodeId?: string; readonly tool: string; readonly responseText: string },
): Collected => {
  const sha256 = sha256Hex(context.responseText);
  const tokens = new Map<string, MutableToken>();
  const findings: DesignSystemFinding[] = [];
  for (const [variable, value] of [...pairs].sort(([left], [right]) => compareText(left, right))) {
    const name = tokenNameFromPath(variable.split(/[/.]/));
    if (!name || name.length > 200) continue;
    if (tokens.has(name)) {
      findings.push(
        finding(
          "duplicate",
          "info",
          `${variable} maps to ${name}, which another variable already uses`,
        ),
      );
      continue;
    }
    tokens.set(name, {
      name,
      type: "other",
      values: {
        default: {
          raw: clip(value),
          resolved: null,
          provenance: {
            source: "figma-desktop",
            location: `${context.nodeId ?? "selection"}#${variable}`.slice(0, 500),
            context: context.tool,
            sha256,
            extractor: FIGMA_DESKTOP_EXTRACTOR,
          },
        },
      },
    });
  }
  return {
    modes: [{ id: "default", name: "Default" }],
    tokens: [...tokens.values()],
    components: [],
    findings,
  };
};
