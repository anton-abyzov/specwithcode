/**
 * Plans an edit of user-scope MCP declarations across AI tools. Pure: the
 * caller reads the files, and writes the planned texts only after checking
 * that nobody changed them since.
 */
import type {
  NativeConnectionApplyInput,
  NativeConnectionsError,
} from "@specweave-studio/contracts";
import {
  appendCodexTable,
  disableCodexServer,
  type EditableTool,
  enableCodexServer,
  maskedEntry,
  parseNativeConfig,
  type PortableDeclaration,
  removeCodexServer,
  setClaudePlugin,
  setCodexPlugin,
  setJsonServer,
  toolDeclaration,
  toolEntry,
  toolServers,
} from "./NativeConnectionEdit.ts";

type ObjectValue = Record<string, unknown>;
const isObject = (v: unknown): v is ObjectValue =>
  v !== null && typeof v === "object" && !Array.isArray(v);
type Code = NativeConnectionsError["code"];

export const EDITABLE_TOOLS: ReadonlyArray<EditableTool> = [
  "codex",
  "claude",
  "claude-desktop",
  "gemini",
  "copilot",
  "cursor",
  "opencode",
  "windsurf",
];
const OTHER_TOOLS = new Set<string>(EDITABLE_TOOLS.filter((t) => t !== "codex" && t !== "claude"));
export const TOOL_LABELS: Record<EditableTool, string> = {
  codex: "Codex",
  claude: "Claude Code",
  "claude-desktop": "Claude Desktop",
  gemini: "Gemini CLI",
  copilot: "Copilot CLI",
  cursor: "Cursor",
  opencode: "OpenCode",
  windsurf: "Windsurf",
};
/** Tools with their own off switch; the others park the entry in SpecWithCode's state. */
const NATIVE_SWITCH = new Set<EditableTool>(["codex", "opencode"]);

/** A configuration file as read: null text when it does not exist yet. */
export interface FileState {
  readonly path: string;
  readonly text: string | null;
  /** Its folder exists, so the tool is installed and the file can be created. */
  readonly creatable: boolean;
  /** Present but too large or unreadable: never planned against, never written. */
  readonly unreadable?: boolean;
}
export interface ManageContext {
  readonly tools: Readonly<Partial<Record<EditableTool, FileState>>>;
  readonly claudeSettings: FileState;
  /** SpecWithCode's store of turned-off entries; null when this host has no state folder. */
  readonly parked: FileState | null;
  readonly digest: (name: string) => string;
}
export interface PlannedFile {
  readonly label: string;
  readonly path: string;
  readonly before: string | null;
  readonly after: string;
  readonly lines: ReadonlyArray<string>;
}
export type Plan = { readonly files: ReadonlyArray<PlannedFile> } | { readonly error: Code };

export interface ParkedEntry {
  readonly tool: EditableTool;
  readonly name: string;
  readonly value: ObjectValue;
}
const isParked = (e: unknown): e is ParkedEntry =>
  isObject(e) &&
  typeof e.tool === "string" &&
  (EDITABLE_TOOLS as ReadonlyArray<string>).includes(e.tool) &&
  typeof e.name === "string" &&
  isObject(e.value);
/** The entries of a parsed store; anything this build does not recognise is skipped. */
export function parkedFrom(data: unknown): ParkedEntry[] {
  const entries = isObject(data) ? data.entries : undefined;
  return Array.isArray(entries) ? entries.filter(isParked) : [];
}
/**
 * The store as written, every item kept so a rewrite never drops entries
 * another build wrote. Null when the file exists but is not a store: it is
 * then never overwritten.
 */
function parseStore(text: string | null): ReadonlyArray<unknown> | null {
  if (text === null || text.trim() === "") return [];
  const data = parseNativeConfig("claude", text);
  return isObject(data) && Array.isArray(data.entries) ? data.entries : null;
}
/** Parked entries have their own id, so a live entry of the same name is never mistaken for one. */
export const parkedId = (tool: EditableTool, hash: string) => `parked:${tool}:${hash}`;
/** A change's backup: every file's text before and after, secrets included. */
export const backupText = (files: ReadonlyArray<PlannedFile>) =>
  JSON.stringify({
    version: 1,
    files: files.map(({ label, path, before, after }) => ({ label, path, before, after })),
  });
