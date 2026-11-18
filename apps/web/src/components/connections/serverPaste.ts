import type { NativeServerInput } from "@specweave-studio/contracts";

import type { BuiltInToolId } from "./builtInTools";
import { parseTomlSubset } from "./serverPasteToml";

/** What a paste, a catalog entry or the summary's edits describe: one server to add. */
export interface ServerDraft {
  readonly name: string;
  readonly kind: "http" | "stdio";
  readonly server: NativeServerInput;
}
/** Why a paste cannot be used: a phrase and what fills its `{flag}`, `{key}` or `{count}`. */
export interface PasteRefusal {
  readonly reason: string;
  readonly params?: Readonly<Record<string, string>>;
}
export type PasteResult =
  | { readonly ok: true; readonly draft: ServerDraft }
  | ({ readonly ok: false } & PasteRefusal);

/** The same rules the machine applies before it writes (`inputDeclaration` on the server). */
export const SERVER_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_KEY = /^[A-Za-z0-9-]{1,128}$/;
const WEB_ADDRESS = /^https?:\/\/\S+$/i;
const control = (text: string) =>
  [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

const UNREADABLE =
  "SpecWithCode could not read this as a web address, a command or a settings block.";
const SSE =
  "This is an SSE server, which SpecWithCode cannot add. Look for a Streamable HTTP address on the server's setup page.";
const NOT_WEB = "Only http and https addresses can be added.";
const FLAG = "SpecWithCode cannot carry over the {tool} option “{flag}”.";
const KEY = "SpecWithCode cannot carry over the setting “{key}”: it only works in one tool.";
const MANY = "This block has {count} servers. Paste one at a time.";

const refuse = (reason: string, params?: Record<string, string>): PasteResult =>
  params ? { ok: false, reason, params } : { ok: false, reason };
const unreadable = () => refuse(UNREADABLE);

/** A name the machine accepts, made from whatever the paste called the server. */
export function serverNameFrom(text: string): string {
  const cleaned = text
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[^A-Za-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return cleaned || "server";
}

const GENERIC = new Set(["mcp", "server", "index", "main", "build", "dist", "run", "start", ""]);
/** `@upstash/context7-mcp@latest` is "context7"; `@playwright/mcp` is "playwright". */
function packageName(spec: string): string {
  const scoped = spec.startsWith("@");
  const [first = "", second = ""] = (scoped ? spec.slice(1) : spec).split("/");
  const strip = (value: string) =>
    value
      .replace(/[@:].*$/, "")
      .replace(/^(mcp-server-|server-|mcp-)/, "")
      .replace(/(-mcp-server|-mcp|-server)$/, "");
  const own = strip(scoped ? second : first);
  return GENERIC.has(own) && scoped ? strip(first) : own;
}

function nameFromAddress(url: string): string {
  try {
    const labels = new URL(url).hostname.split(".");
    // A bare host or an IP address names nothing.
    if (labels.length < 2 || labels.every((label) => /^\d+$/.test(label))) return "server";
    return serverNameFrom(labels.at(-2)!);
  } catch {
    return "server";
  }
}

function nameFromCommand(command: string, args: ReadonlyArray<string>): string {
  const program = (command.split(/[\\/]/).at(-1) ?? "").replace(/\.(cmd|exe)$/, "");
  const words = args.filter((arg) => !arg.startsWith("-") && !/^(dlx|run|exec)$/.test(arg));
  // A container's image comes last; a package runner's package comes first.
  const target = /^(docker|podman)$/.test(program) ? words.at(-1) : words[0];
  if (!target) return GENERIC.has(program) ? "server" : serverNameFrom(packageName(program));
  const base = (target.split(/[\\/]/).at(-1) ?? "").replace(/\.[A-Za-z]+$/, "");
  const name = packageName(target.startsWith("@") ? target : base);
  return GENERIC.has(name) ? "server" : serverNameFrom(name);
}

function addressDraft(
  name: string | null,
  url: string,
  headers: Readonly<Record<string, string>>,
): PasteResult {
  if (!WEB_ADDRESS.test(url))
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? refuse(NOT_WEB) : unreadable();
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return unreadable();
  }
  if (/\/sse\/?$/i.test(path)) return refuse(SSE);
  for (const [key, value] of Object.entries(headers))
    if (!HEADER_KEY.test(key) || control(value)) return unreadable();
  return {
    ok: true,
    draft: {
      name: name === null ? nameFromAddress(url) : serverNameFrom(name),
      kind: "http",
      server: { url, ...(Object.keys(headers).length ? { headers: { ...headers } } : {}) },
    },
  };
}

function programDraft(
  name: string | null,
  command: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
): PasteResult {
  if (!command || command.trim() !== command || control(command) || args.some(control))
    return unreadable();
  for (const [key, value] of Object.entries(env))
    if (!ENV_KEY.test(key) || control(value)) return unreadable();
  return {
    ok: true,
    draft: {
      name: name === null ? nameFromCommand(command, args) : serverNameFrom(name),
      kind: "stdio",
      server: {
        command,
        ...(args.length ? { args: [...args] } : {}),
        ...(Object.keys(env).length ? { env: { ...env } } : {}),
      },
    },
  };
}

/** Split a command line the way a shell would: quotes, escapes and line continuations. */
export function shellWords(text: string): string[] | null {
  const words: string[] = [];
  let word = "";
  // An empty pair of quotes is still a word.
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && next !== undefined && '"\\$`'.includes(next)) {
        word += next;
        index += 1;
      } else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\") {
      if (next === undefined) return null;
      index += 1;
      // A backslash before a line break joins the two lines.
      if (next === "\n") continue;
      if (next === "\r" && text[index + 1] === "\n") {
        index += 1;
        continue;
      }
      word += next;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote !== null) return null;
  if (started) words.push(word);
  return words;
}

