import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  type ProjectConnectionConfig,
  ProjectConnectionTool,
  type ProjectConnectionCallResult,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { redactConnectionText, redactConnectionValue, toolFingerprint } from "./config.ts";

export class ConnectionTransportError extends Schema.TaggedError<ConnectionTransportError>()(
  "ConnectionTransportError",
  {
    reason: Schema.Literals(["unavailable", "changed"]),
  },
) {}
type Target = { config: ProjectConnectionConfig; cwd: string };
export class ProjectConnectionTransport extends Context.Service<
  ProjectConnectionTransport,
  {
    discover: (
      input: Target,
    ) => Effect.Effect<readonly ProjectConnectionTool[], ConnectionTransportError>;
    call: (
      input: Target & { tool: ProjectConnectionTool; arguments: Record<string, unknown> },
    ) => Effect.Effect<ProjectConnectionCallResult, ConnectionTransportError>;
  }
>()("studio/project/ProjectConnectionTransport") {}

const safeError = () => new ConnectionTransportError({ reason: "unavailable" });
const run = <A>(target: Target, action: (client: Client, signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: async (signal) => {
      const env = getDefaultEnvironment();
      for (const key of target.config.envKeys) {
        const value = process.env[key];
        if (value === undefined) throw safeError();
        env[key] = value;
      }
      // Deliberately no inherited arbitrary environment and no shell. Provider auth is never copied.
      const transport = new StdioClientTransport({
        command: target.config.command,
        args: [...target.config.args],
        cwd: target.cwd,
        env,
        stderr: "ignore",
      });
      const client = new Client(
        { name: "specweave-studio-project", version: "0.2.0" },
        { capabilities: {} },
      );
      const bound = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      const close = () => {
        void client.close().catch(() => undefined);
      };
      bound.addEventListener("abort", close, { once: true });
      try {
        await client.connect(transport, { signal: bound, timeout: 10_000 });
        return await action(client, bound);
      } finally {
        bound.removeEventListener("abort", close);
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
      }
    },
    catch: (error) => (Schema.is(ConnectionTransportError)(error) ? error : safeError()),
  });

async function discover(
  client: Client,
  signal: AbortSignal,
  config: ProjectConnectionConfig,
): Promise<ProjectConnectionTool[]> {
  const tools: ProjectConnectionTool[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 10_000 });
    for (const tool of result.tools) {
      if (redactConnectionText(tool.name, config.envKeys) !== tool.name) throw safeError();
      const value = {
        name: tool.name,
        description: redactConnectionText(tool.description ?? "", config.envKeys).slice(0, 4096),
        inputSchema: redactConnectionValue(tool.inputSchema, config.envKeys),
      };
      if (
        !Schema.is(ProjectConnectionTool)(value) ||
        seen.has(value.name) ||
        JSON.stringify(value).length > 32_768 ||
        tools.length >= 200
      )
        throw safeError();
      seen.add(value.name);
      tools.push(value);
    }
    cursor = result.nextCursor;
    if (!cursor) return tools.sort((a, b) => a.name.localeCompare(b.name));
  }
  throw safeError();
}
export const layer = Layer.succeed(ProjectConnectionTransport, {
  discover: (target) => run(target, (client, signal) => discover(client, signal, target.config)),
  call: (target) =>
    run(target, async (client, signal) => {
      const tools = await discover(client, signal, target.config);
      const tool = tools.find((tool) => tool.name === target.tool.name);
      if (!tool || toolFingerprint(tool) !== toolFingerprint(target.tool))
        throw new ConnectionTransportError({ reason: "changed" });
      const result = await client.callTool(
        { name: tool.name, arguments: target.arguments },
        undefined,
        { signal, timeout: 20_000 },
      );
      const content = JSON.stringify(
        redactConnectionValue(
          { content: result.content, structuredContent: result.structuredContent },
          target.config.envKeys,
        ),
      );
      return {
        isError: result.isError === true,
        content:
          content.length <= 262_144
            ? content
            : content.slice(0, 262_000) + "\n[Tool output truncated.]",
      };
    }),
});
