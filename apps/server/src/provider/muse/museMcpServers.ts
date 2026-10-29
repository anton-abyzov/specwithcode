import type * as Acp from "@specweave-studio/effect-acp/compat";

/** One native MCP server in the MSP `session/start` config shape. */
export type MuseSessionMcpServerConfig =
  | {
      readonly transport: "stdio";
      readonly command: string;
      readonly args?: ReadonlyArray<string>;
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly transport: "streamableHttp";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    };

const nameValues = (entries: unknown): Record<string, string> | undefined => {
  if (!Array.isArray(entries)) return undefined;
  const pairs = entries.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const { name, value } = entry as { readonly name?: unknown; readonly value?: unknown };
    return typeof name === "string" && typeof value === "string" ? ([[name, value]] as const) : [];
  });
  return pairs.length === 0 ? undefined : Object.fromEntries(pairs);
};

/**
 * The ACP MCP servers a thread carries, in the shape a Muse session
 * accepts natively (`config.mcpServers`, keyed by name). Stdio and HTTP
 * servers convert; ACP-transport servers have no native equivalent and are
 * left to the terminal fallback environment, as before. Undefined when
 * nothing converts, so session start stays byte-identical for sessions
 * without MCP.
 */
export function museSessionMcpServers(
  servers: ReadonlyArray<Acp.McpServer> | undefined,
): Record<string, MuseSessionMcpServerConfig> | undefined {
  if (servers === undefined) return undefined;
  const converted: Record<string, MuseSessionMcpServerConfig> = {};
  for (const server of servers) {
    const record = server as {
      readonly type?: unknown;
      readonly name?: unknown;
      readonly url?: unknown;
      readonly headers?: unknown;
      readonly command?: unknown;
      readonly args?: unknown;
      readonly env?: unknown;
    };
    if (typeof record.name !== "string") continue;
    if (record.type === "http") {
      if (typeof record.url !== "string") continue;
      const headers = nameValues(record.headers);
      converted[record.name] = {
        transport: "streamableHttp",
        url: record.url,
        ...(headers === undefined ? {} : { headers }),
      };
      continue;
    }
    if (record.type !== undefined && record.type !== "stdio") continue;
    if (typeof record.command !== "string") continue;
    const args = Array.isArray(record.args)
      ? record.args.filter((arg): arg is string => typeof arg === "string")
      : undefined;
    const env = nameValues(record.env);
    converted[record.name] = {
      transport: "stdio",
      command: record.command,
      ...(args === undefined ? {} : { args }),
      ...(env === undefined ? {} : { env }),
    };
  }
  return Object.keys(converted).length === 0 ? undefined : converted;
}