function pair(text: string, separator: "=" | ":"): [string, string] | null {
  const index = text.indexOf(separator);
  if (index <= 0) return null;
  return [text.slice(0, index).trim(), text.slice(index + 1).trim()];
}

/** `--flag=value` as its two halves; a short flag or a plain word as itself. */
function splitFlag(word: string): [string, string | null] {
  const index = word.startsWith("--") ? word.indexOf("=") : -1;
  return index === -1 ? [word, null] : [word.slice(0, index), word.slice(index + 1)];
}

const CLAUDE_REFUSED = new Set(["--client-id", "--client-secret", "--callback-port"]);

/** `claude mcp add [options] <name> <commandOrUrl> [args...]`, as Claude Code 2.1 documents it. */
function claudeAdd(words: ReadonlyArray<string>, env: Record<string, string>): PasteResult {
  const tool = "Claude Code";
  const headers: Record<string, string> = {};
  const positional: string[] = [];
  let transport: string | null = null;
  let index = 0;
  for (; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === "--") {
      positional.push(...words.slice(index + 1));
      break;
    }
    const [flag, inline] = splitFlag(word);
    const value = () => inline ?? words[(index += 1)];
    if (flag === "-t" || flag === "--transport") transport = value() ?? null;
    else if (flag === "-s" || flag === "--scope") value();
    else if (flag === "-e" || flag === "--env" || flag === "-H" || flag === "--header") {
      // Both take one or more values, up to the next option.
      const header = flag === "-H" || flag === "--header";
      const values = inline === null ? [] : [inline];
      for (;;) {
        const next = words[index + 1];
        if (next === undefined || next.startsWith("-")) break;
        const parsed = pair(next, header ? ":" : "=");
        // `https://…` after a header is the server's address, not another header.
        if (parsed === null || (header && parsed[1].startsWith("//"))) break;
        index += 1;
        values.push(next);
      }
      if (values.length === 0) return unreadable();
      for (const item of values) {
        const parsed = pair(item, header ? ":" : "=");
        if (parsed === null) return unreadable();
        (header ? headers : env)[parsed[0]] = parsed[1];
      }
    } else if (CLAUDE_REFUSED.has(flag)) return refuse(FLAG, { tool, flag });
    else if (flag.startsWith("-") && positional.length < 2) return refuse(FLAG, { tool, flag });
    else positional.push(word);
  }
  const [name, target, ...args] = positional;
  if (!name || !target) return unreadable();
  if (transport === "sse") return refuse(SSE);
  const address = /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
  if (transport === "http" || (transport === null && address)) {
    const extra = args.find((arg) => arg.startsWith("-"));
    if (extra) return refuse(FLAG, { tool, flag: splitFlag(extra)[0] });
    if (args.length > 0) return unreadable();
    if (Object.keys(env).length > 0) return refuse(FLAG, { tool, flag: "--env" });
    return addressDraft(name, target, headers);
  }
  if (transport !== null && transport !== "stdio") return unreadable();
  if (Object.keys(headers).length > 0) return refuse(FLAG, { tool, flag: "--header" });
  return programDraft(name, target, args, env);
}

