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

const codexTable = (declaration: PortableDeclaration) =>
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

/** Append `[mcp_servers.<name>]` to a Codex config that does not declare it yet. */
export function appendCodexServer(
  text: string,
  name: string,
  declaration: PortableDeclaration,
): string | null {
  return appendCodexTable(text, name, codexTable(declaration));
}

/** Append a raw server table, as declared, to a Codex config that lacks the name. */
export function appendCodexTable(text: string, name: string, table: ObjectValue): string | null {
  const before = parseNativeConfig("codex", text);
  if (before === null) return null;
  if (isObject(before.mcp_servers) && Object.hasOwn(before.mcp_servers, name)) return null;
  const block = stringify({ mcp_servers: { [name]: table } });
  const separator =
    text.length === 0 || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  const next = `${text}${separator}${block}\n`;
  const server = parseNativeConfig("codex", next)?.mcp_servers;
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

/** Every tool whose user configuration the library edits. */
export type EditableTool =
  | "codex"
  | "claude"
  | "claude-desktop"
  | "gemini"
  | "copilot"
  | "cursor"
  | "opencode"
  | "windsurf";

/** Keys each JSON-configured tool reads in a server entry, beyond the launch itself. */
const TOOL_KEYS: Record<Exclude<EditableTool, "codex" | "claude">, ReadonlySet<string>> = {
  "claude-desktop": new Set(["type", "command", "args", "env"]),
  gemini: new Set(["command", "args", "env", "httpUrl", "headers"]),
  copilot: new Set(["type", "command", "args", "env", "url", "headers", "tools"]),
  cursor: new Set(["type", "command", "args", "env", "url", "headers"]),
  opencode: new Set(["type", "command", "environment", "url", "headers", "enabled"]),
  windsurf: new Set(["command", "args", "env", "serverUrl", "headers", "disabled"]),
};

/** A declaration in any tool's format as a launch every tool can run, or null. */
export function toolDeclaration(tool: EditableTool, config: unknown): PortableDeclaration | null {
  if (tool === "codex" || tool === "claude") return portableDeclaration(tool, config);
  if (!isObject(config)) return null;
  if (Object.keys(config).some((key) => !TOOL_KEYS[tool].has(key))) return null;
  if (tool === "opencode") {
    const { command, url, type } = config;
    if (type === "local" && isStrings(command) && command.length > 0 && url === undefined) {
      const env = config.environment ?? {};
      const [program, ...args] = command;
      if (!portableCommand(program!) || !isStringRecord(env)) return null;
      return { transport: "stdio", command: program!, args, env };
    }
    if (type === "remote" && typeof url === "string" && command === undefined) {
      const headers = config.headers ?? {};
      if (!/^https?:\/\//i.test(url) || !isStringRecord(headers)) return null;
      return { transport: "http", url, headers };
    }
    return null;
  }
  const type = config.type;
  const command = config.command;
  const url =
    tool === "gemini" ? config.httpUrl : tool === "windsurf" ? config.serverUrl : config.url;
  if (typeof command === "string" && url === undefined) {
    if (type !== undefined && type !== "stdio" && type !== "local") return null;
    const args = config.args ?? [];
    const env = config.env ?? {};
    if (!portableCommand(command) || !isStrings(args) || !isStringRecord(env)) return null;
    return { transport: "stdio", command, args, env };
  }
  if (typeof url === "string" && command === undefined) {
    if (type !== undefined && type !== "http" && type !== "streamable-http") return null;
    const headers = config.headers ?? {};
    if (!/^https?:\/\//i.test(url) || !isStringRecord(headers)) return null;
    return { transport: "http", url, headers };
  }
  return null;
}

const nonEmpty = (record: Readonly<Record<string, string>>, key: string) =>
  Object.keys(record).length ? { [key]: { ...record } } : {};

/** The entry a tool reads for this launch, or null when the tool cannot run it. */
export function toolEntry(
  tool: EditableTool,
  declaration: PortableDeclaration,
): ObjectValue | null {
  const stdio = declaration.transport === "stdio" ? declaration : null;
  const http = declaration.transport === "http" ? declaration : null;
  switch (tool) {
    case "codex":
      return codexTable(declaration);
    case "claude":
      return stdio
        ? { type: "stdio", command: stdio.command, args: [...stdio.args], env: { ...stdio.env } }
        : { type: "http", url: http!.url, headers: { ...http!.headers } };
    case "claude-desktop":
      return stdio
        ? { command: stdio.command, args: [...stdio.args], ...nonEmpty(stdio.env, "env") }
        : null;
    case "gemini":
      return stdio
        ? { command: stdio.command, args: [...stdio.args], ...nonEmpty(stdio.env, "env") }
        : { httpUrl: http!.url, ...nonEmpty(http!.headers, "headers") };
    case "cursor":
      return stdio
        ? { command: stdio.command, args: [...stdio.args], ...nonEmpty(stdio.env, "env") }
        : { url: http!.url, ...nonEmpty(http!.headers, "headers") };
    case "copilot":
      return stdio
        ? {
            type: "local",
            command: stdio.command,
            args: [...stdio.args],
            ...nonEmpty(stdio.env, "env"),
            tools: ["*"],
          }
        : { type: "http", url: http!.url, ...nonEmpty(http!.headers, "headers"), tools: ["*"] };
    case "opencode":
      return stdio
        ? {
            type: "local",
            command: [stdio.command, ...stdio.args],
            ...nonEmpty(stdio.env, "environment"),
            enabled: true,
          }
        : { type: "remote", url: http!.url, ...nonEmpty(http!.headers, "headers"), enabled: true };
    case "windsurf":
      return stdio
        ? { command: stdio.command, args: [...stdio.args], ...nonEmpty(stdio.env, "env") }
        : { serverUrl: http!.url, ...nonEmpty(http!.headers, "headers") };
  }
}

/** Where a JSON-configured tool keeps its servers. */
export const jsonServersKey = (tool: Exclude<EditableTool, "codex">) =>
  tool === "opencode" ? "mcp" : "mcpServers";

/** The servers a tool's configuration text declares, or null when it does not parse. */
export function toolServers(tool: EditableTool, text: string | null): ObjectValue | null {
  if (text === null) return {};
  const data = parseNativeConfig(tool === "codex" ? "codex" : "claude", text);
  if (data === null) return null;
  const servers = tool === "codex" ? data.mcp_servers : data[jsonServersKey(tool)];
  if (servers === undefined) return {};
  return isObject(servers) ? servers : null;
}

/**
 * Add, replace (`replace`) or, with `value` undefined, delete one server of a
 * JSON configuration. Null when the file is not an object, the name is taken
 * (adding) or absent (replacing or deleting).
 */
export function setJsonServer(
  tool: Exclude<EditableTool, "codex">,
  text: string | null,
  name: string,
  value: ObjectValue | undefined,
  replace = false,
): string | null {
  const data = parseNativeConfig("claude", text === null || text.trim() === "" ? "{}" : text);
  if (data === null) return null;
  const key = jsonServersKey(tool);
  const servers = data[key] ?? {};
  if (!isObject(servers)) return null;
  const present = Object.hasOwn(servers, name);
  if (value === undefined ? !present : present !== replace) return null;
  const next = { ...servers };
  if (value === undefined) delete next[name];
  else next[name] = value;
  return `${JSON.stringify({ ...data, [key]: next }, null, 2)}\n`;
}

/** Locate `[<table>]` and the lines of its sub-tables, or null when it is not a plain table. */
function codexTableRange(lines: ReadonlyArray<string>, target: string) {
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!/^\s*\[/.test(line)) continue;
    const key = tableKey(line);
    if (start === -1) {
      if (key === target) start = index;
      continue;
    }
    if (key === null || (key !== target && !key.startsWith(`${target}.`)))
      return { start, end: index };
  }
  return start === -1 ? null : { start, end: lines.length };
}

const codexServer = (text: string, name: string) => {
  const servers = parseNativeConfig("codex", text)?.mcp_servers;
  return isObject(servers) && isObject(servers[name]) ? servers[name] : undefined;
};

/** Set `enabled = false` inside `[mcp_servers.<name>]`, flipping or adding the line. */
export function disableCodexServer(text: string, name: string): string | null {
  const lines = text.split("\n");
  const range = codexTableRange(lines, `mcp_servers.${name}`);
  if (range === null) return null;
  let flipped = false;
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = lines[index]!;
    if (/^\s*\[/.test(line)) break;
    if (/^\s*enabled\s*=\s*true\s*(?:#.*)?$/.test(line)) {
      lines[index] = line.replace(/true/, "false");
      flipped = true;
      break;
    }
  }
  if (!flipped) lines.splice(range.start + 1, 0, "enabled = false");
  const next = lines.join("\n");
  return codexServer(next, name)?.enabled === false ? next : null;
}

/** Delete `[mcp_servers.<name>]` and its sub-tables, leaving every other line as written. */
export function removeCodexServer(text: string, name: string): string | null {
  const lines = text.split("\n");
  const range = codexTableRange(lines, `mcp_servers.${name}`);
  if (range === null) return null;
  const before = parseNativeConfig("codex", text);
  // Comments and blank lines after the last key belong to whatever follows, so they stay.
  let end = range.end;
  while (end > range.start + 1 && /^\s*(?:#.*)?$/.test(lines[end - 1]!)) end -= 1;
  lines.splice(range.start, end - range.start);
  let next = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  if (range.start === 0) next = next.replace(/^\n+/, "");
  const after = parseNativeConfig("codex", next);
  if (before === null || after === null || codexServer(next, name) !== undefined) return null;
  // Everything but the one server must read the same as before.
  const rest = { ...object(before.mcp_servers) };
  delete rest[name];
  return JSON.stringify({ ...before, mcp_servers: rest }) ===
    JSON.stringify({ ...after, mcp_servers: object(after.mcp_servers) })
    ? next
    : null;
}

const object = (v: unknown): ObjectValue => (isObject(v) ? v : {});

/** Turn an installed Codex plugin on or off in its `[plugins."<key>"]` table. */
export function setCodexPlugin(text: string, key: string, enabled: boolean): string | null {
  const lines = text.split("\n");
  const range = codexTableRange(lines, `plugins.${key}`);
  if (range === null) return null;
  let set = false;
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = lines[index]!;
    if (/^\s*\[/.test(line)) break;
    if (/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/.test(line)) {
      lines[index] = line.replace(/true|false/, String(enabled));
      set = true;
      break;
    }
  }
  if (!set) lines.splice(range.start + 1, 0, `enabled = ${enabled}`);
  const next = lines.join("\n");
  const plugin = object(parseNativeConfig("codex", next)?.plugins)[key];
  return isObject(plugin) && plugin.enabled === enabled ? next : null;
}

/** A Codex plugin key `<name>@<marketplace>` without its marketplace; skills are named `<name>:<skill>`. */
export const codexPluginName = (key: string) => key.split("@")[0] ?? key;

/** Normalize a TOML array-of-tables header to `a.b`, or null for any other line. */
const arrayTableKey = (line: string) => {
  const match = /^\s*\[\[([^[\]]+)\]\]\s*(?:#.*)?$/.exec(line);
  if (!match) return null;
  return match[1]!
    .split(".")
    .map((part) => part.trim().replace(/^"(.*)"$|^'(.*)'$/, "$1$2"))
    .join(".");
};

/** A `[[skills.config]]` entry that names a skill; entries with a SKILL.md `path` are left alone. */
const namedSkill = (entry: unknown): entry is ObjectValue & { name: string } =>
  isObject(entry) && typeof entry.name === "string" && entry.path === undefined;
const skillEntries = (config: ObjectValue): unknown[] => {
  const list = object(config.skills).config;
  return Array.isArray(list) ? list : [];
};
/** An entry with nothing beyond its name and switch, so it can go or come whole. */
const plainSkill = (entry: ObjectValue) =>
  Object.keys(entry).every((key) => key === "name" || key === "enabled");

/** Skill names a Codex config turns off by name, whichever install they load from. */
export function disabledCodexSkills(config: ObjectValue): Set<string> {
  return new Set(
    skillEntries(config)
      .filter(namedSkill)
      .filter((entry) => entry.enabled === false)
      .map((entry) => entry.name),
  );
}

/** The config with each skill entry mapped; entries mapped to null go, and a list or table emptied by that too. */
const mapSkills = (config: ObjectValue, map: (entry: unknown) => unknown) => {
  if (!Array.isArray(object(config.skills).config)) return config;
  const skills = { ...object(config.skills) };
  const kept = skillEntries(config)
    .map(map)
    .filter((entry) => entry !== null);
  if (kept.length > 0) skills.config = kept;
  else delete skills.config;
  const next = { ...config };
  if (Object.keys(skills).length > 0) next.skills = skills;
  else delete next.skills;
  return next;
};

const parseEntry = (text: string): unknown => {
  try {
    return parse(text);
  } catch {
    return null;
  }
};

/** Line ranges of every `[[skills.config]]` entry with its sub-tables, and the entry each holds. */
function skillBlocks(lines: ReadonlyArray<string>) {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!/^\s*\[/.test(line)) continue;
    const array = arrayTableKey(line);
    const key = array ?? tableKey(line);
    if (start !== -1 && key !== null && key.startsWith("skills.config.")) continue;
    if (start !== -1) ranges.push({ start, end: index });
    start = array === "skills.config" ? index : -1;
  }
  if (start !== -1) ranges.push({ start, end: lines.length });
  return ranges.map((range) => ({
    ...range,
    entry: parseEntry(lines.slice(range.start + 1, range.end).join("\n")),
  }));
}

const quotedKey = (key: string) => `(?:${key}|"${key}"|'${key}')`;
const CONFIG_ARRAY = new RegExp(`^\\s*${quotedKey("config")}\\s*=\\s*\\[`);
const SKILLS_CONFIG_ARRAY = new RegExp(
  `^\\s*${quotedKey("skills")}\\s*\\.\\s*${quotedKey("config")}\\s*=\\s*\\[`,
);

/** The value spans of a TOML array opening at `open`, and its closing bracket; null when it never closes. */
function arrayElements(text: string, open: number) {
  const elements: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = -1;
  let end = -1;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "#") {
      while (index + 1 < text.length && text[index + 1] !== "\n") index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = text.startsWith(char.repeat(3), index) ? char.repeat(3) : char;
      if (depth === 1 && start === -1) start = index;
      index += quote.length;
      while (index < text.length && !text.startsWith(quote, index))
        index += char === '"' && text[index] === "\\" ? 2 : 1;
      index += quote.length - 1;
      if (depth === 1) end = index + 1;
      continue;
    }
    if (char === "[" || char === "{") {
      depth += 1;
      if (depth === 2 && start === -1) start = index;
      continue;
    }
    if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 1) end = index + 1;
      if (depth > 0) continue;
      if (start !== -1) elements.push({ start, end });
      return { close: index, elements };
    }
    if (depth !== 1 || /\s/.test(char)) continue;
    if (char === ",") {
      if (start !== -1) elements.push({ start, end });
      start = -1;
      continue;
    }
    if (start === -1) start = index;
    end = index + 1;
  }
  return null;
}

/** `skills.config` written as one inline array, under `[skills]` or at the top level. */
function inlineSkillArray(text: string) {
  let table = "";
  let offset = 0;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*\[/.test(line)) table = arrayTableKey(line) ?? tableKey(line) ?? "?";
    else {
      const pattern = table === "" ? SKILLS_CONFIG_ARRAY : table === "skills" ? CONFIG_ARRAY : null;
      const match = pattern?.exec(line);
      if (match) {
        const open = offset + match[0].length - 1;
        const found = arrayElements(text, open);
        return found === null ? null : { open, ...found };
      }
    }
    offset += raw.length + 1;
  }
  return null;
}

