import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { verifyDpopProof } from "@specweave-studio/shared/dpop";

/** What a fake tool answers: a structured result, or a declared failure's message. */
export type FakeToolAnswer =
  | { readonly result: Record<string, unknown> }
  | { readonly failure: string }
  | { readonly raw: Response };

export type FakeToolHandler = (
  args: Record<string, unknown>,
) => FakeToolAnswer | Promise<FakeToolAnswer>;

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly dpop: string | null;
  readonly origin: string | null;
  readonly redirect: RequestInit["redirect"];
}

/**
 * Another machine's Studio as this server sees it: its identity endpoint and
 * an MCP endpoint answering the named tools, behind bearer tokens. Declared
 * failures come back the way Effect's MCP server encodes them: `isError` with
 * the failure's message as text.
 */
export function fakeStudioMcp(input: {
  readonly origin: string;
  /** More addresses the machine answers on (its SpecWithCode Connect address). */
  readonly alsoAnswersOn?: ReadonlyArray<string>;
  /** Addresses that throw like a network that is down. */
  readonly offline?: ReadonlySet<string>;
  readonly environmentId: string;
  readonly tokens: Iterable<string>;
  readonly tools: Record<string, FakeToolHandler>;
}) {
  const tokens = new Set(input.tokens);
  const requests: RecordedRequest[] = [];
  const toolCalls: Array<{ readonly name: string; readonly args: Record<string, unknown> }> = [];
  let environmentId = input.environmentId;
  let initializations = 0;
  let pendingRaw: Response | undefined;
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

  const makeServer = () => {
    const server = new Server(
      { name: "fake-studio", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Object.keys(input.tools).map((name) => ({
        name,
        inputSchema: { type: "object" as const },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const handler = input.tools[request.params.name];
      if (!handler)
        throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      toolCalls.push({ name: request.params.name, args });
      const answer = await handler(args);
      if ("raw" in answer) {
        pendingRaw = answer.raw;
        return { content: [] };
      }
      if ("failure" in answer)
        return { isError: true, content: [{ type: "text" as const, text: answer.failure }] };
      return {
        structuredContent: answer.result,
        content: [{ type: "text" as const, text: JSON.stringify(answer.result) }],
      };
    });
    return server;
  };

  const handleMcp = async (request: Request): Promise<Response> => {
    const sessionId = request.headers.get("mcp-session-id");
    let transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      if (sessionId) return new Response("unknown session", { status: 404 });
      initializations += 1;
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => `session-${initializations}`,
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          transports.set(id, transport!);
        },
      });
      await makeServer().connect(transport);
    }
    const response = await transport.handleRequest(request);
    if (pendingRaw) {
      const raw = pendingRaw;
      pendingRaw = undefined;
      return raw;
    }
    return response;
  };

  const fetcher = (async (resource: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(resource instanceof Request ? resource.url : String(resource));
    const headers = new Headers(init?.headers);
    requests.push({
      url: url.toString(),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      dpop: headers.get("dpop"),
      origin: headers.get("origin"),
      redirect: init?.redirect,
    });
    if (
      (url.origin !== input.origin && !input.alsoAnswersOn?.includes(url.origin)) ||
      input.offline?.has(url.origin)
    )
      throw new TypeError("fetch failed");
    if (url.pathname === "/.well-known/studio/environment")
      return Response.json({
        environmentId,
        label: "Remote",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.2.11",
        capabilities: { repositoryIdentity: true },
      });
    if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
    const [scheme, token = ""] = (headers.get("authorization") ?? "").split(" ");
    // A DPoP token needs a valid proof for this method, URL and token, like the real server.
    const proven =
      scheme === "Bearer" ||
      (scheme === "DPoP" &&
        verifyDpopProof({
          proof: headers.get("dpop"),
          method: init?.method ?? "GET",
          url: url.toString(),
          // @effect-diagnostics-next-line globalDate:off -- DPoP proofs carry wall-clock seconds.
          nowEpochSeconds: Math.floor(Date.now() / 1000),
          expectedAccessToken: token,
        }).ok);
    if (!proven || !tokens.has(token)) return new Response("unauthorized", { status: 401 });
    return handleMcp(new Request(url, { ...init, headers }));
  }) as typeof fetch;

  return {
    fetcher,
    requests,
    toolCalls,
    initializations: () => initializations,
    revoke: (token: string) => tokens.delete(token),
    allow: (token: string) => tokens.add(token),
    replaceIdentity: (next: string) => {
      environmentId = next;
    },
  };
}