/** `claude mcp add-json <name> '<json>'`. */
function claudeAddJson(words: ReadonlyArray<string>): PasteResult {
  const positional: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const [flag, inline] = splitFlag(words[index]!);
    if (flag === "-s" || flag === "--scope") {
      if (inline === null) index += 1;
    } else if (flag.startsWith("-") && positional.length < 2)
      return refuse(FLAG, { tool: "Claude Code", flag });
    else positional.push(words[index]!);
  }
  const [name, json, ...rest] = positional;
  if (!name || !json || rest.length > 0) return unreadable();
  let entry: unknown;
  try {
    entry = JSON.parse(json);
  } catch {
    return unreadable();
  }
  return entryDraft(name, entry);
}

/** `codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)`, as Codex 0.162 documents it. */
function codexAdd(words: ReadonlyArray<string>, env: Record<string, string>): PasteResult {
  const tool = "Codex";
  const positional: string[] = [];
  let url: string | null = null;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === "--") {
      positional.push(...words.slice(index + 1));
      break;
    }
    const [flag, inline] = splitFlag(word);
    if (flag === "--url" || flag === "--env") {
      const value = inline ?? words[(index += 1)];
      if (value === undefined) return unreadable();
      if (flag === "--url") url = value;
      else {
        const parsed = pair(value, "=");
        if (parsed === null) return unreadable();
        env[parsed[0]] = parsed[1];
      }
    } else if (flag.startsWith("-") && positional.length < 2) return refuse(FLAG, { tool, flag });
    else positional.push(word);
  }
  const [name, command, ...args] = positional;
  if (!name) return unreadable();
  if (url !== null) {
    if (command !== undefined) return unreadable();
    if (Object.keys(env).length > 0) return refuse(FLAG, { tool, flag: "--env" });
    return addressDraft(name, url, {});
  }
  if (!command) return unreadable();
  return programDraft(name, command, args, env);
}

/** Programs a setup page starts a server with. Anything else is entered by hand. */
const LAUNCHERS =
  /^(npx|uvx|bunx|pnpm|yarn|node|bun|deno|python|python3|uv|pipx|docker|podman)(\.cmd|\.exe)?$/;

function commandLine(text: string): PasteResult {
  const words = shellWords(text.replace(/^\s*\$\s+/, ""));
  if (words === null || words.length === 0) return unreadable();
  const env: Record<string, string> = {};
  let start = 0;
  // `KEY=value command …` sets a variable for that command only.
  while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]!)) {
    const [key, value] = pair(words[start]!, "=")!;
    env[key] = value;
    start += 1;
  }
  const [program, ...rest] = words.slice(start);
  if (!program) return unreadable();
  if (program === "claude" || program === "codex") {
    if (rest[0] !== "mcp") return unreadable();
    if (program === "claude" && rest[1] === "add") return claudeAdd(rest.slice(2), env);
    if (program === "claude" && rest[1] === "add-json" && start === 0)
      return claudeAddJson(rest.slice(2));
    if (program === "codex" && rest[1] === "add") return codexAdd(rest.slice(2), env);
    return unreadable();
  }
  if (!LAUNCHERS.test(program) && !program.startsWith("/")) return unreadable();
  return programDraft(null, program, rest, env);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