/**
 * How a Codex config writes `skills.config`: as `[[skills.config]]` blocks
 * (or not at all), as one inline array, or null for any other form, such as
 * a plain table or an array inside an inline `skills` table.
 */
function skillLayout(text: string, config: ObjectValue) {
  const list = object(config.skills).config;
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const blocks = skillBlocks(lines);
  if (list === undefined) return { kind: "blocks" as const, blocks };
  if (!Array.isArray(list)) return null;
  const inline = inlineSkillArray(text);
  if (inline !== null)
    return inline.elements.length === list.length ? { kind: "inline" as const, ...inline } : null;
  return blocks.length === list.length ? { kind: "blocks" as const, blocks } : null;
}

/** Whether setCodexSkills can edit this config's skill entries; false for a form it does not write. */
export function editableCodexSkills(text: string): boolean {
  const config = parseNativeConfig("codex", text);
  return config !== null && skillLayout(text, config) !== null;
}

/**
 * Turn Codex skills off or on by name in `skills.config`. Off appends an
 * `enabled = false` entry for each name that lacks one, dropping a name entry
 * that turns it on; on removes exactly the name entries that turn them off.
 * An entry with keys of its own keeps them and only has its switch flipped.
 * Path entries and every other line stay as written, in the file's own line
 * endings. Null when the result does not parse, anything beyond those entries
 * reads differently, or an entry for one of the names still says otherwise.
 */
