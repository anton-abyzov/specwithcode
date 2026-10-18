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
} from "@specweave-studio/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { parse } from "smol-toml";
import {
  addClaudeServer,
  appendCodexServer,
  codexPluginProvides,
  enableCodexServer,
  parseNativeConfig,
  portableDeclaration,
} from "./NativeConnectionEdit.ts";

/** Config locations belong to the execution host, never to browser input. */
export class NativeConnectionPaths extends Context.Service<
  NativeConnectionPaths,
  {
    readonly codexHome: string;
    readonly claudeFile: string;
    readonly claudeSettings: string;
    /** Other AI tools' user files, listed read-only. */
    readonly otherTools: ReadonlyArray<OtherToolFile>;
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
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* NativeConnectionPaths;
  const read = (workspaceRoot?: string) =>
    Effect.gen(function* () {
      const sources: Source[] = [];
      const entries: Array<
        { -readonly [K in keyof NativeConnection]: NativeConnection[K] } & { key: string }
      > = [];
      let truncated = false;
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
        // Codex keeps the active version beside older ones; the newest folder is current.
        const versions = yield* fs.readDirectory(directory).pipe(
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
          Effect.map((found) => found.flat().toSorted((a, b) => b.time - a.time)),
          // Not downloaded yet: Codex fetches the plugin before it can run it.
          Effect.orElseSucceed(() => [] as Array<{ name: string; time: number }>),
        );
        const version = versions[0];
        if (!version) continue;
        const root = NodePath.join(directory, version.name);
        yield* plugin("codex", key, root, NodePath.join(root, ".codex-plugin", "plugin.json"));
      }
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
          connections: names.slice(0, MAX_ENTRIES).map((name) => ({
            id: `${tool}:${digest(name)}`,
            name: safeName(name),
            ...otherToolDeclaration(servers[name]),
          })),
        });
      }
      // Last declaration wins within each client. Codex project tables inherit unspecified fields.
      // Plugin servers and other projects' declarations run beside the user's, never instead.
      const seen = new Set<string>();
      for (const entry of entries.toReversed()) {
        if (entry.plugin !== undefined || entry.project !== undefined) continue;
        const key = `${entry.provider}:${entry.key}`;
        entry.shadowed = seen.has(key);
        seen.add(key);
      }
      return {
        observedAt: DateTime.formatIso(yield* DateTime.now),
        sources,
        connections: entries.map(({ key: _key, ...connection }) => connection),
        truncated,
        runtime: "unverified" as const,
        otherTools,
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
  const apply = (input: NativeConnectionApplyInput) =>
    Effect.gen(function* () {
      const [provider, sourceId, hash] = input.connectionId.split(":");
      if (
        (provider !== "codex" && provider !== "claude") ||
        sourceId !== `${provider}-user` ||
        !hash
      )
        return yield* failure("not_found");
      const codexPath = NodePath.join(paths.codexHome, "config.toml");
      const sourcePath = provider === "codex" ? codexPath : paths.claudeFile;
      const source = yield* readConfig(sourcePath);
      if (source === null) return yield* failure("not_found");
      const parsed = parseNativeConfig(provider, source.text);
      if (parsed === null) return yield* failure("write_failed");
      const servers = object(provider === "codex" ? parsed.mcp_servers : parsed.mcpServers);
      const key = Object.keys(servers).find((name) => digest(name) === hash);
      if (key === undefined) return yield* failure("not_found");
      if (input.action === "enable") {
        if (provider !== "codex") return yield* failure("not_portable");
        const next = enableCodexServer(source.text, key);
        if (next === null) return yield* failure("write_failed");
        yield* writeConfig(sourcePath, source, next);
        return yield* read();
      }
      const declaration = portableDeclaration(provider, servers[key]);
      if (declaration === null) return yield* failure("not_portable");
      const targetPath = provider === "codex" ? paths.claudeFile : codexPath;
      const target = yield* readConfig(targetPath);
      const targetText = target?.text ?? (provider === "codex" ? "{}" : "");
      if (parseNativeConfig(provider === "codex" ? "claude" : "codex", targetText) === null)
        return yield* failure("write_failed");
      const next =
        provider === "codex"
          ? addClaudeServer(targetText, key, declaration)
          : appendCodexServer(targetText, key, declaration);
      if (next === null) return yield* failure("exists");
      yield* writeConfig(targetPath, target, next);
      return yield* read();
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
        };
      }),
    ),
  ),
);