/** Names with string, number or boolean values, as environment and header tables hold. */
function stringRecord(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean")
      return null;
    result[key] = String(item);
  }
  return result;
}

const ADDRESS_KEYS = ["url", "httpUrl", "serverUrl"] as const;
const ENTRY_KEYS = new Set([
  "command",
  "args",
  "env",
  "environment",
  "headers",
  "http_headers",
  "type",
  "transport",
  ...ADDRESS_KEYS,
]);
const looksLikeEntry = (value: Record<string, unknown>) =>
  "command" in value || ADDRESS_KEYS.some((key) => key in value);

/** One server entry as any of the tools writes it, with the name the block gave it. */
function entryDraft(name: string | null, entry: unknown): PasteResult {
  if (!isRecord(entry)) return unreadable();
  for (const [key, value] of Object.entries(entry)) {
    if (ENTRY_KEYS.has(key)) continue;
    // "On" written out is what an add does anyway.
    if ((key === "enabled" && value === true) || (key === "disabled" && value === false)) continue;
    return refuse(KEY, { key });
  }
  const type = entry.type ?? entry.transport;
  if (type !== undefined && typeof type !== "string") return unreadable();
  if (type === "sse") return refuse(SSE);
  const addresses = ADDRESS_KEYS.filter((key) => entry[key] !== undefined);
  if (addresses.length > 1) return unreadable();
  const url = addresses.length === 1 ? entry[addresses[0]!] : undefined;
  const env = stringRecord(entry.env ?? entry.environment);
  const headers = stringRecord(entry.headers ?? entry.http_headers);
  if (env === null || headers === null) return unreadable();
  if (url !== undefined) {
    if (typeof url !== "string" || entry.command !== undefined || entry.args !== undefined)
      return unreadable();
    if (
      type !== undefined &&
      !/^(http|streamable-http|streamableHttp|streamable_http|remote)$/.test(type)
    )
      return unreadable();
    if (Object.keys(env).length > 0) return refuse(KEY, { key: "env" });
    return addressDraft(name, url, headers);
  }
  if (type !== undefined && type !== "stdio" && type !== "local") return unreadable();
  if (Object.keys(headers).length > 0) return refuse(KEY, { key: "headers" });
  // OpenCode writes the program and its arguments as one list.
  const command = isStrings(entry.command) ? entry.command[0] : entry.command;
  const args = isStrings(entry.command) ? entry.command.slice(1) : (entry.args ?? []);
  if (typeof command !== "string" || !isStrings(args)) return unreadable();
  if (isStrings(entry.command) && entry.args !== undefined) return unreadable();
  return programDraft(name, command, args, env);
}

const BLOCK_KEYS = ["mcpServers", "mcp_servers", "servers", "mcp"] as const;

/** A settings block as an object: one entry, a name with its entry, or a tool's servers table. */
function blockDraft(root: unknown): PasteResult {
  if (!isRecord(root)) return unreadable();
  const holder = BLOCK_KEYS.find((key) => isRecord(root[key]));
  if (holder === undefined && looksLikeEntry(root)) return entryDraft(null, root);
  const servers = holder === undefined ? root : (root[holder] as Record<string, unknown>);
  const names = Object.keys(servers);
  if (names.length === 0 || !names.every((key) => isRecord(servers[key]))) return unreadable();
  if (names.length > 1) return refuse(MANY, { count: String(names.length) });
  return entryDraft(names[0]!, servers[names[0]!]);
}

function jsonBlock(text: string): PasteResult {
  const body = text.replace(/,\s*$/, "");
  try {
    // A setup page often shows the entry alone: `"name": { … }`.
    return blockDraft(JSON.parse(body.startsWith('"') ? `{${body}}` : body));
  } catch {
    return unreadable();
  }
}