export function setCodexSkills(
  text: string,
  names: ReadonlyArray<string>,
  enabled: boolean,
): string | null {
  const before = parseNativeConfig("codex", text);
  if (before === null) return null;
  const layout = skillLayout(text, before);
  if (layout === null) return null;
  const targets = new Set(names);
  const named = (entry: unknown): entry is ObjectValue & { name: string } =>
    namedSkill(entry) && targets.has(entry.name);
  // On touches only the entries that turn a name off; off, every other entry for it.
  const wrong = (entry: unknown): entry is ObjectValue =>
    named(entry) && (entry.enabled === false) === enabled;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const entryText = (name: string) => stringify({ name }).trim();
  let next = text;
  if (layout.kind === "blocks") {
    const lines = text.split("\n");
    const clean = lines.map((line) => line.replace(/\r$/, ""));
    const cr = eol === "\r\n" ? "\r" : "";
    const blank = (index: number) => index < clean.length && /^\s*$/.test(clean[index]!);
    for (const block of layout.blocks.toReversed()) {
      if (!wrong(block.entry)) continue;
      if (!plainSkill(block.entry)) {
        let flipped = false;
        for (let index = block.start + 1; index < block.end; index += 1) {
          if (/^\s*\[/.test(clean[index]!)) break;
          if (/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/.test(clean[index]!)) {
            lines[index] = lines[index]!.replace(/true|false/, String(enabled));
            flipped = true;
            break;
          }
        }
        if (!flipped) {
          lines.splice(block.start + 1, 0, `enabled = ${enabled}${cr}`);
          clean.splice(block.start + 1, 0, `enabled = ${enabled}`);
        }
        continue;
      }
      // Comments after the last key belong to whatever follows, so they stay.
      let end = block.end;
      while (end > block.start + 1 && /^\s*(?:#.*)?$/.test(clean[end - 1]!)) end -= 1;
      // The blank line that set the entry apart goes with it.
      if (block.start === 0 || blank(block.start - 1)) while (blank(end)) end += 1;
      lines.splice(block.start, end - block.start);
      clean.splice(block.start, end - block.start);
    }
    next = lines.join("\n");
  } else {
    const items = layout.elements.map((item) => ({ ...item }));
    let close = layout.close;
    const replace = (from: number, to: number, insert: string) => {
      next = `${next.slice(0, from)}${insert}${next.slice(to)}`;
      const move = (at: number) => (at >= to ? at + insert.length - (to - from) : at);
      for (const item of items)
        Object.assign(item, { start: move(item.start), end: move(item.end) });
      close = move(close);
    };
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]!;
      const source = next.slice(item.start, item.end);
      const entry = object(parseEntry(`entry = ${source}`)).entry;
      if (!wrong(entry)) continue;
      if (!plainSkill(entry)) {
        const switches = [...source.matchAll(/\benabled\s*=\s*(true|false)\b/g)];
        if (switches.length === 1) {
          const at = item.start + switches[0]!.index!;
          replace(at, at + switches[0]![0].length, `enabled = ${enabled}`);
        } else if (switches.length === 0 && !enabled) {
          const at = item.start + /^\{\s*/.exec(source)![0].length;
          replace(at, at, "enabled = false, ");
        }
        continue;
      }
      // Each entry takes the separator after it; the last takes the one before it.
      const following = items[index + 1];
      const previous = items[index - 1];
      if (following) replace(item.start, following.start, "");
      else if (previous) replace(previous.end, item.end, "");
      else replace(item.start, item.end + /^\s*,?/.exec(next.slice(item.end))![0].length, "");
      items.splice(index, 1);
    }
    if (!enabled) {
      const edited = parseNativeConfig("codex", next);
      if (edited === null) return null;
      const off = disabledCodexSkills(edited);
      const added = [...targets]
        .filter((name) => !off.has(name))
        .map((name) => `{ ${entryText(name)}, enabled = false }`);
      const last = items.at(-1);
      if (added.length > 0 && last) {
        // A multi-line array gets one entry per line, at the last entry's indent.
        const lineStart = next.lastIndexOf("\n", last.start) + 1;
        const indent = /^[ \t]*/.exec(next.slice(lineStart))![0];
        const multiline = next.slice(layout.open, last.start).includes("\n");
        const separator = multiline ? `,${eol}${indent}` : ", ";
        replace(last.end, last.end, added.map((entry) => `${separator}${entry}`).join(""));
      } else if (added.length > 0) replace(close, close, added.join(", "));
    }
  }
  if (!enabled && layout.kind === "blocks") {
    const edited = parseNativeConfig("codex", next);
    if (edited === null) return null;
    const off = disabledCodexSkills(edited);
    const missing = [...targets].filter((name) => !off.has(name));
    if (missing.length > 0) {
      const blocks = missing.map(
        (name) => `[[skills.config]]${eol}${entryText(name)}${eol}enabled = false${eol}`,
      );
      const separator =
        next.length === 0 || next.endsWith(`${eol}${eol}`)
          ? ""
          : next.endsWith("\n")
            ? eol
            : `${eol}${eol}`;
      next = `${next}${separator}${blocks.join(eol)}`;
    }
  }
  const after = parseNativeConfig("codex", next);
  if (after === null) return null;
  // Everything but the switches of the named entries, and plain entries for the names, reads the same.
  const rest = (config: ObjectValue) =>
    JSON.stringify(
      mapSkills(config, (entry) => {
        if (!named(entry)) return entry;
        if (plainSkill(entry)) return null;
        return Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "enabled"));
      }),
    );
  if (rest(before) !== rest(after)) return null;
  const entries = skillEntries(after).filter(named);
  if (entries.some(wrong)) return null;
  const off = disabledCodexSkills(after);
  return names.every((name) => off.has(name) === !enabled) ? next : null;
}

