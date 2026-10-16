/**
 * Text edits for native MCP declarations. Each edit touches only the one
 * server it names and is checked by parsing the result, so comments and the
 * rest of a hand-written config survive.
 */
import { parse, stringify } from "smol-toml";

type ObjectValue = Record<string, unknown>;
const isObject = (v: unknown): v is ObjectValue =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const isStringRecord = (v: unknown): v is Record<string, string> =>
  isObject(v) && Object.values(v).every((x) => typeof x === "string");

/** A launch both tools read the same way. */
export type PortableDeclaration =
  | {
      readonly transport: "stdio";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, string>>;
    }
  | {
      readonly transport: "http";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    };

const CODEX_KEYS = new Set([
  "command",
  "args",
  "env",
  "url",
  "http_headers",
  "enabled",
  "startup_timeout_sec",
  "tool_timeout_sec",
]);
const CLAUDE_KEYS = new Set(["type", "command", "args", "env", "url", "headers"]);

/** A bare program name resolves on PATH; an absolute path is the same file for both tools. */
const portableCommand = (command: string) =>
  command.trim() === command &&
  command.length > 0 &&
  (command.startsWith("/") || !/[\\/]/.test(command));

/**
 * The declaration in a form the other tool can run, or null when it depends
 * on something only the declaring tool understands (a working directory, a
 * relative program path, token indirection, SSE).
 */
export function portableDeclaration(
  provider: "codex" | "claude",
  config: unknown,
): PortableDeclaration | null {
  if (!isObject(config)) return null;
  const allowed = provider === "codex" ? CODEX_KEYS : CLAUDE_KEYS;
  if (Object.keys(config).some((key) => !allowed.has(key))) return null;
  const type = config.type;
  if (type !== undefined && type !== "stdio" && type !== "http") return null;
  const { command, url } = config;
  if (typeof command === "string" && url === undefined && type !== "http") {
    const args = config.args ?? [];
    const env = config.env ?? {};
    if (!portableCommand(command) || !isStrings(args) || !isStringRecord(env)) return null;
    return { transport: "stdio", command, args, env };
  }
  if (typeof url === "string" && command === undefined && type !== "stdio") {
    const headers = (provider === "codex" ? config.http_headers : config.headers) ?? {};
    if (!/^https?:\/\//i.test(url) || !isStringRecord(headers)) return null;
    return { transport: "http", url, headers };
  }
  return null;
}

/** Normalize a TOML table header to `[a.b]` with bare or quoted keys unquoted. */
const tableKey = (line: string) => {
  const match = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/.exec(line);
  if (!match) return null;
  return match[1]!
    .split(".")
    .map((part) => part.trim().replace(/^"(.*)"$|^'(.*)'$/, "$1$2"))
    .join(".");
};

/** Flip `enabled = false` to true inside `[mcp_servers.<name>]`, or null when that line is absent. */
export function enableCodexServer(text: string, name: string): string | null {
  const lines = text.split("\n");
  const target = `mcp_servers.${name}`;
  let inside = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*\[/.test(line)) {
      inside = tableKey(line) === target;
      continue;
    }
    if (inside && /^\s*enabled\s*=\s*false\s*(?:#.*)?$/.test(line)) {
      lines[index] = line.replace(/false/, "true");
      const next = lines.join("\n");
      const server = (parse(next) as ObjectValue).mcp_servers;
      return isObject(server) && isObject(server[name]) && server[name].enabled === true
        ? next
        : null;
    }
  }
  return null;
}

/** Append `[mcp_servers.<name>]` to a Codex config that does not declare it yet. */
export function appendCodexServer(
  text: string,
  name: string,
  declaration: PortableDeclaration,
): string | null {
  const before = parse(text) as ObjectValue;
  if (isObject(before.mcp_servers) && Object.hasOwn(before.mcp_servers, name)) return null;
  const table =
    declaration.transport === "stdio"
      ? {
          command: declaration.command,
          args: [...declaration.args],
          ...(Object.keys(declaration.env).length ? { env: { ...declaration.env } } : {}),
        }
      : {
          url: declaration.url,
          ...(Object.keys(declaration.headers).length
            ? { http_headers: { ...declaration.headers } }
            : {}),
        };
  const block = stringify({ mcp_servers: { [name]: table } });
  const separator =
    text.length === 0 || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  const next = `${text}${separator}${block}\n`;
  const server = (parse(next) as ObjectValue).mcp_servers;
  return isObject(server) && isObject(server[name]) ? next : null;
}

/** Add a user-scope server to `.claude.json`, or null when the name is taken or the file is not an object. */
export function addClaudeServer(
  text: string,
  name: string,
  declaration: PortableDeclaration,
): string | null {
  const data: unknown = JSON.parse(text);
  if (!isObject(data)) return null;
  const servers = data.mcpServers ?? {};
  if (!isObject(servers) || Object.hasOwn(servers, name)) return null;
  const entry =
    declaration.transport === "stdio"
      ? {
          type: "stdio",
          command: declaration.command,
          args: [...declaration.args],
          env: { ...declaration.env },
        }
      : { type: "http", url: declaration.url, headers: { ...declaration.headers } };
  return `${JSON.stringify({ ...data, mcpServers: { ...servers, [name]: entry } }, null, 2)}\n`;
}

/** The top-level table of a Codex TOML or Claude JSON config, or null when it does not parse. */
export function parseNativeConfig(provider: "codex" | "claude", text: string): ObjectValue | null {
  try {
    const data: unknown = provider === "codex" ? parse(text) : JSON.parse(text);
    return isObject(data) ? data : null;
  } catch {
    return null;
  }
}

/** Codex plugins are keyed `<name>@<marketplace>`; one of the same name supersedes a bare server. */
export function codexPluginProvides(config: ObjectValue, name: string): boolean {
  const plugins = config.plugins;
  if (!isObject(plugins)) return false;
  return Object.entries(plugins).some(
    ([key, value]) => key.split("@")[0] === name && isObject(value) && value.enabled === true,
  );
}
