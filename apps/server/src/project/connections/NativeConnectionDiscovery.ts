import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import {
  type NativeConnection,
  type NativeConnectionApplyInput,
  NativeConnectionsError,
  type NativeConnectionsSnapshot,
  type NativeOtherTool,
  type NativeOtherToolInventory,
  type NativePlugin,
} from "@specweave-studio/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { parse } from "smol-toml";
import { ServerConfig } from "../../config.ts";
import {
  codexPluginName,
  codexPluginProvides,
  disabledCodexSkills,
  portableDeclaration,
  toolDeclaration,
} from "./NativeConnectionEdit.ts";
import {
  EDITABLE_TOOLS,
  type FileState,
  backupText,
  parkedFrom,
  parkedId,
  plan,
  type PlannedFile,
} from "./NativeConnectionManage.ts";

/** Config locations belong to the execution host, never to browser input. */
export class NativeConnectionPaths extends Context.Service<
  NativeConnectionPaths,
  {
    readonly codexHome: string;
    readonly claudeFile: string;
    readonly claudeSettings: string;
    /** Other AI tools' user files. */
    readonly otherTools: ReadonlyArray<OtherToolFile>;
    /** SpecWithCode's state folder: turned-off entries and change backups. Absent, edits keep no backup. */
    readonly stateDir?: string;
    /** Shown as `~` in change previews. */
    readonly home?: string;
  }
>()("studio/connections/NativeConnectionPaths") {}
export class NativeConnectionDiscovery extends Context.Service<
  NativeConnectionDiscovery,
  {
    readonly read: (workspaceRoot?: string) => Effect.Effect<NativeConnectionsSnapshot>;
    /** Edits user-scope declarations only; project files belong to the repository. */
    readonly apply: (
      input: NativeConnectionApplyInput,
    ) => Effect.Effect<NativeConnectionsSnapshot, NativeConnectionsError>;
  }
>()("studio/connections/NativeConnectionDiscovery") {}

type ObjectValue = Record<string, unknown>;
const isObject = (v: unknown): v is ObjectValue =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const object = (v: unknown): ObjectValue => (isObject(v) ? v : {});
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 200;
const MAX_BACKUPS = 20;
const PARKED_FILE = NodePath.join("connections", "parked.json");
const digest = (name: string) =>
  NodeCrypto.createHash("sha256").update(name).digest("hex").slice(0, 24);
const safeName = (name: string) =>
  /^[a-zA-Z][a-zA-Z0-9_. -]{0,79}$/.test(name) &&
  !/^(sk-|ph[xsp]_|gh[pousr]_|github_pat_|eyJ)/i.test(name) &&
  !/[a-zA-Z0-9_-]{48}/.test(name)
    ? name
    : `Connection ${digest(name).slice(0, 8)}`;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

// Declarations beyond the Codex and Claude Code user files: plugin bundles and
// other AI tools' configuration.
const text = (v: unknown) => typeof v === "string" && v.trim().length > 0;

export interface OtherToolFile {
  readonly tool: NativeOtherTool;
  readonly path: string;
}

/** User configuration files of other AI tools on the execution host. */
export function otherToolFiles(
  home: string,
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<OtherToolFile> {
  const desktopRoot =
    platform === "darwin"
      ? NodePath.join(home, "Library", "Application Support")
      : platform === "win32"
        ? environment.APPDATA?.trim() || NodePath.join(home, "AppData", "Roaming")
        : environment.XDG_CONFIG_HOME?.trim() || NodePath.join(home, ".config");
  const xdg = environment.XDG_CONFIG_HOME?.trim() || NodePath.join(home, ".config");
  return [
    {
      tool: "claude-desktop",
      path: NodePath.join(desktopRoot, "Claude", "claude_desktop_config.json"),
    },
    {
      tool: "gemini",
      path: NodePath.join(environment.GEMINI_CLI_HOME?.trim() || home, ".gemini", "settings.json"),
    },
    {
      tool: "copilot",
      path: NodePath.join(
        environment.COPILOT_HOME?.trim() || NodePath.join(home, ".copilot"),
        "mcp-config.json",
      ),
    },
    { tool: "cursor", path: NodePath.join(home, ".cursor", "mcp.json") },
    { tool: "opencode", path: NodePath.join(xdg, "opencode", "opencode.json") },
    { tool: "windsurf", path: NodePath.join(home, ".codeium", "windsurf", "mcp_config.json") },
  ];
}

/** The server table of another tool's configuration. OpenCode keys it `mcp`. */
export const otherToolServers = (tool: NativeOtherTool, data: ObjectValue): unknown =>
  tool === "opencode" ? data.mcp : data.mcpServers;

/**
 * Transport and state of a declaration in another tool's format: a command
 * string (or OpenCode's command array) or a URL under `url`, Gemini's
 * `httpUrl` or Windsurf's `serverUrl`.
 */
export function otherToolDeclaration(value: unknown): {
  readonly transport: "stdio" | "http" | "sse" | "unknown";
  readonly state: "configured" | "disabled" | "invalid";
} {
  if (!isObject(value)) return { transport: "unknown", state: "invalid" };
  const command = text(value.command) || (Array.isArray(value.command) && text(value.command[0]));
  const url = text(value.url) || text(value.httpUrl) || text(value.serverUrl);
  const transport =
    command && !url
      ? "stdio"
      : url && !command
        ? value.type === "sse"
          ? "sse"
          : "http"
        : "unknown";
  if (transport === "unknown") return { transport, state: "invalid" };
  return {
    transport,
    state: value.enabled === false || value.disabled === true ? "disabled" : "configured",
  };
}

/** A path segment that cannot climb out of the directory it is joined to. */
const segment = (part: string | undefined): part is string =>
  part !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(part) && !part.includes("..");

/** The cache folder of an enabled Codex plugin keyed `<name>@<marketplace>`. */
export function codexPluginDirectory(codexHome: string, key: string): string | null {
  const [name, marketplace, ...rest] = key.split("@");
  if (rest.length > 0 || !segment(name) || !segment(marketplace)) return null;
  return NodePath.join(codexHome, "plugins", "cache", marketplace, name);
}

/** Codex marks the cache folder of a plugin the user's ChatGPT account installed with this file. */
const ACCOUNT_MARKER = ".codex-remote-plugin-install.json";

/** The `name` of a SKILL.md frontmatter block, when it is a plain skill name. */
export function skillFrontmatterName(text: string): string | null {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") return null;
    const match = /^name:\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const name = match[1]!.replace(/^"(.*)"$|^'(.*)'$/, "$1$2");
    return segment(name) ? name : null;
  }
  return null;
}