function tomlBlock(text: string): PasteResult {
  const root = parseTomlSubset(text);
  if (root !== null) return blockDraft(root);
  // `KEY="value" npx …` starts like TOML and is a command.
  return text.includes("\n") ? unreadable() : commandLine(text);
}

/** Read what a server's setup page gives: an address, a command, or a JSON or TOML block. */
export function parseServerPaste(input: string): PasteResult | null {
  const text = input.trim();
  if (!text) return null;
  if (text.startsWith("{") || text.startsWith('"')) return jsonBlock(text);
  // A TOML block may open with comment lines.
  const first = text.replace(/^(\s*#[^\n]*\n)+/, "").trimStart();
  if (/^\[\s*["'A-Za-z_]/.test(first) || /^[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*["'[{]/.test(first))
    return tomlBlock(text);
  if (!/\s/.test(text) && /^[a-z][a-z0-9+.-]*:\/\//i.test(text))
    return addressDraft(null, text, {});
  return commandLine(text);
}

/** A flag whose value is a secret, as the machine's own masking reads it. */
const SECRET_FLAG =
  /^--?[\w-]*(key|token|secret|password|passwd|pwd|auth|authorization|credential|cookie|pat|session)[\w-]*$/i;

/** Positions in a program's arguments that hold a secret: the value after a secret-named flag. */
export function secretArgs(args: ReadonlyArray<string>): ReadonlySet<number> {
  const secret = new Set<number>();
  args.forEach((arg, index) => {
    if (index > 0 && SECRET_FLAG.test(args[index - 1]!) && !arg.startsWith("-")) secret.add(index);
  });
  return secret;
}

/** A value a setup page prints in place of the reader's own: `YOUR_API_KEY`, `<token>`, `${VAR}`. */
export const isPlaceholder = (value: string) =>
  /^$|^<[^>]*>$|^x{3,}$|^\.{3}$|^…$|^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$|your[-_ ]|^changeme$|^replace[-_ ]?me$/i.test(
    value.trim(),
  );

/** A built-in tool a server duplicates, with one sentence each on what both do. */
export interface BuiltInOverlap {
  readonly tool: BuiltInToolId;
  readonly builtIn: string;
  readonly adds: string;
  readonly link: string;
}
const OVERLAPS: ReadonlyArray<BuiltInOverlap & { readonly match: RegExp }> = [
  {
    tool: "chrome",
    match: /chrome[-_]?devtools/,
    builtIn: "Agents here already browse and click in your signed-in Chrome.",
    adds: "This server adds Chrome's developer tools, such as performance traces and network logs.",
    link: "Open Chrome settings",
  },
  {
    tool: "in-app-browser",
    match: /playwright|puppeteer|browsermcp|browser[-_]?use|browserbase/,
    builtIn: "Agents here already have a browser inside the app for testing sites and screenshots.",
    adds: "This server adds a separate browser that it starts and drives itself.",
    link: "Open Agent access",
  },
  {
    tool: "computer-use",
    match: /computer[-_]?use|desktop[-_]?automation/,
    builtIn: "Agents here can already see the screen, click and type in Mac apps.",
    adds: "This server adds its own way to control the desktop.",
    link: "Open Agent access",
  },
  {
    tool: "simulators",
    match: /ios[-_]?simulator|mobile[-_]?mcp|xcodebuild|android[-_]?(mcp|emulator)|appium/,
    builtIn: "Agents here already run the iOS Simulator and Android Emulator.",
    adds: "This server adds its own commands for simulators and devices.",
    link: "Open Devices",
  },
];

/** The built-in tool this server overlaps with, judged by its name, program and address. */
export function builtInOverlap(draft: ServerDraft): BuiltInOverlap | null {
  const { command = "", args = [], url = "" } = draft.server;
  const text = [draft.name, command, ...args, url].join(" ").toLowerCase();
  const found = OVERLAPS.find((overlap) => overlap.match.test(text));
  if (!found) return null;
  const { match: _match, ...overlap } = found;
  return overlap;
}