const serializeParked = (entries: ReadonlyArray<unknown>) =>
  `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_KEY = /^[A-Za-z0-9-]{1,128}$/;
/** Control characters would break a config line or hide part of a command. */
const control = (text: string) =>
  [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/** The launch a user typed, or null when it is incomplete or unsafe to write. */
export function inputDeclaration(
  server: NativeConnectionApplyInput["server"],
): PortableDeclaration | null {
  if (!server) return null;
  const { command, url } = server;
  if ((command === undefined) === (url === undefined)) return null;
  if (command !== undefined) {
    if (server.url !== undefined || server.headers !== undefined) return null;
    if (command.trim() !== command || command.length === 0 || control(command)) return null;
    const args = server.args ?? [];
    const env = server.env ?? {};
    if (args.some(control)) return null;
    if (Object.keys(env).some((k) => !ENV_KEY.test(k))) return null;
    if (Object.values(env).some(control)) return null;
    return { transport: "stdio", command, args: [...args], env: { ...env } };
  }
  if (server.args !== undefined || server.env !== undefined) return null;
  if (!/^https?:\/\/[^\s]+$/i.test(url!)) return null;
  const headers = server.headers ?? {};
  if (Object.keys(headers).some((k) => !HEADER_KEY.test(k))) return null;
  if (Object.values(headers).some(control)) return null;
  return { transport: "http", url: url!, headers: { ...headers } };
}

/** A tool's entry for `name` and whether it was parked, from a library connection id. */
function resolve(id: string, context: ManageContext, parked: ReadonlyArray<ParkedEntry>) {
  const parts = id.split(":");
  if (parts[0] === "parked") {
    const aside =
      parts.length === 3
        ? parked.find((e) => e.tool === parts[1] && context.digest(e.name) === parts[2])
        : undefined;
    return aside ? { tool: aside.tool, name: aside.name, value: aside.value, parked: true } : null;
  }
  const tool =
    parts.length === 3 &&
    (parts[0] === "codex" || parts[0] === "claude") &&
    parts[1] === `${parts[0]}-user`
      ? parts[0]
      : parts.length === 2 && OTHER_TOOLS.has(parts[0]!)
        ? (parts[0] as EditableTool)
        : null;
  const hash = parts.at(-1);
  if (tool === null || !hash) return null;
  const servers = toolServers(tool, context.tools[tool]?.text ?? null) ?? {};
  const name = Object.keys(servers).find((n) => context.digest(n) === hash);
  return name !== undefined && isObject(servers[name])
    ? { tool, name, value: servers[name], parked: false }
    : null;
}

/** Add `value` under `name`, or null when the name is taken or the file does not parse. */
const addTo = (tool: EditableTool, text: string | null, name: string, value: ObjectValue) =>
  tool === "codex"
    ? appendCodexTable(text ?? "", name, value)
    : setJsonServer(tool, text, name, value);
const removeFrom = (tool: EditableTool, text: string, name: string) =>
  tool === "codex" ? removeCodexServer(text, name) : setJsonServer(tool, text, name, undefined);

export function plan(input: NativeConnectionApplyInput, context: ManageContext): Plan {
  const usable = (state: FileState | undefined): state is FileState =>
    state !== undefined && !state.unreadable;
  const store = context.parked === null ? [] : parseStore(context.parked.text);
  // A store that cannot be read is never rewritten: it may hold the only copy of a server.
  if (
    input.action !== "plugin" &&
    context.parked !== null &&
    (context.parked.unreadable || store === null)
  )
    return { error: "write_failed" };
  const raw = store ?? [];
  const parked = raw.filter(isParked);
  const taken = (tool: EditableTool, name: string) =>
    Object.hasOwn(toolServers(tool, context.tools[tool]?.text ?? null) ?? {}, name) ||
    parked.some((e) => e.tool === tool && e.name === name);
  const file = (
    tool: EditableTool,
    after: string | null,
    lines: ReadonlyArray<string>,
  ): PlannedFile | null => {
    const state = context.tools[tool];
    return state && after !== null
      ? { label: TOOL_LABELS[tool], path: state.path, before: state.text, after, lines }
      : null;
  };
  const parkedFile = (entries: ReadonlyArray<unknown>, line: string): PlannedFile => ({
    label: "SpecWithCode",
    path: context.parked!.path,
    before: context.parked!.text,
    after: serializeParked(entries),
    lines: [line],
  });
  const done = (...files: Array<PlannedFile | null>): Plan =>
    files.every((f) => f !== null) ? { files } : { error: "write_failed" };

  if (input.action === "add") {
    const name = input.name ?? "";
    const declaration = inputDeclaration(input.server);
    const tools = [...new Set(input.tools ?? [])];
    if (!NAME.test(name) || declaration === null || tools.length === 0)
      return { error: "invalid_input" };
    const files: PlannedFile[] = [];
    for (const tool of tools) {
      const state = context.tools[tool];
      if (!state || (state.text === null && !state.creatable && !state.unreadable))
        return { error: "unsupported" };
      if (!usable(state) || toolServers(tool, state.text) === null)
        return { error: "write_failed" };
      if (taken(tool, name)) return { error: "exists" };
      const entry = toolEntry(tool, declaration);
      if (entry === null) return { error: "unsupported" };
      const next = file(tool, addTo(tool, state.text, name, entry), [
        `Add ${name}: ${maskedEntry(entry)}`,
      ]);
      if (next === null) return { error: "write_failed" };
      files.push(next);
    }
    return { files };
  }

  if (input.action === "plugin") {
    const key = input.pluginKey;
    if (!input.provider || !key || input.enabled === undefined) return { error: "invalid_input" };
    const line = `Turn ${input.enabled ? "on" : "off"} plugin ${key}`;
    if (input.provider === "codex") {
      const state = context.tools.codex;
      if (state?.unreadable) return { error: "write_failed" };
      if (!state || state.text === null) return { error: "not_found" };
      const next = setCodexPlugin(state.text, key, input.enabled);
      return next === null ? { error: "not_found" } : done(file("codex", next, [line]));
    }
    const settings = context.claudeSettings;
    if (settings.unreadable) return { error: "write_failed" };
    const next = setClaudePlugin(settings.text, key, input.enabled);
    if (next === null) return { error: "write_failed" };
    return {
      files: [
        {
          label: "Claude Code",
          path: settings.path,
          before: settings.text,
          after: next,
          lines: [line],
        },
      ],
    };
  }

  if (input.action === "undo" || !input.connectionId) return { error: "invalid_input" };
  const [prefix, second] = input.connectionId.split(":");
  const idTool = (prefix === "parked" ? second : prefix) as EditableTool;
  if (context.tools[idTool]?.unreadable) return { error: "write_failed" };
  const found = resolve(input.connectionId, context, parked);
  if (found === null) return { error: "not_found" };
  const { tool, name, value } = found;
  const text = context.tools[tool]?.text ?? null;
  const without = (entries: ReadonlyArray<unknown>) =>
    entries.filter((e) => !(isParked(e) && e.tool === tool && e.name === name));

  switch (input.action) {
    case "enable": {
      if (found.parked) {
        if (!context.parked) return { error: "unsupported" };
        if (Object.hasOwn(toolServers(tool, text) ?? {}, name)) return { error: "exists" };
        return done(
          file(tool, addTo(tool, text, name, value), [`Add ${name} back: ${maskedEntry(value)}`]),
          parkedFile(without(raw), `Release the kept copy of ${name}`),
        );
      }
      if (tool === "codex") {
        const next = enableCodexServer(text ?? "", name);
        return next === null
          ? { error: "unsupported" }
          : done(file(tool, next, [`Turn on ${name}`]));
      }
      if (tool === "opencode" && value.enabled === false)
        return done(
          file(tool, setJsonServer(tool, text, name, { ...value, enabled: true }, true), [
            `Turn on ${name}`,
          ]),
        );
      return { error: "unsupported" };
    }
    case "disable": {
      if (found.parked || value.enabled === false) return { error: "unsupported" };
      if (NATIVE_SWITCH.has(tool)) {
        const next =
          tool === "codex"
            ? disableCodexServer(text ?? "", name)
            : setJsonServer(tool, text, name, { ...value, enabled: false }, true);
        return done(file(tool, next, [`Turn off ${name}`]));
      }
      if (!context.parked) return { error: "unsupported" };
      // The kept copy is written first, so a failed second write leaves a duplicate, never a loss.
      return done(
        parkedFile([...without(raw), { tool, name, value }], `Keep ${name}: ${maskedEntry(value)}`),
        file(tool, removeFrom(tool, text ?? "", name), [
          `Take ${name} out until it is turned on again`,
        ]),
      );
    }
    case "remove": {
      if (found.parked) return done(parkedFile(without(raw), `Remove the kept copy of ${name}`));
      return done(
        file(tool, removeFrom(tool, text ?? "", name), [`Remove ${name}: ${maskedEntry(value)}`]),
      );
    }
    case "copy":
    case "copyAll": {
      const declaration = toolDeclaration(tool, value);
      if (declaration === null) return { error: "not_portable" };
      // Copy what runs today; a turned-off entry is turned on first, where it is declared.
      if (found.parked || value.enabled === false) return { error: "unsupported" };
      const targets =
        input.action === "copy"
          ? tool === "codex"
            ? (["claude"] as const)
            : tool === "claude"
              ? (["codex"] as const)
              : []
          : EDITABLE_TOOLS.filter((t) => t !== tool);
      const files: PlannedFile[] = [];
      for (const target of targets) {
        const state = context.tools[target];
        if (state?.unreadable) {
          if (input.action === "copy") return { error: "write_failed" };
          continue;
        }
        // Copy everywhere reaches installed tools only; the single copy may create the file.
        if (!state || (state.text === null && (input.action === "copyAll" || !state.creatable)))
          continue;
        const servers = toolServers(target, state.text);
        if (servers === null) {
          if (input.action === "copy") return { error: "write_failed" };
          continue;
        }
        if (taken(target, name)) {
          if (input.action === "copy") return { error: "exists" };
          continue;
        }
        const entry = toolEntry(target, declaration);
        if (entry === null) continue;
        const next = file(target, addTo(target, state.text, name, entry), [
          `Add ${name}: ${maskedEntry(entry)}`,
        ]);
        if (next === null) return { error: "write_failed" };
        files.push(next);
      }
      return files.length > 0 ? { files } : { error: "unsupported" };
    }
  }
}