/** Enabled Codex plugin keys, in configuration order. */
export const enabledCodexPlugins = (config: ObjectValue): string[] =>
  Object.entries(object(config.plugins))
    .filter(([, value]) => isObject(value) && value.enabled === true)
    .map(([key]) => key);

/**
 * Install folders of enabled Claude Code plugins. User installs always count;
 * project installs count only for that project. Later settings win.
 */
export function claudePluginInstalls(
  index: ObjectValue,
  enabled: ReadonlyArray<ObjectValue>,
  pluginsRoot: string,
  workspaceRoot?: string,
): Array<{ readonly key: string; readonly path: string }> {
  const flags: ObjectValue = Object.assign({}, ...enabled.map((s) => object(s.enabledPlugins)));
  const installs: Array<{ key: string; path: string }> = [];
  for (const [key, raw] of Object.entries(object(index.plugins))) {
    if (flags[key] !== true) continue;
    const candidates = (Array.isArray(raw) ? raw : [raw]).filter(isObject);
    const install = candidates.find(
      (c) =>
        c.scope === undefined ||
        c.scope === "user" ||
        (workspaceRoot !== undefined && c.projectPath === workspaceRoot),
    );
    if (!install || typeof install.installPath !== "string") continue;
    const path = NodePath.resolve(install.installPath);
    const relative = NodePath.relative(pluginsRoot, path);
    if (relative.startsWith("..") || NodePath.isAbsolute(relative)) continue;
    installs.push({ key, path });
  }
  return installs;
}

/**
 * Where a plugin's manifest points for its MCP servers: an inline table, or a
 * file inside the plugin (default `.mcp.json`). Null when it points outside.
 */
export function pluginMcpReference(
  root: string,
  manifest: ObjectValue,
): { readonly inline: ObjectValue } | { readonly file: string } | null {
  const reference = manifest.mcpServers;
  if (isObject(reference)) return { inline: reference };
  const file = NodePath.resolve(root, typeof reference === "string" ? reference : ".mcp.json");
  const relative = NodePath.relative(root, file);
  return relative.startsWith("..") || NodePath.isAbsolute(relative) ? null : { file };
}

/** The server table of a plugin's MCP file; plugins wrap it in `mcpServers`. */
export const pluginServers = (data: ObjectValue): unknown =>
  isObject(data.mcpServers) ? data.mcpServers : data.mcp_servers;

/** A plugin's display name from its manifest, else its key without the marketplace. */
export function pluginLabel(key: string, manifest: ObjectValue): string {
  const display = object(manifest.interface).displayName ?? manifest.displayName;
  if (typeof display === "string" && display.trim()) return display.trim().slice(0, 60);
  return key.split("@")[0] ?? key;
}