/** Turn a Claude Code plugin on or off in user settings.json `enabledPlugins`. */
export function setClaudePlugin(text: string | null, key: string, enabled: boolean): string | null {
  const data = parseNativeConfig("claude", text === null || text.trim() === "" ? "{}" : text);
  if (data === null) return null;
  const flags = data.enabledPlugins ?? {};
  if (!isObject(flags)) return null;
  return `${JSON.stringify({ ...data, enabledPlugins: { ...flags, [key]: enabled } }, null, 2)}\n`;
}

const MASK = "••••";
const SECRET_WORD =
  "key|token|secret|password|passwd|pwd|auth|authorization|credential|cookie|pat|session";
const SECRET_VALUE = /^(sk-|ph[xsp]_|gh[pousr]_|github_pat_|xox[abp]-|eyJ)|[A-Za-z0-9_-]{32}/i;
/** A flag whose next argument is a secret, or a name-value pair (header, env) to keep only the name of. */
const SECRET_FLAG = new RegExp(`^--?[\\w-]*(${SECRET_WORD})[\\w-]*$`, "i");
const PAIR_FLAG = /^(--header|-H|-e|--env|--env-var|--set-env)$/;
/** `name=value` or `name: value` with a secret-named name, anywhere in the string. */
const SECRET_PAIR = new RegExp(`([\\w.-]*(?:${SECRET_WORD})[\\w.-]*\\s*[=:]\\s*)\\S.*`, "i");
const SECRET_KEY = new RegExp(`(${SECRET_WORD})`, "i");
const VALUE_TABLES = new Set(["env", "environment", "headers", "http_headers"]);

