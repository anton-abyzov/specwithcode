import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import type { NativeConnection, NativeConnectionsSnapshot } from "@specweave-studio/contracts";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { parse } from "smol-toml";

/** Config locations belong to the execution host, never to browser input. */
export class NativeConnectionPaths extends Context.Service<
  NativeConnectionPaths,
  {
    readonly codexHome: string;
    readonly claudeFile: string;
    readonly claudeSettings: string;
  }
>()("studio/connections/NativeConnectionPaths") {}
export class NativeConnectionDiscovery extends Context.Service<
  NativeConnectionDiscovery,
  {
    readonly read: (workspaceRoot?: string) => Effect.Effect<NativeConnectionsSnapshot>;
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
      // Open regular files only, cap reads even if the file grows after stat, close every handle.
      const file = (
        path: string,
        id: string,
        provider: "codex" | "claude",
        scope: Source["scope"],
        toml = false,
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const info = yield* fs.stat(path);
            if (info.type !== "File") {
              sources.push({ id, provider, scope, status: "unreadable" });
              return {};
            }
            if (Number(info.size) > MAX_BYTES) {
              sources.push({ id, provider, scope, status: "too_large" });
              return {};
            }
            const handle = yield* fs.open(path, { flag: "r" });
            const chunks: Uint8Array[] = [];
            let length = 0;
            while (length <= MAX_BYTES) {
              const part = yield* handle.readAlloc(Math.min(65536, MAX_BYTES + 1 - length));
              if (Option.isNone(part) || part.value.length === 0) break;
              length += part.value.length;
              chunks.push(part.value);
            }
            if (length > MAX_BYTES) {
              sources.push({ id, provider, scope, status: "too_large" });
              return {};
            }
            let data: unknown;
            try {
              const text = Buffer.concat(chunks).toString("utf8");
              data = toml ? parse(text) : JSON.parse(text);
            } catch {
              sources.push({ id, provider, scope, status: "invalid" });
              return {};
            }
            if (!data || typeof data !== "object" || Array.isArray(data)) {
              sources.push({ id, provider, scope, status: "invalid" });
              return {};
            }
            sources.push({ id, provider, scope, status: "read" });
            return object(data);
          }),
        ).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              sources.push({
                id,
                provider,
                scope,
                status: error.reason._tag === "NotFound" ? "missing" : "unreadable",
              });
              return {} as ObjectValue;
            }),
          ),
        );
      const add = (
        raw: unknown,
        provider: "codex" | "claude",
        sourceId: string,
        scope: Source["scope"],
        previous: ObjectValue = {},
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
          entries.push({
            id: `${provider}:${sourceId}:${digest(name)}`,
            key: name,
            name: safeName(name),
            provider,
            sourceId,
            scope,
            transport,
            state: !valid ? "invalid" : config.enabled === false ? "disabled" : "configured",
            shadowed: false,
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
      const userCodex = add(codex.mcp_servers, "codex", "codex-user", "user");
      const claude = yield* file(paths.claudeFile, "claude-user", "claude", "user");
      add(claude.mcpServers, "claude", "claude-user", "user");
      if (workspaceRoot) {
        const projectCodex = yield* file(
          NodePath.join(workspaceRoot, ".codex", "config.toml"),
          "codex-project",
          "codex",
          "project",
          true,
        );
        add(projectCodex.mcp_servers, "codex", "codex-project", "project", userCodex);
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
      // Last declaration wins within each client. Codex project tables inherit unspecified fields.
      const seen = new Set<string>();
      for (const entry of entries.toReversed()) {
        const key = `${entry.provider}:${entry.key}`;
        entry.shadowed = seen.has(key);
        seen.add(key);
      }
      return {
        observedAt: DateTime.formatIso(yield* DateTime.now),
        sources,
        connections: entries.map(
          ({ id, name, provider, sourceId, scope, transport, state, shadowed }) => ({
            id,
            name,
            provider,
            sourceId,
            scope,
            transport,
            state,
            shadowed,
          }),
        ),
        truncated,
        runtime: "unverified" as const,
      };
    });
  return NativeConnectionDiscovery.of({ read });
});
export const layer = Layer.effect(NativeConnectionDiscovery, make);
export const layerHost = layer.pipe(
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(
    Layer.effect(
      NativeConnectionPaths,
      Effect.gen(function* () {
        const environment = yield* HostProcessEnvironment;
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
        };
      }),
    ),
  ),
);