type Source = NativeConnectionsSnapshot["sources"][number];
type ConfigRecord = { readonly path: string; readonly mode: number; readonly text: string } | null;
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* NativeConnectionPaths;
  type Status = Source["status"];
  // Open regular files only, cap reads even if the file grows after stat, close every handle.
  const bounded = (path: string, toml = false) =>
    Effect.scoped(
      Effect.gen(function* () {
        const none = (status: Status) => ({ status, data: {} as ObjectValue });
        const info = yield* fs.stat(path);
        if (info.type !== "File") return none("unreadable");
        if (Number(info.size) > MAX_BYTES) return none("too_large");
        const handle = yield* fs.open(path, { flag: "r" });
        const chunks: Uint8Array[] = [];
        let length = 0;
        while (length <= MAX_BYTES) {
          const part = yield* handle.readAlloc(Math.min(65536, MAX_BYTES + 1 - length));
          if (Option.isNone(part) || part.value.length === 0) break;
          length += part.value.length;
          chunks.push(part.value);
        }
        if (length > MAX_BYTES) return none("too_large");
        let data: unknown;
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          data = toml ? parse(text) : JSON.parse(text);
        } catch {
          return none("invalid");
        }
        if (!isObject(data)) return none("invalid");
        return { status: "read" as Status, data };
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          status: (error.reason._tag === "NotFound" ? "missing" : "unreadable") as Status,
          data: {} as ObjectValue,
        }),
      ),
    );
  const cacheRoot = NodePath.join(paths.codexHome, "plugins", "cache");
  /** Folder names safe to join under `directory`, sorted and capped; none when it is unreadable. */
  const folders = (directory: string, limit: number) =>
    fs.readDirectory(directory).pipe(
      Effect.map((names) => names.filter(segment).toSorted().slice(0, limit)),
      Effect.orElseSucceed(() => [] as string[]),
    );
  /** Codex keeps the active version beside older ones; the newest folder is current. */
  const newestVersion = (directory: string) =>
    fs.readDirectory(directory).pipe(
      Effect.flatMap((names) =>
        Effect.forEach(names.slice(0, 50), (name) =>
          fs.stat(NodePath.join(directory, name)).pipe(
            Effect.map((info) =>
              info.type === "Directory"
                ? [
                    {
                      name,
                      time: Option.match(info.mtime, {
                        onNone: () => 0,
                        onSome: (d) => d.getTime(),
                      }),
                    },
                  ]
                : [],
            ),
            Effect.orElseSucceed(() => []),
          ),
        ),
      ),
      Effect.map((found) => found.flat().toSorted((a, b) => b.time - a.time)[0]?.name),
      // Not downloaded yet: Codex fetches the plugin before it can run it.
      Effect.orElseSucceed(() => undefined),
    );
  /** Keys of the plugins the user's ChatGPT account installed, from their marked cache folders. */
  const accountPlugins = Effect.gen(function* () {
    const keys: string[] = [];
    for (const marketplace of yield* folders(cacheRoot, 50))
      for (const name of yield* folders(NodePath.join(cacheRoot, marketplace), MAX_ENTRIES + 1)) {
        const marked = yield* fs
          .exists(NodePath.join(cacheRoot, marketplace, name, ACCOUNT_MARKER))
          .pipe(Effect.orElseSucceed(() => false));
        if (marked) keys.push(`${name}@${marketplace}`);
      }
    return keys;
  });
  /** A skill's name from the start of its SKILL.md, else its folder; null without one. */
  const skillName = (folder: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = NodePath.join(folder, "SKILL.md");
        if ((yield* fs.stat(path)).type !== "File") return null;
        const handle = yield* fs.open(path, { flag: "r" });
        const head = yield* handle.readAlloc(16384);
        const text = Option.isSome(head) ? Buffer.from(head.value).toString("utf8") : "";
        return skillFrontmatterName(text) ?? NodePath.basename(folder);
      }),
    ).pipe(Effect.orElseSucceed(() => null));
  /**
   * The skills each Codex plugin name ships, from the newest version of every
   * cached install of that name, local or account: Codex names them
   * `<plugin>:<skill>` whichever install it loads.
   */
  const pluginSkills = (names: Iterable<string>) =>
    Effect.gen(function* () {
      const result = new Map<string, string[]>();
      const marketplaces = yield* folders(cacheRoot, 50);
      for (const name of [...new Set(names)].filter(segment).slice(0, MAX_ENTRIES)) {
        const skills = new Set<string>();
        for (const marketplace of marketplaces) {
          const directory = NodePath.join(cacheRoot, marketplace, name);
          const version = yield* newestVersion(directory);
          if (version === undefined) continue;
          const root = NodePath.join(directory, version);
          const manifest = yield* bounded(NodePath.join(root, ".codex-plugin", "plugin.json"));
          const declared = manifest.data.skills;
          const folder = NodePath.resolve(root, typeof declared === "string" ? declared : "skills");
          const relative = NodePath.relative(root, folder);
          if (relative.startsWith("..") || NodePath.isAbsolute(relative)) continue;
          for (const skill of yield* folders(folder, MAX_ENTRIES)) {
            const found = yield* skillName(NodePath.join(folder, skill));
            if (found !== null) skills.add(found);
          }
        }
        if (skills.size > 0) result.set(name, [...skills]);
      }
      return result;
    });
  const read = (workspaceRoot?: string) =>
    Effect.gen(function* () {
      const sources: Source[] = [];
      const entries: Array<
        { -readonly [K in keyof NativeConnection]: NativeConnection[K] } & { key: string }
      > = [];
      let truncated = false;
      const file = (
        path: string,
        id: string,
        provider: "codex" | "claude",
        scope: Source["scope"],
        toml = false,
      ) =>
        bounded(path, toml).pipe(
          Effect.map(({ status, data }) => {
            sources.push({ id, provider, scope, status });
            return data;
          }),
        );
      const add = (
        raw: unknown,
        provider: "codex" | "claude",
        sourceId: string,
        scope: Source["scope"],
        previous: ObjectValue = {},
        root: ObjectValue = {},
        origin: {
          readonly plugin?: string;
          readonly pluginKey?: string;
          readonly project?: string;
        } = {},
      ) => {
        const configs = object(raw);
        if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
          const source = sources.find((s) => s.id === sourceId);
          if (source) sources[sources.indexOf(source)] = { ...source, status: "invalid" };
        }
        const names = Object.keys(configs);
        if (names.length > MAX_ENTRIES) truncated = true;
        for (const name of names.slice(0, MAX_ENTRIES)) {
          const value = configs[name];
          const config =
            provider === "codex" ? { ...object(previous[name]), ...object(value) } : object(value);
          const command = typeof config.command === "string" && config.command.trim().length > 0;
          const url = typeof config.url === "string" && config.url.trim().length > 0;
          const declared = config.type;
          const transport: NativeConnection["transport"] =
            command && !url && (!declared || declared === "stdio")
              ? "stdio"
              : url && !command && (!declared || declared === "http" || declared === "sse")
                ? declared === "sse"
                  ? "sse"
                  : "http"
                : "unknown";
          const valid =
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            transport !== "unknown";
          const plain = origin.plugin === undefined && origin.project === undefined;
          entries.push({
            id: `${provider}:${sourceId}:${digest(
              origin.pluginKey !== undefined
                ? `${origin.pluginKey}/${name}`
                : origin.project !== undefined
                  ? `${origin.project}/${name}`
                  : name,
            )}`,
            key: name,
            name: safeName(name),
            provider,
            sourceId,
            scope,
            transport,
            state: !valid ? "invalid" : config.enabled === false ? "disabled" : "configured",
            shadowed: false,
            ...(scope === "user" && valid && plain
              ? { portable: portableDeclaration(provider, value) !== null }
              : {}),
            ...(provider === "codex" && plain && codexPluginProvides(root, name)
              ? { pluginProvided: true }
              : {}),
            ...(origin.plugin !== undefined ? { plugin: origin.plugin } : {}),
            ...(origin.project !== undefined ? { project: origin.project } : {}),
          });
        }
        return configs;
      };
      const codex = yield* file(
        NodePath.join(paths.codexHome, "config.toml"),
        "codex-user",
        "codex",
        "user",
        true,
      );
      const userCodex = add(codex.mcp_servers, "codex", "codex-user", "user", {}, codex);
      const claude = yield* file(paths.claudeFile, "claude-user", "claude", "user");
      add(claude.mcpServers, "claude", "claude-user", "user");
      // Entries SpecWithCode turned off in tools without an off switch.
      const parked =
        paths.stateDir === undefined
          ? []
          : parkedFrom((yield* bounded(NodePath.join(paths.stateDir, PARKED_FILE))).data);
      for (const entry of parked.filter((e) => e.tool === "claude")) {
        const before = entries.length;
        add({ [entry.name]: entry.value }, "claude", "claude-user", "user");
        for (const added of entries.slice(before)) {
          added.id = parkedId("claude", digest(entry.name));
          added.state = added.state === "invalid" ? "invalid" : "disabled";
          added.parked = true;
        }
      }
      let claudeSettings: ObjectValue[] = [];
      if (workspaceRoot) {
        const projectCodex = yield* file(
          NodePath.join(workspaceRoot, ".codex", "config.toml"),
          "codex-project",
          "codex",
          "project",
          true,
        );
        add(projectCodex.mcp_servers, "codex", "codex-project", "project", userCodex, codex);
        const projectClaude = yield* file(
          NodePath.join(workspaceRoot, ".mcp.json"),
          "claude-project",
          "claude",
          "project",
        );
        add(projectClaude.mcpServers, "claude", "claude-project", "project");
        const rawLocal = object(claude.projects)[workspaceRoot];
        const local = object(rawLocal);
        const userStatus = sources.find((s) => s.id === "claude-user")!.status;
        const localStatus =
          userStatus !== "read"
            ? userStatus
            : (claude.projects !== undefined && !isObject(claude.projects)) ||
                (rawLocal !== undefined && !isObject(rawLocal))
              ? "invalid"
              : rawLocal === undefined
                ? "missing"
                : "read";
        sources.push({
          id: "claude-local",
          provider: "claude",
          scope: "local",
          status: localStatus,
        });
        add(local.mcpServers, "claude", "claude-local", "local");
        const settings = [
          yield* file(paths.claudeSettings, "claude-user-settings", "claude", "user"),
          yield* file(
            NodePath.join(workspaceRoot, ".claude", "settings.json"),
            "claude-project-settings",
            "claude",
            "project",
          ),
          yield* file(
            NodePath.join(workspaceRoot, ".claude", "settings.local.json"),
            "claude-local-settings",
            "claude",
            "local",
          ),
        ];
        claudeSettings = settings;
        const disabledShared = new Set(settings.flatMap((s) => strings(s.disabledMcpjsonServers)));
        const disabled = new Set(strings(local.disabledMcpServers));
        for (const entry of entries)
          if (
            entry.provider === "claude" &&
            (disabled.has(entry.key) ||
              (entry.scope === "project" && disabledShared.has(entry.key)))
          )
            entry.state = "disabled";
      }
      if (!workspaceRoot) {
        // Settings has no project to narrow to, so list every private-project declaration.
        const userStatus = sources.find((s) => s.id === "claude-user")!.status;
        const projects = claude.projects;
        sources.push({
          id: "claude-all-projects",
          provider: "claude",
          scope: "local",
          status:
            userStatus !== "read"
              ? userStatus
              : projects !== undefined && !isObject(projects)
                ? "invalid"
                : "read",
        });
        const declaring = Object.entries(object(projects)).filter(
          ([, value]) => Object.keys(object(object(value).mcpServers)).length > 0,
        );
        if (declaring.length > MAX_ENTRIES) truncated = true;
        for (const [path, value] of declaring.slice(0, MAX_ENTRIES)) {
          const local = object(value);
          const project = safeName(NodePath.basename(path) || path);
          const before = entries.length;
          add(local.mcpServers, "claude", "claude-all-projects", "local", {}, {}, { project });
          const disabled = new Set(strings(local.disabledMcpServers));
          for (const entry of entries.slice(before))
            if (disabled.has(entry.key)) entry.state = "disabled";
        }
        const settings = yield* bounded(paths.claudeSettings);
        claudeSettings = [settings.data];
        if (settings.status !== "read" && settings.status !== "missing")
          sources.push({
            id: "claude-user-settings",
            provider: "claude",
            scope: "user",
            status: settings.status,
          });
      }
      // Plugin bundles declare servers their tool starts with the plugin.
      const pluginStatus: Record<"codex" | "claude", Status> = { codex: "read", claude: "read" };
      const labels = new Map<string, string>();
      const worse = (provider: "codex" | "claude", status: Status) => {
        if (status !== "read" && status !== "missing") pluginStatus[provider] = status;
      };
      const plugin = (
        provider: "codex" | "claude",
        key: string,
        root: string,
        manifestPath: string,
      ) =>
        Effect.gen(function* () {
          const manifest = yield* bounded(manifestPath);
          worse(provider, manifest.status);
          const label = pluginLabel(key, manifest.data);
          labels.set(`${provider}:${key}`, label);
          const origin = { plugin: label, pluginKey: key };
          const sourceId = `${provider}-plugins`;
          const reference = pluginMcpReference(root, manifest.data);
          let servers: ObjectValue = {};
          if (reference === null) worse(provider, "invalid");
          else if ("inline" in reference)
            servers = add(reference.inline, provider, sourceId, "user", {}, {}, origin);
          else {
            const mcp = yield* bounded(reference.file);
            worse(provider, mcp.status);
            servers = add(pluginServers(mcp.data), provider, sourceId, "user", {}, {}, origin);
          }
          if (provider === "codex") {
            // Codex app connectors are remote servers reached through the account.
            const apps = yield* bounded(NodePath.join(root, ".app.json"));
            worse(provider, apps.status);
            const declared = object(apps.data.apps);
            add(
              Object.fromEntries(
                Object.keys(declared)
                  // A plugin that ships both lists its server once.
                  .filter((name) => !Object.hasOwn(servers, name))
                  .map((name) => [
                    /^app-[0-9a-f]{16,}$/.test(name) ? label : name,
                    // Only the transport is derived; the value is never returned.
                    { url: "https://app.connector" },
                  ]),
              ),
              provider,
              sourceId,
              "user",
              {},
              {},
              origin,
            );
          }
        });
      const codexPlugins = enabledCodexPlugins(codex);
      if (codexPlugins.length > MAX_ENTRIES) truncated = true;
      for (const key of codexPlugins.slice(0, MAX_ENTRIES)) {
        const directory = codexPluginDirectory(paths.codexHome, key);
        if (directory === null) {
          worse("codex", "invalid");
          continue;
        }
        const version = yield* newestVersion(directory);
        if (version === undefined) continue;
        const root = NodePath.join(directory, version);
        yield* plugin("codex", key, root, NodePath.join(root, ".codex-plugin", "plugin.json"));
      }
      // Account plugins load whatever config.toml says, so they are listed from the cache.
      const accountKeys = yield* accountPlugins;
      if (accountKeys.length > MAX_ENTRIES) truncated = true;
      const account = new Set(accountKeys.slice(0, MAX_ENTRIES));
      for (const key of account) {
        if (labels.has(`codex:${key}`)) continue;
        const directory = codexPluginDirectory(paths.codexHome, key);
        const version = directory === null ? undefined : yield* newestVersion(directory);
        if (directory === null || version === undefined) continue;
        const manifest = yield* bounded(
          NodePath.join(directory, version, ".codex-plugin", "plugin.json"),
        );
        worse("codex", manifest.status);
        labels.set(`codex:${key}`, pluginLabel(key, manifest.data));
      }
      const tables = object(codex.plugins);
      const codexKeys = [
        ...Object.keys(tables).filter((key) => isObject(tables[key])),
        ...[...account].filter((key) => !isObject(tables[key])),
      ].slice(0, MAX_ENTRIES);
      // A plugin is off once every skill it ships is turned off by name.
      const skillsOf = yield* pluginSkills(codexKeys.map(codexPluginName));
      const skillsOff = disabledCodexSkills(codex);
      const skillsOn = (key: string) => {
        const name = codexPluginName(key);
        const skills = skillsOf.get(name) ?? [];
        return skills.length === 0 || skills.some((skill) => !skillsOff.has(`${name}:${skill}`));
      };
      const pluginsRoot = NodePath.join(NodePath.dirname(paths.claudeSettings), "plugins");
      const index = yield* bounded(NodePath.join(pluginsRoot, "installed_plugins.json"));
      worse("claude", index.status);
      const installs = claudePluginInstalls(index.data, claudeSettings, pluginsRoot, workspaceRoot);
      if (installs.length > MAX_ENTRIES) truncated = true;
      for (const install of installs.slice(0, MAX_ENTRIES))
        yield* plugin(
          "claude",
          install.key,
          install.path,
          NodePath.join(install.path, ".claude-plugin", "plugin.json"),
        );
      const flags: ObjectValue = Object.assign(
        {},
        ...claudeSettings.map((s) => object(s.enabledPlugins)),
      );
      const plugins: NativePlugin[] = [
        ...codexKeys.map((key) => ({
          provider: "codex" as const,
          key,
          enabled: (account.has(key) || object(tables[key]).enabled === true) && skillsOn(key),
          ...(account.has(key) ? { account: true } : {}),
          // An account plugin with no skills has nothing config.toml can switch.
          ...(account.has(key) && !skillsOf.has(codexPluginName(key)) ? { switchable: false } : {}),
        })),
        ...Object.keys(object(index.data.plugins)).map((key) => ({
          provider: "claude" as const,
          key,
          enabled: flags[key] === true,
          // The toggle writes user settings; a project or local flag would win over it.
          ...(claudeSettings
            .slice(1)
            .some((settings) => Object.hasOwn(object(settings.enabledPlugins), key))
            ? { overridden: true }
            : {}),
        })),
      ]
        .slice(0, MAX_ENTRIES)
        .map((p) => ({
          ...p,
          key: p.key.slice(0, 200),
          label: labels.get(`${p.provider}:${p.key}`) ?? pluginLabel(p.key, {}),
        }));
      sources.push(
        { id: "codex-plugins", provider: "codex", scope: "user", status: pluginStatus.codex },
        { id: "claude-plugins", provider: "claude", scope: "user", status: pluginStatus.claude },
      );
      const otherTools: NativeOtherToolInventory[] = [];
      for (const { tool, path } of paths.otherTools) {
        const config = yield* bounded(path);
        const servers = object(otherToolServers(tool, config.data));
        const names = Object.keys(servers);
        if (names.length > MAX_ENTRIES) truncated = true;
        otherTools.push({
          tool,
          status: config.status,
          connections: [
            ...names.slice(0, MAX_ENTRIES).map((name) => ({
              id: `${tool}:${digest(name)}`,
              name: safeName(name),
              ...otherToolDeclaration(servers[name]),
              ...(toolDeclaration(tool, servers[name]) !== null ? { portable: true } : {}),
            })),
            ...parked
              .filter((e) => e.tool === tool)
              .map((e) => {
                const declared = otherToolDeclaration(e.value);
                return {
                  id: parkedId(tool, digest(e.name)),
                  name: safeName(e.name),
                  transport: declared.transport,
                  state:
                    declared.state === "invalid" ? ("invalid" as const) : ("disabled" as const),
                  parked: true,
                };
              }),
          ],
        });
      }
      // Last declaration wins within each client. Codex project tables inherit unspecified fields.
      // Plugin servers and other projects' declarations run beside the user's, never instead.
      const seen = new Set<string>();
      for (const entry of entries.toReversed()) {
        if (entry.plugin !== undefined || entry.project !== undefined || entry.parked) continue;
        const key = `${entry.provider}:${entry.key}`;
        entry.shadowed = seen.has(key);
        seen.add(key);
      }
      // A kept copy never stands in for a declaration the tool still runs.
      for (const entry of entries)
        if (entry.parked)
          entry.shadowed = entries.some(
            (e) =>
              !e.parked &&
              e.plugin === undefined &&
              e.project === undefined &&
              e.provider === entry.provider &&
              e.key === entry.key,
          );
      return {
        observedAt: DateTime.formatIso(yield* DateTime.now),
        sources,
        connections: entries.map(({ key: _key, ...connection }) => connection),
        truncated,
        runtime: "unverified" as const,
        otherTools,
        plugins,
      };
    });
  const failure = (code: NativeConnectionsError["code"]) => new NativeConnectionsError({ code });
  /** The real file behind a possibly symlinked config, its text and mode; null when absent. */
  const readConfig = (path: string) =>
    Effect.gen(function* () {
      if (!(yield* fs.exists(path))) return null;
      const real = yield* fs.realPath(path);
      const info = yield* fs.stat(real);
      if (info.type !== "File" || Number(info.size) > MAX_BYTES)
        return yield* failure("write_failed");
      return { path: real, mode: info.mode & 0o777, text: yield* fs.readFileString(real) };
    }).pipe(Effect.catchTags({ PlatformError: () => Effect.fail(failure("unavailable")) }));
  /** Replace the file only if nobody wrote it since it was read; the rename keeps readers whole. */
  const writeConfig = (
    path: string,
    before: { readonly path: string; readonly mode: number; readonly text: string } | null,
    next: string,
  ) =>
    Effect.gen(function* () {
      const current = yield* readConfig(path);
      if ((current?.text ?? null) !== (before?.text ?? null)) return yield* failure("changed");
      const target = before?.path ?? path;
      const temporary = `${target}.specwithcode-${NodeCrypto.randomUUID()}.tmp`;
      yield* fs.writeFileString(temporary, next, { mode: before?.mode ?? 0o600 }).pipe(
        Effect.flatMap(() => fs.rename(temporary, target)),
        Effect.tapError(() => fs.remove(temporary).pipe(Effect.ignore)),
        Effect.mapError(() => failure("write_failed")),
      );
    });
  const display = (path: string) =>
    paths.home && (path === paths.home || path.startsWith(`${paths.home}${NodePath.sep}`))
      ? `~${path.slice(paths.home.length)}`
      : path;
  /** A file as the planner sees it; one that is too large or unreadable blocks only edits to it. */
  const state = (path: string) =>
    Effect.gen(function* () {
      const read = yield* Effect.result(readConfig(path));
      const creatable = yield* fs
        .exists(NodePath.dirname(path))
        .pipe(Effect.orElseSucceed(() => false));
      if (read._tag === "Failure")
        return {
          record: null,
          file: { path, text: null, creatable: false, unreadable: true } as FileState,
        };
      const current = read.success;
      return {
        record: current,
        file: { path, text: current?.text ?? null, creatable } as FileState,
      };
    });
  const backupsDir = () => NodePath.join(paths.stateDir!, "connections", "backups");
  const ensureDir = (path: string) =>
    fs
      .makeDirectory(path, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(() => failure("write_failed")));
  /** Write each planned file in order; on a failure put back the ones already written. */
  const writeAll = (
    planned: ReadonlyArray<PlannedFile>,
    records: ReadonlyMap<string, ConfigRecord>,
  ) =>
    Effect.gen(function* () {
      const written: PlannedFile[] = [];
      for (const change of planned) {
        if (paths.stateDir && change.path.startsWith(paths.stateDir))
          yield* ensureDir(NodePath.dirname(change.path));
        const result = yield* Effect.result(
          writeConfig(change.path, records.get(change.path) ?? null, change.after),
        );
        if (result._tag === "Failure") {
          for (const done of written.toReversed())
            yield* restore(done.path, done.after, done.before).pipe(Effect.ignore);
          return yield* result.failure;
        }
        written.push(change);
      }
    });
  /** Put `before` back (deleting a file the change created) if the file still reads `after`. */
  const restore = (path: string, after: string, before: string | null) =>
    Effect.gen(function* () {
      const current = yield* readConfig(path);
      if ((current?.text ?? null) !== after) return yield* failure("undo_unavailable");
      if (before === null)
        return yield* fs.remove(current!.path).pipe(Effect.mapError(() => failure("write_failed")));
      yield* writeConfig(path, current, before);
    });
  /** Write `after` again if the file still reads `before` (absent when null). */
  const reapply = (path: string, before: string | null, after: string) =>
    Effect.gen(function* () {
      const current = yield* readConfig(path);
      if ((current?.text ?? null) !== before) return yield* failure("changed");
      yield* writeConfig(path, current, after);
    });
  const undo = (changeId: string) =>
    Effect.gen(function* () {
      if (!paths.stateDir || !/^\d{13}-[0-9a-f]{8}$/.test(changeId))
        return yield* failure("undo_unavailable");
      const backupPath = NodePath.join(backupsDir(), `${changeId}.json`);
      const backup = yield* bounded(backupPath);
      const files = Array.isArray(backup.data.files) ? backup.data.files.filter(isObject) : [];
      if (backup.status !== "read" || files.length === 0) return yield* failure("undo_unavailable");
      const changes = files.flatMap((f) =>
        typeof f.path === "string" &&
        typeof f.after === "string" &&
        (f.before === null || typeof f.before === "string")
          ? [{ path: f.path, after: f.after, before: f.before as string | null, label: f.label }]
          : [],
      );
      // All or nothing: every file must still read what the change wrote.
      for (const change of changes) {
        const current = yield* readConfig(change.path);
        if ((current?.text ?? null) !== change.after) return yield* failure("undo_unavailable");
      }
      // Reverse order restores the file that adds a server back before the one that drops it.
      const restored: typeof changes = [];
      for (const change of changes.toReversed()) {
        const result = yield* Effect.result(restore(change.path, change.after, change.before));
        if (result._tag === "Failure") {
          // Re-apply the change to the files already restored, so no server is left in neither.
          for (const done of restored.toReversed())
            yield* reapply(done.path, done.before, done.after).pipe(Effect.ignore);
          return yield* failure("undo_unavailable");
        }
        restored.push(change);
      }
      yield* fs.remove(backupPath).pipe(Effect.ignore);
      return {
        ...(yield* read()),
        change: {
          preview: false,
          files: changes.map((c) => ({
            tool: typeof c.label === "string" ? c.label : "",
            path: display(c.path),
            lines: ["Restored as it was before the change"],
          })),
        },
      };
    });
  const apply = (input: NativeConnectionApplyInput) =>
    Effect.gen(function* () {
      if (input.action === "undo") return yield* undo(input.changeId ?? "");
      const codexPath = NodePath.join(paths.codexHome, "config.toml");
      const records = new Map<string, ConfigRecord>();
      const tools: Partial<Record<(typeof EDITABLE_TOOLS)[number], FileState>> = {};
      const toolPaths = [
        ["codex", codexPath],
        ["claude", paths.claudeFile],
        ...paths.otherTools.map((t) => [t.tool, t.path] as const),
      ] as const;
      for (const [tool, path] of toolPaths) {
        const { record, file } = yield* state(path);
        records.set(path, record);
        tools[tool] = file;
      }
      const settings = yield* state(paths.claudeSettings);
      records.set(paths.claudeSettings, settings.record);
      let parked: FileState | null = null;
      if (paths.stateDir) {
        const parkedPath = NodePath.join(paths.stateDir, PARKED_FILE);
        const current = yield* state(parkedPath);
        records.set(parkedPath, current.record);
        parked = { ...current.file, creatable: true };
      }
      if (input.action === "plugin") {
        const known = (yield* read()).plugins ?? [];
        const plugin = known.find(
          (p) => p.provider === input.provider && p.key === input.pluginKey,
        );
        if (!plugin) return yield* failure("not_found");
        if (plugin.overridden || plugin.switchable === false) return yield* failure("unsupported");
      }
      const codexPluginSkills =
        input.action === "plugin" && input.provider === "codex" && input.pluginKey
          ? yield* pluginSkills([codexPluginName(input.pluginKey)])
          : new Map<string, string[]>();
      const planned = plan(input, {
        tools,
        claudeSettings: settings.file,
        parked,
        digest,
        codexPluginSkills,
      });
      if ("error" in planned) return yield* failure(planned.error);
      const summary = planned.files.map((f) => ({
        tool: f.label,
        path: display(f.path),
        lines: [...f.lines],
      }));
      if (input.preview) return { ...(yield* read()), change: { preview: true, files: summary } };
      let id: string | undefined;
      if (paths.stateDir) {
        // The backup holds the full texts, secrets included, so it stays owner-only.
        const millis = DateTime.toEpochMillis(yield* DateTime.now);
        id = `${String(millis).padStart(13, "0")}-${NodeCrypto.randomUUID().slice(0, 8)}`;
        yield* ensureDir(backupsDir());
        yield* fs
          .writeFileString(
            NodePath.join(backupsDir(), `${id}.json`),
            backupText(
              planned.files.map((f) => ({ ...f, path: records.get(f.path)?.path ?? f.path })),
            ),
            { mode: 0o600 },
          )
          .pipe(Effect.mapError(() => failure("write_failed")));
        const old = yield* fs.readDirectory(backupsDir()).pipe(Effect.orElseSucceed(() => []));
        for (const name of old
          .filter((n) => /^\d{13}-[0-9a-f]{8}\.json$/.test(n))
          .toSorted()
          .slice(0, -MAX_BACKUPS))
          yield* fs.remove(NodePath.join(backupsDir(), name)).pipe(Effect.ignore);
      }
      yield* writeAll(planned.files, records);
      return {
        ...(yield* read()),
        change: { ...(id ? { id } : {}), preview: false, files: summary },
      };
    });
  return NativeConnectionDiscovery.of({ read, apply });
});
export const layer = Layer.effect(NativeConnectionDiscovery, make);
export const layerHost = layer.pipe(
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(
    Layer.effect(
      NativeConnectionPaths,
      Effect.gen(function* () {
        const environment = yield* HostProcessEnvironment;
        // Absent in tests that build the host layer alone; edits then keep no backup.
        const config = yield* Effect.serviceOption(ServerConfig);
        const platform = yield* HostProcessPlatform;
        const home = NodeOS.homedir();
        const claudeDirectory = environment.CLAUDE_CONFIG_DIR?.trim();
        return {
          codexHome: NodePath.resolve(
            environment.CODEX_HOME?.trim() || NodePath.join(home, ".codex"),
          ),
          claudeFile: claudeDirectory
            ? NodePath.resolve(claudeDirectory, ".claude.json")
            : NodePath.join(home, ".claude.json"),
          claudeSettings: NodePath.join(
            claudeDirectory || NodePath.join(home, ".claude"),
            "settings.json",
          ),
          otherTools: otherToolFiles(home, platform, environment),
          ...(Option.isSome(config) ? { stateDir: config.value.stateDir } : {}),
          home,
        };
      }),
    ),
  ),
);