const maskString = (value: string) => {
  if (SECRET_VALUE.test(value)) return MASK;
  return (
    value
      .replace(/\bBearer\s+\S+/gi, `Bearer ${MASK}`)
      .replace(SECRET_PAIR, `$1${MASK}`)
      // URL credentials and query strings carry tokens.
      .replace(/\/\/[^/@\s]+@/, `//${MASK}@`)
      .replace(/\?.*$/, (q) => (q ? `?${MASK}` : q))
  );
};
/** `NAME=value` or `Name: value`, keeping only the name. */
const maskPair = (value: string) => {
  const index = value.search(/[=:]/);
  return index > 0 ? `${value.slice(0, index + 1)}${MASK}` : MASK;
};
/** Every string under a value, masked whole. */
const maskAll = (v: unknown): unknown =>
  typeof v === "string"
    ? MASK
    : Array.isArray(v)
      ? v.map(maskAll)
      : isObject(v)
        ? Object.fromEntries(Object.entries(v).map(([k, item]) => [k, maskAll(item)]))
        : v;

/** A one-line view of an entry with environment, header and secret-shaped values masked. */
export function maskedEntry(value: unknown): string {
  const mask = (v: unknown): unknown => {
    if (typeof v === "string") return maskString(v);
    if (Array.isArray(v))
      return v.map((item, index) => {
        const flag = index > 0 ? String(v[index - 1]) : "";
        if (typeof item !== "string") return mask(item);
        if (PAIR_FLAG.test(flag)) return maskPair(item);
        if (SECRET_FLAG.test(flag)) return MASK;
        return mask(item);
      });
    if (!isObject(v)) return v;
    return Object.fromEntries(
      Object.entries(v).map(([k, item]) => [
        k,
        VALUE_TABLES.has(k) && isObject(item)
          ? Object.fromEntries(Object.keys(item).map((name) => [name, MASK]))
          : SECRET_KEY.test(k)
            ? maskAll(item)
            : mask(item),
      ]),
    );
  };
  return JSON.stringify(mask(value)).slice(0, 600);
}
