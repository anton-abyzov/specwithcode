// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs";
import * as path from "node:path";
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
import * as ServerConfig from "../../config.ts";
import { redactConnectionText, redactConnectionValue, toolFingerprint } from "./config.ts";

export class ConnectionTransportError extends Schema.TaggedError<ConnectionTransportError>()(
  "ConnectionTransportError",
  {
    reason: Schema.Literals(["unavailable", "changed"]),
  },
) {}
/**
 * A process given a stored token never starts in the project's folder. Agents can
 * write there, and npx runs a matching package it finds in node_modules there or in
 * any parent folder, so a planted package would receive the token. Each start gets a
 * new folder inside the secrets folder, which agents are refused, with its own
 * package.json so npm does not treat a parent folder as the project. A parent of the
 * secrets folder is still writable, so presets also name their package with
 * `npx --package`, whose installed bin comes before any node_modules/.bin on the path.
 */
const startFolder = (target: Target, secretsDir: string) => {
  if (Object.keys(target.stored ?? {}).length === 0) return null;
  const root = path.join(secretsDir, "connection-start");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const folder = fs.mkdtempSync(path.join(root, "start-"));
  fs.writeFileSync(path.join(folder, "package.json"), '{"private":true}\n');
  return folder;
};

type Target = {
  config: ProjectConnectionConfig;
  cwd: string;
  /** Values from the secret store; they win over the host environment. */
  stored?: Readonly<Record<string, string>>;
};
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
>()("specweave-studio/project/connections/ProjectConnectionTransport") {}

const safeError = () => new ConnectionTransportError({ reason: "unavailable" });
const toTransportError = (error: unknown) =>
  Schema.is(ConnectionTransportError)(error) ? error : safeError();
// The SDK's own close waits up to 2 s after ending stdin and 2 s after SIGTERM, then
// sends SIGKILL; the wait for the exit after that is bounded too, about 6 s in all.
const EXIT_WAIT_MS = 2_000;

const open = (target: Target, secretsDir: string) => {
  const env = getDefaultEnvironment();
  for (const key of target.config.envKeys) {
    const value = target.stored?.[key] ?? process.env[key];
    if (value === undefined) throw safeError();
    env[key] = value;
  }
  const emptyFolder = startFolder(target, secretsDir);
  // A workspace root in a parent folder would pull npm back up out of that folder.
  if (emptyFolder) env.npm_config_workspaces = "false";
  // Deliberately no inherited arbitrary environment and no shell. Provider auth is never copied.
  const transport = new StdioClientTransport({
    command: target.config.command,
    args: [...target.config.args],
    cwd: emptyFolder ?? target.cwd,
    env,
    stderr: "ignore",
  });
  const client = new Client(
    { name: "specweave-studio-project", version: "0.2.0" },
    { capabilities: {} },
  );
  // The SDK reports the child's `close` event here, after it has exited.
  const exited = new Promise<void>((resolve) => {
    client.onclose = resolve;
  });
  // Set before connecting: a failed handshake has the SDK close the transport, clearing its pid.
  return { transport, client, exited, started: false, emptyFolder };
};

/**
 * Closes the owned process and waits for it to exit. Interruption waits for
 * this too, so a cancelled call never leaves the process running; on Windows
 * a running child also keeps its working folder from being removed.
 */
const close = ({ transport, client, exited, started, emptyFolder }: ReturnType<typeof open>) =>
  Effect.gen(function* () {
    yield* Effect.promise(async () => {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    });
    if (started) yield* Effect.promise(() => exited).pipe(Effect.timeoutOption(EXIT_WAIT_MS));
    if (emptyFolder)
      yield* Effect.try(() => fs.rmSync(emptyFolder, { recursive: true, force: true })).pipe(
        Effect.ignore,
      );
  });

const storedValues = (target: Target) => Object.values(target.stored ?? {});
// A check may be the first run of an npx package, which downloads it first.
const CHECK_LIMITS = { totalMs: 120_000, connectMs: 90_000 };
const CALL_LIMITS = { totalMs: 30_000, connectMs: 10_000 };

const run = <A>(
  secretsDir: string,
  target: Target,
  limits: typeof CALL_LIMITS,
  action: (client: Client, signal: AbortSignal) => Promise<A>,
) =>
  Effect.acquireUseRelease(
    Effect.try({ try: () => open(target, secretsDir), catch: toTransportError }),
    (session) =>
      Effect.tryPromise({
        try: async (signal) => {
          const { transport, client } = session;
          const bound = AbortSignal.any([signal, AbortSignal.timeout(limits.totalMs)]);
          session.started = true;
          await client.connect(transport, { signal: bound, timeout: limits.connectMs });
          return await action(client, bound);
        },
        catch: toTransportError,
      }),
    close,
  );

async function discover(
  client: Client,
  signal: AbortSignal,
  config: ProjectConnectionConfig,
  stored: readonly string[],
): Promise<ProjectConnectionTool[]> {
  const tools: ProjectConnectionTool[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 10_000 });
    for (const tool of result.tools) {
      if (redactConnectionText(tool.name, config.envKeys, stored) !== tool.name) throw safeError();
      const value = {
        name: tool.name,
        description: redactConnectionText(tool.description ?? "", config.envKeys, stored).slice(
          0,
          4096,
        ),
        inputSchema: redactConnectionValue(tool.inputSchema, config.envKeys, stored),
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
export const layer = Layer.effect(
  ProjectConnectionTransport,
  Effect.gen(function* () {
    const { secretsDir } = yield* ServerConfig.ServerConfig;
    return ProjectConnectionTransport.of({
      discover: (target) =>
        run(secretsDir, target, CHECK_LIMITS, (client, signal) =>
          discover(client, signal, target.config, storedValues(target)),
        ),
      call: (target) =>
        run(secretsDir, target, CALL_LIMITS, async (client, signal) => {
          const stored = storedValues(target);
          const tools = await discover(client, signal, target.config, stored);
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
              stored,
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
  }),
);
