import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import * as Discovery from "./NativeConnectionDiscovery.ts";

let root: string;
beforeEach(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "native-connections-"));
});
afterEach(async () => {
  await NodeFSP.rm(root, { recursive: true, force: true });
});
const put = (path: string, data: string | object) =>
  Effect.promise(async () => {
    const target = NodePath.join(root, path);
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, typeof data === "string" ? data : JSON.stringify(data));
  });
const scan = (project = false) =>
  Effect.gen(function* () {
    const service = yield* Discovery.NativeConnectionDiscovery;
    return yield* service.read(project ? NodePath.join(root, "repo") : undefined);
  }).pipe(
    Effect.provide(
      Discovery.layer.pipe(
        Layer.provide(NodeFileSystem.layer),
        Layer.provide(
          Layer.succeed(Discovery.NativeConnectionPaths, {
            codexHome: NodePath.join(root, "custom-codex"),
            claudeFile: NodePath.join(root, "custom-claude", ".claude.json"),
            claudeSettings: NodePath.join(root, "custom-claude", "settings.json"),
          }),
        ),
      ),
    ),
  );

describe("native connection configuration discovery", () => {
  it.effect("resolves custom native home paths on the execution host", () =>
    Effect.gen(function* () {
      yield* put("custom-claude/.claude.json", { mcpServers: { custom: { command: "echo" } } });
      const result = yield* Effect.gen(function* () {
        return yield* (yield* Discovery.NativeConnectionDiscovery).read();
      }).pipe(
        Effect.provide(Discovery.layerHost),
        Effect.provideService(HostProcessEnvironment, {
          CODEX_HOME: NodePath.join(root, "custom-codex"),
          CLAUDE_CONFIG_DIR: NodePath.join(root, "custom-claude"),
        }),
      );
      expect(result.connections.map((c) => c.name)).toEqual(["custom"]);
    }),
  );
  it.effect("distinguishes absent configuration from an invalid document", () =>
    Effect.gen(function* () {
      yield* put("custom-codex/config.toml", "[broken");
      const result = yield* scan();
      expect(result.sources.map((s) => [s.id, s.status])).toEqual([
        ["codex-user", "invalid"],
        ["claude-user", "missing"],
      ]);
      expect(result.connections).toEqual([]);
    }),
  );
  it.effect("projects only bounded metadata and never executes a configured command", () =>
    Effect.gen(function* () {
      const command = `touch ${NodePath.join(root, "must-not-exist")}`;
      yield* put(
        "custom-codex/config.toml",
        `[mcp_servers.posthog]\nurl = "https://example.invalid/mcp?token=private-url-token"\n[mcp_servers.posthog.http_headers]\nAuthorization = "Bearer private-header-token"\n[mcp_servers.local]\ncommand = "${command}"\nargs = ["private-arg-token"]\n[mcp_servers.local.env]\nSECRET = "private-env-token"\n`,
      );
      yield* put("custom-claude/.claude.json", {
        mcpServers: {
          posthog: {
            type: "http",
            url: "https://other.invalid",
            headers: { Authorization: "private-claude-token" },
          },
        },
        oauthAccount: { secret: "private-account-token" },
      });
      const result = yield* scan();
      expect(result.connections.map((c) => [c.name, c.provider, c.transport])).toEqual([
        ["posthog", "codex", "http"],
        ["local", "codex", "stdio"],
        ["posthog", "claude", "http"],
      ]);
      expect(JSON.stringify(result)).not.toMatch(
        /private-|example\.invalid|other\.invalid|touch|oauthAccount|Authorization|SECRET/,
      );
      yield* Effect.promise(() =>
        expect(NodeFSP.readFile(NodePath.join(root, "must-not-exist"))).rejects.toMatchObject({
          code: "ENOENT",
        }),
      );
      expect(result.runtime).toBe("unverified");
    }),
  );
  it.effect("reads quoted and inline TOML tables and merges project overrides", () =>
    Effect.gen(function* () {
      yield* put(
        "custom-codex/config.toml",
        '[mcp_servers]\n"with.dot" = { command = "echo", args = ["hello"] }\n[mcp_servers.disabled]\nurl="https://example.invalid"\nenabled=false\n',
      );
      yield* put("repo/.codex/config.toml", '[mcp_servers."with.dot"]\nenabled=false\n');
      const result = yield* scan(true);
      expect(
        result.connections
          .filter((c) => c.name === "with.dot")
          .map((c) => [c.scope, c.state, c.transport, c.shadowed]),
      ).toEqual([
        ["user", "configured", "stdio", true],
        ["project", "disabled", "stdio", false],
      ]);
      expect(result.connections.find((c) => c.name === "disabled")?.state).toBe("disabled");
    }),
  );
  it.effect(
    "isolates registered project paths and applies Claude local over shared over user",
    () =>
      Effect.gen(function* () {
        yield* put("custom-claude/.claude.json", {
          mcpServers: { shared: { command: "user" } },
          projects: {
            [NodePath.join(root, "repo")]: {
              mcpServers: { shared: { type: "http", url: "https://private.invalid" } },
              disabledMcpServers: ["shared"],
            },
            [NodePath.join(root, "other")]: { mcpServers: { foreign: { command: "no" } } },
          },
        });
        yield* put("repo/.mcp.json", {
          mcpServers: { shared: { command: "project" }, onlyProject: { command: "project" } },
        });
        yield* put("repo/.claude/settings.local.json", { disabledMcpjsonServers: ["onlyProject"] });
        const global = yield* scan();
        expect(global.connections.map((c) => c.name)).toEqual(["shared"]);
        const result = yield* scan(true);
        const matches = result.connections.filter((c) => c.name === "shared");
        expect(matches.map((c) => [c.scope, c.shadowed])).toEqual([
          ["user", true],
          ["project", true],
          ["local", false],
        ]);
        expect(matches.at(-1)?.state).toBe("disabled");
        expect(result.connections.find((c) => c.name === "onlyProject")?.state).toBe("disabled");
        expect(JSON.stringify(result)).not.toContain("foreign");
      }),
  );
  it.effect("marks oversized, non-file, malformed and unsupported sources explicitly", () =>
    Effect.gen(function* () {
      yield* put("custom-codex/config.toml", " ".repeat(2 * 1024 * 1024 + 1));
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(root, "custom-claude", ".claude.json"), { recursive: true }),
      );
      yield* put("repo/.mcp.json", { mcpServers: [] });
      yield* put(
        "repo/.codex/config.toml",
        '[mcp_servers.invalid]\ntype="magic"\nurl="somewhere"\n',
      );
      const result = yield* scan(true);
      expect(result.sources.find((s) => s.id === "codex-user")?.status).toBe("too_large");
      expect(result.sources.find((s) => s.id === "claude-user")?.status).toBe("unreadable");
      expect(result.sources.find((s) => s.id === "claude-project")?.status).toBe("invalid");
      expect(result.connections[0]?.state).toBe("invalid");
    }),
  );
  it.effect("caps server counts and masks secret-shaped or markup server names", () =>
    Effect.gen(function* () {
      const mcpServers = Object.fromEntries(
        Array.from({ length: 205 }, (_, i) => [
          i === 0 ? "sk-privatecredential" : i === 1 ? "<script>bad</script>" : `server-${i}`,
          { command: "echo" },
        ]),
      );
      yield* put("custom-claude/.claude.json", { mcpServers });
      const result = yield* scan();
      expect(result.connections).toHaveLength(200);
      expect(result.truncated).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/sk-privatecredential|<script>/);
      expect(result.connections[0]?.name).toMatch(/^Connection /);
    }),
  );
  it.effect("refreshes evidence after changes without retaining removed connections", () =>
    Effect.gen(function* () {
      yield* put("custom-claude/.claude.json", { mcpServers: { old: { command: "echo" } } });
      expect((yield* scan()).connections).toHaveLength(1);
      yield* put("custom-claude/.claude.json", { mcpServers: {} });
      expect((yield* scan()).connections).toEqual([]);
    }),
  );
  it.effect("does not turn invalid JSON root values into a successful empty scan", () =>
    Effect.gen(function* () {
      yield* put("custom-claude/.claude.json", "[]");
      expect((yield* scan()).sources.find((s) => s.id === "claude-user")?.status).toBe("invalid");
    }),
  );
  it.effect.each([null, [], { repo: null }, { repo: [] }])(
    "reports malformed Claude private project data as invalid: %j",
    (projects) =>
      Effect.gen(function* () {
        const data =
          projects && !Array.isArray(projects)
            ? { [NodePath.join(root, "repo")]: projects.repo }
            : projects;
        yield* put("custom-claude/.claude.json", { projects: data });
        expect((yield* scan(true)).sources.find((s) => s.id === "claude-local")?.status).toBe(
          "invalid",
        );
      }),
  );
  it.effect("distinguishes an absent Claude private project from an inspected one", () =>
    Effect.gen(function* () {
      yield* put("custom-claude/.claude.json", { projects: {} });
      expect((yield* scan(true)).sources.find((s) => s.id === "claude-local")?.status).toBe(
        "missing",
      );
      yield* put("custom-claude/.claude.json", { projects: { [NodePath.join(root, "repo")]: {} } });
      expect((yield* scan(true)).sources.find((s) => s.id === "claude-local")?.status).toBe("read");
    }),
  );
});
